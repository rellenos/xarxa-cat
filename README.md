# Visor del transport públic de Catalunya

Mapa web amb totes les línies de transport públic de Catalunya (metro, FGC, Rodalies,
regionals, TRAM, funiculars, bus TMB, bus AMB, bus urbà, bus interurbà i autocars),
amb filtres per xarxa / operador / línia, cercador de línies i parades i fitxa de cada línia.

## Ús

```sh
npm install
npm run data     # descarrega el GTFS i genera public/data/*  (--refresh per tornar a descarregar)
npm run dev      # http://localhost:5173
npm run build    # web estàtica a dist/
```

## Publicació (GitHub Pages)

`.github/workflows/deploy.yml` construeix les dades i la web i la publica a GitHub Pages a cada push a `main`,
cada dilluns (GTFS nous) i a mà (*Actions → Run workflow*). Cal activar-ho un cop a *Settings → Pages → Source:
GitHub Actions*. `public/data/` no es versiona: el workflow el genera. Les dades d'OpenStreetMap i ICGC es
llegeixen de `data/raw/` (per actualitzar-les: `npm run data -- --refresh` en local i commit). Les rutes per
carretera d'OSRM es guarden a la cache d'Actions (llavor: `data/cache/osrm-routes.json`).

## Dades

- Font principal: GTFS agregat de l'**ATM** "Autobusos i trens de Catalunya" (Punt d'Accés Nacional),
  descarregat sense clau des del mirall de Mobility Database:
  `https://files.mobilitydatabase.org/mdb-2826/latest.zip` (~95 MB).
  Inclou ~200 operadors: TMB, FGC, Rodalies, Renfe regionals, TRAM, AMB, bus interurbà de la
  Generalitat i busos urbans (Girona, Lleida, Tarragona, Reus, Sabadell, Mataró…).
- Les línies franceses (.liO / Hérault) que porta el feed s'exclouen.
- **Llarga distància i internacional** (ferrocarril): Renfe AV/LD/MD (mdb-2620), Ouigo (mdb-2785) i iryo (mdb-3645),
  només rutes que creuen la frontera de Catalunya. Renfe i Ouigo no publiquen traçat: es calcula sobre la xarxa
  ferroviària d'OpenStreetMap (`scripts/railroute.mjs`, A* sobre les vies dins el requadre del mapa, preferint alta
  velocitat per AVE/Euromed/Alvia/Ouigo). Fora del requadre la línia es talla a la vora. Cache: `data/raw/osm-rail.json`.
  Al panell: operador (Renfe, Ouigo, iryo) i, dins de Renfe, el producte (AVE, Avlo, Alvia, Euromed, Intercity,
  Regional, Regional Exprés) segons el `route_short_name` (`service` a `FEEDS`).
- **Exprés.cat**: les línies de bus interurbà amb número `e1`, `e2`… (no AMB) van a un grup propi, agrupades per empresa.
- **Línies estatals**: feed nacional d'ALSA (`https://files.mobilitydatabase.org/mdb-2825/latest.zip`). Només les rutes
  amb parades dins i fora de Catalunya que l'ATM no porta (Barcelona–Madrid, –Saragossa, –Andalusia…). Els feeds
  d'Avanza (VAC-124 Osca–Lleida, VAC-245 Osca–Barcelona) estan caducats (2024) i no s'inclouen.
- `scripts/groups.mjs` decideix a quina xarxa del panell va cada ruta (afegir municipis urbans a `URBAN`).
  Els busos AMB, interurbans i de llarga distància s'agrupen per empresa/grup (`BRANDS`: Moventis,
  Sagalés, Alsa, Monbus, Direxis…) i, a dins, per filial o àmbit (`AREA_ALIASES` unifica noms escrits diferent).
  Els autònoms amb una sola línia van a "Petits operadors".
- Línies duplicades (mateixa empresa + mateix número + mateixa zona, venen del feed de la Generalitat i del de
  l'operador) es fusionen en una.
- `scripts/build-data.mjs` tria els traçats representatius de cada línia, els simplifica i genera:
  - `index.json` – línies, xarxes i parades (per al panell i el cercador)
  - `lines.geojson` – traçats (una feature per línia)
  - `stops.geojson` – parades
- Línies sense traçat oficial (autocars Alsa, urbans de Reus i Tarragona…) es calculen per carretera
  entre parades amb el servidor públic d'OSRM (1 petició/s). El resultat es desa a `data/cache/osrm-routes.json`
  i només es torna a demanar si canvien les parades.
- **Línies en projecte / construcció**: de les vies d'OpenStreetMap amb `railway=construction|proposed`
  (Overpass API, `scripts/planned.mjs`). Es desa a `data/raw/osm-planned.json`; `--refresh` les torna a baixar.
  `NAME_ALIASES` / `UNNAMED_PROJECTS` agrupen trams que formen part del mateix projecte.

- **Filtres** (pestanya Xarxes): nocturns (`N1`, `N-80`… o "nocturn" al nom), exprés.cat, a demanda (`TAD` al nom o
  parades amb `pickup_type`/`drop_off_type` = 2), accessibles (≥ 90 % d'expedicions amb `wheelchair_accessible` = 1;
  FGC, Rodalies i molts operadors no ho publiquen) i comarca / municipi (cada parada se situa dins els límits ICGC →
  camp `mu` de cada línia, `places` a `index.json`). Els tipus de servei se sumen; accessibilitat i lloc restringeixen.

Per afegir un altre feed GTFS, afegeix-lo a `FEEDS` a `scripts/build-data.mjs`.

- **Límit de Catalunya**: relació OSM 349053 via Nominatim, desat a `data/raw/catalunya-boundary.json` i
  convertit a `public/data/catalunya.geojson` (contorn + màscara per enfosquir l'exterior).

- **Zones tarifàries ATM**: sector de cada parada (`areas.txt` + `stop_areas.txt` del feed ATM). Cada municipi
  (límits de l'ICGC 1:250.000, `data/raw/icgc/`) pren el sector majoritari de les seves parades →
  `public/data/zones.geojson`. Municipis sense parades amb sector queden sense color.

- **Àrea Metropolitana de Barcelona**: els 36 municipis (`AMB_MUNICIPALITIES` a `scripts/build-data.mjs`) dels límits
  ICGC. El perímetre es calcula unint-los (arestes compartides s'eliminen) i només es dibuixa la frontera terrestre
  → `public/data/amb.geojson`.

- **Estacions i intercanviadors** (`scripts/stations.mjs`): estacions de tren (`railway=station`) i d'autobusos
  (`amenity=bus_station`) d'OpenStreetMap, amb les línies pròpies que paren a prop (180 m tren, 250 m bus).
  Intercanviador = dues famílies ferroviàries (Renfe, FGC, Metro, TRAM) o tren + oferta de bus gran. Les de metro/tramvia
  només entren si són intercanviador. Es fusionen duplicats i es classifiquen en 3 nivells d'importància (zoom).
  Cache: `data/raw/osm-stations.json` → `public/data/stations.geojson`.

- **Províncies, comarques i vegueries**: unint els municipis ICGC pels camps `CODIPROV`, `CODICOMAR` i `CODIVEGUE`
  (`writeDivision`) → `public/data/{provincies,comarques,vegueries}.geojson` (polígons, fronteres i punt d'etiqueta).
- Zones de les ATM de Girona, Lleida i Camp de Tarragona: no hi ha dades obertes (ni GTFS ni llistat de municipis per
  zona), només mapes PDF a les seves webs; no s'inclouen.

## Mapes base

Selector a dalt a la dreta (`src/basemaps.js`): Clar, Blanc sense noms, Fosc i Colors (OpenFreeMap: positron,
dark, liberty), OpenStreetMap estàndard (teselles raster d'openstreetmap.org: ús moderat, amb atribució),
i Topogràfic / Satèl·lit de l'ICGC. En canviar de mapa base es conserven totes les capes pròpies.

## Logos

`public/logos/`: logotips de Wikimedia Commons (Metro, FGC, Rodalies, Renfe, TRAM, TMB, AMB, Alsa, Monbus, TUS
Sabadell, Direxis, TMG Girona, Renfe AVE/Avlo/Alvia/Euromed/Intercity/MD/Regional, Ouigo, iryo, exprés.cat — aquest
últim CC BY-SA 3.0) i de les webs oficials dels operadors (Sagalés, Moventis, TEISA, HIFE, Avanza,
Soler i Sauret, Autocorb, Cots Alsina, Reus Transport). Les variants `*-icon` són retalls del símbol per al panell;
la fitxa de línia fa servir el logo complet. Són marques dels seus operadors; s'usen només per identificar les xarxes.
Es configuren a `src/logos.js` (clau `sub:<nom tal com surt al panell>`). Una xarxa urbana sense logo propi mostra el
del seu operador; si no n'hi ha cap, la icona de text.

## Tecnologia

Vite + MapLibre GL JS 6 (sense framework), mapa base OpenFreeMap (Positron).
El worker de MapLibre es serveix sense transformar (plugin a `vite.config.js`).
