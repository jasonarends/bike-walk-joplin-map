// =====================================================
// Bike Walk Joplin — Community Safety Map
// =====================================================

// ---- Config ----
const SUPABASE_URL = 'https://fyqgkqmabbzgufdzrzzy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bG7sx_kuaCwefhByYTB80Q_rsNE5gbX';

const DATA_SOURCES = {
  jatsoPoints: 'https://services6.arcgis.com/6TZ2wV0tqNiq5bdQ/arcgis/rest/services/BikePedInput_Jatso/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson',
  jatsoLines:  'https://services6.arcgis.com/6TZ2wV0tqNiq5bdQ/arcgis/rest/services/BikePedInput_Line/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson',
  bikeInfra: 'https://services1.arcgis.com/5olyYd7fCfTTiVp8/ArcGIS/rest/services/JATSO_Bike_Paths/FeatureServer/4/query?where=1%3D1&outFields=*&f=geojson',
  // NCES EDGE 2023-24 school geocodes — authoritative federal data, updated annually
  schools:   'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2324/MapServer/0/query?where=CITY+%3D+%27JOPLIN%27+AND+STATE+%3D+%27MO%27&outFields=NAME,STREET,GRADESPAN,STATUS,LAT,LON&f=geojson',
};

// ---- Supabase client ----
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Map ----
const JOPLIN = [37.0842, -94.5133];
let map, layerGroups = {};
let pendingLayer = null;   // the drawn layer waiting for metadata
let formState   = { type: null, mode: null, severity: null };
let bwjCount    = 0;

function initMap() {
  map = L.map('map', { center: JOPLIN, zoom: 13, zoomControl: false });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd', maxZoom: 20,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Leaflet.pm — enable drawing globally, hide built-in toolbar (we use custom HTML)
  map.pm.setGlobalOptions({ snappable: true, snapDistance: 12 });

  // Drawing complete
  map.on('pm:create', onDrawComplete);

  loadAllLayers();
  loadBwjReports();
}

// ---- Markers / styles ----
function pinIcon(fill, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 38" width="28" height="38">
    <path d="M14 0C8.48 0 4 4.48 4 10c0 7.5 10 18 10 18S24 17.5 24 10C24 4.48 19.52 0 14 0z"
          fill="${fill}" stroke="rgba(0,0,0,0.2)" stroke-width="1"/>
    <text x="14" y="13" text-anchor="middle" dominant-baseline="middle"
          font-size="12" fill="white" font-family="system-ui" font-weight="bold">${label}</text>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [28,38], iconAnchor: [14,38], popupAnchor: [0,-40] });
}

function dotIcon(fill) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
    <circle cx="9" cy="9" r="7" fill="${fill}" stroke="white" stroke-width="1.5" opacity="0.9"/>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [18,18], iconAnchor: [9,9], popupAnchor: [0,-11] });
}

const ICONS = {
  jatso:   dotIcon('#8b6fb3'),
  problem: pinIcon('#e8453c', '!'),
  route:   pinIcon('#3b82f6', '→'),
  good:    pinIcon('#1cc760', '✓'),
  bwj:     pinIcon('#f5a623', '★'),
};

function bwjStyle(submissionType) {
  const colors = { problem: '#e8453c', route: '#3b82f6', good: '#1cc760' };
  const c = colors[submissionType] || '#f5a623';
  return { color: c, weight: 3, opacity: 0.85, fillColor: c, fillOpacity: 0.15 };
}

// ---- Popup ----
function makePopup(typeLabel, typeClass, body, badges = []) {
  const b = badges.filter(Boolean).map(x => `<span class="popup-badge">${x}</span>`).join('');
  return `<div class="popup-inner">
    <div class="popup-type ${typeClass}">${typeLabel}</div>
    <div class="popup-comment">${body || 'No description provided.'}</div>
    ${b ? `<div class="popup-meta">${b}</div>` : ''}
  </div>`;
}

// ---- Load JATSO layers ----
async function loadAllLayers() {
  const results = await Promise.allSettled([
    loadJatsoPoints(),
    loadJatsoLines(),
    loadBikeInfra(),
  ]);
  hideLoading();
  updateStats();
  const names = ['JATSO reports', 'JATSO routes', 'bike infrastructure'];
  results.forEach((r,i) => {
    if (r.status === 'rejected') {
      console.warn(`Failed to load ${names[i]}:`, r.reason);
      // Only show toast for infra since it has an uncertain URL; others are confirmed
      if (i === 2) showToast('Bike infrastructure layer unavailable — check URL in app.js', 'info');
    }
  });
}

async function loadJatsoPoints() {
  const data = await fetchGeoJSON(DATA_SOURCES.jatsoPoints);
  const group = L.featureGroup();
  data.features.forEach(f => {
    if (!f.geometry?.coordinates) return;
    const [lng, lat] = f.geometry.coordinates;
    const comment = f.properties?.Comment || f.properties?.comment || '';
    L.marker([lat, lng], { icon: ICONS.jatso })
      .bindPopup(makePopup('JATSO Community Report', 'type-jatso', comment, ['Official input']), { maxWidth: 280 })
      .addTo(group);
  });
  layerGroups.points = group.addTo(map);
  return data.features.length;
}

async function loadJatsoLines() {
  const data = await fetchGeoJSON(DATA_SOURCES.jatsoLines);
  const group = L.featureGroup();
  data.features.forEach(f => {
    if (!f.geometry) return;
    const comment = f.properties?.Comment || f.properties?.comment || '';
    const coords = geoJsonCoordsToLatLng(f.geometry);
    if (!coords) return;
    L.polyline(coords, { color: '#7c5cbf', weight: 3, opacity: 0.75, dashArray: '7 4' })
      .bindPopup(makePopup('JATSO Route Suggestion', 'type-jatso', comment, ['Route input']), { maxWidth: 280 })
      .addTo(group);
  });
  layerGroups.lines = group.addTo(map);
  return data.features.length;
}

async function loadBikeInfra() {
  const data = await fetchGeoJSON(DATA_SOURCES.bikeInfra);
  const group = L.featureGroup();
  data.features.forEach(f => {
    if (!f.geometry) return;
    const p = f.properties || {};
    const name = p.StreetName || p.RoadName || 'Unnamed';
    const badges = [p.LaneType || p.Lane_Designator, p.SurfaceType, p.Status].filter(Boolean);
    const coords = geoJsonCoordsToLatLng(f.geometry);
    if (!coords) return;
    L.polyline(coords, { color: '#1cc760', weight: 4, opacity: 0.85 })
      .bindPopup(makePopup('Existing Bike Facility', 'type-infra', name, badges), { maxWidth: 280 })
      .addTo(group);
  });
  layerGroups.infra = group.addTo(map);
  return data.features.length;
}

// ---- Load BWJ community reports from Supabase ----
async function loadBwjReports() {
  try {
    const { data, error } = await db.from('reports').select('*').order('created_at', { ascending: false });
    if (error) throw error;

    if (!layerGroups.bwj) layerGroups.bwj = L.featureGroup().addTo(map);

    data.forEach(row => renderBwjReport(row, layerGroups.bwj));

    bwjCount = data.length;
    updateBwjStat();
  } catch (err) {
    console.error('Could not load BWJ reports:', err);
  }
}

function renderBwjReport(row, group) {
  const geom = row.geojson;
  if (!geom) return;

  const typeLabel = { problem:'Problem Report', route:'Route Suggestion', good:'Good Example' }[row.submission_type] || 'BWJ Report';
  const popupHtml = makePopup(typeLabel, 'type-bwj',
    row.description,
    [row.submission_type, row.mode, row.severity ? `severity: ${row.severity}` : null].filter(Boolean)
  );

  const style = bwjStyle(row.submission_type);

  if (geom.type === 'Point') {
    const icon = ICONS[row.submission_type] || ICONS.bwj;
    L.marker([geom.coordinates[1], geom.coordinates[0]], { icon })
      .bindPopup(popupHtml, { maxWidth: 280 })
      .addTo(group);

  } else if (geom.type === 'LineString') {
    const coords = geom.coordinates.map(c => [c[1], c[0]]);
    L.polyline(coords, { ...style, dashArray: '8 4' })
      .bindPopup(popupHtml, { maxWidth: 280 })
      .addTo(group);

  } else if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    L.geoJSON({ type: 'Feature', geometry: geom }, {
      style: () => style,
    }).bindPopup(popupHtml, { maxWidth: 280 }).addTo(group);
  }
}

// ---- Draw toolbar ----
function initDrawToolbar() {
  const addBtn     = document.getElementById('add-btn');
  const toolbar    = document.getElementById('draw-toolbar');
  const cancelBtn  = document.getElementById('draw-cancel');

  const tools = [
    { id: 'draw-marker',    shape: 'Marker',    icon: '📍', label: 'Point placed' },
    { id: 'draw-line',      shape: 'Line',       icon: '〰️',  label: 'Route drawn' },
    { id: 'draw-polygon',   shape: 'Polygon',    icon: '⬡',  label: 'Area drawn' },
    { id: 'draw-rectangle', shape: 'Rectangle',  icon: '⬜',  label: 'Box drawn' },
  ];

  addBtn.addEventListener('click', () => {
    addBtn.classList.add('hidden');
    toolbar.style.display = 'flex';
  });

  tools.forEach(({ id, shape }) => {
    document.getElementById(id)?.addEventListener('click', () => {
      // Clear any active tool highlight
      document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      document.body.classList.add('drawing-mode');
      map.pm.enableDraw(shape);
    });
  });

  cancelBtn.addEventListener('click', cancelDraw);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') cancelDraw();
  });
}

function cancelDraw() {
  map.pm.disableDraw();
  document.body.classList.remove('drawing-mode');
  document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('draw-toolbar').style.display = 'none';
  document.getElementById('add-btn').classList.remove('hidden');

  // Remove any layer that was partially drawn but not confirmed
  if (pendingLayer) {
    map.removeLayer(pendingLayer);
    pendingLayer = null;
  }
}

function onDrawComplete(e) {
  document.body.classList.remove('drawing-mode');
  document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('draw-toolbar').style.display = 'none';

  pendingLayer = e.layer;

  // Style it as a pending BWJ feature
  if (pendingLayer.setStyle) {
    pendingLayer.setStyle({ color: '#f5a623', fillColor: '#f5a623', fillOpacity: 0.12, weight: 2, dashArray: '5 4' });
  }

  // Figure out the shape type for the badge
  const shapeMap = { Marker: ['📍','Point placed'], Line: ['〰️','Route drawn'], Polygon: ['⬡','Area drawn'], Rectangle: ['⬜','Box drawn'] };
  const [icon, label] = shapeMap[e.shape] || ['📍','Feature placed'];
  document.getElementById('drawn-shape-icon').textContent  = icon;
  document.getElementById('drawn-shape-label').textContent = label;

  openMetaPanel();
}

// ---- Metadata panel ----
function initMetaPanel() {
  document.getElementById('meta-close')?.addEventListener('click',  discardDrawing);
  document.getElementById('meta-cancel')?.addEventListener('click', discardDrawing);
  document.getElementById('meta-submit')?.addEventListener('click', saveReport);
  document.getElementById('add-another')?.addEventListener('click', resetMeta);
  document.getElementById('overlay')?.addEventListener('click',     discardDrawing);

  // Type selection
  document.getElementById('submission-type')?.addEventListener('click', e => {
    const btn = e.target.closest('.choice-btn');
    if (!btn) return;
    document.querySelectorAll('#submission-type .choice-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    formState.type = btn.dataset.value;
    updateConditionalFields();
  });

  // Mode selection
  document.getElementById('mode-select')?.addEventListener('click', e => {
    const btn = e.target.closest('.choice-pill');
    if (!btn) return;
    document.querySelectorAll('#mode-select .choice-pill').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    formState.mode = btn.dataset.value;
  });

  // Severity
  document.getElementById('severity-select')?.addEventListener('click', e => {
    const btn = e.target.closest('.severity-btn');
    if (!btn) return;
    document.querySelectorAll('.severity-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    formState.severity = btn.dataset.value;
  });

  initPhotoUpload();
}

function openMetaPanel() {
  document.getElementById('meta-panel').classList.add('open');
  document.getElementById('meta-panel').removeAttribute('aria-hidden');
  document.getElementById('overlay').classList.add('active');
  document.getElementById('meta-form-fields').style.display = '';
  document.getElementById('meta-success').style.display = 'none';
  document.getElementById('meta-nav').style.display = 'flex';
}

function closeMetaPanel() {
  document.getElementById('meta-panel').classList.remove('open');
  document.getElementById('meta-panel').setAttribute('aria-hidden', 'true');
  document.getElementById('overlay').classList.remove('active');
  document.getElementById('add-btn').classList.remove('hidden');
}

function discardDrawing() {
  if (pendingLayer) { map.removeLayer(pendingLayer); pendingLayer = null; }
  closeMetaPanel();
  resetFormFields();
}

function updateConditionalFields() {
  const isProblem = formState.type === 'problem';
  document.getElementById('issue-checks-group').style.display = isProblem ? '' : 'none';
  document.getElementById('problem-meta-row').style.display   = isProblem ? '' : 'none';
}

async function saveReport() {
  if (!formState.type) { showToast('Please select a submission type', 'error'); return; }
  if (!formState.mode) { showToast('Please select who is affected', 'error'); return; }
  if (!pendingLayer)   { showToast('No feature drawn — please draw on the map', 'error'); return; }

  const submitBtn = document.getElementById('meta-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  const geojson = pendingLayer.toGeoJSON().geometry;
  const issues  = [...document.querySelectorAll('#issue-checks input:checked')].map(i => i.value);

  const payload = {
    geojson,
    geom_type:       geojson.type,
    submission_type: formState.type,
    mode:            formState.mode,
    issues:          issues.length ? issues : null,
    description:     document.getElementById('description').value || null,
    frequency:       document.getElementById('frequency').value || null,
    severity:        formState.severity || null,
    name:            document.getElementById('name-input').value || null,
    email:           document.getElementById('email-input').value || null,
    followup:        document.getElementById('followup-check').checked,
  };

  try {
    const { data, error } = await db.from('reports').insert(payload).select().single();
    if (error) throw error;

    // Style the drawn layer permanently and add to BWJ group
    if (pendingLayer.setStyle) {
      pendingLayer.setStyle({ ...bwjStyle(formState.type), dashArray: null });
    } else if (pendingLayer.setIcon) {
      pendingLayer.setIcon(ICONS[formState.type] || ICONS.bwj);
    }

    const typeLabel = { problem:'Problem Report', route:'Route Suggestion', good:'Good Example' }[formState.type] || 'BWJ Report';
    pendingLayer.bindPopup(makePopup(typeLabel, 'type-bwj',
      payload.description,
      [formState.type, formState.mode].filter(Boolean)
    ), { maxWidth: 280 });

    if (!layerGroups.bwj) layerGroups.bwj = L.featureGroup().addTo(map);
    layerGroups.bwj.addLayer(pendingLayer);
    pendingLayer = null;

    bwjCount++;
    updateBwjStat();

    // Show success state
    document.getElementById('meta-form-fields').style.display = 'none';
    document.getElementById('meta-success').style.display = '';
    document.getElementById('meta-nav').style.display = 'none';
    showToast('Report saved to the map!', 'success');

  } catch (err) {
    console.error('Save failed:', err);
    showToast('Save failed — please try again', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save to Map';
  }
}

function resetMeta() {
  resetFormFields();
  closeMetaPanel();
}

function resetFormFields() {
  formState = { type: null, mode: null, severity: null };

  document.querySelectorAll('.choice-btn, .choice-pill, .severity-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('#issue-checks input').forEach(c => c.checked = false);
  ['description','name-input','email-input'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('frequency').value = '';
  document.getElementById('followup-check').checked = false;
  document.getElementById('photo-input').value = '';
  document.getElementById('photo-preview').style.display = 'none';
  document.getElementById('photo-placeholder').style.display = '';
  document.getElementById('issue-checks-group').style.display = '';
  document.getElementById('problem-meta-row').style.display = '';
}

// ---- Photo upload ----
function initPhotoUpload() {
  const area        = document.getElementById('photo-upload-area');
  const input       = document.getElementById('photo-input');
  const placeholder = document.getElementById('photo-placeholder');
  const preview     = document.getElementById('photo-preview');
  const previewImg  = document.getElementById('photo-preview-img');

  placeholder?.addEventListener('click', () => input?.click());

  area?.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('drag-over'); });
  area?.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area?.addEventListener('drop', e => {
    e.preventDefault(); area.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file?.type.startsWith('image/')) showPreview(file);
  });

  input?.addEventListener('change', e => {
    if (e.target.files?.[0]) showPreview(e.target.files[0]);
  });

  document.getElementById('remove-photo')?.addEventListener('click', () => {
    preview.style.display = 'none'; placeholder.style.display = ''; input.value = '';
  });

  function showPreview(file) {
    const reader = new FileReader();
    reader.onload = e => {
      previewImg.src = e.target.result;
      placeholder.style.display = 'none';
      preview.style.display = '';
    };
    reader.readAsDataURL(file);
  }
}

// ---- Strava heatmap layer (local cached tiles) ----
// Tiles are downloaded via scripts/download_strava_tiles.py and committed to the repo.
// The layer is enabled automatically once tiles/strava/ is populated.
// Opacity is kept low so the heatmap overlays without overwhelming the base map.

// Tiles are 512×512 @2x PNGs saved as {z}/{x}/{y}.png
// tileSize:512 + zoomOffset:-1 tells Leaflet to treat each tile as covering
// a 512px slot, so zoom levels align correctly with the rest of the map.
const STRAVA_TILE_PATH = 'tiles/strava/{z}/{x}/{y}.png';

async function initStravaLayer() {
  // Check if tiles exist by probing a known central tile (z13 over Joplin)
  // lon=-94.51 lat=37.08 → tile x=1943 y=3124 at z=13
  const probePath = 'tiles/strava/13/1943/3124.png';
  try {
    const res = await fetch(probePath, { method: 'HEAD' });
    if (res.ok) {
      enableStravaToggle();
    }
  } catch {
    // Tiles not present — toggle stays disabled
  }
}

function enableStravaToggle() {
  const toggle = document.getElementById('toggle-strava');
  const badge  = document.getElementById('strava-badge');
  if (toggle) toggle.disabled = false;
  if (badge)  { badge.textContent = 'Ready'; badge.classList.add('ready'); }
}

function addStravaLayer() {
  if (layerGroups.strava) { layerGroups.strava.addTo(map); return; }
  layerGroups.strava = L.tileLayer(STRAVA_TILE_PATH, {
    minZoom:    12,
    maxZoom:    16,
    tileSize:   512,   // tiles are 512×512 (@2x)
    zoomOffset: -1,    // compensate so zoom levels align with the base map
    opacity:    0.7,
    errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  }).addTo(map);
}

function removeStravaLayer() {
  if (layerGroups.strava) map.removeLayer(layerGroups.strava);
}

// ---- Schools layer ----
async function loadSchools() {
  if (layerGroups.schools) { layerGroups.schools.addTo(map); layerGroups.schoolZones?.addTo(map); return; }
  showToast('Loading schools…', 'info');
  try {
    const res  = await fetch(DATA_SOURCES.schools);
    const data = await res.json();
    const group = L.featureGroup();
    const zones = L.featureGroup();

    // NCES returns GeoJSON: {features: [{geometry: {coordinates: [lon, lat]}, properties: {NAME, ...}}]}
    (data.features || []).forEach(f => {
      const p   = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      if (!lat || !lon) return;

      const name  = p.NAME  ? toTitleCase(p.NAME)  : 'School';
      const grade = p.GRADESPAN ? `Grades ${p.GRADESPAN}` : '';

      L.circle([lat, lon], {
        radius: 1609, color: '#1370AF', fillColor: '#1370AF',
        fillOpacity: 0.07, weight: 1.5, opacity: 0.3,
      }).addTo(zones);

      L.marker([lat, lon], {
        icon: L.divIcon({
          html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22"><circle cx="11" cy="11" r="9" fill="#1370AF" stroke="white" stroke-width="1.5"/><text x="11" y="15" text-anchor="middle" font-size="11" fill="white">🏫</text></svg>`,
          className: '', iconSize: [22,22], iconAnchor: [11,11], popupAnchor: [0,-13],
        })
      })
        .bindPopup(makePopup('School', 'type-school', name, [grade, '1-mile walk zone'].filter(Boolean)), { maxWidth: 240 })
        .addTo(group);
    });

    layerGroups.schoolZones = zones.addTo(map);
    layerGroups.schools     = group.addTo(map);
    showToast(`Loaded ${(data.features || []).length} schools`, 'success');
  } catch (err) {
    console.error('Schools failed:', err);
    showToast('Could not load school data', 'error');
    const t = document.getElementById('toggle-schools'); if (t) t.checked = false;
  }
}

function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function removeSchools() {
  if (layerGroups.schools)    map.removeLayer(layerGroups.schools);
  if (layerGroups.schoolZones) map.removeLayer(layerGroups.schoolZones);
}

// ---- Crash hotspots layer ----
async function initCrashLayer() {
  try {
    const res = await fetch('data/crashes.geojson', { method: 'HEAD' });
    if (res.ok) {
      document.getElementById('crashes-layer-item').style.display = '';
    }
  } catch { /* file not present */ }
}

async function loadCrashes() {
  if (layerGroups.crashes) { layerGroups.crashes.addTo(map); return; }
  showToast('Loading crash data…', 'info');
  try {
    const res  = await fetch('data/crashes.geojson');
    const data = await res.json();
    const group = L.featureGroup();

    data.features.forEach(f => {
      const p   = f.properties;
      const [lng, lat] = f.geometry.coordinates;

      // Scale circle radius by crash count (min 8m, max 40m)
      const r = Math.min(8 + p.total * 1.5, 40);
      const isFatal = p.fatal > 0;

      L.circleMarker([lat, lng], {
        radius: r,
        color:       isFatal ? '#8b0000' : '#e8453c',
        fillColor:   isFatal ? '#8b0000' : '#e8453c',
        fillOpacity: 0.55,
        weight:      isFatal ? 2 : 1,
        opacity:     0.8,
      })
        .bindPopup(makePopup(
          'Crash Hotspot', 'type-crash',
          `<strong>${p.label}</strong>`,
          [
            `${p.total} crashes`,
            p.pedestrian ? `${p.pedestrian} pedestrian` : null,
            p.bicycle    ? `${p.bicycle} bicycle` : null,
            p.fatal      ? `⚠ ${p.fatal} fatal` : null,
            p.years,
          ].filter(Boolean)
        ), { maxWidth: 260 })
        .addTo(group);
    });

    layerGroups.crashes = group.addTo(map);
    showToast(`Loaded ${data.features.length} crash locations`, 'success');
  } catch (err) {
    console.error('Crash data failed:', err);
    showToast('Could not load crash data', 'error');
    document.getElementById('toggle-crashes').checked = false;
  }
}

function removeCrashes() {
  if (layerGroups.crashes) map.removeLayer(layerGroups.crashes);
}

// ---- Layer toggles ----
function initLayerToggles() {
  const simple = { 'toggle-points': 'points', 'toggle-lines': 'lines', 'toggle-infra': 'infra', 'toggle-bwj': 'bwj' };
  Object.entries(simple).forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener('change', e => {
      const g = layerGroups[key]; if (!g) return;
      e.target.checked ? g.addTo(map) : map.removeLayer(g);
    });
  });
  document.getElementById('toggle-schools')?.addEventListener('change', e => {
    e.target.checked ? loadSchools() : removeSchools();
  });
  document.getElementById('toggle-crashes')?.addEventListener('change', e => {
    e.target.checked ? loadCrashes() : removeCrashes();
  });
  document.getElementById('toggle-strava')?.addEventListener('change', e => {
    e.target.checked ? addStravaLayer() : removeStravaLayer();
  });
  document.getElementById('layer-panel-toggle')?.addEventListener('click', () => {
    document.getElementById('layer-panel').classList.add('collapsed');
    document.getElementById('layer-panel-open').style.display = 'flex';
  });
  document.getElementById('layer-panel-open')?.addEventListener('click', () => {
    document.getElementById('layer-panel').classList.remove('collapsed');
    document.getElementById('layer-panel-open').style.display = 'none';
  });
}

// ---- Stats ----
function updateStats() {
  countUp('stat-jatso',  layerGroups.points?.getLayers().length ?? 0);
  countUp('stat-routes', layerGroups.lines?.getLayers().length  ?? 0);
  countUp('stat-infra',  layerGroups.infra?.getLayers().length  ?? 0);
  updateBwjStat();
}
function updateBwjStat() {
  const el = document.querySelector('#stat-bwj .stat-value');
  if (el) el.textContent = bwjCount;
}
function countUp(id, target) {
  const el = document.querySelector(`#${id} .stat-value`);
  if (!el || target === 0) { if (el) el.textContent = '0'; return; }
  let n = 0;
  const step = () => { n = Math.min(n + Math.ceil(target/18), target); el.textContent = n; if (n < target) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function hideLoading() { document.getElementById('map-loading')?.classList.add('hidden'); }

// ---- Modal ----
function initModal() {
  const modal    = document.getElementById('how-modal');
  const backdrop = document.getElementById('how-modal-backdrop');
  const close    = document.getElementById('how-modal-close');
  const open     = document.getElementById('about-btn');
  open?.addEventListener('click',    () => modal?.classList.add('open'));
  close?.addEventListener('click',   () => modal?.classList.remove('open'));
  backdrop?.addEventListener('click',() => modal?.classList.remove('open'));
}

// ---- Helpers ----
function geoJsonCoordsToLatLng(geometry) {
  if (geometry.type === 'LineString')      return geometry.coordinates.map(c => [c[1], c[0]]);
  if (geometry.type === 'MultiLineString') return geometry.coordinates[0].map(c => [c[1], c[0]]);
  return null;
}

async function fetchGeoJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0'; toast.style.transform = 'translateY(6px)';
    setTimeout(() => toast.remove(), 320);
  }, 3000);
}

// ---- Boot ----
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initLayerToggles();
  initDrawToolbar();
  initMetaPanel();
  initModal();
  initStravaLayer();  // probe for tiles, enables toggle if present
  initCrashLayer();   // probe for data/crashes.geojson, shows toggle if present
});
