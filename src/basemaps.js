// Base map styles the viewer can switch between. All free and keyless.
const OFM = 'https://tiles.openfreemap.org/styles/';
// Glyphs for our own labels when the base style is raster-only
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const rasterStyle = (tiles, attribution, maxzoom = 19) => ({
  version: 8,
  glyphs: GLYPHS,
  sources: { base: { type: 'raster', tiles: [tiles], tileSize: 256, attribution, maxzoom } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});

const ICGC = 'https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wmts/';
const ICGC_ATTR = '© <a href="https://www.icgc.cat" target="_blank" rel="noopener">Institut Cartogràfic i Geològic de Catalunya</a>';

// dark: true -> outside-Catalonia mask and labels switch to dark colours
// labels: false -> hide the base map's own place / street names
export const BASEMAPS = {
  clar: { name: 'Clar', swatch: '#f2f1ee', style: `${OFM}positron` },
  blanc: { name: 'Blanc sense noms', swatch: '#ffffff', style: `${OFM}positron`, labels: false },
  fosc: { name: 'Fosc', swatch: '#2b2f36', style: `${OFM}dark`, dark: true },
  colors: { name: 'Colors i vegetació', swatch: '#cfe5b4', style: `${OFM}liberty` },
  osm: {
    name: 'OpenStreetMap',
    swatch: '#f2efe9',
    style: rasterStyle('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'),
  },
  topo: { name: 'Topogràfic ICGC', swatch: '#e9dfc4', style: rasterStyle(`${ICGC}topografic/MON3857NW/{z}/{x}/{y}.png`, ICGC_ATTR, 20) },
  orto: { name: 'Satèl·lit ICGC', swatch: '#4a5a3a', style: rasterStyle(`${ICGC}orto/MON3857NW/{z}/{x}/{y}.png`, ICGC_ATTR, 20), dark: true },
};
export const DEFAULT_BASEMAP = 'clar';
