// Planned / under-construction rail lines in Catalonia, from OpenStreetMap (Overpass API).
// OSM tags used: railway=construction|proposed + construction=*/proposed=* (subway, tram, rail, light_rail…)
import fs from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MIRRORS = ['https://overpass.private.coffee/api/interpreter'];
const QUERY = `[out:json][timeout:180];
area["ISO3166-2"="ES-CT"]->.cat;
way["railway"~"^(construction|proposed)$"](area.cat);
out tags geom;`;

const EXCLUDE_NAME = /mercader|apartador|capacitat de l'estaci/i;
const MODES = { subway: 'subway', light_rail: 'tram', tram: 'tram', rail: 'rail', railway: 'rail', narrow_gauge: 'rail' };
export const PLANNED_MODE_LABEL = { subway: 'Metro', tram: 'Tramvia', rail: 'Ferrocarril' };

const TRAMCAMP = 'TramCamp · Fase 1 (Cambrils – Salou – Vila-seca)';

// Names for projects whose ways carry no name, keyed by a test on the `source` tag / position.
const UNNAMED_PROJECTS = [
  { test: (t) => /connexio-trambaix/.test(t.source || ''), name: 'Connexió Trambaix – Trambesòs per la Diagonal' },
  { test: (t, [x, y]) => MODES[t.proposed || t.construction] === 'tram' && y < 41.25 && x < 1.5, name: TRAMCAMP },
];

// Renames for named ways that belong to one project under different names.

// Facts OSM does not carry (or carries only partially), checked against official sources.
// The TramCamp phase 1 is under construction (only a couple of OSM ways say so; the rest still say "proposed").
// Phase 2 (Vila-seca – Tarragona / Reus / airport) has no published alignment, so it can't be drawn.
const PROJECT_INFO = {
  [TRAMCAMP]: {
    status: 'construction', ref: 'TramCamp', operator: 'Ferrocarrils de la Generalitat de Catalunya', opening: '2029',
    source: 'https://govern.cat/govern/docs/2024/09/04/19/16/519e6035-0d53-493f-ab86-f0c21cbf3d4c.pdf',
  },
};

const NAME_ALIASES = [
  { re: /barcelona\s*-\s*val[eè]ncia/i, mode: 'tram', name: TRAMCAMP },
  { re: /montcada bifurcaci|l[ií]nia barcelona-ripoll/i, mode: 'rail', name: 'R3 · Desdoblament Montcada – Vic', ref: 'R3' },
];

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameKey = (n) => [...new Set(strip(n).replace(/[.:,;|()–-]/g, ' ').split(/\s+/).filter(Boolean))].sort().join(' ');

function bbox(lines) {
  let b = [180, 90, -180, -90];
  for (const l of lines) for (const [x, y] of l) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
}
function overlap(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const ar = (r) => Math.max((r[2] - r[0]) * (r[3] - r[1]), 1e-10);
  return (ix * iy) / Math.min(ar(a), ar(b));
}

function lengthM(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
    const k = Math.cos((y1 * Math.PI) / 180);
    d += Math.hypot((x2 - x1) * k, y2 - y1) * 111320;
  }
  return d;
}

/** POST an Overpass query (with retries and a mirror); caches the JSON answer in `cacheFile`. */
export async function overpass(query, cacheFile, refresh, log, label = 'OSM data') {
  if (!refresh && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  let lastErr;
  for (const [i, url] of [OVERPASS, ...MIRRORS, OVERPASS].entries()) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    log(`download ${label}`, url);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'mapa-transport-catalunya build script' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      fs.writeFileSync(cacheFile, JSON.stringify(json));
      return json;
    } catch (e) {
      lastErr = e;
      log('  overpass failed:', e.message);
    }
  }
  // Fall back to an older download when every server fails
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  throw lastErr;
}

export const fetchPlanned = (cacheFile, refresh, log) => overpass(QUERY, cacheFile, refresh, log, 'OSM planned lines');

/**
 * Groups OSM ways into projects.
 * @returns [{ key, name, status: 'construction'|'proposed', mode, coords: [[x,y]…][], operator, source, opening, osm }]
 */
export function buildProjects(osm) {
  const groups = new Map();
  const unnamed = [];
  for (const w of osm.elements) {
    if (w.type !== 'way' || !w.geometry || w.geometry.length < 2) continue;
    const t = w.tags || {};
    const status = t.railway; // construction | proposed
    const mode = MODES[t[status] || t[`${status}:railway`]];
    if (!mode) continue; // platforms, stations, untyped
    let name = t['name:ca'] || t.name;
    if (name && EXCLUDE_NAME.test(name)) continue;
    const alias = name && NAME_ALIASES.find((a) => a.mode === mode && a.re.test(name));
    if (alias) name = alias.name;
    const coords = w.geometry.map((p) => [p.lon, p.lat]);
    const item = { w, t, status, mode, coords };
    if (name) {
      const key = `${mode}|${nameKey(name)}`;
      const g = groups.get(key) || { key, names: new Map(), items: [] };
      g.names.set(name, (g.names.get(name) || 0) + 1);
      g.items.push(item);
      groups.set(key, g);
    } else {
      const known = UNNAMED_PROJECTS.find((p) => p.test(t, coords[0]));
      if (known) {
        const key = `${mode}|${nameKey(known.name)}`;
        const g = groups.get(key) || { key, names: new Map([[known.name, 1]]), items: [] };
        g.items.push(item);
        groups.set(key, g);
      } else unnamed.push(item);
    }
  }

  // Unnamed subway/tram ways: connected components by shared end points, kept if long enough.
  const comp = [];
  const byEnd = new Map();
  const ek = ([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`;
  unnamed.forEach((it, i) => {
    for (const p of [it.coords[0], it.coords[it.coords.length - 1]]) {
      const k = ek(p);
      (byEnd.get(k) || byEnd.set(k, []).get(k)).push(i);
    }
  });
  const seen = new Set();
  unnamed.forEach((it, i) => {
    if (seen.has(i) || it.mode === 'rail') return; // unnamed rail = mostly sidings / works
    const stack = [i];
    const items = [];
    seen.add(i);
    while (stack.length) {
      const j = stack.pop();
      items.push(unnamed[j]);
      for (const p of [unnamed[j].coords[0], unnamed[j].coords.at(-1)]) {
        for (const n of byEnd.get(ek(p)) || []) {
          if (!seen.has(n) && unnamed[n].mode === it.mode && unnamed[n].status === it.status) { seen.add(n); stack.push(n); }
        }
      }
    }
    if (items.reduce((a, x) => a + lengthM(x.coords), 0) < 300) return;
    const label = `${PLANNED_MODE_LABEL[it.mode]} ${it.status === 'construction' ? 'en construcció' : 'projectat'} (sense nom)`;
    // parallel tracks of the same project come as separate components: merge overlapping ones
    const bb = bbox(items.map((x) => x.coords));
    const twin = comp.find((c) => c.mode === it.mode && c.status === it.status && overlap(c.bb, bb) > 0.3);
    if (twin) { twin.items.push(...items); twin.bb = bbox(twin.items.map((x) => x.coords)); return; }
    comp.push({ key: `${it.mode}|unnamed|${items[0].w.id}`, names: new Map([[label, 1]]), items, mode: it.mode, status: it.status, bb });
  });

  return [...groups.values(), ...comp].map((g) => {
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const nCons = g.items.filter((x) => x.status === 'construction').length;
    const pick = (k) => g.items.map((x) => x.t[k]).find(Boolean) || null;
    return {
      key: g.key,
      name,
      ref: PROJECT_INFO[name]?.ref || NAME_ALIASES.find((a) => a.name === name)?.ref || null,
      unnamed: name.endsWith('(sense nom)'),
      status: PROJECT_INFO[name]?.status || (nCons * 2 >= g.items.length ? 'construction' : 'proposed'),
      mode: g.items[0].mode,
      coords: g.items.map((x) => x.coords),
      operator: PROJECT_INFO[name]?.operator || pick('operator'),
      source: PROJECT_INFO[name]?.source || (pick('source')?.startsWith('http') ? pick('source') : null),
      opening: PROJECT_INFO[name]?.opening || pick('opening_date'),
      osm: g.items[0].w.id,
      length: g.items.reduce((a, x) => a + lengthM(x.coords), 0),
    };
  }).filter((p) => p.length >= 150);
}

/** Line reference mentioned in a project name, e.g. "Metro L9/L10 …" -> "L9/L10". */
export function refFromName(name) {
  const m = name.match(/\b([LTSR]\d{1,2}[NS]?)(\/[LTSR]?\d{1,2})?\b/);
  return m ? m[0] : null;
}
