// Main stations and interchanges: rail stations and bus stations from OpenStreetMap, enriched with the lines
// of our own GTFS data that stop nearby, then ranked so the most important ones show first.

export const STATIONS_QUERY = `[out:json][timeout:180];
area["ISO3166-2"="ES-CT"]->.cat;
(
  nwr["railway"="station"](area.cat);
  nwr["amenity"="bus_station"](area.cat);
  nwr["public_transport"="station"]["bus"="yes"](area.cat);
);
out center tags;`;

const R = 6371e3;
const dist = (a, b) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * (Math.PI / 180) * R;
};
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// "Estació d'Autobusos Barcelona Fabra i Puig", "Barcelona-Fabra i Puig" -> "fabra i puig"
const core = (n) => strip(n)
  .replace(/[-–|·,.()']/g, ' ')
  .replace(/\b(estacio|estacion|intercanviador|terminal|autobusos|autobussos|autobuses|bus|de|del|d|la|el|les|els|barcelona)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
// rail families: Rodalies and Renfe regionals are one operator
const FAMILY = { rodalies: 'renfe', renfe: 'renfe', fgc: 'fgc', metro: 'metro', tram: 'tram', funicular: 'funicular' };

/**
 * @param osm      Overpass JSON
 * @param out      build output (routes, stops)
 * @param GROUPS   network groups (category per group)
 * @returns GeoJSON features
 */
export function buildStations(osm, out, GROUPS) {
  // 1. candidates from OSM
  const cands = [];
  for (const e of osm.elements) {
    const t = e.tags || {};
    const x = e.lon ?? e.center?.lon, y = e.lat ?? e.center?.lat;
    const name = t['name:ca'] || t.name;
    if (x == null || !name) continue;
    if (t.disused || t['disused:railway'] || t.railway === 'halt' && !t.public_transport) continue;
    let kind;
    if (t.railway === 'station') {
      const st = t.station || (t.subway === 'yes' ? 'subway' : t.light_rail === 'yes' ? 'light_rail' : 'train');
      if (['funicular', 'monorail', 'miniature'].includes(st) || t.usage === 'tourism' || t.tourism) continue;
      kind = st === 'subway' || st === 'light_rail' || st === 'tram' ? 'urban' : 'rail';
    } else {
      kind = 'bus';
      // OSM sometimes tags simple stops as bus stations: keep real stations / interchanges only
      if (!/estaci|intercanvi|terminal|bus station/i.test(name)) kind = 'bus?';
    }
    cands.push({ name, x, y, kind, osm: `${e.type}/${e.id}` });
  }

  // 2. merge duplicates (station node + area, platforms…) of the same kind within 250 m and similar name
  const merged = [];
  for (const c of cands.sort((a, b) => (a.osm.startsWith('node') ? 0 : 1) - (b.osm.startsWith('node') ? 0 : 1))) {
    const twin = merged.find((m) => m.kind === c.kind && dist([m.x, m.y], [c.x, c.y]) < 250
      && (strip(m.name).includes(strip(c.name)) || strip(c.name).includes(strip(m.name))));
    if (!twin) merged.push({ ...c });
  }

  // 3. lines serving each station (stops within reach)
  const grid = new Map();
  const cell = (x, y) => `${Math.floor(x * 200)},${Math.floor(y * 200)}`; // ~400 m cells
  out.stops.forEach((s, i) => { const k = cell(s.x, s.y); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const near = (x, y, r) => {
    const res = [];
    const cx = Math.floor(x * 200), cy = Math.floor(y * 200);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) || []) {
        const s = out.stops[i];
        if (dist([s.x, s.y], [x, y]) <= r) res.push(s);
      }
    }
    return res;
  };

  const features = [];
  for (const st of merged) {
    const stops = near(st.x, st.y, st.kind === 'bus' ? 250 : 180);
    const routes = new Set();
    for (const s of stops) for (const ri of s.r) {
      const r = out.routes[ri];
      if (r.m === 'plan') continue;
      routes.add(ri);
    }
    if (!routes.size) continue;
    const groups = new Set([...routes].map((ri) => out.routes[ri].g));
    const families = new Set([...groups].map((g) => FAMILY[g]).filter(Boolean));
    const busLines = [...routes].filter((ri) => GROUPS[out.routes[ri].g].category === 'bus').length;
    const railLines = routes.size - busLines;
    if (st.kind === 'bus?') {
      if (busLines < 8) continue;
      st.kind = 'bus';
    }

    // interchange: two rail families (Renfe + FGC, metro + Renfe…), or a train station with a big bus offer,
    // or a bus station next to the train
    const inter = families.size >= 2
      || (st.kind === 'rail' && families.size >= 1 && busLines >= 12)
      || (st.kind === 'bus' && families.size >= 1);
    if (st.kind === 'urban' && families.size < 2) continue; // plain metro / tram stops are already on the map
    const type = inter ? 'inter' : st.kind === 'bus' ? 'bus' : 'rail';

    const score = railLines * 3 + Math.min(busLines, 60) + groups.size * 8 + (st.kind === 'bus' ? 10 : 0);
    // tier 0: show from far away · tier 1: regional · tier 2: local
    const tier = score >= 70 ? 0 : score >= 25 ? 1 : 2;
    features.push({
      type: 'Feature',
      properties: {
        n: st.name, t: type, k: tier, sc: score,
        nr: railLines, nb: busLines,
        r: [...routes].join(','),
        osm: st.osm,
      },
      geometry: { type: 'Point', coordinates: [Math.round(st.x * 1e5) / 1e5, Math.round(st.y * 1e5) / 1e5] },
    });
  }
  // one entry per place: same core name within 400 m (rail station + metro + bus station of the same interchange)
  features.sort((a, b) => b.properties.sc - a.properties.sc);
  const kept = [];
  for (const f of features) {
    const c = core(f.properties.n);
    const sameName = (k) => c && core(k.properties.n)
      && (core(k.properties.n).includes(c) || c.includes(core(k.properties.n)));
    const d = (k) => dist(k.geometry.coordinates, f.geometry.coordinates);
    // same name within 400 m, or anything within 150 m (e.g. 'Aerobús T1' next to 'Aeroport T1')
    const twin = kept.find((k) => (d(k) < 400 && sameName(k)) || d(k) < 150);
    if (!twin) { kept.push(f); continue; }
    const p = twin.properties;
    const rs = new Set([...p.r.split(','), ...f.properties.r.split(',')]);
    p.r = [...rs].join(',');
    if (f.properties.t !== p.t) p.t = 'inter';
    if (sameName(twin) && f.properties.n.length < p.n.length && !/^estaci/i.test(f.properties.n)) p.n = f.properties.n;
    p.nr = Math.max(p.nr, f.properties.nr);
    p.nb = Math.max(p.nb, f.properties.nb);
    p.k = Math.min(p.k, f.properties.k);
  }
  // 'Barcelona-Passeig de Gràcia' -> 'Passeig de Gràcia'
  for (const k of kept) k.properties.n = k.properties.n.replace(/^Barcelona\s*[-–]\s*(?=\S)/, '');
  return kept;
}
