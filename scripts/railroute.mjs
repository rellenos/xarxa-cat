// Routes trains along the real OpenStreetMap rail network (for GTFS feeds without shapes).
// Only the network inside the map bounds is loaded: the map can't show anything beyond them anyway.

export const RAIL_BBOX = [-1.8, 39.3, 5.1, 44.1]; // [minLon, minLat, maxLon, maxLat]
export const RAIL_QUERY = `[out:json][timeout:300][bbox:${RAIL_BBOX[1]},${RAIL_BBOX[0]},${RAIL_BBOX[3]},${RAIL_BBOX[2]}];
way["railway"="rail"]["service"!~"."]["usage"!~"^(industrial|military|tourism|test)$"];
out tags geom;`;

export const insideRailBbox = ([x, y]) => x >= RAIL_BBOX[0] && x <= RAIL_BBOX[2] && y >= RAIL_BBOX[1] && y <= RAIL_BBOX[3];

const dist = (a, b) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
};

/** Graph: node ids by coordinate, adjacency with length and high-speed flag, plus a grid for snapping. */
export function buildRailGraph(osm) {
  const id = new Map();
  const coords = [];
  const adj = [];
  const node = (p) => {
    const k = `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;
    let i = id.get(k);
    if (i === undefined) { i = coords.length; id.set(k, i); coords.push([p.lon, p.lat]); adj.push([]); }
    return i;
  };
  for (const w of osm.elements) {
    if (!w.geometry || w.geometry.length < 2) continue;
    const hs = w.tags?.highspeed === 'yes' || /^1435$/.test(w.tags?.gauge || '');
    let prev = node(w.geometry[0]);
    for (let j = 1; j < w.geometry.length; j++) {
      const cur = node(w.geometry[j]);
      const d = dist(coords[prev], coords[cur]);
      adj[prev].push({ to: cur, d, hs });
      adj[cur].push({ to: prev, d, hs });
      prev = cur;
    }
  }
  const grid = new Map();
  coords.forEach(([x, y], i) => {
    const k = `${Math.floor(x * 50)},${Math.floor(y * 50)}`; // ~2 km cells
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  });
  return { coords, adj, grid };
}

function snap(g, p, maxM = 2500) {
  const cx = Math.floor(p[0] * 50), cy = Math.floor(p[1] * 50);
  const ring = Math.ceil(maxM / 1500);
  let best = -1, bd = maxM;
  for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
    for (const i of g.grid.get(`${cx + dx},${cy + dy}`) || []) {
      const d = dist(g.coords[i], p);
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

// Small binary heap for A*
class Heap {
  constructor() { this.a = []; }
  push(v, p) {
    const a = this.a; a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top[1];
  }
  get size() { return this.a.length; }
}

/**
 * Shortest path between two points on the rail graph.
 * highSpeed: true favours high-speed (standard gauge) track, false keeps to the conventional network.
 */
export function railPath(g, a, b, highSpeed, snapM = 2500) {
  const s = snap(g, a, snapM), t = snap(g, b, snapM);
  if (s < 0 || t < 0) return null;
  if (s === t) return [g.coords[s]];
  const factor = (hs) => (highSpeed ? (hs ? 1 : 2.5) : (hs ? 6 : 1));
  const gScore = new Map([[s, 0]]);
  const from = new Map();
  const heap = new Heap();
  heap.push(s, dist(g.coords[s], g.coords[t]));
  const target = g.coords[t];
  let steps = 0;
  while (heap.size) {
    const u = heap.pop();
    if (u === t) break;
    if (++steps > 400000) return null;
    const gu = gScore.get(u);
    for (const e of g.adj[u]) {
      const ng = gu + e.d * factor(e.hs);
      if (ng < (gScore.get(e.to) ?? Infinity)) {
        gScore.set(e.to, ng);
        from.set(e.to, u);
        heap.push(e.to, ng + dist(g.coords[e.to], target));
      }
    }
  }
  if (!from.has(t)) return null;
  const path = [];
  for (let v = t; v !== undefined; v = from.get(v)) path.push(g.coords[v]);
  path.reverse();
  // sanity: a detour 3x longer than the straight line means the graph is broken there
  let len = 0;
  for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
  if (len > dist(a, b) * 3 + 5000) return null;
  return path;
}

// Where the segment a -> b leaves the bbox (a inside, b outside), slightly inside the border
function borderPoint(a, b) {
  const [x0, y0, x1, y1] = RAIL_BBOX;
  let t = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx) t = Math.min(t, ((dx > 0 ? x1 : x0) - a[0]) / dx);
  if (dy) t = Math.min(t, ((dy > 0 ? y1 : y0) - a[1]) / dy);
  t = Math.max(0, t - 0.01);
  return [a[0] + dx * t, a[1] + dy * t];
}

/**
 * Line through all stops, clipped to the map bounds: where the train leaves the bounds towards a far stop
 * (Madrid, Lyon…) the line follows the track to the border. Null when nothing can be drawn.
 */
export function routeByRail(g, pts, highSpeed) {
  // stops inside the bbox, plus a border point wherever the sequence crosses out or in
  const seq = [];
  for (let i = 0; i < pts.length; i++) {
    const inA = insideRailBbox(pts[i]);
    if (inA) seq.push({ p: pts[i], border: false });
    const next = pts[i + 1];
    if (!next) break;
    const inB = insideRailBbox(next);
    if (inA && !inB) seq.push({ p: borderPoint(pts[i], next), border: true });
    if (!inA && inB) seq.push({ p: borderPoint(next, pts[i]), border: true });
  }
  if (seq.length < 2) return null;
  let line = [];
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    if (a.border && b.border) continue; // the train is outside the map between these two
    const seg = railPath(g, a.p, b.p, highSpeed, a.border || b.border ? 25000 : 2500);
    if (!seg) continue;
    line = line.length ? line.concat(seg.slice(1)) : seg;
  }
  return line.length >= 2 ? line : null;
}
