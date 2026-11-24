// Network groups shown in the sidebar and rules to classify GTFS routes into them.

// rank: drawing / stop priority (lower = more important)
export const GROUPS = {
  metro:        { name: 'Metro de Barcelona',               category: 'rail', color: '#E2001A', rank: 0, icon: 'M' },
  fgc:          { name: 'Ferrocarrils de la Generalitat',   category: 'rail', color: '#97D700', rank: 0, icon: 'FGC' },
  rodalies:     { name: 'Rodalies de Catalunya',            category: 'rail', color: '#E87200', rank: 0, icon: 'R' },
  renfe:        { name: 'Regionals i Alta Velocitat',       category: 'rail', color: '#7A1E99', rank: 0, icon: 'RG' },
  ferroext:     { name: 'Llarga distància i internacional', category: 'rail', color: '#5B2C83', rank: 1, icon: 'LD' },
  tram:         { name: 'TRAM Barcelona',                   category: 'rail', color: '#008C7A', rank: 1, icon: 'T' },
  funicular:    { name: 'Funiculars i cremalleres',         category: 'rail', color: '#4A4A4A', rank: 1, icon: 'F' },
  tmb_bus:      { name: 'Bus TMB (Barcelona)',              category: 'bus',  color: '#E2001A', rank: 2, icon: 'TMB' },
  amb:          { name: 'Bus metropolità AMB',              category: 'bus',  color: '#C8102E', rank: 2, icon: 'AMB' },
  expres:       { name: 'Exprés.cat',                       category: 'bus',  color: '#D7141A', rank: 2, icon: 'e' },
  urba:         { name: 'Bus urbà',                         category: 'bus',  color: '#1E88E5', rank: 3, icon: 'U' },
  interurba:    { name: 'Bus interurbà',                    category: 'bus',  color: '#43A047', rank: 3, icon: 'IB' },
  rodalies_bus: { name: 'Bus Rodalies (substitutori)',      category: 'bus',  color: '#E87200', rank: 3, icon: 'RB' },
  llarga:       { name: 'Autocars de llarga distància',     category: 'bus',  color: '#5E35B1', rank: 3, icon: 'LD' },
  estatal:      { name: 'Línies estatals (interregionals)', category: 'bus',  color: '#1F4E9C', rank: 3, icon: 'ES' },
  construccio:  { name: 'En construcció',                   category: 'planned', color: '#F57C00', rank: 4, icon: 'OB' },
  projecte:     { name: 'Projectades',                      category: 'planned', color: '#78909C', rank: 4, icon: 'PR' },
  anunciat:     { name: 'Bus anunciat',                     category: 'planned', color: '#E65100', rank: 4, icon: 'BA' },
};

// French .liO / Hérault networks included in the ATM feed
export const EXCLUDED_AGENCY_PREFIXES = ['LIO_'];

// Urban bus networks: agency id -> municipality label
const URBAN = {
  ABR_1: 'Abrera',
  AMP_1: 'Amposta',
  CUB_1: 'Cubelles',
  CUN_1: 'Cunit',
  EMP_1: 'Empuriabrava',
  FIG_47: 'Figueres',
  GIR_TMG: 'Girona',
  GRA_7: 'Granollers',
  LLE_5: 'Lleida',
  MAN_6: 'Manresa',
  MAS_Masats: 'Igualada',
  MAT_1: 'Mataró',
  MON_1: 'Mont-roig del Camp',
  MOR_1: "Móra d'Ebre",
  OLO_OLO: 'Olot',
  PUI_1: 'Puigcerdà',
  REU_: 'Reus',
  ROS_1: 'Roses',
  RUB_1: 'Rubí',
  SSL_88: 'Martorell',
  TAR_EMT: 'Tarragona',
  TCC_4: 'Sitges',
  TRD_1: 'Torredembarra',
  TTS_1: 'Tortosa',
  TUS_109: 'Sabadell',
  VFP_AP: 'Vilafranca del Penedès',
  VHI_1: "Vandellós i l'Hospitalet de l'Infant",
  VIC_3: 'Vic',
};

const MODE_BY_TYPE = {
  0: 'tram', 1: 'metro', 2: 'rail', 3: 'bus', 4: 'ferry', 5: 'funicular', 6: 'funicular', 7: 'funicular',
  11: 'bus', 12: 'rail', 200: 'coach',
};

const LEGAL_SUFFIX = /,?\s*\b(S\.?A\.?U?\.?|S\.?L\.?U?\.?|SAT|S\.At)\b\.?(\s*\([^)]*\))?\s*$/i;

function titleCase(s) {
  const small = new Set(['i', 'de', 'del', 'la', 'les', 'el', 'els', 'y']);
  return s.toLowerCase().replace(/[\p{L}.']+/gu, (w, idx) =>
    idx > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
}

function normalizeAgency(name) {
  let n = name.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  // drop ", SA", ", SL (AMPSA)", ", SA -TEISA-", ", SAU i Marfina Bus, SA"…
  n = n.replace(/,\s*(S\.?A\.?U?|S\.?L\.?U?)\b\.?.*$/i, '').replace(LEGAL_SUFFIX, '').replace(/[,\s-]+$/, '').trim();
  if (!/\p{Ll}/u.test(n)) n = titleCase(n); // ALL CAPS -> Title Case
  return n;
}

// Company / group brands. When an agency name mentions several (joint services),
// the brand that appears first in the name wins.
const BRANDS = [
  [/renfe/i, 'Renfe'],
  [/ouigo/i, 'Ouigo'],
  [/iryo|ilsa/i, 'iryo'],
  [/sagal[eé]s/i, 'Sagalés'],
  [/moventis|sarbus|sarfa|\bcasas\b|vallesana/i, 'Moventis'],
  [/alsina graells|\balsa\b/i, 'Alsa'],
  [/direxis|olesa|tusgsal|masats/i, 'Direxis'],
  [/monbus|hispano igualadina/i, 'Monbus'],
  [/\bhife\b|fuente en segures/i, 'HIFE'],
  [/teisa|el[eè]ctrics interurbans/i, 'TEISA'],
  [/\bplana\b/i, 'Empresa Plana'],
  [/cots alsina/i, 'Cots Alsina'],
  [/soler i sauret/i, 'Soler i Sauret'],
  [/avanza/i, 'Avanza'],
  [/autocorb/i, 'Autocorb'],
  [/barrera/i, 'Autocars Barrera'],
  [/montferri/i, 'Montferri'],
  [/gam[oó]n/i, 'Autocars Gamón'],
  [/r\. font/i, 'Autocares R. Font'],
  [/[ií]zaro/i, 'Autocares Ízaro'],
  [/franch/i, 'Autocars Franch'],
  [/barcelona bus/i, 'Barcelona Bus'],
  [/marfina/i, 'Marfina Bus'],
  [/cintoi/i, 'Cintoi Bus'],
  [/estarriol/i, 'Estarriol Bus'],
];

const COMPANY_WORDS = /bus|autocar|transport|servei|tur[ií]stic|motiland|circuitos|grup|empresa|hispano|ferrocarril|balliu|busgarvi/i;

// Canonical names for subsidiaries / areas that appear spelled several ways.
const AREA_ALIASES = [
  [/^empresa casas$/i, 'Casas'],
  [/^(transports el[eè]ctrics interurbans|teisa interurbans)$/i, 'TEISA'],
  [/^teisa\/sarfa$/i, 'TEISA i Sarfa'],
  [/^(sa )?alsina graells( de auto transportes)?$/i, 'Alsina Graells'],
  [/^grup d'empreses: sa alsina graells at, lhife$/i, 'Alsina Graells i HIFE'],
  [/^alsa - nex continental$/i, 'Nex Continental'],
  [/^cintoi bus - empresa plana$/i, 'Cintoi Bus i Empresa Plana'],
  [/plana$/i, 'Empresa Plana'],
  [/fuente en segures|^hife$/i, 'HIFE'],
  [/olesa|^direxis tgo$/i, "TGO (Transports Generals d'Olesa)"],
  [/^direxis tusgsal$/i, 'Tusgsal'],
  [/masats/i, 'Masats'],
  [/montferri/i, 'Montferri'],
  [/^miguel gam[oó]n$/i, 'Miguel Gamón'],
  [/^autocares barrera$/i, 'Autocars Barrera'],
  [/^autocares izaro$/i, 'Autocares Ízaro'],
  [/^barcelona bus sl i sarfa$/i, 'Barcelona Bus i Sarfa'],
];

/** { company, area } for a bus agency name. */
export function companyOf(agencyId, agencyName) {
  let area = normalizeAgency(agencyName);
  for (const [re, name] of AREA_ALIASES) if (re.test(area)) { area = name; break; }
  let best = null;
  for (const [re, brand] of BRANDS) {
    const m = agencyName.match(re);
    if (m && (!best || m.index < best.index)) best = { index: m.index, brand };
  }
  if (best) return { company: best.brand, area };
  // Self-employed operators (people's names) of small on-demand services
  if (agencyId.startsWith('GEN_') && !/\b(S\.?A\.?U?|S\.?L\.?U?)\b/i.test(agencyName) && !COMPANY_WORDS.test(agencyName)) {
    return { company: 'Petits operadors', area };
  }
  return { company: area, area };
}

/** Returns { group, subgroup, mode, category } or null to drop the route. */
export function classifyRoute(r, agencyName) {
  const a = r.agency_id;
  const type = Number(r.route_type);
  let mode = MODE_BY_TYPE[type] ?? (type >= 100 && type < 200 ? 'rail' : type >= 700 && type < 800 ? 'bus' : 'bus');
  let group;
  let subgroup = null;
  let subgroup2 = null;

  if (mode === 'funicular') group = 'funicular';
  else if (a.startsWith('TMB_')) group = mode === 'metro' ? 'metro' : 'tmb_bus';
  else if (a.startsWith('FGC_')) group = 'fgc';
  else if (a.startsWith('ROD_')) group = 'rodalies';
  else if (a.startsWith('REG_') || a.startsWith('AVE_')) group = 'renfe';
  else if (a.startsWith('TBX_') || a.startsWith('TBS_')) group = 'tram';
  else if (a.startsWith('RBU_')) group = 'rodalies_bus';
  else if (URBAN[a]) { group = 'urba'; subgroup = URBAN[a]; }
  else {
    // exprés.cat: the Generalitat's express interurban network, lines e1, E11.1, E16…
    const expres = mode === 'bus' && !a.startsWith('AMB_') && /^e\d+(\.\d+)?$/i.test((r.route_short_name || '').trim());
    group = a.startsWith('AMB_') ? 'amb' : expres ? 'expres' : mode === 'coach' ? 'llarga' : 'interurba';
    const { company, area } = companyOf(a, agencyName);
    subgroup = company;
    // Third level only when it adds information (subsidiary / area name differs from the brand)
    if (area !== company) subgroup2 = area;
  }

  // Substitute buses of rail operators stay in their network but are drawn as bus
  if (mode === 'coach') mode = 'bus';
  const company = companyOf(a, agencyName).company;
  return { group, subgroup, subgroup2, company, mode, category: GROUPS[group].category };
}
