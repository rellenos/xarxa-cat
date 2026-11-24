// Population coverage: how many people live near a stop, per municipality.
// Source: Idescat, "Població de Catalunya georeferenciada a 1 de gener" (Census, multiresolution 62.5/125/250 m grid,
// ETRS89 / UTM 31N shapefile). Cells with fewer than 17 people are suppressed ("***"): counted as SUPPRESSED_POP.
import fs from 'node:fs';

export const POP_URL = 'https://www.idescat.cat/serveis/biblioteca/docs/bib/publicacions/gridpoblacio01012025.zip';
export const POP_YEAR = 2025;
const SUPPRESSED_POP = 8; // about half of the 17-person threshold
export const BUS_RADIUS = 500; // m to any stop
export const RAIL_RADIUS = 1000; // m to a rail / metro / tram station

// ---- ETRS89 / UTM zone 31N <-> lon/lat (GRS80), Snyder's formulas ----
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996, LON0 = 3 * Math.PI / 180, FE = 500000;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const M = (phi) => A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
  - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
  + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));

export function toUtm(lon, lat) {
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = EP2 * Math.cos(phi) ** 2, Aa = Math.cos(phi) * (lam - LON0);
  const x = FE + K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * EP2) * Aa ** 5 / 120);
  const y = K0 * (M(phi) + N * Math.tan(phi) * (Aa ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * Aa ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  return [x, y];
}

export function fromUtm(x, y) {
  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2), T1 = Math.tan(phi1) ** 2, C1 = EP2 * Math.cos(phi1) ** 2;
  const R1 = A * (1 - E2) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5, D = (x - FE) / (N1 * K0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * D ** 6 / 720);
  const lon = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(phi1);
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

// ---- minimal shapefile + dbf readers (only what this grid needs: polygon bbox, numeric fields) ----
function readShpBoxes(file) {
  const b = fs.readFileSync(file);
  const boxes = [];
  let o = 100;
  while (o + 8 <= b.length) {
    const len = b.readInt32BE(o + 4) * 2;
    const type = b.readInt32LE(o + 8);
    boxes.push(type === 0 ? null : [b.readDoubleLE(o + 12), b.readDoubleLE(o + 20), b.readDoubleLE(o + 28), b.readDoubleLE(o + 36)]);
    o += 8 + len;
  }
  return boxes;
}

function readDbf(file, wanted) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(4), headerLen = b.readUInt16LE(8), recLen = b.readUInt16LE(10);
  const fields = [];
  let pos = 1;
  for (let o = 32; b[o] !== 0x0d; o += 32) {
    const name = b.toString('latin1', o, o + 11).replace(/\0.*/, '');
    const len = b[o + 16];
    fields.push({ name, pos, len });
    pos += len;
  }
  const use = fields.filter((f) => wanted.includes(f.name));
  const rows = new Array(n);
  for (let r = 0; r < n; r++) {
    const base = headerLen + r * recLen;
    const row = {};
    for (const f of use) {
      const s = b.toString('latin1', base + f.pos, base + f.pos + f.len).trim();
      row[f.name] = s.startsWith('*') ? null : Number(s); // null = suppressed
    }
    rows[r] = row;
  }
  return rows;
}

/** Populated grid cells as { x, y (UTM), lon, lat, pop, suppressed }. */
export function loadPopulationGrid(dir) {
  const base = `${dir}/${POP_YEAR}/gridpoblacio0101${POP_YEAR}`;
  const boxes = readShpBoxes(`${base}.shp`);
  const rows = readDbf(`${base}.dbf`, ['TOTAL']);
  const cells = [];
  boxes.forEach((bx, i) => {
    if (!bx) return;
    const t = rows[i].TOTAL;
    const pop = t === null ? SUPPRESSED_POP : t;
    if (!pop) return;
    const x = (bx[0] + bx[2]) / 2, y = (bx[1] + bx[3]) / 2;
    const [lon, lat] = fromUtm(x, y);
    cells.push({ x, y, lon, lat, pop, suppressed: t === null, size: bx[2] - bx[0] });
  });
  return cells;
}

/** Grid index of points (UTM metres) for radius queries. */
export function pointIndex(points, cell) {
  const g = new Map();
  for (const p of points) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    (g.get(k) || g.set(k, []).get(k)).push(p);
  }
  return (x, y, r) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), n = Math.ceil(r / cell), r2 = r * r;
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) {
      for (const p of g.get(`${cx + dx},${cy + dy}`) || []) if ((p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2) return true;
    }
    return false;
  };
}
