// What's new: lines seen for the first time in the GTFS feeds, and bus lines announced but not in open data yet.
import fs from 'node:fs';

const NEW_DAYS = 60; // a line counts as "new" for two months after it first shows up

const isoDay = (d) => d.toISOString().slice(0, 10);
const keyOf = (r) => `${r.g}|${(r.co || r.a || '').toLowerCase()}|${(r.s || '').toLowerCase().replace(/[\s.-]/g, '')}`;

/**
 * Registry of every line ever seen ({ baseline, routes: { key: 'YYYY-MM-DD' } }), kept in the repo and updated by
 * each build. Lines first seen after the baseline (the day the registry started) are flagged `nw` for NEW_DAYS.
 */
export function markNewRoutes(out, file, log) {
  const today = isoDay(new Date());
  const reg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { baseline: today, routes: {} };
  const limit = isoDay(new Date(Date.now() - NEW_DAYS * 864e5));
  let added = 0, flagged = 0;
  for (const r of out.routes) {
    if (r.m === 'plan') continue;
    const k = keyOf(r);
    if (!reg.routes[k]) { reg.routes[k] = today; added++; }
    const seen = reg.routes[k];
    if (seen > reg.baseline && seen >= limit) { r.nw = seen.replace(/-/g, ''); flagged++; }
  }
  if (added) {
    reg.routes = Object.fromEntries(Object.entries(reg.routes).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(file, JSON.stringify(reg, null, 0).replace(/,"/g, ',\n"'));
  }
  log(`new lines: ${added} first seen today, ${flagged} flagged as new (registry since ${reg.baseline})`);
}

const haversine = (a, b) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
};

/**
 * Announced bus lines (data/announced.json) drawn by road as "planned" routes. An announcement is dropped once a GTFS
 * line with the same short name serves both of its ends.
 */
export async function addAnnounced(out, file, { routeByRoad, simplify, round, log }) {
  if (!fs.existsSync(file)) return;
  const { lines } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const STATUS = { servei: 'Ja en servei', anunciat: 'Data anunciada', previst: 'Previst' };
  let n = 0;
  for (const a of lines) {
    const pts = a.points.map(([, x, y]) => [x, y]);
    const ends = [pts[0], pts.at(-1)];
    if (a.match) {
      const near = (si, p) => { const s = out.stops[si]; return haversine([s.x, s.y], p) < 1500; };
      const want = a.match.near ? [a.match.near] : ends;
      const live = out.routes.find((r) => r.m !== 'plan' && r.s?.toLowerCase() === a.match.s.toLowerCase()
        && want.every((p) => r.st.some((si) => near(si, p))));
      if (live) { log(`announced ${a.id}: now in GTFS (${live.id}), skipped`); continue; }
    }
    let line = await routeByRoad(pts);
    if (!line) { log(`announced ${a.id}: no road route, straight segments`); line = pts; }
    const coords = simplify(line, 0.00008).map(([x, y]) => [round(x), round(y)]);
    let b = [180, 90, -180, -90];
    for (const [x, y] of coords) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    const color = (a.color || 'E65100').replace('#', '');
    const idx = out.routes.length;
    let km = 0;
    for (let i = 1; i < line.length; i++) km += haversine(line[i - 1], line[i]);
    out.routes.push({
      id: `ann:${a.id}`,
      s: a.s,
      l: a.l,
      c: color,
      tc: null,
      m: 'plan',
      pm: 'bus',
      g: 'anunciat',
      sg: STATUS[a.status] || 'Previst',
      a: a.operator || 'Per determinar',
      u: a.source,
      un: a.sourceName,
      od: a.dateText || a.date,
      as: a.status,
      ax: a.approx ? 1 : undefined,
      nt2: a.note,
      ast: a.points.filter(([name]) => !name.startsWith('~')).map(([name, x, y]) => [name, x, y]),
      km: Math.round(km / 100) / 10,
      o: 0,
      t: 0,
      b,
      st: [],
    });
    out.features.push({
      type: 'Feature',
      id: idx,
      properties: { i: idx, m: 'plan', c: '#' + color, s: a.s, ps: a.status === 'servei' ? 'c' : 'p' },
      geometry: { type: 'LineString', coordinates: coords },
    });
    n++;
  }
  log(`announced: ${n} bus lines`);
}
