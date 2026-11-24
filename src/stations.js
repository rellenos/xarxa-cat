// Station / interchange icons drawn on a canvas (so they survive base map switches without extra files).
export const STATION_TYPES = {
  rail: { label: 'Estació de tren', color: '#1d3557' },
  bus: { label: "Estació d'autobusos", color: '#2e7d32' },
  inter: { label: 'Intercanviador', color: '#c8102e' },
};

const S = 56; // px at pixelRatio 2 -> 28 css px

function tile(ctx, color) {
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 2, 2, S - 4, S - 4, 13);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, 6, 6, S - 12, S - 12, 10);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTrain(ctx, color) {
  tile(ctx, color);
  roundRect(ctx, 18, 13, 20, 24, 5); ctx.fill(); // body
  ctx.fillStyle = color;
  roundRect(ctx, 21, 16, 14, 8, 2); ctx.fill(); // windscreen
  ctx.beginPath(); ctx.arc(23, 31, 2, 0, 7); ctx.arc(33, 31, 2, 0, 7); ctx.fill(); // lights
  ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(21, 39); ctx.lineTo(17, 44); ctx.moveTo(35, 39); ctx.lineTo(39, 44); ctx.stroke(); // rails
}

function drawBus(ctx, color) {
  tile(ctx, color);
  roundRect(ctx, 16, 13, 24, 26, 5); ctx.fill(); // body
  ctx.fillStyle = color;
  roundRect(ctx, 19, 17, 18, 9, 2); ctx.fill(); // windscreen
  ctx.beginPath(); ctx.arc(21, 33, 2, 0, 7); ctx.arc(35, 33, 2, 0, 7); ctx.fill(); // lights
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(18, 39, 5, 5); ctx.fillRect(33, 39, 5, 5); // wheels
}

function drawInterchange(ctx, color) {
  tile(ctx, color);
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(16, 22); ctx.lineTo(38, 22); ctx.moveTo(31, 15); ctx.lineTo(38, 22); ctx.lineTo(31, 29); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(40, 35); ctx.lineTo(18, 35); ctx.moveTo(25, 28); ctx.lineTo(18, 35); ctx.lineTo(25, 42); ctx.stroke();
}

/** Registers the three icons on the map (no-op when already there). */
export function addStationIcons(map) {
  const draw = { rail: drawTrain, bus: drawBus, inter: drawInterchange };
  for (const [type, fn] of Object.entries(draw)) {
    const id = `st-${type}`;
    if (map.hasImage(id)) continue;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    fn(ctx, STATION_TYPES[type].color);
    map.addImage(id, ctx.getImageData(0, 0, S, S), { pixelRatio: 2 });
  }
}

/** Same icon as a data URL, for the sidebar / popups. */
export function stationIconURL(type) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ({ rail: drawTrain, bus: drawBus, inter: drawInterchange })[type](ctx, STATION_TYPES[type].color);
  return c.toDataURL();
}
