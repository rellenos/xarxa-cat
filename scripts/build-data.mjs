// Builds the map data (public/data/*) from GTFS feeds.
// Usage: npm run data            (uses cached zips in data/raw)
//        npm run data -- --refresh  (re-downloads feeds)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { GROUPS, classifyRoute, companyOf, EXCLUDED_AGENCY_PREFIXES } from './groups.mjs';
import { fetchPlanned, buildProjects, refFromName, PLANNED_MODE_LABEL, overpass } from './planned.mjs';
import { STATIONS_QUERY, buildStations } from './stations.mjs';
import { RAIL_QUERY, buildRailGraph, routeByRail, insideRailBbox } from './railroute.mjs';
import { markNewRoutes, addAnnounced } from './news.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'public', 'data');
const REFRESH = process.argv.includes('--refresh');
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD (UTC)

const FEEDS = [
  {
    id: 'atm',
    name: 'ATM Àrea de Barcelona — Autobusos i trens de Catalunya',
    url: 'https://files.mobilitydatabase.org/mdb-2826/latest.zip',
    source: 'https://nap.transportes.gob.es/ (via Mobility Database mdb-2826)',
  },
  {
    // State-run interregional coach concessions (Barcelona–Madrid, –Zaragoza, –Andalusia…). Only routes that
    // cross the Catalan border, and not already in the ATM feed.
    id: 'alsa',
    name: 'ALSA — línies estatals (concessions interregionals)',
    url: 'https://files.mobilitydatabase.org/mdb-2825/latest.zip',
    source: 'https://nap.transportes.gob.es/ (via Mobility Database mdb-2825)',
    group: 'estatal',
    shortPrefix: /^ALSA\s*-\s*/i,
    crossBorderOnly: true,
  },
  // Long-distance and international trains that leave Catalonia (AVE, Euromed, Alvia, TGV, Ouigo, iryo…)
  {
    id: 'renfe-ld',
    name: 'Renfe — Alta Velocitat, Llarga i Mitja Distància',
    url: 'https://files.mobilitydatabase.org/mdb-2620/latest.zip',
    source: 'https://data.renfe.com/ (via Mobility Database mdb-2620)',
    group: 'ferroext', mode: 'rail', crossBorderOnly: true, nameFromStops: true,
    colors: {
      AVE: '6D2C83', AVLO: '8E44AD', 'AVE INT': '4A2366', ALVIA: '2E6DB4', EUROMED: 'C2185B', Intercity: '607D8B',
      MD: '8D6E63', REGIONAL: '8D6E63', 'REG.EXP.': 'A1887F', '*': '7E57C2',
    },
    highSpeed: (r) => /^(AVE|AVLO|AVE INT|EUROMED|ALVIA)$/i.test(r.short),
    // third level in the panel: Renfe > service brand
    service: (short) => ({
      AVE: 'AVE', 'AVE INT': 'AVE Internacional', AVLO: 'Avlo', ALVIA: 'Alvia', EUROMED: 'Euromed', Intercity: 'Intercity',
      MD: 'Media Distancia', REGIONAL: 'Regional', 'REG.EXP.': 'Regional Exprés',
    })[short] || null,
  },
  {
    id: 'ouigo',
    name: 'Ouigo España',
    url: 'https://files.mobilitydatabase.org/mdb-2785/latest.zip',
    source: 'https://nap.transportes.gob.es/ (via Mobility Database mdb-2785)',
    group: 'ferroext', mode: 'rail', crossBorderOnly: true, shortName: 'Ouigo', colors: { '*': 'D6007E' },
    highSpeed: () => true,
  },
  {
    id: 'iryo',
    name: 'iryo',
    url: 'https://files.mobilitydatabase.org/mdb-3645/latest.zip',
    source: 'https://iryo.eu (via Mobility Database mdb-3645)',
    group: 'ferroext', mode: 'rail', crossBorderOnly: true, shortName: 'iryo',
    highSpeed: () => true,
  },
];

// 'BARCELONA-SANTS -- MADRID-PUERTA DE ATOCHA' -> 'Barcelona-Sants – Madrid-Puerta de Atocha'
const prettyRouteName = (n) => (/[a-z]/.test(n) ? n : n.toLowerCase().replace(/(^|[\s(\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()))
  .replace(/\s+--\s+/g, ' – ').replace(/\b(De|Del|La|El|Les|Els|I|Y)\b/g, (w) => w.toLowerCase());

let RAIL_GRAPH = null;
async function railGraph() {
  if (!RAIL_GRAPH) {
    const osm = await overpass(RAIL_QUERY, path.join(RAW, 'osm-rail.json'), REFRESH, log, 'OSM rail network');
    RAIL_GRAPH = buildRailGraph(osm);
    log(`  rail graph: ${RAIL_GRAPH.coords.length} nodes`);
  }
  return RAIL_GRAPH;
}

// ---------- helpers ----------
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function download(url, dest) {
  log('download', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.part'));
  fs.renameSync(dest + '.part', dest);
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', (e) => { entries.set(path.basename(e.fileName), e); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function entryStream({ zip, entries }, name) {
  const e = entries.get(name);
  if (!e) return Promise.resolve(null);
  return new Promise((resolve, reject) =>
    zip.openReadStream(e, (err, s) => (err ? reject(err) : resolve(s))));
}

/** Stream a CSV file line by line. Fast path splits on commas; quoted lines use csv-parse. */
async function eachRow(feed, name, onRow) {
  const stream = await entryStream(feed, name);
  if (!stream) return false;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let n = 0;
  for await (let line of rl) {
    if (!header) {
      header = line.replace(/^﻿/, '').split(',').map((h) => h.trim());
      continue;
    }
    if (!line) continue;
    const vals = line.includes('"') ? parseCsvSync(line, { relax_quotes: true })[0] : line.split(',');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = vals[i] ?? '';
    onRow(row);
    n++;
  }
  log(`  ${name}: ${n} rows`);
  return true;
}

// Douglas-Peucker on [lon, lat] arrays, tolerance in degrees of latitude.
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const k = Math.cos((points[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[a][0] * k, ay = points[a][1];
    const bx = points[b][0] * k, by = points[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = points[i][0] * k, py = points[i][1];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (x) => Math.round(x * 1e5) / 1e5;

// ---------- road routing for lines without shapes (OSRM, cached on disk) ----------
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const CACHE_FILE = path.join(ROOT, 'data', 'cache', 'osrm-routes.json');
let osrmCache = null;
let lastOsrmCall = 0;
let osrmCalls = 0;

function loadOsrmCache() {
  if (osrmCache) return osrmCache;
  try { osrmCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { osrmCache = {}; }
  return osrmCache;
}
function saveOsrmCache() {
  if (!osrmCache) return;
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(osrmCache));
}

const haversine = (a, b) => {
  const R = 6371e3, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function osrmChunk(pts) {
  const key = pts.map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(';');
  const cache = loadOsrmCache();
  if (key in cache) return cache[key];
  // Public demo server: max 1 request / second
  const wait = lastOsrmCall + 1100 - Date.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  lastOsrmCall = Date.now();
  osrmCalls++;
  let result = null;
  try {
    const res = await fetch(`${OSRM}${key}?overview=full&geometries=geojson&continue_straight=false`, {
      headers: { 'User-Agent': 'mapa-transport-catalunya build script' },
    });
    if (res.ok) {
      const j = await res.json();
      if (j.code === 'Ok' && j.routes?.[0]) result = { d: j.routes[0].distance, c: j.routes[0].geometry.coordinates };
    } else if (res.status === 429) {
      await new Promise((r2) => setTimeout(r2, 5000));
      return osrmChunk(pts); // retry after backoff
    }
  } catch (e) {
    log('  osrm error', e.message);
    return undefined; // network problem: don't cache
  }
  cache[key] = result;
  if (osrmCalls % 20 === 0) { saveOsrmCache(); log(`  osrm: ${osrmCalls} requests`); }
  return result;
}

/** Road geometry through all stops, or null when routing looks wrong / fails. */
async function routeByRoad(pts) {
  const CHUNK = 60;
  let coords = [];
  let dist = 0;
  for (let i = 0; i < pts.length - 1; i += CHUNK - 1) {
    const part = pts.slice(i, i + CHUNK);
    if (part.length < 2) break;
    const r = await osrmChunk(part);
    if (!r) return null;
    coords = coords.length ? coords.concat(r.c.slice(1)) : r.c;
    dist += r.d;
  }
  let straight = 0;
  for (let i = 1; i < pts.length; i++) straight += haversine(pts[i - 1], pts[i]);
  // Road path should be a bit longer than stop-to-stop, not absurdly longer
  if (!coords.length || dist > straight * 2.5 + 2000) return null;
  return coords;
}

const lengthM = (l) => {
  let d = 0;
  for (let i = 1; i < l.length; i++) d += haversine(l[i - 1], l[i]);
  return d;
};

function lineLength(l) {
  let d = 0;
  for (let i = 1; i < l.length; i++) d += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return d;
}

// Distance² (degrees, lon scaled) from point p to segment ab.
function segDist2(p, a, b, k) {
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** True when ≥97% of the points of `c` lie within `tol` degrees of line `l`. */
function covered(c, l, tol) {
  const k = Math.cos((l[0][1] * Math.PI) / 180);
  const tol2 = tol * tol;
  let miss = 0;
  const allowed = Math.floor(c.length * 0.03);
  for (const p of c) {
    let ok = false;
    for (let i = 1; i < l.length && !ok; i++) if (segDist2(p, l[i - 1], l[i], k) <= tol2) ok = true;
    if (!ok && ++miss > allowed) return false;
  }
  return true;
}

function cleanName(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// ---------- main ----------
// Routes of `feed` with stops both inside and outside Catalonia, minus those whose number the ATM feed already has
async function routesCrossingCatalonia(feed, cfg, out) {
  let inside;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(RAW, 'catalunya-boundary.json'), 'utf8'));
    const mp = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    inside = (x, y) => pointInMultiPolygon(x, y, mp);
  } catch {
    inside = (x, y) => y >= 40.52 && y <= 42.86 && x >= 0.16 && x <= 3.33;
  }
  const where = new Map();
  await eachRow(feed, 'stops.txt', (s) => where.set(s.stop_id, inside(Number(s.stop_lon), Number(s.stop_lat))));
  const tripRoute = new Map();
  await eachRow(feed, 'trips.txt', (t) => tripRoute.set(t.trip_id, t.route_id));
  const seen = new Map(); // route -> bit 1 inside, 2 outside
  await eachRow(feed, 'stop_times.txt', (st) => {
    const rid = tripRoute.get(st.trip_id);
    const w = where.get(st.stop_id);
    if (rid === undefined || w === undefined) return;
    seen.set(rid, (seen.get(rid) || 0) | (w ? 1 : 2));
  });
  // only compare with lines of the same kind: a bus called "AVE" must not hide the AVE trains
  const cat = GROUPS[cfg.group].category;
  const known = new Set(out.routes.filter((r) => GROUPS[r.g].category === cat).map((r) => r.s.toLowerCase()));
  const keep = new Set();
  await eachRow(feed, 'routes.txt', (r) => {
    const short = cleanName(r.route_short_name).replace(cfg.shortPrefix || /^$/, '').toLowerCase();
    if (seen.get(r.route_id) === 3 && !(short && known.has(short))) keep.add(r.route_id);
  });
  log(`  ${cfg.id}: ${keep.size} routes cross the Catalan border`);
  return keep;
}

// Service flags read from route names: night buses (N1, N-80, "nocturn"…) and on-demand services (TAD)
const NIGHT_SHORT = /^N[-\s]?\d+[A-Z]?$/i;
const NIGHT_NAME = /nocturn|nitbus/i;
const DEMAND_NAME = /\bTAD\b|\bTd\b|a demanda/i;

async function processFeed(cfg, out) {
  const file = path.join(RAW, `${cfg.id}.zip`);
  if (REFRESH || !fs.existsSync(file)) await download(cfg.url, file);
  log('feed', cfg.id);
  const feed = await openZip(file);

  // agencies
  const agencies = new Map();
  await eachRow(feed, 'agency.txt', (r) => agencies.set(r.agency_id, cleanName(r.agency_name)));

  const keep = cfg.crossBorderOnly ? await routesCrossingCatalonia(feed, cfg, out) : null;

  // routes
  const routes = new Map();
  await eachRow(feed, 'routes.txt', (r) => {
    if (EXCLUDED_AGENCY_PREFIXES.some((p) => r.agency_id.startsWith(p))) return;
    if (keep && !keep.has(r.route_id)) return;
    const agencyName = agencies.get(r.agency_id) || r.agency_id;
    let cls = classifyRoute(r, agencyName);
    if (cls && cfg.group) {
      const company = companyOf(r.agency_id, agencyName).company;
      const mode = cfg.mode || 'bus';
      const subgroup2 = cfg.service ? cfg.service(cleanName(r.route_short_name)) : null;
      cls = { group: cfg.group, subgroup: company, subgroup2, company, mode, category: GROUPS[cfg.group].category };
    }
    if (!cls) return;
    const rawName = `${r.route_short_name || ''} ${r.route_long_name || ''} ${r.route_desc || ''}`;
    routes.set(r.route_id, {
      night: NIGHT_SHORT.test((r.route_short_name || '').trim()) || NIGHT_NAME.test(rawName),
      demand: DEMAND_NAME.test(rawName),
      wcYes: 0,
      id: `${cfg.id}:${r.route_id}`,
      short: cfg.shortName || cleanName(r.route_short_name).replace(cfg.shortPrefix || /^$/, ''),
      long: prettyRouteName(cleanName(r.route_long_name)),
      type: Number(r.route_type),
      color: (cfg.colors?.[cleanName(r.route_short_name)] || cfg.colors?.['*'] || r.route_color || '').replace('#', '').toUpperCase(),
      textColor: (r.route_text_color || '').replace('#', '').toUpperCase(),
      agency: agencyName,
      url: r.route_url || '',
      sort: Number(r.route_sort_order) || 0,
      ...cls,
      // filled later
      trips: 0,
      shapeCounts: new Map(), // `${dir}|${shape}` -> {count, trip}
      noShapeTrips: new Map(), // dir -> [trip ids]
    });
  });

  // first day each service runs (calendar with any weekday, or an added calendar_dates day) -> lines not running yet
  const serviceFirst = new Map();
  const earlier = (sid, d) => { if (d && (!serviceFirst.has(sid) || d < serviceFirst.get(sid))) serviceFirst.set(sid, d); };
  await eachRow(feed, 'calendar.txt', (c) => {
    if (['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].some((d) => c[d] === '1')) earlier(c.service_id, c.start_date);
  });
  await eachRow(feed, 'calendar_dates.txt', (c) => { if (c.exception_type === '1') earlier(c.service_id, c.date); });

  // trips
  const tripRoute = new Map();
  await eachRow(feed, 'trips.txt', (t) => {
    const r = routes.get(t.route_id);
    if (!r) return;
    r.trips++;
    const first = serviceFirst.get(t.service_id);
    if (first && (!r.firstDay || first < r.firstDay)) r.firstDay = first;
    if (t.wheelchair_accessible === '1') r.wcYes++;
    const dir = t.direction_id || '0';
    if (t.shape_id) {
      const key = `${dir}|${t.shape_id}`;
      const sc = r.shapeCounts.get(key);
      if (sc) sc.count++;
      else r.shapeCounts.set(key, { count: 1, trip: t.trip_id, shape: t.shape_id, dir });
    } else {
      const arr = r.noShapeTrips.get(dir) || [];
      if (arr.length < 5) arr.push(t.trip_id);
      r.noShapeTrips.set(dir, arr);
    }
    tripRoute.set(t.trip_id, t.route_id);
  });

  // Choose representative shapes per route/direction and trips to read stops from.
  const wantedShapes = new Set();
  const wantedTrips = new Map(); // trip -> route_id
  for (const [rid, r] of routes) {
    const byDir = new Map();
    for (const sc of r.shapeCounts.values()) {
      const arr = byDir.get(sc.dir) || [];
      arr.push(sc);
      byDir.set(sc.dir, arr);
    }
    r.shapes = [];
    for (const arr of byDir.values()) {
      arr.sort((a, b) => b.count - a.count);
      const top = arr[0].count;
      for (const sc of arr.slice(0, 4)) {
        if (sc.count < top * 0.15) break;
        r.shapes.push(sc.shape);
        wantedShapes.add(sc.shape);
        wantedTrips.set(sc.trip, rid);
      }
    }
    for (const arr of r.noShapeTrips.values()) for (const t of arr) wantedTrips.set(t, rid);
  }
  log(`  ${routes.size} routes, ${wantedShapes.size} shapes, ${wantedTrips.size} sample trips`);

  // stop_times for sample trips
  const tripStops = new Map();
  await eachRow(feed, 'stop_times.txt', (st) => {
    if (!wantedTrips.has(st.trip_id)) return;
    const arr = tripStops.get(st.trip_id) || [];
    // pickup/drop-off type 2 = must phone the agency (on-demand service)
    arr.push([Number(st.stop_sequence), st.stop_id, st.pickup_type === '2' || st.drop_off_type === '2']);
    tripStops.set(st.trip_id, arr);
  });

  // stops
  const stops = new Map();
  await eachRow(feed, 'stops.txt', (s) => {
    stops.set(s.stop_id, {
      name: cleanName(s.stop_name),
      lat: Number(s.stop_lat),
      lon: Number(s.stop_lon),
      parent: s.parent_station || '',
      type: s.location_type || '0',
    });
  });

  // ATM fare sectors ("1", "2C", "3A", "2B'"…): stop -> sector name (parents inherit from children)
  const sectorArea = new Map();
  await eachRow(feed, 'areas.txt', (a) => {
    if (/^\d[A-HZ]?'?$/.test(a.area_name)) sectorArea.set(a.area_id, a.area_name);
  });
  const stopSector = new Map();
  await eachRow(feed, 'stop_areas.txt', (sa) => {
    const sec = sectorArea.get(sa.area_id);
    if (!sec || stopSector.has(sa.stop_id)) return;
    stopSector.set(sa.stop_id, sec);
    const parent = stops.get(sa.stop_id)?.parent;
    if (parent && !stopSector.has(parent)) stopSector.set(parent, sec);
  });

  // shapes
  const shapePts = new Map();
  await eachRow(feed, 'shapes.txt', (p) => {
    if (!wantedShapes.has(p.shape_id)) return;
    const arr = shapePts.get(p.shape_id) || [];
    arr.push([Number(p.shape_pt_sequence), Number(p.shape_pt_lon), Number(p.shape_pt_lat)]);
    shapePts.set(p.shape_id, arr);
  });
  feed.zip.close();

  // Assemble
  for (const [rid, r] of routes) {
    const lines = [];
    const tol = r.category === 'rail' ? 0.00002 : 0.00008;
    const candidates = [];
    for (const sid of r.shapes) {
      const pts = shapePts.get(sid);
      if (!pts || pts.length < 2) continue;
      pts.sort((a, b) => a[0] - b[0]);
      candidates.push(simplify(pts.map((p) => [p[1], p[2]]), tol));
    }
    // Longest first; skip variants already covered by a kept shape (e.g. reverse direction).
    candidates.sort((a, b) => lineLength(b) - lineLength(a));
    for (const c of candidates) {
      if (!lines.some((l) => covered(c, l, r.category === 'rail' ? 0.0003 : 0.00025))) lines.push(c);
    }

    // stops served (ordered by the longest sample trip first)
    const stopIds = [];
    const seen = new Set();
    const sampleTrips = [...wantedTrips].filter(([, rr]) => rr === rid).map(([t]) => tripStops.get(t)).filter(Boolean);
    sampleTrips.sort((a, b) => b.length - a.length);
    const phoneStops = sampleTrips.flat().filter((x) => x[2]).length;
    if (phoneStops && phoneStops >= sampleTrips.flat().length * 0.5) r.demand = true;
    for (const st of sampleTrips) {
      st.sort((a, b) => a[0] - b[0]);
      for (const [, sid] of st) {
        const s = stops.get(sid);
        if (!s) continue;
        const key = s.parent && stops.has(s.parent) ? s.parent : sid;
        if (!seen.has(key)) { seen.add(key); stopIds.push(key); }
      }
    }
    if (!r.long && cfg.nameFromStops && sampleTrips[0]) {
      const first = stops.get(sampleTrips[0][0][1]), last = stops.get(sampleTrips[0].at(-1)[1]);
      if (first && last) r.long = prettyRouteName(`${first.name} – ${last.name}`);
    }
    // Routes without shapes: draw straight segments between stops of each sample trip.
    if (!lines.length) {
      const bestPerDir = [...r.noShapeTrips.values()].map((ts) =>
        ts.map((t) => tripStops.get(t)).filter(Boolean).sort((a, b) => b.length - a.length)[0]).filter(Boolean);
      let allRouted = true;
      for (const st of bestPerDir) {
        const pts = st.map(([, sid]) => stops.get(sid)).filter(Boolean).map((s) => [s.lon, s.lat]);
        if (pts.length < 2) continue;
        if (r.category === 'rail') {
          const g = await railGraph();
          const rail = routeByRail(g, pts, cfg.highSpeed ? cfg.highSpeed(r) : false);
          if (pts.some((p) => !insideRailBbox(p))) r.clipped = true;
          if (rail) lines.push(simplify(rail, 0.00003));
          else { allRouted = false; }
          continue;
        }
        const road = await routeByRoad(pts);
        if (road) lines.push(simplify(road, 0.00008));
        else { lines.push(pts); allRouted = false; }
      }
      if (lines.length) {
        if (r.category === 'rail') r.railRouted = true;
        else if (allRouted) r.routed = true;
        else r.approx = true;
      }
    }
    if (!lines.length) continue;

    const coords = lines.map((l) => l.map(([x, y]) => [round(x), round(y)]));
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const l of coords) for (const [x, y] of l) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const idx = out.routes.length;
    out.routes.push({
      id: r.id,
      s: r.short,
      l: r.long,
      c: r.color || null,
      tc: r.textColor || null,
      m: r.mode,
      g: r.group,
      sg: r.subgroup || null,
      sg2: r.subgroup2 || undefined,
      co: r.company || undefined,
      a: r.agency,
      u: r.url || null,
      o: r.sort,
      t: r.trips,
      b: [minX, minY, maxX, maxY],
      ap: r.approx ? 1 : undefined,
      rt: r.routed ? 1 : undefined,
      cl: r.clipped ? 1 : undefined,
      rr: r.railRouted ? 1 : undefined,
      nt: r.night ? 1 : undefined,
      dm: r.demand ? 1 : undefined,
      // wheelchair: 1 = (almost) every trip accessible, 2 = some trips
      wc: r.wcYes && r.wcYes >= r.trips * 0.9 ? 1 : r.wcYes ? 2 : undefined,
      // not running yet: first service day (YYYYMMDD) is after the build day
      ns: r.firstDay && r.firstDay > TODAY ? r.firstDay : undefined,
      st: stopIds.map((sid) => {
        const key = `${cfg.id}:${sid}`;
        if (!out.stopIndex.has(key)) {
          const s = stops.get(sid);
          out.stopIndex.set(key, { i: out.stops.length });
          out.stops.push({ id: key, n: s.name, x: round(s.lon), y: round(s.lat), r: [], z: stopSector.get(sid) });
        }
        const so = out.stops[out.stopIndex.get(key).i];
        so.r.push(idx);
        return out.stopIndex.get(key).i;
      }),
    });
    out.features.push({
      type: 'Feature',
      id: idx,
      properties: {
        i: idx, m: r.mode, c: '#' + (r.color || GROUPS[r.group].color.replace('#', '')), s: r.short,
        ...(r.approx ? { ap: 1 } : {}),
      },
      geometry: coords.length === 1
        ? { type: 'LineString', coordinates: coords[0] }
        : { type: 'MultiLineString', coordinates: coords },
    });
  }
}

// The ATM feed sometimes carries the same bus line twice (Generalitat feed + operator feed).
// Drop a route when another one of the same company has the same number and covers the same area.
function dedupe(out) {
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    const area = (r) => Math.max((r[2] - r[0]) * (r[3] - r[1]), 1e-9);
    return inter / (area(a) + area(b) - inter);
  };
  const score = (r) => (r.ap ? 0 : 1e9) + r.st.length * 1e5 + r.t;
  const byKey = new Map();
  out.routes.forEach((r, i) => {
    if (r.g === 'ferroext' && r.l) {
      const ends = r.l.split(' – ').map((x) => x.toLowerCase()).sort().join('|');
      const k = `ext|${r.s}|${ends}`;
      (byKey.get(k) || byKey.set(k, []).get(k)).push(i);
      return;
    }
    if (GROUPS[r.g].category !== 'bus' || !r.co || !r.s) return;
    const k = `${r.co}|${r.s.toLowerCase().replace(/[\s.-]/g, '')}`;
    (byKey.get(k) || byKey.set(k, []).get(k)).push(i);
  });
  const drop = new Set();
  for (const ids of byKey.values()) {
    ids.sort((a, b) => score(out.routes[b]) - score(out.routes[a]));
    for (let x = 0; x < ids.length; x++) {
      if (drop.has(ids[x])) continue;
      for (let y = x + 1; y < ids.length; y++) {
        if (!drop.has(ids[y]) && iou(out.routes[ids[x]].b, out.routes[ids[y]].b) > 0.5) {
          drop.add(ids[y]);
          // keep what the dropped copy knew (one feed may flag accessibility / on-demand, the other not)
          const keep = out.routes[ids[x]], gone = out.routes[ids[y]];
          keep.nt ||= gone.nt;
          keep.dm ||= gone.dm;
          if (gone.wc && (!keep.wc || gone.wc < keep.wc)) keep.wc = gone.wc;
          keep.ns = keep.ns && gone.ns ? (keep.ns < gone.ns ? keep.ns : gone.ns) : undefined; // either copy running = running
        }
      }
    }
  }
  if (!drop.size) return;

  const newIdx = new Int32Array(out.routes.length).fill(-1);
  const routes = [];
  out.routes.forEach((r, i) => { if (!drop.has(i)) { newIdx[i] = routes.length; routes.push(r); } });
  const features = out.features.filter((_, i) => !drop.has(i));
  features.forEach((f, i) => { f.id = i; f.properties.i = i; });

  const stopIdx = new Int32Array(out.stops.length).fill(-1);
  const stops = [];
  out.stops.forEach((s, i) => {
    s.r = s.r.filter((ri) => !drop.has(ri)).map((ri) => newIdx[ri]);
    if (s.r.length) { stopIdx[i] = stops.length; stops.push(s); }
  });
  for (const r of routes) r.st = r.st.map((si) => stopIdx[si]).filter((si) => si >= 0);

  log(`dedupe: dropped ${drop.size} duplicate routes`);
  out.routes = routes;
  out.features = features;
  out.stops = stops;
}

// Planned / under-construction lines (OpenStreetMap) appended as routes of the "planned" category.
async function addPlanned(out) {
  let osm;
  try {
    osm = await fetchPlanned(path.join(RAW, 'osm-planned.json'), REFRESH, log);
  } catch (e) {
    log('planned lines skipped:', e.message);
    return;
  }
  const colorByRef = new Map();
  for (const r of out.routes) {
    if (['metro', 'fgc', 'tram', 'rodalies'].includes(r.g) && r.c && !colorByRef.has(r.s)) colorByRef.set(r.s, r.c);
  }
  const defaults = { subway: 'E2001A', tram: '008C7A', rail: '7A1E99' };
  const projects = buildProjects(osm);
  // Unnamed projects: describe them by the nearest rail / tram station
  const railStops = out.stops.filter((st) => st.r.some((ri) => GROUPS[out.routes[ri].g].category === 'rail'));
  for (const p of projects) {
    if (!p.unnamed) continue;
    const l = p.coords[0];
    const [cx, cy] = l[Math.floor(l.length / 2)];
    let best = null, bd = Infinity;
    for (const st of railStops) {
      const d = (st.x - cx) ** 2 + (st.y - cy) ** 2;
      if (d < bd) { bd = d; best = st; }
    }
    if (best) p.name = p.name.replace('(sense nom)', `(prop de ${best.n})`);
  }
  projects.sort((a, b) => a.name.localeCompare(b.name, 'ca'));
  for (const p of projects) {
    const ref = p.ref || refFromName(p.name);
    const short = ref || (/orbital/i.test(p.name) ? 'LOF' : { subway: 'Metro', tram: 'Tram', rail: 'Tren' }[p.mode]);
    const r0 = ref?.split('/')[0];
    const color = (r0 && (colorByRef.get(r0) || [...colorByRef].find(([k]) => k.startsWith(r0) && /^[NS]?$/.test(k.slice(r0.length)))?.[1]))
      || defaults[p.mode];
    const lines = p.coords.map((l) => simplify(l, 0.00002).map(([x, y]) => [round(x), round(y)]));
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const l of lines) for (const [x, y] of l) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const idx = out.routes.length;
    out.routes.push({
      id: `osm:${p.key}`,
      s: short,
      l: p.name,
      c: color,
      tc: null,
      m: 'plan',
      pm: p.mode,
      g: p.status === 'construction' ? 'construccio' : 'projecte',
      sg: PLANNED_MODE_LABEL[p.mode],
      a: p.operator || 'OpenStreetMap',
      u: p.source || `https://www.openstreetmap.org/way/${p.osm}`,
      osm: p.osm,
      od: p.opening || undefined,
      km: Math.round(p.length / 100) / 10,
      o: 0,
      t: 0,
      b: [minX, minY, maxX, maxY],
      st: [],
    });
    out.features.push({
      type: 'Feature',
      id: idx,
      properties: { i: idx, m: 'plan', c: '#' + color, s: short, ps: p.status === 'construction' ? 'c' : 'p' },
      geometry: { type: 'MultiLineString', coordinates: lines },
    });
  }
  log(`planned: ${projects.length} projects`);
}

// ---------- ATM fare zones by municipality (ICGC municipal boundaries) ----------
const ICGC_MUNIS = 'https://datacloud.icgc.cat/datacloud/divisions-administratives/json_unzip/divisions-administratives-v2r2-municipis-250000-20260120.json';

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInMultiPolygon = (x, y, mp) =>
  mp.some((poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, y, h)));

async function loadMunicipalities() {
  const dir = path.join(RAW, 'icgc');
  const file = path.join(dir, 'municipis-250000.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    await download(ICGC_MUNIS, file);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).features.map((f) => {
    const mp = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let b = [180, 90, -180, -90];
    for (const [x, y] of mp.flat(2)) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    return {
      code: f.properties.CODIMUNI, name: f.properties.NOMMUNI, comarca: f.properties.NOMCOMAR,
      vegueria: f.properties.NOMVEGUE, vcode: f.properties.CODIVEGUE,
      ccode: f.properties.CODICOMAR, pcode: f.properties.CODIPROV, provincia: f.properties.NOMPROV, mp, b,
    };
  });
}

let MUNICIPALITIES = null;

async function writeZones(out) {
  MUNICIPALITIES ||= await loadMunicipalities();
  // votes: municipality -> sector -> count
  const votes = new Map();
  for (const s of out.stops) {
    if (!s.z) continue;
    const m = MUNICIPALITIES.find((mu) => s.x >= mu.b[0] && s.x <= mu.b[2] && s.y >= mu.b[1] && s.y <= mu.b[3] && pointInMultiPolygon(s.x, s.y, mu.mp));
    if (!m) continue;
    const v = votes.get(m) || new Map();
    v.set(s.z, (v.get(s.z) || 0) + 1);
    votes.set(m, v);
  }
  const features = [];
  const bySector = new Map();
  for (const [m, v] of votes) {
    const [sector, n] = [...v.entries()].sort((a, b) => b[1] - a[1])[0];
    const zone = Number(sector[0]);
    const geom = m.mp
      .map((poly) => poly.map((ring) => simplify(ring, 0.0004).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])))
      .filter((poly) => poly[0].length >= 4);
    features.push({ type: 'Feature', properties: { k: 'm', n: m.name, c: m.comarca, z: zone, s: sector }, geometry: { type: 'MultiPolygon', coordinates: geom } });
    const best = bySector.get(sector);
    if (!best || n > best.n) bySector.set(sector, { n, m, zone });
  }
  // one label per sector, at the bbox centre of its busiest municipality
  for (const [sector, { m, zone }] of bySector) {
    features.push({
      type: 'Feature',
      properties: { k: 'l', z: zone, s: sector },
      geometry: { type: 'Point', coordinates: [round((m.b[0] + m.b[2]) / 2), round((m.b[1] + m.b[3]) / 2)] },
    });
  }
  fs.writeFileSync(path.join(OUT, 'zones.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  log(`zones: ${votes.size} municipalities in ${bySector.size} sectors,`, (fs.statSync(path.join(OUT, 'zones.geojson')).size / 1e3).toFixed(0), 'kB');
}

// ---------- municipalities and comarques served by each line (for the place filter) ----------
async function assignMunicipalities(out) {
  MUNICIPALITIES ||= await loadMunicipalities();
  const stopMuni = out.stops.map((s) => MUNICIPALITIES.findIndex((mu) =>
    s.x >= mu.b[0] && s.x <= mu.b[2] && s.y >= mu.b[1] && s.y <= mu.b[3] && pointInMultiPolygon(s.x, s.y, mu.mp)));
  const comarques = [...new Set(MUNICIPALITIES.map((m) => m.comarca))].sort((a, b) => a.localeCompare(b, 'ca'));
  const munis = MUNICIPALITIES.map((m) => ({ n: m.name, c: comarques.indexOf(m.comarca), b: m.b.map(round) }));
  for (const r of out.routes) {
    const set = new Set((r.st || []).map((si) => stopMuni[si]).filter((m) => m >= 0));
    for (const [, x, y] of r.ast || []) { // announced lines: their planned stops
      const m = MUNICIPALITIES.findIndex((mu) => x >= mu.b[0] && x <= mu.b[2] && y >= mu.b[1] && y <= mu.b[3] && pointInMultiPolygon(x, y, mu.mp));
      if (m >= 0) set.add(m);
    }
    if (set.size) r.mu = [...set].sort((a, b) => a - b);
  }
  out.stops.forEach((s, i) => { if (stopMuni[i] >= 0) s.mu = stopMuni[i]; });
  log(`places: ${out.routes.filter((r) => r.mu).length} routes in ${munis.length} municipalities / ${comarques.length} comarques`);
  return { munis, comarques };
}

// ---------- main stations and interchanges (OSM + our lines) ----------
async function writeStations(out) {
  let osm;
  try {
    osm = await overpass(STATIONS_QUERY, path.join(RAW, 'osm-stations.json'), REFRESH, log, 'OSM stations');
  } catch (e) {
    log('stations skipped:', e.message);
    return;
  }
  const features = buildStations(osm, out, GROUPS);
  fs.writeFileSync(path.join(OUT, 'stations.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  const byType = {};
  for (const f of features) byType[f.properties.t] = (byType[f.properties.t] || 0) + 1;
  log('stations:', features.length, byType, (fs.statSync(path.join(OUT, 'stations.geojson')).size / 1e3).toFixed(0), 'kB');
}

// ---------- vegueries (dissolved from ICGC municipalities) ----------
const VEGUERIA_NAMES = { "Val d'Aran (entitat territorial singular)": "Val d'Aran", 'Alt Pirineu': 'Alt Pirineu' };

/** Chains undirected edges [{a, b}] into polylines (closed rings come back closed). */
function chainEdges(list, key) {
  const adj = new Map();
  for (const e of list) for (const [p, q] of [[e.a, e.b], [e.b, e.a]]) (adj.get(key(p)) || adj.set(key(p), []).get(key(p))).push({ e, to: q });
  const used = new Set();
  const chains = [];
  for (const e of list) {
    if (used.has(e)) continue;
    used.add(e);
    const chain = [e.a, e.b];
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip = atEnd ? chain.at(-1) : chain[0];
        const next = (adj.get(key(tip)) || []).find((x) => !used.has(x.e));
        if (!next) break;
        used.add(next.e);
        if (atEnd) chain.push(next.to); else chain.unshift(next.to);
      }
    }
    chains.push(chain);
  }
  return chains;
}

function ringArea(r) {
  let a = 0;
  for (let i = 1; i < r.length; i++) a += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1];
  return a / 2;
}
function ringCentroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 1; i < r.length; i++) {
    const f = r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1];
    a += f; cx += (r[i - 1][0] + r[i][0]) * f; cy += (r[i - 1][1] + r[i][1]) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Dissolves ICGC municipalities into a territorial division (vegueria, comarca, província…):
 * one MultiPolygon + label point per unit, plus the borders between units.
 */
async function writeDivision(file, codeOf, nameOf) {
  MUNICIPALITIES ||= await loadMunicipalities();
  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  // edge -> how many times each unit uses it
  const edges = new Map();
  for (const m of MUNICIPALITIES) for (const poly of m.mp) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      const a = key(ring[i - 1]), b = key(ring[i]);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(k) || edges.set(k, { a: ring[i - 1], b: ring[i], v: new Map() }).get(k);
      e.v.set(codeOf(m), (e.v.get(codeOf(m)) || 0) + 1);
    }
  }
  const names = new Map(MUNICIPALITIES.map((m) => [codeOf(m), nameOf(m)]));
  const features = [];
  // 1. each unit: edges used once inside it -> closed rings -> polygons
  for (const [code, name] of names) {
    const own = [...edges.values()].filter((e) => e.v.get(code) === 1);
    const rings = chainEdges(own, key)
      .filter((c) => c.length >= 4 && key(c[0]) === key(c.at(-1)))
      .map((c) => simplify(c, 0.0004).map(([x, y]) => [round(x), round(y)]))
      .filter((c) => c.length >= 4);
    if (!rings.length) continue;
    rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
    features.push({ type: 'Feature', properties: { k: 'v', c: code, n: name }, geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) } });
    features.push({ type: 'Feature', properties: { k: 'l', c: code, n: name }, geometry: { type: 'Point', coordinates: ringCentroid(rings[0]).map(round) } });
  }
  // 2. borders between two units
  const inner = [...edges.values()].filter((e) => e.v.size === 2);
  const borders = chainEdges(inner, key).map((c) => simplify(c, 0.0004).map(([x, y]) => [round(x), round(y)]));
  features.push({ type: 'Feature', properties: { k: 'b' }, geometry: { type: 'MultiLineString', coordinates: borders } });
  fs.writeFileSync(path.join(OUT, file), JSON.stringify({ type: 'FeatureCollection', features }));
  log(`${file}: ${names.size} units,`, (fs.statSync(path.join(OUT, file)).size / 1e3).toFixed(0), 'kB');
}

// ---------- Àrea Metropolitana de Barcelona (36 municipalities) ----------
const AMB_MUNICIPALITIES = ['Badalona', 'Badia del Vallès', 'Barberà del Vallès', 'Barcelona', 'Begues', 'Castellbisbal',
  'Castelldefels', 'Cerdanyola del Vallès', 'Cervelló', 'Corbera de Llobregat', 'Cornellà de Llobregat',
  'Esplugues de Llobregat', 'Gavà', "l'Hospitalet de Llobregat", 'Molins de Rei', 'Montcada i Reixac', 'Montgat', 'Pallejà',
  'la Palma de Cervelló', 'el Papiol', 'el Prat de Llobregat', 'Ripollet', 'Sant Adrià de Besòs', 'Sant Andreu de la Barca',
  'Sant Boi de Llobregat', 'Sant Climent de Llobregat', 'Sant Cugat del Vallès', 'Sant Feliu de Llobregat', 'Sant Joan Despí',
  'Sant Just Desvern', 'Sant Vicenç dels Horts', 'Santa Coloma de Cervelló', 'Santa Coloma de Gramenet', 'Tiana',
  'Torrelles de Llobregat', 'Viladecans'];

async function writeAmb() {
  MUNICIPALITIES ||= await loadMunicipalities();
  const munis = MUNICIPALITIES.filter((m) => AMB_MUNICIPALITIES.includes(m.name));
  if (munis.length !== AMB_MUNICIPALITIES.length) log(`  AMB: only ${munis.length} of ${AMB_MUNICIPALITIES.length} municipalities found`);

  // Outer perimeter: keep edges used by exactly one municipality, then chain them into lines
  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const edges = new Map();
  for (const m of munis) for (const poly of m.mp) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      const a = key(ring[i - 1]), b = key(ring[i]);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(k);
      if (e) e.n++;
      else edges.set(k, { n: 1, a: ring[i - 1], b: ring[i] });
    }
  }
  const adj = new Map();
  // land border only: edges also used by a municipality outside the AMB (coastline edges have no neighbour)
  const outside = new Set();
  for (const m of MUNICIPALITIES) {
    if (munis.includes(m)) continue;
    if (m.b[0] > 2.4 || m.b[2] < 1.7 || m.b[1] > 41.7 || m.b[3] < 41.1) continue; // far away
    for (const poly of m.mp) for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const x = key(ring[i - 1]), y = key(ring[i]);
        outside.add(x < y ? `${x}|${y}` : `${y}|${x}`);
      }
    }
  }
  const outer = [...edges.entries()].filter(([k, e]) => e.n === 1 && outside.has(k)).map(([, e]) => e);
  for (const e of outer) {
    for (const [p, q] of [[e.a, e.b], [e.b, e.a]]) (adj.get(key(p)) || adj.set(key(p), []).get(key(p))).push({ e, to: q });
  }
  const used = new Set();
  const chains = [];
  for (const e of outer) {
    if (used.has(e)) continue;
    used.add(e);
    const chain = [e.a, e.b];
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip = atEnd ? chain.at(-1) : chain[0];
        const next = (adj.get(key(tip)) || []).find((x) => !used.has(x.e));
        if (!next) break;
        used.add(next.e);
        if (atEnd) chain.push(next.to); else chain.unshift(next.to);
      }
    }
    // skip tiny closed bits (piers, breakwaters) under 1 km
    if (lengthM(chain) >= 1000) chains.push(simplify(chain, 0.00015).map(([x, y]) => [round(x), round(y)]));
  }

  const features = [
    { type: 'Feature', properties: { k: 'border' }, geometry: { type: 'MultiLineString', coordinates: chains } },
    ...munis.map((m) => ({
      type: 'Feature',
      properties: { k: 'm', n: m.name, c: m.comarca },
      geometry: {
        type: 'MultiPolygon',
        coordinates: m.mp.map((poly) => poly.map((ring) => simplify(ring, 0.0003).map(([x, y]) => [round(x), round(y)])))
          .filter((poly) => poly[0].length >= 4),
      },
    })),
  ];
  fs.writeFileSync(path.join(OUT, 'amb.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  log(`amb: ${munis.length} municipalities, perimeter in ${chains.length} part(s),`, (fs.statSync(path.join(OUT, 'amb.geojson')).size / 1e3).toFixed(0), 'kB');
}

// Catalonia outline (OSM relation 349053 via Nominatim, already simplified) -> border + outside mask.
async function writeBoundary() {
  const cache = path.join(RAW, 'catalunya-boundary.json');
  if (REFRESH || !fs.existsSync(cache)) {
    log('download Catalonia boundary (Nominatim)');
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/details?osmtype=R&osmid=349053&polygon_geojson=1&format=json', {
        headers: { 'User-Agent': 'MapaTransportCatalunya/0.1 (personal open-data viewer; low volume)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!/Polygon/.test(j.geometry?.type)) throw new Error('no polygon');
      fs.writeFileSync(cache, JSON.stringify(j.geometry));
    } catch (e) {
      log('  boundary download failed:', e.message);
      if (!fs.existsSync(cache)) return;
    }
  }
  const geom = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates)
    .map((poly) => poly.map((ring) => {
      const simp = simplify(ring, 0.0003).map(([x, y]) => [round(x), round(y)]);
      return simp.length >= 4 ? simp : ring.map(([x, y]) => [round(x), round(y)]);
    }));
  const world = [[-30, 25], [30, 25], [30, 60], [-30, 60], [-30, 25]];
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { kind: 'mask' }, geometry: { type: 'Polygon', coordinates: [world, ...polys.map((p) => p[0])] } },
      { type: 'Feature', properties: { kind: 'border' }, geometry: { type: 'MultiPolygon', coordinates: polys } },
    ],
  };
  fs.writeFileSync(path.join(OUT, 'catalunya.geojson'), JSON.stringify(fc));
  log('catalunya.geojson', (fs.statSync(path.join(OUT, 'catalunya.geojson')).size / 1e3).toFixed(0), 'kB');
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const out = { routes: [], features: [], stops: [], stopIndex: new Map() };
  for (const cfg of FEEDS) await processFeed(cfg, out);
  saveOsrmCache();
  dedupe(out);
  markNewRoutes(out, path.join(ROOT, 'data', 'seen-routes.json'), log);
  await addPlanned(out);
  await addAnnounced(out, path.join(ROOT, 'data', 'announced.json'), { routeByRoad, simplify, round, log });
  saveOsrmCache();
  await writeBoundary();
  await writeZones(out);
  await writeAmb();
  await writeDivision('vegueries.geojson', (m) => m.vcode, (m) => VEGUERIA_NAMES[m.vegueria] || m.vegueria);
  await writeDivision('comarques.geojson', (m) => m.ccode, (m) => m.comarca);
  await writeDivision('provincies.geojson', (m) => m.pcode, (m) => m.provincia);
  await writeStations(out);
  const places = await assignMunicipalities(out);

  const index = {
    generated: new Date().toISOString(),
    sources: FEEDS.map(({ id, name, source }) => ({ id, name, source })),
    groups: GROUPS,
    places,
    routes: out.routes,
    stops: out.stops.map((s) => ({ n: s.n, x: s.x, y: s.y, r: s.r, ...(s.z ? { z: s.z } : {}) })),
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(OUT, 'lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: out.features }));
  const stopsGeo = {
    type: 'FeatureCollection',
    features: out.stops.map((s, i) => ({
      type: 'Feature',
      id: i,
      properties: { i, n: s.n, k: Math.min(...s.r.map((ri) => GROUPS[out.routes[ri].g].rank)) },
      geometry: { type: 'Point', coordinates: [s.x, s.y] },
    })),
  };
  fs.writeFileSync(path.join(OUT, 'stops.geojson'), JSON.stringify(stopsGeo));

  const counts = {};
  for (const r of out.routes) counts[r.g] = (counts[r.g] || 0) + 1;
  log('routes per group', counts);
  for (const f of ['index.json', 'lines.geojson', 'stops.geojson']) {
    log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), 'MB');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
