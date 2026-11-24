import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { LOGOS } from './logos.js';
import { BASEMAPS, DEFAULT_BASEMAP } from './basemaps.js';
import { STATION_TYPES, addStationIcons, stationIconURL } from './stations.js';

// Served untouched by the `maplibre-worker` plugin in vite.config.js
maplibregl.setWorkerUrl(new URL(`vendor/maplibre-gl-worker.mjs?v=${maplibregl.getVersion()}`, document.baseURI).href);

const asset = (p) => new URL(p, document.baseURI).href;
const NONE = ['==', ['get', 'i'], -1];
let basemapKey = BASEMAPS[safeStorage('get', 'basemap')] ? safeStorage('get', 'basemap') : DEFAULT_BASEMAP;
// Line widths in px at zoom 7, 10, 13, 16, 18 (before the progressive factor).
// Rail ~35 % thicker than before at mid zooms; bus thin from far away, ~30 % thicker from zoom 13.
const LINE_WIDTHS = {
  'lines-bus': [0.35, 0.8, 2.1, 3.9, 6],
  'lines-approx': [0.35, 0.8, 1.8, 3.2, 5],
  'lines-tram': [1.2, 2.4, 3.9, 5.8, 8.5],
  'lines-rail-casing': [3, 4.8, 6.9, 9.2, 13],
  'lines-rail': [1.7, 3, 4.7, 6.5, 9],
  'planned-casing': [2.7, 4.2, 6, 8.5, 12],
  'planned-c': [1.5, 2.6, 4, 5.8, 8.5],
  'planned-p': [1.5, 2.6, 4, 5.8, 8.5],
  'sel-casing': [4.4, 6.2, 8.4, 11, 15],
  'sel-line': [2.4, 3.6, 5.2, 7.2, 10],
};
const widthExpr = (stops, f = 1) => ['interpolate', ['exponential', 1.4], ['zoom'],
  7, stops[0] * f, 10, stops[1] * f, 13, stops[2] * f, 16, stops[3] * f, 18, stops[4] * f];

// Progressive factor: ×1 with 300+ visible lines, growing smoothly (log scale) up to ×1.8 with 5 or fewer
function widthFactor() {
  let n = 0;
  for (let i = 0; i < visible.length; i++) if (isShown(i) && DATA.routes[i].m !== 'plan') n++;
  const MANY = 300, FEW = 5, MAX = 1.8;
  if (n >= MANY) return 1;
  if (n <= FEW) return MAX;
  return 1 + (MAX - 1) * (Math.log(MANY) - Math.log(n)) / (Math.log(MANY) - Math.log(FEW));
}

let appliedFactor = 1;
function applyLineWidths(force = false) {
  const f = widthFactor();
  if (!force && Math.abs(f - appliedFactor) < 0.02) return;
  appliedFactor = f;
  for (const [layer, stops] of Object.entries(LINE_WIDTHS)) {
    if (map.getLayer(layer)) map.setPaintProperty(layer, 'line-width', widthExpr(stops, f));
  }
}

const LINE_OPACITY = {
  'lines-bus': ['interpolate', ['linear'], ['zoom'], 7, 0.45, 11, 0.85],
  'lines-approx': ['interpolate', ['linear'], ['zoom'], 7, 0.35, 11, 0.7],
  'lines-tram': 1,
  'lines-rail': 1,
  'lines-rail-casing': 1,
  'planned-casing': 0.9,
  'planned-c': 1,
  'planned-p': 0.85,
};
const CATEGORIES = { rail: 'Ferrocarril', bus: 'Autobús', planned: 'En projecte' };
const PLANNED_MODE = { subway: 'Metro', tram: 'Tramvia', rail: 'Ferrocarril' };
const MODE_LABEL = {
  metro: 'Metro', rail: 'Tren', tram: 'Tramvia', funicular: 'Funicular / cremallera', bus: 'Autobús',
};

// ---------- state ----------
let DATA; // index.json
let visible; // Uint8Array per route: what the user ticked in the tree
let passes; // Uint8Array per route: passes the active filters (a line is drawn when visible && passes)
// Service filters: the type ones (night / exprés / on demand) add up (OR); accessibility and place narrow (AND)
const SERVICE_FILTERS = [
  { key: 'nt', label: 'Nocturns', title: 'Bus nocturn (N1, N-80…)', test: (r) => r.nt },
  { key: 'expres', label: 'Exprés.cat', title: 'Línies exprés.cat (e1, e2…)', test: (r) => r.g === 'expres' },
  { key: 'dm', label: 'A demanda', title: 'Transport a demanda (TAD): cal reservar el servei', test: (r) => r.dm },
];
const WC_FILTER = {
  key: 'wc', label: 'Accessibles',
  title: 'Totes les expedicions adaptades a cadira de rodes, segons les dades dels operadors (FGC, Rodalies i molts autobusos no ho publiquen)',
  test: (r) => r.wc === 1,
};
let activeFilters = new Set(JSON.parse(safeStorage('get', 'filters') || '[]'));
let placeFilter = JSON.parse(safeStorage('get', 'place') || 'null'); // { t: 'm' | 'c', i }
const isShown = (i) => visible[i] && passes[i];
const filtersActive = () => activeFilters.size > 0 || !!placeFilter;
let selected = null; // route index
let showZones = safeStorage('get', 'zones') === '1';
let showAmb = safeStorage('get', 'amb') === '1';
let showVegueries = safeStorage('get', 'vegueries') === '1';
let showComarques = safeStorage('get', 'comarques') === '1';
let showProvincies = safeStorage('get', 'provincies') === '1';
const PROVINCIA_COLORS = { '08': '#EF9A9A', '17': '#90CAF9', '25': '#FFE082', '43': '#A5D6A7' };
// vegueria code (ICGC CODIVEGUE) -> colour
const VEGUERIA_COLORS = {
  '01': '#E57373', '02': '#64B5F6', '03': '#FFB74D', '04': '#81C784', '05': '#4DB6AC',
  '06': '#BA68C8', '07': '#F06292', '08': '#A1887F', '00': '#7986CB',
};
let showStations = safeStorage('get', 'stations') !== '0'; // on by default
let stationFocus = safeStorage('get', 'stationFocus') !== '0'; // click on a station highlights its lines
let focusedStation = null; // { n, t, ids, xy } while a station is focused
const TABS = ['xarxes', 'capes', 'info'];
let currentTab = TABS.includes(safeStorage('get', 'tab')) ? safeStorage('get', 'tab') : 'xarxes';
const AMB_COLOR = '#C8102E';
const ZONE_COLORS = ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA', '#6D4C41'];
let map;
let popup;
const expanded = new Set(JSON.parse(safeStorage('get', 'expanded') || '[]'));
let tree; // [{category nodes}]

const $ = (s, el = document) => el.querySelector(s);
const panel = $('#panel');

function safeStorage(op, key, val) {
  try {
    return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, val);
  } catch { return null; }
}

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function textColorFor(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1a1a1a' : '#ffffff';
}

function routeColor(r) {
  return '#' + (r.c || DATA.groups[r.g].color.replace('#', ''));
}

function badge(r) {
  const bg = routeColor(r);
  const fg = r.tc && r.tc !== r.c ? '#' + r.tc : textColorFor(bg);
  const el = document.createElement('span');
  el.className = 'badge';
  el.style.background = bg;
  el.style.color = fg;
  el.textContent = r.s || '·';
  el.title = r.s;
  return el;
}

const collator = new Intl.Collator('ca', { numeric: true, sensitivity: 'base' });
const byRoute = (a, b) => {
  const ra = DATA.routes[a], rb = DATA.routes[b];
  return (ra.o - rb.o) || collator.compare(ra.s, rb.s) || collator.compare(ra.l, rb.l);
};

// ---------- operator logos ----------
function logoImg(file, cls, fallback = null) {
  const img = document.createElement('img');
  img.className = cls;
  img.src = asset(`logos/${file}`);
  img.alt = '';
  img.addEventListener('error', () => (fallback ? img.replaceWith(fallback()) : img.remove()), { once: true });
  return img;
}

// Logo for a company / municipality node ("Monbus (La Hispano Igualadina)" also tries "Monbus")
function nodeLogo(node) {
  const own = LOGOS[`sub:${node.label}`] || LOGOS[`sub:${node.label.replace(/ \(.*\)$/, '')}`];
  if (own) return own;
  // e.g. an urban network run by HIFE / TEISA… shows its operator's logo
  const cos = new Set(node.all.map((i) => DATA.routes[i].co).filter(Boolean));
  return cos.size === 1 ? LOGOS[`sub:${[...cos][0]}`] || null : null;
}

function groupIcon(groupId) {
  const g = DATA.groups[groupId];
  return LOGOS[groupId] ? logoImg(LOGOS[groupId], 'glogo', () => textIcon(g)) : textIcon(g);
}

function textIcon(g) {
  const ic = document.createElement('span');
  ic.className = 'gicon';
  ic.style.background = g.color;
  ic.textContent = g.icon;
  return ic;
}

// ---------- tree model ----------
function buildTree() {
  const cats = {};
  DATA.routes.forEach((r, i) => {
    const g = DATA.groups[r.g];
    const cat = (cats[g.category] ||= { key: `c:${g.category}`, label: CATEGORIES[g.category], kind: 'cat', children: {} });
    let node = (cat.children[r.g] ||= { key: `g:${r.g}`, label: g.name, kind: 'group', group: r.g, children: {}, routes: [] });
    if (r.sg) {
      node = (node.children[r.sg] ||= { key: `s:${r.g}:${r.sg}`, label: r.sg, kind: 'sub', group: r.g, children: {}, routes: [] });
      if (r.sg2) {
        node = (node.children[r.sg2] ||= { key: `t:${r.g}:${r.sg}:${r.sg2}`, label: r.sg2, kind: 'sub2', group: r.g, routes: [] });
      }
    }
    node.routes.push(i);
  });
  const groupOrder = Object.keys(DATA.groups);
  const LAST = 'Petits operadors';
  const finalize = (node) => {
    if (node.children) {
      let kids = Object.values(node.children);
      if (node.kind === 'sub' && kids.length) {
        if (node.routes.length) {
          // company with lines of its own plus subsidiaries: give its own lines a child too
          kids.push({ key: `${node.key}:_`, label: node.label, kind: 'sub2', group: node.group, routes: node.routes });
          node.routes = [];
        } else if (kids.length === 1) {
          // a single subsidiary: show it in the company label instead of nesting
          node.label = `${node.label} (${kids[0].label})`;
          node.routes = kids[0].routes;
          kids = [];
        }
      }
      if (node.kind === 'cat') kids.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
      else kids.sort((a, b) => (a.label === LAST) - (b.label === LAST) || collator.compare(a.label, b.label));
      node.children = kids;
      kids.forEach(finalize);
    }
    node.routes?.sort(byRoute);
    node.all = [...(node.children || []).flatMap((c) => c.all), ...(node.routes || [])];
  };
  const out = ['rail', 'bus', 'planned'].filter((c) => cats[c]).map((c) => cats[c]);
  out.forEach(finalize);
  return out;
}

// With filters on, a node's checkbox and count only look at the lines that pass them
function nodeState(node) {
  let on = 0, n = 0;
  for (const i of node.all) {
    if (!passes[i]) continue;
    n++;
    on += visible[i];
  }
  return on === 0 ? 'none' : on === n ? 'all' : 'some';
}
const passCount = (node) => node.all.reduce((a, i) => a + passes[i], 0);

// ---------- sidebar rendering ----------
// Tabs: Xarxes (network tree) · Capes (base map + overlays) · Info (legend + sources)
function setTabBar(active) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === active;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
}

function showTab(tab) {
  currentTab = tab;
  safeStorage('set', 'tab', tab);
  renderPanel();
}

function renderPanel() {
  setTabBar(currentTab);
  if (currentTab === 'capes') renderLayersTab();
  else if (currentTab === 'info') renderInfoTab();
  else renderTree();
  panel.scrollTop = Number(safeStorage('get', `scroll:${currentTab}`) || 0);
}

function renderTree() {
  currentTab = 'xarxes';
  safeStorage('set', 'tab', 'xarxes');
  setTabBar('xarxes');
  panel.replaceChildren();
  const frag = document.createDocumentFragment();
  frag.append(renderTreeToolbar(), renderFilterBox());
  const cats = tree.filter((cat) => passCount(cat));
  for (const cat of cats) frag.append(renderNode(cat, 0));
  if (!cats.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty';
    empty.textContent = 'Cap línia compleix els filtres.';
    frag.append(empty);
  }
  panel.append(frag);
  syncChecks();
  panel.scrollTop = Number(safeStorage('get', 'scroll:xarxes') || 0);
}

function renderTreeToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'tool';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    bar.append(b);
  };
  btn('Mostra-ho tot', 'Mostra totes les línies', () => { visible.fill(1); onVisibilityChange(); });
  btn('Amaga-ho tot', 'Amaga totes les línies', () => { visible.fill(0); onVisibilityChange(); });
  btn('Plega', 'Plega totes les xarxes', () => {
    expanded.clear();
    safeStorage('set', 'expanded', '[]');
    safeStorage('set', 'scroll:xarxes', '0');
    panel.querySelectorAll('.node.open').forEach((n) => {
      n.classList.remove('open');
      n.querySelector(':scope > .row .row-label')?.setAttribute('aria-expanded', 'false');
    });
  });
  return bar;
}

// ---------- Capes tab ----------
function renderLayersTab() {
  panel.replaceChildren();
  const box = document.createElement('div');
  box.className = 'tab-page';
  // base map
  const h = document.createElement('h3');
  h.className = 'section-title';
  h.textContent = 'Mapa base';
  const grid = document.createElement('div');
  grid.className = 'basemap-grid';
  for (const [key, bm] of Object.entries(BASEMAPS)) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'basemap-opt';
    opt.dataset.key = key;
    opt.setAttribute('aria-checked', String(key === basemapKey));
    opt.innerHTML = `<span class="sw" style="background:${bm.swatch}"></span><span></span>`;
    opt.lastChild.textContent = bm.name;
    opt.addEventListener('click', () => setBasemap(key));
    grid.append(opt);
  }
  box.append(h, grid);
  box.append(renderLayersBox('Transport', ['stations', 'zones']));
  box.append(renderLayersBox('Territori', ['provincies', 'comarques', 'vegueries', 'amb']));
  panel.append(box);
}

// ---------- Info tab ----------
function renderInfoTab() {
  panel.replaceChildren();
  const box = document.createElement('div');
  box.className = 'tab-page info';
  const counts = {};
  for (const r of DATA.routes) {
    const c = DATA.groups[r.g].category;
    counts[c] = (counts[c] || 0) + 1;
  }
  const fmt = (n) => n.toLocaleString('ca');
  box.innerHTML = `
    <h3 class="section-title">Resum</h3>
    <div class="stats">
      <div><b>${fmt(counts.rail || 0)}</b><span>línies de ferrocarril</span></div>
      <div><b>${fmt(counts.bus || 0)}</b><span>línies d'autobús</span></div>
      <div><b>${fmt(counts.planned || 0)}</b><span>projectes</span></div>
      <div><b>${fmt(DATA.stops.length)}</b><span>parades</span></div>
    </div>
    <h3 class="section-title">Llegenda</h3>
    <ul class="legend">
      <li><svg viewBox="0 0 40 10"><path d="M2 5h36" stroke="#fff" stroke-width="7"/><path d="M2 5h36" stroke="#E87200" stroke-width="4"/></svg>Ferrocarril (metro, FGC, Rodalies…)</li>
      <li><svg viewBox="0 0 40 10"><path d="M2 5h36" stroke="#43A047" stroke-width="2"/></svg>Autobús</li>
      <li><svg viewBox="0 0 40 10"><path d="M2 5h36" stroke="#FB712B" stroke-width="3.5" stroke-dasharray="7 4"/></svg>En construcció</li>
      <li><svg viewBox="0 0 40 10"><path d="M2 5h36" stroke="#1EB53A" stroke-width="3.5" stroke-dasharray="2.5 5" stroke-linecap="round"/></svg>Projectada</li>
      <li><svg viewBox="0 0 40 10"><circle cx="20" cy="5" r="3.5" fill="#fff" stroke="#333" stroke-width="1.5"/></svg>Parada / estació</li>
      <li><span class="legend-note">Les línies sense traçat oficial es dibuixen per carretera entre parades (indicat a la fitxa).</span></li>
    </ul>
    <h3 class="section-title">Fonts de dades</h3>
    <ul class="sources">
      <li><a href="https://mobilitydatabase.org/feeds/gtfs/mdb-2826" target="_blank" rel="noopener">ATM — autobusos i trens de Catalunya</a> (GTFS, Punt d'Accés Nacional)</li>
      <li><a href="https://mobilitydatabase.org/feeds/gtfs/mdb-2825" target="_blank" rel="noopener">ALSA</a> — línies estatals interregionals (GTFS)</li>
      <li><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> — línies en projecte i estacions (ODbL)</li>
      <li><a href="https://www.icgc.cat" target="_blank" rel="noopener">ICGC</a> — límits municipals, vegueries; mapes topogràfic i satèl·lit</li>
      <li><a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a> — traçats calculats per carretera</li>
      <li><a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> — mapes base</li>
      <li>Logotips: Wikimedia Commons i webs dels operadors (marques dels seus titulars)</li>
    </ul>
    <p class="muted updated">Dades generades el ${new Date(DATA.generated).toLocaleDateString('ca', { dateStyle: 'long' })}.</p>`;
  panel.append(box);
}

// Extra map layers (fare zones, AMB…), shown above the network tree
const EXTRA_LAYERS = {
  stations: { label: 'Estacions i intercanviadors', note: 'tren i bus', layers: ['stations-0', 'stations-1', 'stations-2'], get: () => showStations, set: (v) => { showStations = v; } },
  zones: { label: 'Zones tarifàries ATM', note: 'àrea de Barcelona', layers: ['zones-fill', 'zones-line', 'zones-label'], get: () => showZones, set: (v) => { showZones = v; } },
  provincies: { label: 'Províncies', note: '4', layers: ['prov-fill', 'prov-border', 'prov-label'], get: () => showProvincies, set: (v) => { showProvincies = v; } },
  comarques: { label: 'Comarques', note: '43', layers: ['com-fill', 'com-border', 'com-label'], get: () => showComarques, set: (v) => { showComarques = v; } },
  vegueries: { label: 'Vegueries', note: '8 + Aran', layers: ['veg-fill', 'veg-border', 'veg-label'], get: () => showVegueries, set: (v) => { showVegueries = v; } },
  amb: { label: 'Àrea Metropolitana (AMB)', note: '36 municipis', layers: ['amb-fill', 'amb-band', 'amb-line', 'amb-label'], get: () => showAmb, set: (v) => { showAmb = v; } },
};

function renderLayersBox(title, keys) {
  const box = document.createElement('div');
  box.className = 'layers-box';
  const h = document.createElement('h3');
  h.className = 'section-title';
  h.textContent = title;
  box.append(h);
  for (const key of keys) {
    const def = EXTRA_LAYERS[key];
    const row = document.createElement('label');
    row.className = 'layer-row';
    row.innerHTML = '<input type="checkbox"><span class="name"></span><span class="count"></span>';
    row.querySelector('.name').textContent = def.label;
    row.querySelector('.count').textContent = def.note;
    const cb = row.querySelector('input');
    cb.checked = def.get();
    box.append(row);
    let legend = null;
    if (key === 'zones') {
      legend = document.createElement('div');
      legend.className = 'zone-legend';
      legend.hidden = !def.get();
      ZONE_COLORS.forEach((c, i) => {
        const chip = document.createElement('span');
        chip.className = 'zone-chip';
        chip.style.setProperty('--zc', c);
        chip.textContent = i + 1;
        chip.title = `Zona ${i + 1}`;
        legend.append(chip);
      });
      box.append(legend);
    } else if (key === 'stations') {
      legend = document.createElement('div');
      legend.className = 'station-legend';
      legend.hidden = !def.get();
      const opt = document.createElement('label');
      opt.className = 'sub-option';
      opt.innerHTML = '<input type="checkbox"><span>En clicar una estació, ressalta les seves línies</span>';
      const ocb = opt.querySelector('input');
      ocb.checked = stationFocus;
      ocb.addEventListener('change', () => {
        stationFocus = ocb.checked;
        safeStorage('set', 'stationFocus', stationFocus ? '1' : '0');
        if (!stationFocus && focusedStation) deselect();
      });
      legend.append(opt);
      for (const [type, t] of Object.entries(STATION_TYPES)) {
        const item = document.createElement('span');
        item.innerHTML = `<img src="${stationIconURL(type)}" alt="">`;
        item.append(t.label);
        legend.append(item);
      }
      box.append(legend);
    } else if (key === 'provincies') {
      const sw = document.createElement('span');
      sw.className = 'veg-swatch prov';
      row.insertBefore(sw, row.querySelector('.name'));
    } else if (key === 'comarques') {
      const sw = document.createElement('span');
      sw.className = 'veg-swatch com';
      row.insertBefore(sw, row.querySelector('.name'));
    } else if (key === 'vegueries') {
      const sw = document.createElement('span');
      sw.className = 'veg-swatch multi';
      row.insertBefore(sw, row.querySelector('.name'));
    } else if (key === 'amb') {
      const sw = document.createElement('span');
      sw.className = 'amb-swatch';
      row.insertBefore(sw, row.querySelector('.name'));
    }
    cb.addEventListener('change', () => {
      def.set(cb.checked);
      if (legend) legend.hidden = !cb.checked;
      safeStorage('set', key, cb.checked ? '1' : '0');
      applyExtraLayersVisibility();
    });
  }
  return box;
}

function applyExtraLayersVisibility() {
  for (const def of Object.values(EXTRA_LAYERS)) {
    for (const l of def.layers) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', def.get() ? 'visible' : 'none');
  }
}

// ---------- filters (service type, accessibility, place) ----------
function placeName(p) {
  if (!p) return '';
  return p.t === 'c' ? DATA.places.comarques[p.i] : DATA.places.munis[p.i].n;
}

function routeInPlace(r, p) {
  if (!r.mu) return false;
  if (p.t === 'm') return r.mu.includes(p.i);
  return r.mu.some((m) => DATA.places.munis[m].c === p.i);
}

function recomputePasses() {
  const svc = SERVICE_FILTERS.filter((f) => activeFilters.has(f.key));
  const wc = activeFilters.has(WC_FILTER.key);
  DATA.routes.forEach((r, i) => {
    passes[i] = (!svc.length || svc.some((f) => f.test(r)))
      && (!wc || WC_FILTER.test(r))
      && (!placeFilter || routeInPlace(r, placeFilter)) ? 1 : 0;
  });
}

function onFiltersChange() {
  safeStorage('set', 'filters', JSON.stringify([...activeFilters]));
  safeStorage('set', 'place', JSON.stringify(placeFilter));
  recomputePasses();
  if (selected !== null && !passes[selected]) resetHighlight();
  renderTree();
  onVisibilityChange();
}

// Number of lines a chip would give, given the other active filters
function chipCount(f) {
  const isSvc = SERVICE_FILTERS.includes(f);
  const wc = activeFilters.has(WC_FILTER.key) && f !== WC_FILTER;
  let n = 0;
  for (const r of DATA.routes) {
    if (!f.test(r)) continue;
    if (!isSvc) {
      const svc = SERVICE_FILTERS.filter((s) => activeFilters.has(s.key));
      if (svc.length && !svc.some((s) => s.test(r))) continue;
    }
    if (wc && !WC_FILTER.test(r)) continue;
    if (placeFilter && !routeInPlace(r, placeFilter)) continue;
    n++;
  }
  return n;
}

function placeBounds(p) {
  const { munis } = DATA.places;
  const list = p.t === 'm' ? [munis[p.i]] : munis.filter((m) => m.c === p.i);
  let b = [180, 90, -180, -90];
  for (const m of list) b = [Math.min(b[0], m.b[0]), Math.min(b[1], m.b[1]), Math.max(b[2], m.b[2]), Math.max(b[3], m.b[3])];
  return [[b[0], b[1]], [b[2], b[3]]];
}

function setPlace(p) {
  placeFilter = p;
  onFiltersChange();
  if (p) {
    const isMobile = window.innerWidth < 768;
    map.fitBounds(placeBounds(p), {
      padding: isMobile ? { top: 40, bottom: window.innerHeight * 0.5, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 },
      maxZoom: 13,
    });
  }
}

// Places with at least one line, matching a query: comarques first, then municipalities
let placeLineCounts;
function searchPlaces(q, limit = 8) {
  const { munis, comarques } = DATA.places;
  if (!placeLineCounts) {
    const m = new Array(munis.length).fill(0), c = new Array(comarques.length).fill(0);
    for (const r of DATA.routes) {
      if (!r.mu) continue;
      const cs = new Set();
      for (const mi of r.mu) { m[mi]++; cs.add(munis[mi].c); }
      for (const ci of cs) c[ci]++;
    }
    placeLineCounts = { m, c };
  }
  const nq = norm(q);
  const score = (name) => {
    const n = norm(name);
    return n === nq ? 0 : n.startsWith(nq) ? 1 : n.split(/[\s'-]+/).some((w) => w.startsWith(nq)) ? 2 : n.includes(nq) ? 3 : -1;
  };
  const hits = [];
  comarques.forEach((name, i) => { const s = score(name); if (s >= 0 && placeLineCounts.c[i]) hits.push({ t: 'c', i, s, n: placeLineCounts.c[i] }); });
  munis.forEach((m, i) => { const s = score(m.n); if (s >= 0 && placeLineCounts.m[i]) hits.push({ t: 'm', i, s: s + 0.5, n: placeLineCounts.m[i] }); });
  hits.sort((a, b) => a.s - b.s || b.n - a.n);
  return hits.slice(0, limit);
}

function renderFilterBox() {
  const box = document.createElement('details');
  box.className = 'filters';
  box.open = safeStorage('get', 'filtersOpen') !== '0' || filtersActive();
  box.addEventListener('toggle', () => safeStorage('set', 'filtersOpen', box.open ? '1' : '0'));
  const sum = document.createElement('summary');
  sum.innerHTML = '<span>Filtres</span>';
  if (filtersActive()) {
    const n = passes.reduce((a, b) => a + b, 0);
    const tag = document.createElement('span');
    tag.className = 'filters-on';
    tag.textContent = `${n.toLocaleString('ca')} línies`;
    sum.append(tag);
  }
  box.append(sum);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const f of [...SERVICE_FILTERS, WC_FILTER]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip chip-${f.key}`;
    b.title = f.title;
    const on = activeFilters.has(f.key);
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `${FILTER_ICONS[f.key]}<span></span><span class="chip-n"></span>`;
    b.children[1].textContent = f.label;
    b.children[2].textContent = chipCount(f);
    b.addEventListener('click', () => {
      if (activeFilters.has(f.key)) activeFilters.delete(f.key);
      else activeFilters.add(f.key);
      onFiltersChange();
    });
    chips.append(b);
  }
  box.append(chips);

  // place: comarca or municipality
  const place = document.createElement('div');
  place.className = 'place-filter';
  if (placeFilter) {
    const pill = document.createElement('div');
    pill.className = 'place-pill';
    pill.innerHTML = `${FILTER_ICONS.place}<span class="pp-kind"></span><strong></strong><button type="button" class="pp-x" aria-label="Treu el filtre de lloc" title="Treu el filtre de lloc"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    pill.querySelector('.pp-kind').textContent = placeFilter.t === 'c' ? 'Comarca' : 'Municipi';
    pill.querySelector('strong').textContent = placeName(placeFilter);
    pill.querySelector('.pp-x').addEventListener('click', () => setPlace(null));
    place.append(pill);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'place-input';
    wrap.innerHTML = `${FILTER_ICONS.place}<input type="search" placeholder="Filtra per comarca o municipi" aria-label="Filtra per comarca o municipi" autocomplete="off">`;
    const input = wrap.querySelector('input');
    const list = document.createElement('div');
    list.className = 'place-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const show = () => {
      const q = input.value.trim();
      list.replaceChildren();
      if (q.length < 2) { list.hidden = true; return; }
      const hits = searchPlaces(q);
      if (!hits.length) {
        list.innerHTML = '<div class="place-none">Cap comarca ni municipi amb línies</div>';
      }
      for (const h of hits) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'place-opt';
        b.setAttribute('role', 'option');
        b.innerHTML = '<span class="po-name"></span><span class="po-sub"></span>';
        b.firstChild.textContent = placeName(h);
        b.lastChild.textContent = h.t === 'c' ? `comarca · ${h.n} línies` : `${DATA.places.comarques[DATA.places.munis[h.i].c]} · ${h.n} línies`;
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so blur doesn't close first
        b.addEventListener('click', () => setPlace({ t: h.t, i: h.i }));
        list.append(b);
      }
      list.hidden = false;
    };
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => { list.hidden = true; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') list.querySelector('.place-opt')?.click();
      if (e.key === 'Escape') { input.value = ''; list.hidden = true; e.stopPropagation(); }
    });
    place.append(wrap, list);
  }
  box.append(place);

  if (filtersActive()) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'linklike filters-clear';
    clear.textContent = 'Treu tots els filtres';
    clear.addEventListener('click', () => { activeFilters.clear(); placeFilter = null; onFiltersChange(); });
    box.append(clear);
  }
  return box;
}

const FILTER_ICONS = {
  nt: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  expres: '<svg viewBox="0 0 24 24"><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/></svg>',
  dm: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></svg>',
  wc: '<svg viewBox="0 0 24 24"><circle cx="11" cy="4" r="1.6"/><path d="M11 7v6h5l2 5"/><path d="M8 10.5a5.5 5.5 0 1 0 7.5 7"/></svg>',
  place: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.3"/></svg>',
};

function renderNode(node, depth) {
  const wrap = document.createElement('div');
  wrap.className = `node node-${node.kind}`;
  wrap.dataset.key = node.key;

  const row = document.createElement('div');
  row.className = 'row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.key = node.key;
  cb.setAttribute('aria-label', `Mostra ${node.label}`);
  cb.addEventListener('change', () => {
    const v = cb.checked ? 1 : 0;
    for (const i of node.all) if (passes[i]) visible[i] = v;
    onVisibilityChange();
  });
  node.cb = cb;

  const label = document.createElement('button');
  label.className = 'row-label';
  if (node.kind === 'group') {
    label.append(groupIcon(node.group));
  } else if ((node.kind === 'sub' || node.kind === 'sub2') && (DATA.groups[node.group].category === 'bus' || node.group === 'ferroext')) {
    // same slot for every company row so names line up, logo or not
    const slot = document.createElement('span');
    slot.className = 'clogo-slot';
    if (nodeLogo(node)) slot.append(logoImg(nodeLogo(node), 'clogo'));
    label.append(slot);
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = node.label;
  label.append(name);
  const count = document.createElement('span');
  count.className = 'count';
  const nLines = passCount(node);
  count.textContent = nLines === 1 ? '1 línia' : `${nLines} línies`;
  label.append(count);
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  label.append(chev);
  label.setAttribute('aria-expanded', 'false');

  const body = document.createElement('div');
  body.className = 'children';
  const open = () => {
    if (!body.childElementCount) {
      for (const c of node.children || []) if (passCount(c)) body.append(renderNode(c, depth + 1));
      for (const i of node.routes || []) if (passes[i]) body.append(renderRouteRow(i));
      syncChecks(body);
    }
    wrap.classList.add('open');
    label.setAttribute('aria-expanded', 'true');
  };
  label.addEventListener('click', () => {
    if (wrap.classList.contains('open')) {
      wrap.classList.remove('open');
      label.setAttribute('aria-expanded', 'false');
      expanded.delete(node.key);
    } else {
      open();
      expanded.add(node.key);
    }
    safeStorage('set', 'expanded', JSON.stringify([...expanded]));
  });
  if (expanded.has(node.key) || (node.kind === 'cat' && !safeStorage('get', 'expanded'))) open();

  row.append(cb, label);
  wrap.append(row, body);
  return wrap;
}

function renderRouteRow(i) {
  const r = DATA.routes[i];
  const row = document.createElement('div');
  row.className = 'row route-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.route = i;
  cb.setAttribute('aria-label', `Mostra ${r.s} ${r.l}`);
  cb.addEventListener('change', () => {
    visible[i] = cb.checked ? 1 : 0;
    onVisibilityChange();
  });
  const label = document.createElement('button');
  label.className = 'row-label';
  label.append(badge(r));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = r.l || r.s;
  label.append(name);
  label.addEventListener('click', () => selectRoute(i, true));
  row.append(cb, label);
  return row;
}

function syncChecks(root = panel) {
  for (const cb of root.querySelectorAll('input[data-key]')) {
    const node = findNode(cb.dataset.key);
    if (!node) continue;
    const st = nodeState(node);
    cb.checked = st === 'all';
    cb.indeterminate = st === 'some';
  }
  for (const cb of root.querySelectorAll('input[data-route]')) cb.checked = !!visible[cb.dataset.route];
}

const nodeIndex = new Map();
function indexNodes(nodes, parent = null) {
  for (const n of nodes) {
    n.parent = parent;
    nodeIndex.set(n.key, n);
    if (n.children) indexNodes(n.children, n);
  }
}

const nodePath = (n) => {
  const out = [];
  for (let x = n; x; x = x.parent) out.unshift(x);
  return out;
};

// Search text of a tree node: its label, plus the operators of its lines for company / municipality nodes
function nodeHaystack(n) {
  if (n._hay) return n._hay;
  let extra = '';
  if (n.kind === 'sub' || n.kind === 'sub2') {
    extra = [...new Set(n.all.flatMap((i) => [DATA.routes[i].a, DATA.routes[i].co || '']))].join(' ');
  }
  return (n._hay = norm(`${n.label} ${extra}`));
}

// Leave the search, open the tree down to `key`, scroll to it and frame its lines on the map
function revealNode(key) {
  const node = findNode(key);
  if (!node) return;
  $('#search').value = '';
  for (const n of nodePath(node)) expanded.add(n.key);
  safeStorage('set', 'expanded', JSON.stringify([...expanded]));
  if (selected !== null || focusedStation) resetHighlight();
  renderTree();
  const el = panel.querySelector(`.node[data-key="${CSS.escape(key)}"]`);
  if (el) {
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }
  let b = [180, 90, -180, -90];
  for (const i of node.all) {
    const r = DATA.routes[i].b;
    b = [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])];
  }
  const isMobile = window.innerWidth < 768;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
    padding: isMobile ? { top: 40, bottom: window.innerHeight * 0.5, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 },
    maxZoom: 14,
  });
}
const findNode = (k) => nodeIndex.get(k);

// ---------- route detail ----------
function renderRouteDetail(i) {
  setTabBar(null);
  const r = DATA.routes[i];
  const g = DATA.groups[r.g];
  panel.replaceChildren();
  const box = document.createElement('div');
  box.className = 'detail';

  const back = document.createElement('button');
  back.className = 'back';
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg> Totes les línies';
  back.addEventListener('click', () => clearSelection());

  const head = document.createElement('div');
  head.className = 'detail-head';
  const b = badge(r);
  b.classList.add('big');
  const titles = document.createElement('div');
  titles.innerHTML = `<h2></h2><p class="muted"></p>`;
  titles.querySelector('h2').textContent = r.l || r.s;
  titles.querySelector('p').textContent = r.m === 'plan'
    ? `${PLANNED_MODE[r.pm]} · ${g.name.toLowerCase()}`
    : `${MODE_LABEL[r.m] || r.m} · ${r.a}`;
  head.append(b, titles);
  const logoFile = LOGOS[`sub:${r.sg2}`] || LOGOS[`sub:${r.sg}`] || LOGOS[`sub:${r.co}`] || LOGOS[r.g];
  if (logoFile) head.append(logoImg(logoFile.replace('-icon', ''), 'dlogo')); // full logo in the detail view

  const meta = document.createElement('dl');
  meta.className = 'meta';
  const addMeta = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    meta.append(dt, dd);
  };
  if (r.m === 'plan') {
    addMeta('Estat', r.g === 'construccio' ? 'En construcció' : 'Projectada / en estudi');
    addMeta('Tipus', PLANNED_MODE[r.pm]);
    addMeta('Longitud', `${r.km.toLocaleString('ca')} km`);
    if (r.od) addMeta('Obertura prevista', r.od);
    if (r.a !== 'OpenStreetMap') addMeta('Operador', r.a);
    addMeta('Font', 'OpenStreetMap (traçat aproximat)');
  } else {
  addMeta('Xarxa', g.name);
  if (r.co && g.category === 'bus' && r.g !== 'urba') addMeta('Empresa', r.sg2 ? `${r.co} · ${r.sg2}` : r.co);
  else if (r.sg) addMeta(r.g === 'urba' ? 'Municipi' : 'Empresa', r.sg);
  addMeta('Operador (GTFS)', r.a);
  addMeta('Parades', String(r.st.length));
  addMeta('Expedicions', `${r.t.toLocaleString('ca')} al calendari`);
  const service = [r.nt && 'Nocturn', r.g === 'expres' && 'Exprés.cat', r.dm && 'A demanda (cal reservar)'].filter(Boolean);
  if (service.length) addMeta('Servei', service.join(' · '));
  addMeta('Accessibilitat', r.wc === 1 ? 'Adaptada a cadira de rodes' : r.wc === 2 ? 'Algunes expedicions adaptades' : 'Sense dades de l’operador');
  if (r.mu?.length) {
    const names = r.mu.map((m) => DATA.places.munis[m].n).sort(collator.compare);
    addMeta(r.mu.length === 1 ? 'Municipi' : `Municipis (${r.mu.length})`, names.length > 14 ? `${names.slice(0, 12).join(', ')} i ${names.length - 12} més` : names.join(', '));
  }
  if (r.ap) addMeta('Traçat', 'Aproximat (sense traçat oficial)');
  else if (r.rt) addMeta('Traçat', 'Calculat per carretera entre parades (l’operador no publica el traçat)');
  else if (r.rr) addMeta('Traçat', 'Calculat sobre la xarxa ferroviària d’OpenStreetMap (l’operador no publica el traçat)');
  if (r.cl) addMeta('Abast', 'Es dibuixa fins al límit del mapa; la línia continua més enllà');
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const zoom = document.createElement('button');
  zoom.className = 'btn';
  zoom.textContent = 'Centra al mapa';
  zoom.addEventListener('click', () => fitRoute(i));
  actions.append(zoom);
  if (r.u) {
    const a = document.createElement('a');
    a.className = 'btn ghost';
    a.href = r.u;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.m === 'plan' ? (r.u.includes('openstreetmap.org') ? 'Veure a OpenStreetMap' : 'Més informació') : 'Web de l’operador';
    actions.append(a);
  }

  const list = document.createElement('ol');
  list.className = 'stops';
  list.style.setProperty('--line', routeColor(r));
  for (const si of r.st) {
    const s = DATA.stops[si];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = s.n;
    btn.addEventListener('click', () => focusStop(si, 15));
    const others = s.r.filter((x) => x !== i);
    const conn = document.createElement('span');
    conn.className = 'conns';
    const seen = new Set();
    for (const o of others) {
      const ro = DATA.routes[o];
      const k = ro.s + ro.c;
      if (seen.has(k) || DATA.groups[ro.g].category !== 'rail') continue;
      seen.add(k);
      conn.append(badge(ro));
    }
    li.append(btn, conn);
    list.append(li);
  }
  const h3 = document.createElement('h3');
  h3.textContent = 'Parades';
  box.append(back, head, meta, actions);
  if (r.st.length) box.append(h3, list);
  panel.append(box);
  panel.scrollTop = 0;
}

// ---------- search ----------
function renderSearch(q) {
  setTabBar(null);
  const nq = norm(q);
  const terms = nq.split(/\s+/).filter(Boolean);

  const groupHits = [];
  for (const n of nodeIndex.values()) {
    if (n.kind === 'cat' || n.key.endsWith(':_')) continue;
    const hay = nodeHaystack(n);
    if (!terms.every((t) => hay.includes(t))) continue;
    const label = norm(n.label);
    const score = label === nq ? 0 : label.startsWith(nq) ? 1 : label.includes(nq) ? 2
      : terms.every((t) => label.includes(t)) ? 3 : 4; // 4 = matched only through its operators
    const planned = DATA.groups[n.group]?.category === 'planned' ? 1 : 0; // projects after current networks
    groupHits.push([planned, score, nodePath(n).length, -n.all.length, n]);
  }
  groupHits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

  const routeHits = [];
  DATA.routes.forEach((r, i) => {
    const hay = r._hay ||= norm(`${r.s} ${r.l} ${r.a} ${r.sg || ''} ${r.sg2 || ''} ${r.co || ''} ${DATA.groups[r.g].name}`);
    if (terms.every((t) => hay.includes(t))) {
      const exact = norm(r.s) === nq ? 0 : norm(r.s).startsWith(nq) ? 1 : 2;
      routeHits.push([exact, DATA.groups[r.g].rank, i]);
    }
  });
  routeHits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || byRoute(a[2], b[2]));

  const stopHits = [];
  const seenNames = new Set();
  DATA.stops.forEach((s, i) => {
    const h = s._h ||= norm(s.n);
    if (terms.every((t) => h.includes(t))) {
      const key = h + Math.round(s.x * 200) + Math.round(s.y * 200);
      if (seenNames.has(key)) return;
      seenNames.add(key);
      stopHits.push([h.startsWith(nq) ? 0 : 1, -s.r.length, i]);
    }
  });
  stopHits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  panel.replaceChildren();
  const box = document.createElement('div');
  box.className = 'results';
  const section = (title, n) => {
    const h = document.createElement('h3');
    h.textContent = `${title} (${n})`;
    box.append(h);
  };
  if (groupHits.length) {
    section('Xarxes i operadors', groupHits.length);
    for (const n of groupHits.slice(0, 20).map((h) => h[4])) {
      const row = document.createElement('div');
      row.className = 'result group-result';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const st = nodeState(n);
      cb.checked = st === 'all';
      cb.indeterminate = st === 'some';
      cb.setAttribute('aria-label', `Mostra ${n.label}`);
      cb.addEventListener('change', () => {
        for (const i of n.all) visible[i] = cb.checked ? 1 : 0;
        onVisibilityChange();
      });
      const btn = document.createElement('button');
      btn.className = 'group-result-btn';
      const own = n.kind !== 'group' && nodeLogo(n);
      const g = own ? logoImg(own, 'glogo') : n.group ? groupIcon(n.group) : null;
      if (g) btn.append(g);
      const t = document.createElement('span');
      t.className = 'name';
      t.innerHTML = '<span></span><small class="muted"></small>';
      t.firstChild.textContent = n.label;
      const path = nodePath(n).slice(0, -1).map((x) => x.label);
      t.lastChild.textContent = `${path.join(' › ')} · ${n.all.length === 1 ? '1 línia' : `${n.all.length} línies`}`;
      btn.append(t);
      btn.addEventListener('click', () => revealNode(n.key));
      row.append(cb, btn);
      box.append(row);
    }
  }
  section('Línies', routeHits.length);
  for (const [, , i] of routeHits.slice(0, 60)) {
    const r = DATA.routes[i];
    const btn = document.createElement('button');
    btn.className = 'result';
    btn.append(badge(r));
    const t = document.createElement('span');
    t.className = 'name';
    t.innerHTML = '<span></span><small class="muted"></small>';
    t.firstChild.textContent = r.l || r.s;
    t.lastChild.textContent = [DATA.groups[r.g].name, r.sg, r.sg2].filter(Boolean).join(' · ');
    btn.append(t);
    btn.addEventListener('click', () => { visible[i] = 1; onVisibilityChange(); selectRoute(i, true); });
    box.append(btn);
  }
  section('Parades', stopHits.length);
  for (const [, , si] of stopHits.slice(0, 40)) {
    const s = DATA.stops[si];
    const btn = document.createElement('button');
    btn.className = 'result';
    const pin = document.createElement('span');
    pin.className = 'pin';
    btn.append(pin);
    const t = document.createElement('span');
    t.className = 'name';
    t.innerHTML = '<span></span><small class="badges"></small>';
    t.firstChild.textContent = s.n;
    const seen = new Set();
    for (const ri of s.r) {
      const r = DATA.routes[ri];
      if (seen.has(r.s + r.c) || seen.size >= 8) continue;
      seen.add(r.s + r.c);
      t.lastChild.append(badge(r));
    }
    btn.append(t);
    btn.addEventListener('click', () => focusStop(si));
    box.append(btn);
  }
  panel.append(box);
  panel.scrollTop = 0;
}

// ---------- map ----------
function matchFilter(prop, ids) {
  return ids.length ? ['match', ['get', prop], ids, true, false] : NONE;
}

function visibleRouteIds() {
  const ids = [];
  for (let i = 0; i < visible.length; i++) if (isShown(i)) ids.push(i);
  return ids;
}

function applyMapFilters() {
  if (!map?.getLayer('lines-bus')) return;
  const ids = visibleRouteIds();
  const base = matchFilter('i', ids);
  map.setFilter('lines-bus', ['all', base, ['==', ['get', 'm'], 'bus'], ['!', ['has', 'ap']]]);
  map.setFilter('lines-approx', ['all', base, ['has', 'ap']]);
  map.setFilter('lines-tram', ['all', base, ['==', ['get', 'm'], 'tram']]);
  map.setFilter('lines-rail-casing', ['all', base, ['in', ['get', 'm'], ['literal', ['rail', 'metro', 'funicular']]]]);
  map.setFilter('planned-casing', ['all', base, ['==', ['get', 'm'], 'plan']]);
  map.setFilter('planned-c', ['all', base, ['==', ['get', 'm'], 'plan'], ['==', ['get', 'ps'], 'c']]);
  map.setFilter('planned-p', ['all', base, ['==', ['get', 'm'], 'plan'], ['==', ['get', 'ps'], 'p']]);
  map.setFilter('lines-rail', ['all', base, ['in', ['get', 'm'], ['literal', ['rail', 'metro', 'funicular']]]]);
  map.setFilter('lines-labels', base);

  const stopIds = [];
  DATA.stops.forEach((s, i) => { if (s.r.some(isShown)) stopIds.push(i); });
  map.setFilter('stops', matchFilter('i', stopIds));
  map.setFilter('stop-labels', ['all', matchFilter('i', stopIds), ['<=', ['get', 'k'], 1]]);
}

function onVisibilityChange() {
  syncChecks();
  applyMapFilters();
  applyLineWidths();
  safeStorage('set', 'hidden', JSON.stringify(DATA.routes.map((r, i) => (visible[i] ? null : r.id)).filter(Boolean)));
  updateFooter();
}

function updateFooter() {
  let n = 0;
  for (let i = 0; i < visible.length; i++) n += isShown(i) ? 1 : 0;
  $('#footer').innerHTML = `<span>${n.toLocaleString('ca')} de ${DATA.routes.length.toLocaleString('ca')} línies visibles${filtersActive() ? ' · <b>filtrat</b>' : ''}</span>
    <button class="linklike" type="button">Fonts i llegenda</button>`;
  $('#footer button').addEventListener('click', () => { $('#search').value = ''; if (selected !== null || focusedStation) resetHighlight(); showTab('info'); });
}

function fitRoute(i) {
  const [x0, y0, x1, y1] = DATA.routes[i].b;
  const isMobile = window.innerWidth < 768;
  map.fitBounds([[x0, y0], [x1, y1]], {
    padding: isMobile ? { top: 40, bottom: window.innerHeight * 0.5, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 },
    maxZoom: 15,
  });
}

function selectRoute(i, fit) {
  focusedStation = null;
  selected = i;
  popup?.remove();
  const r = DATA.routes[i];
  map.setFilter('sel-casing', ['==', ['get', 'i'], i]);
  map.setFilter('sel-line', ['==', ['get', 'i'], i]);
  map.setFilter('sel-stops', matchFilter('i', r.st));
  map.setPaintProperty('sel-line', 'line-color', routeColor(r));
  map.setPaintProperty('sel-line', 'line-dasharray', r.m === 'plan' ? [1.6, 0.9] : undefined);
  map.setPaintProperty('sel-stops', 'circle-stroke-color', routeColor(r));
  for (const l of Object.keys(LINE_OPACITY)) map.setPaintProperty(l, 'line-opacity', 0.18);
  map.setPaintProperty('stops', 'circle-opacity', 0.2);
  map.setPaintProperty('stops', 'circle-stroke-opacity', 0.2);
  if (fit) fitRoute(i);
  $('#search').value = '';
  renderRouteDetail(i);
  setHashParam('linia', r.id);
  document.body.classList.remove('sb-collapsed');
}

// Highlight several lines at once (each in its own colour) and dim the rest
function highlightRoutes(ids) {
  const f = matchFilter('i', ids);
  map.setFilter('sel-casing', f);
  map.setFilter('sel-line', f);
  map.setFilter('sel-stops', NONE);
  map.setPaintProperty('sel-line', 'line-color', ['get', 'c']);
  map.setPaintProperty('sel-line', 'line-dasharray', undefined);
  for (const l of Object.keys(LINE_OPACITY)) map.setPaintProperty(l, 'line-opacity', 0.18);
  map.setPaintProperty('stops', 'circle-opacity', 0.2);
  map.setPaintProperty('stops', 'circle-stroke-opacity', 0.2);
}

function fitRoutes(ids) {
  let b = [180, 90, -180, -90];
  for (const i of ids) {
    const r = DATA.routes[i].b;
    b = [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])];
  }
  const isMobile = window.innerWidth < 768;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
    padding: isMobile ? { top: 40, bottom: window.innerHeight * 0.5, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 },
    maxZoom: 14,
  });
}

function focusStation(f) {
  const p = f.properties;
  const ids = String(p.r).split(',').map(Number).filter((i) => DATA.routes[i]);
  if (selected !== null || focusedStation) resetHighlight();
  popup?.remove();
  focusedStation = { n: p.n, t: p.t, ids, xy: f.geometry.coordinates };
  highlightRoutes(ids);
  $('#search').value = '';
  renderStationDetail();
  document.body.classList.remove('sb-collapsed');
}

// Panel for a focused station: its lines grouped by network
function renderStationDetail() {
  const st = focusedStation;
  if (!st) return;
  setTabBar(null);
  panel.replaceChildren();
  const box = document.createElement('div');
  box.className = 'detail';
  const back = document.createElement('button');
  back.className = 'back';
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg> Totes les línies';
  back.addEventListener('click', () => deselect());

  const head = document.createElement('div');
  head.className = 'detail-head';
  const icon = document.createElement('img');
  icon.className = 'st-icon';
  icon.src = stationIconURL(st.t);
  icon.alt = '';
  const titles = document.createElement('div');
  titles.innerHTML = '<h2></h2><p class="muted"></p>';
  titles.querySelector('h2').textContent = st.n;
  const groups = new Map();
  for (const i of st.ids) {
    const g = DATA.routes[i].g;
    (groups.get(g) || groups.set(g, []).get(g)).push(i);
  }
  titles.querySelector('p').textContent = `${STATION_TYPES[st.t].label} · ${st.ids.length} línies · ${groups.size} xarxes`;
  head.append(icon, titles);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const fit = document.createElement('button');
  fit.className = 'btn';
  fit.textContent = 'Centra les línies';
  fit.addEventListener('click', () => fitRoutes(st.ids));
  const only = document.createElement('button');
  only.className = 'btn ghost';
  only.textContent = 'Mostra només aquestes';
  only.title = 'Amaga la resta de línies del mapa';
  only.addEventListener('click', () => {
    visible.fill(0);
    for (const i of st.ids) visible[i] = 1;
    onVisibilityChange();
  });
  actions.append(fit, only);
  box.append(back, head, actions);

  const order = Object.keys(DATA.groups);
  for (const g of [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
    const h = document.createElement('h3');
    h.className = 'st-group';
    h.append(groupIcon(g), document.createTextNode(` ${DATA.groups[g].name}`));
    box.append(h);
    for (const i of groups.get(g).sort(byRoute)) {
      const r = DATA.routes[i];
      const row = document.createElement('button');
      row.className = 'result';
      row.append(badge(r));
      const t = document.createElement('span');
      t.className = 'name';
      t.innerHTML = '<span></span>';
      t.firstChild.textContent = r.l || r.s;
      row.append(t);
      row.addEventListener('click', () => { focusedStation = null; selectRoute(i, true); });
      box.append(row);
    }
  }
  panel.append(box);
  panel.scrollTop = 0;
}

function clearSelection() {
  resetHighlight();
  renderTree();
}

function resetHighlight() {
  selected = null;
  focusedStation = null;
  map.setFilter('sel-casing', NONE);
  map.setFilter('sel-line', NONE);
  map.setFilter('sel-stops', NONE);
  for (const [l, v] of Object.entries(LINE_OPACITY)) map.setPaintProperty(l, 'line-opacity', v);
  map.setPaintProperty('stops', 'circle-opacity', 1);
  map.setPaintProperty('stops', 'circle-stroke-opacity', 1);
  setHashParam('linia', null);
}

// Sidebar covers the left part of the map on desktop: shift targets to the visible area.
function mapOffset() {
  if (window.innerWidth < 768) return [0, -window.innerHeight * 0.2];
  return [($('#sidebar').offsetWidth + 12) / 2, 0];
}

function focusStop(si, zoom = 15.5) {
  const s = DATA.stops[si];
  if (selected !== null && !DATA.routes[selected].st.includes(si)) resetHighlight();
  map.flyTo({ center: [s.x, s.y], zoom: Math.max(map.getZoom(), zoom), offset: mapOffset() });
  showStopPopup(si);
}

// Leave the selected line: clear the highlight and go back to the tab the user was on
function deselect() {
  popup?.remove();
  if (selected === null && !focusedStation) return;
  resetHighlight();
  if (!$('#search').value) renderPanel();
}

// Keeps MapLibre's `map=` hash param and our own params side by side.
function setHashParam(key, value) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (value == null) params.delete(key);
  else params.set(key, value);
  const s = params.toString().replace(/%2F/g, '/');
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
}

function routeListHTML(ids, title) {
  const wrap = document.createElement('div');
  wrap.className = 'pop';
  if (title) {
    const h = document.createElement('strong');
    h.textContent = title;
    wrap.append(h);
  }
  const list = document.createElement('div');
  list.className = 'pop-list';
  ids.sort((a, b) => DATA.groups[DATA.routes[a].g].rank - DATA.groups[DATA.routes[b].g].rank || byRoute(a, b));
  for (const i of ids.slice(0, 40)) {
    const r = DATA.routes[i];
    const btn = document.createElement('button');
    btn.append(badge(r));
    const s = document.createElement('span');
    s.textContent = r.l || r.s;
    btn.append(s);
    btn.addEventListener('click', () => selectRoute(i, false));
    list.append(btn);
  }
  if (ids.length > 40) {
    const more = document.createElement('small');
    more.className = 'muted';
    more.textContent = `i ${ids.length - 40} més…`;
    list.append(more);
  }
  wrap.append(list);
  return wrap;
}

function showStationPopup(f) {
  const p = f.properties;
  const ids = String(p.r).split(',').map(Number).filter((i) => DATA.routes[i]);
  popup?.remove();
  const content = routeListHTML(ids, p.n);
  const sub = document.createElement('div');
  sub.className = 'pop-zone';
  sub.innerHTML = `<img class="pop-st" src="${stationIconURL(p.t)}" alt=""> ${STATION_TYPES[p.t].label} · ${ids.length} línies`;
  content.querySelector('strong')?.after(sub);
  popup = new maplibregl.Popup({ maxWidth: '320px', offset: 14 })
    .setLngLat(f.geometry.coordinates)
    .setDOMContent(content)
    .addTo(map);
}

function showStopPopup(si) {
  const s = DATA.stops[si];
  popup?.remove();
  const ids = s.r.filter(isShown);
  const content = routeListHTML(ids.length ? ids : [...s.r], s.n);
  if (s.z) {
    const z = document.createElement('div');
    z.className = 'pop-zone';
    z.innerHTML = `<span class="zone-chip" style="--zc:${ZONE_COLORS[Number(s.z[0]) - 1]}">${s.z[0]}</span> Zona ${s.z[0]} · sector ${s.z}`;
    content.querySelector('strong')?.after(z);
  }
  popup = new maplibregl.Popup({ maxWidth: '320px', offset: 8 })
    .setLngLat([s.x, s.y])
    .setDOMContent(content)
    .addTo(map);
}

// ---------- base map switching ----------
const OUR_SOURCES = new Set(['lines', 'stops', 'catalunya', 'zones', 'amb', 'stations', 'vegueries', 'comarques', 'provincies']);
// our layers that go under the base map's labels; the rest stay on top
const BELOW_LABELS = new Set(['prov-fill', 'prov-border', 'veg-fill', 'veg-border', 'com-fill', 'com-border', 'cat-mask', 'cat-border-halo', 'cat-border', 'zones-fill', 'zones-line', 'amb-fill', 'amb-band', 'amb-line', 'lines-bus', 'lines-approx',
  'lines-tram', 'lines-rail-casing', 'lines-rail', 'planned-casing', 'planned-c', 'planned-p']);

function setBasemap(key) {
  if (!BASEMAPS[key] || key === basemapKey) return;
  basemapKey = key;
  safeStorage('set', 'basemap', key);
  map.setStyle(BASEMAPS[key].style, {
    // keep our sources and layers (with their current filters / paint) on top of the new base map
    transformStyle: (prev, next) => {
      if (!prev) return next;
      const sources = { ...next.sources };
      for (const id of OUR_SOURCES) if (prev.sources[id]) sources[id] = prev.sources[id];
      const ours = prev.layers.filter((l) => OUR_SOURCES.has(l.source));
      const below = ours.filter((l) => BELOW_LABELS.has(l.id));
      const above = ours.filter((l) => !BELOW_LABELS.has(l.id));
      const i = next.layers.findIndex((l) => l.type === 'symbol');
      const layers = i < 0
        ? [...next.layers, ...below, ...above]
        : [...next.layers.slice(0, i), ...below, ...next.layers.slice(i), ...above];
      return { ...next, glyphs: next.glyphs || prev.glyphs, sources, layers };
    },
  });
  map.once('style.load', applyBasemapTweaks);
}

// Per-basemap adjustments: Catalan names, hidden labels, dark-theme colours for our overlays
function applyBasemapTweaks() {
  const bm = BASEMAPS[basemapKey];
  addStationIcons(map); // images are dropped by setStyle
  localizeBasemap();
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && !OUR_SOURCES.has(l.source)) {
      map.setLayoutProperty(l.id, 'visibility', bm.labels === false ? 'none' : 'visible');
    }
  }
  const dark = !!bm.dark;
  map.setPaintProperty('cat-mask', 'fill-color', dark ? '#05070a' : '#e6e6ea');
  map.setPaintProperty('cat-mask', 'fill-opacity', dark ? 0.55 : ['interpolate', ['linear'], ['zoom'], 6, 0.75, 12, 0.55]);
  map.setPaintProperty('cat-border', 'line-color', dark ? '#d5d9e0' : '#4a4f57');
  map.setPaintProperty('cat-border-halo', 'line-color', dark ? '#000000' : '#5f6670');
  map.setPaintProperty('stop-labels', 'text-color', dark ? '#f1f1f1' : '#333333');
  map.setPaintProperty('stop-labels', 'text-halo-color', dark ? '#111111' : '#ffffff');
  map.setPaintProperty('lines-labels', 'text-halo-color', dark ? '#111111' : '#ffffff');
  map.setPaintProperty('amb-label', 'text-color', dark ? '#ff9aa9' : '#8f0b21');
  map.setPaintProperty('com-border', 'line-color', dark ? '#d5d9e0' : '#4a4f57');
  for (const l of ['com-label', 'prov-label']) {
    map.setPaintProperty(l, 'text-color', dark ? '#e6e8ec' : (l === 'com-label' ? '#4a4f57' : '#5a5f66'));
    map.setPaintProperty(l, 'text-halo-color', dark ? '#111111' : '#ffffff');
  }
  for (const l of ['stations-0', 'stations-1', 'stations-2']) {
    map.setPaintProperty(l, 'text-color', dark ? '#f1f1f1' : '#1c1f24');
    map.setPaintProperty(l, 'text-halo-color', dark ? '#111111' : '#ffffff');
  }
  map.setPaintProperty('amb-label', 'text-halo-color', dark ? '#111111' : '#ffffff');
  for (const l of ['lines-rail-casing', 'planned-casing', 'sel-casing']) map.setPaintProperty(l, 'line-color', dark ? '#0d0f13' : '#ffffff');
  document.querySelectorAll('.basemap-opt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.key === basemapKey)));
}

// Show basemap place names in Catalan when available.
function localizeBasemap() {
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(l.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name')) {
      map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ca'], ['get', 'name:latin'], ['get', 'name']]);
    }
  }
}

function addLayers() {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('lines', { type: 'geojson', data: asset('data/lines.geojson'), tolerance: 0.2 });
  map.addSource('stops', { type: 'geojson', data: asset('data/stops.geojson') });
  map.addSource('catalunya', { type: 'geojson', data: asset('data/catalunya.geojson') });
  map.addSource('zones', { type: 'geojson', data: asset('data/zones.geojson') });
  map.addSource('amb', { type: 'geojson', data: asset('data/amb.geojson') });
  map.addSource('vegueries', { type: 'geojson', data: asset('data/vegueries.geojson') });
  map.addSource('comarques', { type: 'geojson', data: asset('data/comarques.geojson') });
  map.addSource('provincies', { type: 'geojson', data: asset('data/provincies.geojson') });
  map.addSource('stations', { type: 'geojson', data: asset('data/stations.geojson') });
  addStationIcons(map);

  // Outside Catalonia: greyed out; border: dark red line with a white halo (all below transit lines)
  const pvis = showProvincies ? 'visible' : 'none';
  map.addLayer({
    id: 'prov-fill', type: 'fill', source: 'provincies', filter: ['==', ['get', 'k'], 'v'],
    layout: { visibility: pvis },
    paint: {
      'fill-color': ['match', ['get', 'c'], ...Object.entries(PROVINCIA_COLORS).flat(), '#999'],
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.32, 12, 0.15],
    },
  }, firstSymbol);
  map.addLayer({
    id: 'prov-border', type: 'line', source: 'provincies', filter: ['==', ['get', 'k'], 'b'],
    layout: { visibility: pvis, 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 4.5] },
  }, firstSymbol);
  const vvis = showVegueries ? 'visible' : 'none';
  const vegColor = ['match', ['get', 'c'], ...Object.entries(VEGUERIA_COLORS).flat(), '#999'];
  map.addLayer({
    id: 'veg-fill', type: 'fill', source: 'vegueries', filter: ['==', ['get', 'k'], 'v'],
    layout: { visibility: vvis },
    paint: { 'fill-color': vegColor, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 0.15] },
  }, firstSymbol);
  map.addLayer({
    id: 'veg-border', type: 'line', source: 'vegueries', filter: ['==', ['get', 'k'], 'b'],
    layout: { visibility: vvis, 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 12, 3.5], 'line-opacity': 0.95 },
  }, firstSymbol);
  const cvis = showComarques ? 'visible' : 'none';
  map.addLayer({
    id: 'com-fill', type: 'fill', source: 'comarques', filter: ['==', ['get', 'k'], 'v'],
    layout: { visibility: cvis },
    paint: { 'fill-color': '#5f6670', 'fill-opacity': 0.03 }, // nearly invisible: only there to be clicked
  }, firstSymbol);
  map.addLayer({
    id: 'com-border', type: 'line', source: 'comarques', filter: ['==', ['get', 'k'], 'b'],
    layout: { visibility: cvis, 'line-join': 'round' },
    paint: { 'line-color': '#4a4f57', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.6] },
  }, firstSymbol);
  map.addLayer({
    id: 'cat-mask', type: 'fill', source: 'catalunya', filter: ['==', ['get', 'kind'], 'mask'],
    paint: { 'fill-color': '#e6e6ea', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 12, 0.55] },
  }, firstSymbol);
  map.addLayer({
    id: 'cat-border-halo', type: 'line', source: 'catalunya', filter: ['==', ['get', 'kind'], 'border'],
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': '#5f6670', 'line-opacity': 0.22,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 12, 12],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 8],
    },
  }, firstSymbol);
  map.addLayer({
    id: 'cat-border', type: 'line', source: 'catalunya', filter: ['==', ['get', 'kind'], 'border'],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#4a4f57', 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 12, 1.4] },
  }, firstSymbol);
  const zoneColor = ['match', ['get', 'z'], ...ZONE_COLORS.flatMap((c, i) => [i + 1, c]), '#999'];
  const zvis = showZones ? 'visible' : 'none';
  map.addLayer({
    id: 'zones-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'k'], 'm'],
    layout: { visibility: zvis },
    paint: { 'fill-color': zoneColor, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.35, 13, 0.2] },
  }, firstSymbol);
  map.addLayer({
    id: 'zones-line', type: 'line', source: 'zones', filter: ['==', ['get', 'k'], 'm'],
    layout: { visibility: zvis },
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 1.2], 'line-opacity': 0.8 },
  }, firstSymbol);
  const avis = showAmb ? 'visible' : 'none';
  map.addLayer({
    id: 'amb-fill', type: 'fill', source: 'amb', filter: ['==', ['get', 'k'], 'm'],
    layout: { visibility: avis },
    paint: { 'fill-color': AMB_COLOR, 'fill-opacity': 0.06 },
  }, firstSymbol);
  map.addLayer({
    id: 'amb-band', type: 'line', source: 'amb', filter: ['==', ['get', 'k'], 'border'],
    layout: { visibility: avis, 'line-join': 'round' },
    paint: {
      'line-color': AMB_COLOR, 'line-opacity': 0.22,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 14],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 9],
    },
  }, firstSymbol);
  map.addLayer({
    id: 'amb-line', type: 'line', source: 'amb', filter: ['==', ['get', 'k'], 'border'],
    layout: { visibility: avis, 'line-join': 'round' },
    paint: { 'line-color': '#7a0a1c', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 13, 1.6] },
  }, firstSymbol);

  map.addLayer({
    id: 'lines-bus', type: 'line', source: 'lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': widthExpr(LINE_WIDTHS['lines-bus'], appliedFactor), 'line-opacity': LINE_OPACITY['lines-bus'] },
  }, firstSymbol);
  map.addLayer({
    id: 'lines-approx', type: 'line', source: 'lines',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': widthExpr(LINE_WIDTHS['lines-approx'], appliedFactor), 'line-opacity': LINE_OPACITY['lines-approx'], 'line-dasharray': [2, 2] },
  }, firstSymbol);
  map.addLayer({
    id: 'lines-tram', type: 'line', source: 'lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': widthExpr(LINE_WIDTHS['lines-tram'], appliedFactor), 'line-opacity': 1 },
  }, firstSymbol);
  map.addLayer({
    id: 'lines-rail-casing', type: 'line', source: 'lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': widthExpr(LINE_WIDTHS['lines-rail-casing'], appliedFactor), 'line-opacity': 1 },
  }, firstSymbol);
  map.addLayer({
    id: 'lines-rail', type: 'line', source: 'lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': widthExpr(LINE_WIDTHS['lines-rail'], appliedFactor), 'line-opacity': 1 },
  }, firstSymbol);
  map.addLayer({
    id: 'planned-casing', type: 'line', source: 'lines', filter: NONE,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': widthExpr(LINE_WIDTHS['planned-casing'], appliedFactor), 'line-opacity': LINE_OPACITY['planned-casing'] },
  }, firstSymbol);
  map.addLayer({
    id: 'planned-c', type: 'line', source: 'lines', filter: NONE,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': widthExpr(LINE_WIDTHS['planned-c'], appliedFactor), 'line-dasharray': [1.6, 0.9], 'line-opacity': 1 },
  }, firstSymbol);
  map.addLayer({
    id: 'planned-p', type: 'line', source: 'lines', filter: NONE,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': widthExpr(LINE_WIDTHS['planned-p'], appliedFactor), 'line-dasharray': [0.6, 1.4], 'line-opacity': LINE_OPACITY['planned-p'] },
  }, firstSymbol);
  map.addLayer({
    id: 'sel-casing', type: 'line', source: 'lines', filter: NONE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': widthExpr(LINE_WIDTHS['sel-casing'], appliedFactor) },
  });
  map.addLayer({
    id: 'sel-line', type: 'line', source: 'lines', filter: NONE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#000', 'line-width': widthExpr(LINE_WIDTHS['sel-line'], appliedFactor) },
  });
  map.addLayer({
    id: 'stops', type: 'circle', source: 'stops', minzoom: 9,
    filter: NONE,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'k'], [0], 1.5, 0], 11, ['match', ['get', 'k'], [0], 3, [1], 2, 0], 13, ['match', ['get', 'k'], [0, 1], 4, 2], 17, 7],
      'circle-color': '#ffffff',
      'circle-stroke-color': ['match', ['get', 'k'], [0], '#333', [1], '#555', '#888'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2],
    },
  });
  map.addLayer({
    id: 'sel-stops', type: 'circle', source: 'stops', filter: NONE,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 13, 5, 17, 8],
      'circle-color': '#ffffff',
      'circle-stroke-color': '#000',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 15, 3],
    },
  });
  map.addLayer({
    id: 'lines-labels', type: 'symbol', source: 'lines', minzoom: 13,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 350,
      'text-field': ['get', 's'],
      'text-size': 11,
      'text-font': ['Noto Sans Bold'],
      'text-max-angle': 30,
      'text-padding': 4,
    },
    paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  });
  // stations: tier 0 from far away, tier 1 regional, tier 2 local; names appear later than icons
  const svis = showStations ? 'visible' : 'none';
  [[0, 6, 9], [1, 9, 11.5], [2, 11, 13]].forEach(([tier, minzoom, labelZoom]) => {
    map.addLayer({
      id: `stations-${tier}`, type: 'symbol', source: 'stations', minzoom,
      filter: ['==', ['get', 'k'], tier],
      layout: {
        visibility: svis,
        'icon-image': ['concat', 'st-', ['get', 't']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, tier === 0 ? 0.75 : 0.6, 12, tier === 0 ? 1 : 0.85, 16, 1.1],
        'icon-allow-overlap': tier === 0,
        'symbol-sort-key': ['-', 0, ['get', 'sc']],
        'text-field': ['step', ['zoom'], '', labelZoom, ['get', 'n']],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 13],
        'text-offset': [0, 1.25], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9,
      },
      paint: { 'text-color': '#1c1f24', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
    });
  });
  map.addLayer({
    id: 'prov-label', type: 'symbol', source: 'provincies', filter: ['==', ['get', 'k'], 'l'], maxzoom: 9,
    layout: {
      visibility: showProvincies ? 'visible' : 'none',
      'text-field': ['upcase', ['get', 'n']], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 13, 9, 18], 'text-letter-spacing': 0.2,
    },
    paint: { 'text-color': '#5a5f66', 'text-halo-color': '#ffffff', 'text-halo-width': 2, 'text-opacity': 0.85 },
  });
  map.addLayer({
    id: 'com-label', type: 'symbol', source: 'comarques', filter: ['==', ['get', 'k'], 'l'], minzoom: 7.5, maxzoom: 12,
    layout: {
      visibility: showComarques ? 'visible' : 'none',
      'text-field': ['get', 'n'], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 7.5, 10, 11, 13], 'text-max-width': 7,
    },
    paint: { 'text-color': '#4a4f57', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
  });
  map.addLayer({
    id: 'veg-label', type: 'symbol', source: 'vegueries', filter: ['==', ['get', 'k'], 'l'], maxzoom: 10,
    layout: {
      visibility: showVegueries ? 'visible' : 'none',
      'text-field': ['upcase', ['get', 'n']], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 9, 15], 'text-letter-spacing': 0.12, 'text-max-width': 8,
    },
    paint: {
      'text-color': ['match', ['get', 'c'], ...Object.entries(VEGUERIA_COLORS).flat(), '#555'],
      'text-halo-color': '#ffffff', 'text-halo-width': 2, 'text-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'amb-label', type: 'symbol', source: 'amb', filter: ['==', ['get', 'k'], 'border'], minzoom: 10,
    layout: {
      visibility: showAmb ? 'visible' : 'none',
      'symbol-placement': 'line', 'symbol-spacing': 600, 'text-field': 'Àrea Metropolitana de Barcelona',
      'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-letter-spacing': 0.05,
    },
    paint: { 'text-color': '#8f0b21', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5, 'text-opacity': 0.8 },
  });
  map.addLayer({
    id: 'zones-label', type: 'symbol', source: 'zones', filter: ['==', ['get', 'k'], 'l'], minzoom: 8,
    layout: {
      visibility: showZones ? 'visible' : 'none',
      'text-field': ['get', 's'], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 16], 'text-allow-overlap': false,
    },
    paint: { 'text-color': ['match', ['get', 'z'], ...ZONE_COLORS.flatMap((c, i) => [i + 1, c]), '#555'], 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'stop-labels', type: 'symbol', source: 'stops', minzoom: 14,
    filter: ['<=', ['get', 'k'], 1],
    layout: {
      'text-field': ['get', 'n'], 'text-size': 11, 'text-font': ['Noto Sans Regular'],
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });

  applyMapFilters();

  const lineLayers = ['sel-line', 'lines-rail', 'lines-tram', 'planned-c', 'planned-p', 'lines-bus', 'lines-approx'];
  map.on('click', (e) => {
    const pad = 6;
    const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const stationHit = showStations && map.queryRenderedFeatures(box, { layers: ['stations-0', 'stations-1', 'stations-2'] })[0];
    if (stationHit) return stationFocus ? focusStation(stationHit) : showStationPopup(stationHit);
    const stopHits = map.queryRenderedFeatures(box, { layers: ['sel-stops', 'stops'] });
    if (stopHits.length) return showStopPopup(stopHits[0].properties.i);
    const hits = map.queryRenderedFeatures(box, { layers: lineLayers });
    const ids = [...new Set(hits.map((f) => f.properties.i))];
    if (!ids.length) {
      // click on empty map: first deselect the highlighted line, if any
      if (selected !== null || focusedStation) {
        deselect();
        return;
      }
      // area under the cursor: one line per active territorial layer
      const at = (on, layer) => (on && map.queryRenderedFeatures(e.point, { layers: [layer] })[0]) || null;
      const zf = at(showZones, 'zones-fill');
      const af = at(showAmb, 'amb-fill');
      const vf = at(showVegueries, 'veg-fill');
      const cf = at(showComarques, 'com-fill');
      const pf = at(showProvincies, 'prov-fill');
      if (!zf && !af && !vf && !cf && !pf) return;
      popup?.remove();
      const div = document.createElement('div');
      div.className = 'pop';
      const title = document.createElement('strong');
      // municipality name when a municipal layer is on, otherwise the most local unit
      title.textContent = (zf || af)?.properties.n || cf?.properties.n || vf?.properties.n || pf?.properties.n;
      div.append(title);
      const line = (html, text) => {
        const d = document.createElement('div');
        d.className = 'pop-zone';
        d.innerHTML = html;
        if (text) d.append(text);
        div.append(d);
      };
      if (zf) line(`<span class="zone-chip" style="--zc:${ZONE_COLORS[zf.properties.z - 1]}">${zf.properties.z}</span> Zona ${zf.properties.z} · sector ${zf.properties.s}`);
      if (af) line('<span class="amb-swatch"></span> Àrea Metropolitana de Barcelona');
      if (cf && (zf || af)) line('<span class="veg-swatch com"></span> Comarca: ', cf.properties.n);
      else if (!cf && (zf || af)) line('<span class="veg-swatch com"></span> Comarca: ', (zf || af).properties.c);
      if (vf) line(`<span class="veg-swatch" style="background:${VEGUERIA_COLORS[vf.properties.c]}"></span> Vegueria: `, vf.properties.n);
      if (pf) line(`<span class="veg-swatch" style="background:${PROVINCIA_COLORS[pf.properties.c]}"></span> Província: `, pf.properties.n);
      popup = new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setDOMContent(div).addTo(map);
      return;
    }
    if (ids.length === 1) return selectRoute(ids[0], false);
    popup?.remove();
    popup = new maplibregl.Popup({ maxWidth: '320px', offset: 4 })
      .setLngLat(e.lngLat)
      .setDOMContent(routeListHTML(ids, `${ids.length} línies`))
      .addTo(map);
  });
  for (const l of [...lineLayers, 'stops', 'sel-stops', 'stations-0', 'stations-1', 'stations-2']) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ---------- init ----------
async function init() {
  const hadHash = location.hash.includes('map=');
  const CATALUNYA_BOUNDS = [[0.16, 40.52], [3.33, 42.86]];
  const fitPadding = () => (window.innerWidth < 768
    ? { top: 20, left: 10, right: 10, bottom: window.innerHeight * 0.55 }
    : { top: 30, bottom: 30, right: 30, left: 410 });
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS[basemapKey].style,
    bounds: [[0.16, 40.52], [3.33, 42.86]], // Catalunya
    fitBoundsOptions: {
      padding: window.innerWidth < 768
        ? { top: 20, left: 10, right: 10, bottom: window.innerHeight * 0.55 }
        : { top: 30, bottom: 30, right: 30, left: 410 },
    },
    minZoom: window.innerWidth < 768 ? 5.6 : 6.3, // whole Catalonia must still fit on a phone
    maxBounds: [[-1.6, 39.4], [5.0, 44.0]], // Catalonia and surroundings
    hash: 'map',
    attributionControl: { compact: true },
  });
  if (import.meta.env.DEV) window.__map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  const [data] = await Promise.all([
    fetch(asset('data/index.json')).then((r) => r.json()),
    new Promise((res) => map.once('load', res)),
  ]);
  // the container may have been resized while loading: frame Catalonia again unless the URL has a position
  if (!hadHash) map.fitBounds(CATALUNYA_BOUNDS, { padding: fitPadding(), animate: false });
  DATA = data;
  visible = new Uint8Array(DATA.routes.length).fill(1);
  const hidden = new Set(JSON.parse(safeStorage('get', 'hidden') || '[]'));
  DATA.routes.forEach((r, i) => { if (hidden.has(r.id)) visible[i] = 0; });
  passes = new Uint8Array(DATA.routes.length);
  if (placeFilter && !DATA.places?.[placeFilter.t === 'c' ? 'comarques' : 'munis']?.[placeFilter.i]) placeFilter = null;
  recomputePasses();

  tree = buildTree();
  indexNodes(tree);
  renderPanel();
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    $('#search').value = '';
    popup?.remove();
    if (selected !== null || focusedStation) resetHighlight();
    showTab(t.dataset.tab);
  }));
  syncChecks();
  updateFooter();
  appliedFactor = widthFactor();
  addLayers();
  applyBasemapTweaks();

  panel.addEventListener('scroll', () => {
    if (selected === null && !$('#search').value) safeStorage('set', `scroll:${currentTab}`, String(panel.scrollTop));
  });

  let t;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      const q = e.target.value.trim();
      if (q.length >= 2) renderSearch(q);
      else if (selected !== null) renderRouteDetail(selected);
      else if (focusedStation) renderStationDetail();
      else renderPanel();
    }, 120);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('.group-result-btn, button.result')?.click();
    if (e.key === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); }
  });
  $('#sb-toggle').addEventListener('click', () => document.body.classList.toggle('sb-collapsed'));
  // Esc anywhere outside the search box deselects too
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target !== $('#search')) deselect();
  });

  const linia = new URLSearchParams(location.hash.slice(1)).get('linia');
  if (linia) {
    const i = DATA.routes.findIndex((r) => r.id === linia);
    if (i >= 0) { visible[i] = 1; if (!passes[i]) { activeFilters.clear(); placeFilter = null; onFiltersChange(); } applyMapFilters(); selectRoute(i, !location.hash.includes('map=')); }
  }
}

init().catch((e) => {
  console.error(e);
  panel.innerHTML = '<div class="loading">No s’han pogut carregar les dades.</div>';
});
