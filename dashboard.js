// =====================================================
// Bike Walk Joplin — Crash Dashboard
// Reads data/crashes.geojson (written by scripts/fetch_crashes.py)
// and computes all statistics + renders charts client-side.
// =====================================================

// External data sources (same as app.js)
const DATA_SOURCES = {
  cityBikeLanesSidewalk: 'https://www.joplingis.org/server/rest/services/Bike_Lanes/Bike_Lanes_mxd_2024/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson',
  cityBikeLanesRoad:     'https://www.joplingis.org/server/rest/services/Bike_Lanes/Bike_Lanes_mxd_2024/MapServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=geojson',
  schools:               'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2324/MapServer/0/query?where=CITY+%3D+%27JOPLIN%27+AND+STATE+%3D+%27MO%27&outFields=*&f=geojson',
};

const JOPLIN = [37.0842, -94.5133];

// BWJ palette for charts
const CLR = {
  fatal:     '#e8453c',
  injury:    '#f5a623',
  pdo:       '#8EB5DB',
  ped:       '#00527A',
  bike:      '#1370AF',
  teal:      '#00527A',
  blue:      '#1370AF',
  blueLight: '#8EB5DB',
  border:    '#dce3ec',
  muted:     '#8896a8',
};

// Global chart defaults
Chart.defaults.font.family = "'Work Sans', system-ui, sans-serif";
Chart.defaults.color = CLR.muted;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.padding = 14;
Chart.defaults.plugins.tooltip.backgroundColor = '#fff';
Chart.defaults.plugins.tooltip.titleColor = '#1a2430';
Chart.defaults.plugins.tooltip.bodyColor = '#4a5568';
Chart.defaults.plugins.tooltip.borderColor = '#dce3ec';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;

// =====================================================
// UTILITY
// =====================================================

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

// Haversine distance in metres
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const dφ = (lat2 - lat1) * Math.PI / 180;
  const dλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Fast approximate distance in metres using flat-earth (good to ~1% at this scale)
function distMFast(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180);
  return Math.sqrt(dLat*dLat + dLon*dLon);
}

function fmtNum(n) {
  return n.toLocaleString();
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00Z');
  const now = new Date();
  return Math.floor((now - d) / 86400000);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Normalize MSHP street-name prefixes to a human-readable form
const PREFIX_MAP = {
  'CST ': '', 'MO ':  'MO-', 'US ':  'US-', 'IS ':  'I-',
  'RT ':  'RT ', 'LP ':  'LP ', 'BU ':  'BUS ',
};
function normStreet(raw) {
  if (!raw) return '';
  let s = raw.trim();
  for (const [prefix, repl] of Object.entries(PREFIX_MAP)) {
    if (s.startsWith(prefix)) { s = repl + s.slice(prefix.length); break; }
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Severity helpers
function sevClass(sev) {
  if (!sev) return 'pdo';
  const s = sev.toLowerCase();
  if (s.includes('fatal')) return 'fatal';
  if (s.includes('injury') || s.includes('personal')) return 'injury';
  return 'pdo';
}
function sevColor(sev) {
  return { fatal: CLR.fatal, injury: CLR.injury, pdo: CLR.pdo }[sevClass(sev)] || CLR.pdo;
}
function sevLabel(sev) {
  return { fatal: 'Fatal', injury: 'Personal Injury', pdo: 'Property Damage' }[sevClass(sev)] || sev;
}

// Crash circle icon for Leaflet
function crashCircle(sev) {
  const fill = sevColor(sev);
  const r = sevClass(sev) === 'fatal' ? 8 : 6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r*2+4}" height="${r*2+4}">
    <circle cx="${r+2}" cy="${r+2}" r="${r}" fill="${fill}" stroke="white" stroke-width="1.5" opacity="0.88"/>
  </svg>`;
  return L.divIcon({
    html: svg, className: '',
    iconSize: [r*2+4, r*2+4], iconAnchor: [r+2, r+2], popupAnchor: [0, -r-4],
  });
}

// =====================================================
// TABS
// =====================================================

let mapsInitialized = { where: false, risk: false };

function initTabs() {
  const btns = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      panels.forEach(p => { p.classList.remove('active'); p.hidden = true; });

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const panelId = 'tab-' + btn.dataset.tab;
      const panel = document.getElementById(panelId);
      panel.classList.add('active');
      panel.hidden = false;

      // Lazy-init maps when their tab is first shown
      if (btn.dataset.tab === 'where' && !mapsInitialized.where) {
        mapsInitialized.where = true;
        initWhereMap(window._crashes);
      }
      if (btn.dataset.tab === 'risk' && !mapsInitialized.risk) {
        mapsInitialized.risk = true;
        initRiskMap(window._crashes);
      }
    });
  });
}

// =====================================================
// MAIN ENTRY
// =====================================================

async function main() {
  initTabs();

  const gj = await fetchJSON('data/crashes.geojson');
  const crashes = gj.features;
  window._crashes = crashes; // available for lazy map init

  // Update header data note
  const fetched = gj.metadata?.fetched
    ? new Date(gj.metadata.fetched).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : null;
  const dateNote = document.getElementById('data-date-note');
  if (fetched) dateNote.textContent = `Data fetched ${fetched} · ${crashes.length} crashes`;
  else dateNote.textContent = `${crashes.length} crashes`;

  renderOverview(crashes);
  renderWhen(crashes);
  renderWho(crashes);
  // Where and Risk tabs init their maps lazily on first tab click
}

// =====================================================
// TAB 1 — OVERVIEW
// =====================================================

function renderOverview(crashes) {
  const totalFatal    = crashes.filter(f => sevClass(f.properties.SEVERITY) === 'fatal').length;
  const totalInjured  = crashes.reduce((s, f) => s + (f.properties.INJURED || 0), 0);
  const totalKilled   = crashes.reduce((s, f) => s + (f.properties.KILLED || 0), 0);

  document.getElementById('stat-total').textContent   = fmtNum(crashes.length);
  document.getElementById('stat-fatal').textContent   = fmtNum(totalKilled);
  document.getElementById('stat-injured').textContent = fmtNum(totalInjured);

  // Days since last fatal crash event
  const fatalCrashes = crashes
    .filter(f => f.properties.KILLED > 0)
    .sort((a, b) => a.properties.ACC_DATE > b.properties.ACC_DATE ? 1 : -1);
  if (fatalCrashes.length) {
    const lastDate = fatalCrashes[fatalCrashes.length - 1].properties.ACC_DATE;
    const days = daysSince(lastDate);
    document.getElementById('stat-days-since').textContent = days !== null ? fmtNum(days) : '—';
    document.getElementById('stat-last-fatal-date').textContent = formatDate(lastDate);
  }

  // Date range from data
  const dates = crashes.map(f => f.properties.ACC_DATE).filter(Boolean).sort();
  const firstYear = dates[0]?.slice(0, 4) ?? '';
  const lastYear  = dates[dates.length-1]?.slice(0, 4) ?? '';
  document.getElementById('stat-years-label').textContent =
    firstYear && lastYear ? `${firstYear}–${lastYear} · Jasper County` : 'Jasper County';

  // Summary paragraph
  const pedCount  = crashes.filter(f => f.properties.ACC_TYPE === 'Pedestrian').length;
  const bikeCount = crashes.filter(f => f.properties.ACC_TYPE === 'Pedalcycle').length;
  const fatalPct  = ((totalFatal / crashes.length) * 100).toFixed(0);
  const joplinCount = crashes.filter(f => f.properties.CITY === 'JOPLIN').length;
  const summary = `Between ${firstYear} and ${lastYear}, ${crashes.length} crashes involving pedestrians or cyclists ` +
    `were recorded in Jasper County — ${pedCount} involving pedestrians and ${bikeCount} involving bicycle riders. ` +
    `${totalFatal} of those crashes (${fatalPct}%) resulted in at least one death, and at least ${totalInjured} people were injured. ` +
    `${joplinCount} crashes (${((joplinCount/crashes.length)*100).toFixed(0)}%) occurred within the city of Joplin.`;
  document.getElementById('hero-summary').textContent = summary;

  // Year chart
  buildYearChart(crashes, firstYear, lastYear);
}

function buildYearChart(crashes, firstYear, lastYear) {
  const years = [];
  for (let y = parseInt(firstYear); y <= parseInt(lastYear); y++) years.push(String(y));

  const byYear = { Fatal: {}, 'Personal Injury': {}, 'Property Damage': {} };
  years.forEach(y => { byYear.Fatal[y] = 0; byYear['Personal Injury'][y] = 0; byYear['Property Damage'][y] = 0; });

  crashes.forEach(f => {
    const y = f.properties.ACC_DATE?.slice(0, 4);
    if (!y || !byYear.Fatal[y] === undefined) return;
    const sk = sevClass(f.properties.SEVERITY);
    const label = sk === 'fatal' ? 'Fatal' : sk === 'injury' ? 'Personal Injury' : 'Property Damage';
    if (byYear[label][y] !== undefined) byYear[label][y]++;
  });

  new Chart(document.getElementById('chart-year'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Fatal',           data: years.map(y => byYear.Fatal[y]),             backgroundColor: CLR.fatal,  stack: 'sev' },
        { label: 'Personal Injury', data: years.map(y => byYear['Personal Injury'][y]), backgroundColor: CLR.injury, stack: 'sev' },
        { label: 'Property Damage', data: years.map(y => byYear['Property Damage'][y]), backgroundColor: CLR.pdo,    stack: 'sev' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, grid: { color: '#f0f3f6' }, ticks: { precision: 0 } },
      },
    },
  });
}

// =====================================================
// TAB 2 — WHEN
// =====================================================

function renderWhen(crashes) {
  buildTimeHeatmap(crashes);
  buildLightingDonut(crashes);
  buildMonthlyBar(crashes);
  buildYearTypeLine(crashes);
}

function buildTimeHeatmap(crashes) {
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // ACC_TIME is "HH:MM:SS", DAY_WEEK is "Mon     " etc
  const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const hourMap = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0, 10:0, 11:0, 12:0,
                    13:0, 14:0, 15:0, 16:0, 17:0, 18:0, 19:0, 20:0, 21:0, 22:0, 23:0 };

  // grid[hour][dayIndex] = count
  const grid = {};
  for (let h = 0; h < 24; h++) {
    grid[h] = [0,0,0,0,0,0,0];
  }

  crashes.forEach(f => {
    const time = f.properties.ACC_TIME || '';
    const day  = (f.properties.DAY_WEEK || '').trim().slice(0, 3);
    const hour = parseInt(time.slice(0, 2));
    const dayIdx = dayMap[day];
    if (isNaN(hour) || dayIdx === undefined) return;
    grid[hour][dayIdx]++;
  });

  let maxVal = 0;
  for (let h = 0; h < 24; h++) for (let d = 0; d < 7; d++) maxVal = Math.max(maxVal, grid[h][d]);

  const hourLabels = [
    '12a','1a','2a','3a','4a','5a','6a','7a','8a','9a','10a','11a',
    '12p','1p','2p','3p','4p','5p','6p','7p','8p','9p','10p','11p',
  ];

  let html = '<table class="heatmap-table"><thead><tr><th></th>';
  DAY_LABELS.forEach(d => { html += `<th>${d}</th>`; });
  html += '</tr></thead><tbody>';

  for (let h = 0; h < 24; h++) {
    html += `<tr><td class="heatmap-row-label">${hourLabels[h]}</td>`;
    for (let d = 0; d < 7; d++) {
      const v = grid[h][d];
      const intensity = maxVal > 0 ? v / maxVal : 0;
      const bg = heatColor(intensity);
      const cls = v > 0 ? 'has-value' : '';
      const title = `${DAY_LABELS[d]} ${hourLabels[h]}: ${v} crash${v !== 1 ? 'es' : ''}`;
      html += `<td class="${cls}" style="background:${bg}" title="${title}">${v > 0 ? v : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('heatmap-container').innerHTML = html;
}

function heatColor(t) {
  // 0 → light grey, 1 → dark teal
  if (t === 0) return '#f0f3f6';
  const r = Math.round(lerp(238, 0,   t));
  const g = Math.round(lerp(243, 82,  t));
  const b = Math.round(lerp(246, 122, t));
  return `rgb(${r},${g},${b})`;
}
function lerp(a, b, t) { return a + (b - a) * t; }

function buildLightingDonut(crashes) {
  const counts = {};
  crashes.forEach(f => {
    const lc = f.properties.LIGHT_COND || 'Unknown';
    counts[lc] = (counts[lc] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const palette = [CLR.teal, CLR.blue, CLR.blueLight, CLR.amber, CLR.fatal, '#aab4c0'];

  new Chart(document.getElementById('chart-lighting'), {
    type: 'doughnut',
    data: {
      labels: sorted.map(([k]) => k),
      datasets: [{ data: sorted.map(([,v]) => v), backgroundColor: sorted.map((_, i) => palette[i % palette.length]), borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
      cutout: '62%',
    },
  });
}

function buildMonthlyBar(crashes) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const bySev = { Fatal: new Array(12).fill(0), 'Personal Injury': new Array(12).fill(0), 'Property Damage': new Array(12).fill(0) };
  crashes.forEach(f => {
    const m = parseInt((f.properties.ACC_DATE || '').slice(5, 7)) - 1;
    if (m < 0 || m > 11) return;
    const sk = sevClass(f.properties.SEVERITY);
    const label = sk === 'fatal' ? 'Fatal' : sk === 'injury' ? 'Personal Injury' : 'Property Damage';
    bySev[label][m]++;
  });

  new Chart(document.getElementById('chart-monthly'), {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [
        { label: 'Fatal',           data: bySev.Fatal,             backgroundColor: CLR.fatal,  stack: 's' },
        { label: 'Personal Injury', data: bySev['Personal Injury'], backgroundColor: CLR.injury, stack: 's' },
        { label: 'Property Damage', data: bySev['Property Damage'], backgroundColor: CLR.pdo,    stack: 's' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, grid: { color: '#f0f3f6' }, ticks: { precision: 0 } },
      },
    },
  });
}

function buildYearTypeLine(crashes) {
  const yearSet = new Set(crashes.map(f => f.properties.ACC_DATE?.slice(0, 4)).filter(Boolean));
  const years = Array.from(yearSet).sort();
  const pedData  = years.map(y => crashes.filter(f => f.properties.ACC_DATE?.startsWith(y) && f.properties.ACC_TYPE === 'Pedestrian').length);
  const bikeData = years.map(y => crashes.filter(f => f.properties.ACC_DATE?.startsWith(y) && f.properties.ACC_TYPE === 'Pedalcycle').length);

  new Chart(document.getElementById('chart-year-type'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Pedestrian', data: pedData,  backgroundColor: CLR.ped,  stack: 't' },
        { label: 'Bicycle',    data: bikeData, backgroundColor: CLR.bike, stack: 't' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, grid: { color: '#f0f3f6' }, ticks: { precision: 0 } },
      },
    },
  });
}

// =====================================================
// TAB 3 — WHERE
// =====================================================

function initWhereMap(crashes) {
  const map = L.map('map-where', { center: JOPLIN, zoom: 13 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd', maxZoom: 20,
  }).addTo(map);

  // Heatmap layer (weighted by severity)
  const heatPoints = crashes.map(f => {
    const [lon, lat] = f.geometry.coordinates;
    const weight = sevClass(f.properties.SEVERITY) === 'fatal' ? 5
                 : sevClass(f.properties.SEVERITY) === 'injury' ? 2 : 1;
    return [lat, lon, weight];
  });
  L.heatLayer(heatPoints, { radius: 22, blur: 18, maxZoom: 17, gradient: {
    0.0: 'rgba(0,82,122,0)',
    0.3: 'rgba(0,82,122,0.4)',
    0.6: 'rgba(245,166,35,0.7)',
    1.0: 'rgba(232,69,60,0.9)',
  }}).addTo(map);

  // Severity markers
  crashes.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const on  = normStreet(p.ON_STREET);
    const at  = normStreet(p.AT_STREET);
    const loc = on && at ? `${on} @ ${at}` : on || at || 'Unknown location';
    const sc  = sevClass(p.SEVERITY);
    const typeLabel = p.ACC_TYPE === 'Pedestrian' ? 'Pedestrian crash' : 'Bicycle crash';
    const popup = `<div class="crash-popup">
      <div class="crash-popup-type ${sc}">${sevLabel(p.SEVERITY)}</div>
      <div class="crash-popup-loc">${escHtml(loc)}</div>
      <div class="crash-popup-meta">
        ${p.ACC_TYPE || ''} · ${p.ACC_DATE || ''}<br>
        ${p.INJURED ? `${p.INJURED} injured` : ''}${p.KILLED ? ` · ${p.KILLED} killed` : ''}
        ${p.LIGHT_COND ? `<br>${p.LIGHT_COND}` : ''}
      </div>
    </div>`;
    L.marker([lat, lon], { icon: crashCircle(p.SEVERITY) })
      .bindPopup(popup, { maxWidth: 260 })
      .addTo(map);
  });

  buildIntersectionTable(crashes);
  buildCorridorChart(crashes);
}

// Cluster crashes within ~30m by rounding lat/lon to 4 decimal places (~11m grid)
function buildIntersectionTable(crashes) {
  const clusters = {};
  crashes.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    // 3 decimal places = ~111m grid; use 3.5 steps → round to nearest 0.0005 (~55m)
    const key = `${(Math.round(lat / 0.0003) * 0.0003).toFixed(4)},${(Math.round(lon / 0.0003) * 0.0003).toFixed(4)}`;
    if (!clusters[key]) clusters[key] = [];
    clusters[key].push(f);
  });

  const ranked = Object.values(clusters)
    .filter(c => c.length >= 2)
    .map(c => ({
      crashes: c,
      count: c.length,
      fatals: c.filter(f => sevClass(f.properties.SEVERITY) === 'fatal').length,
      label: bestLabel(c),
    }))
    .sort((a, b) => b.count - a.count || b.fatals - a.fatals)
    .slice(0, 15);

  const tbody = document.querySelector('#table-intersections tbody');
  ranked.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="rank-num">${i + 1}</td>
      <td>${escHtml(r.label)}</td>
      <td class="crash-count">${r.count}</td>
      <td class="fatal-count ${r.fatals === 0 ? 'zero' : ''}">${r.fatals || '—'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function bestLabel(crashes) {
  // Find the most common ON_STREET @ AT_STREET pair in the cluster
  const labels = {};
  crashes.forEach(f => {
    const on = normStreet(f.properties.ON_STREET);
    const at = normStreet(f.properties.AT_STREET);
    const k  = at ? `${on} @ ${at}` : on || 'Unknown';
    labels[k] = (labels[k] || 0) + 1;
  });
  return Object.entries(labels).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
}

function buildCorridorChart(crashes) {
  const counts = {};
  crashes.forEach(f => {
    const s = normStreet(f.properties.ON_STREET);
    if (!s) return;
    counts[s] = (counts[s] || 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);

  new Chart(document.getElementById('chart-corridors'), {
    type: 'bar',
    data: {
      labels: top.map(([k]) => k),
      datasets: [{ label: 'Crashes', data: top.map(([,v]) => v), backgroundColor: CLR.teal, borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#f0f3f6' }, ticks: { precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

// =====================================================
// TAB 4 — WHO & HOW
// =====================================================

function renderWho(crashes) {
  buildTypeDonut(crashes);
  buildSeverityModeChart(crashes);
  buildFactorChart(crashes);
  buildWeekdayChart(crashes);
}

function buildTypeDonut(crashes) {
  const ped  = crashes.filter(f => f.properties.ACC_TYPE === 'Pedestrian').length;
  const bike = crashes.filter(f => f.properties.ACC_TYPE === 'Pedalcycle').length;

  new Chart(document.getElementById('chart-type-donut'), {
    type: 'doughnut',
    data: {
      labels: ['Pedestrian', 'Bicycle'],
      datasets: [{ data: [ped, bike], backgroundColor: [CLR.ped, CLR.bike], borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ped + bike;
              return ` ${ctx.label}: ${ctx.raw} (${((ctx.raw / total) * 100).toFixed(1)}%)`;
            },
          },
        },
      },
      cutout: '62%',
    },
  });
}

function buildSeverityModeChart(crashes) {
  const modes = ['Pedestrian', 'Pedalcycle'];
  const modeLabels = ['Pedestrian', 'Bicycle'];
  const sevKeys = ['fatal', 'injury', 'pdo'];
  const sevLabels = ['Fatal', 'Personal Injury', 'Property Damage'];
  const colors = [CLR.fatal, CLR.injury, CLR.pdo];

  const datasets = sevKeys.map((sk, si) => ({
    label: sevLabels[si],
    data: modes.map(m => {
      const total = crashes.filter(f => f.properties.ACC_TYPE === m).length;
      const count = crashes.filter(f => f.properties.ACC_TYPE === m && sevClass(f.properties.SEVERITY) === sk).length;
      return total > 0 ? parseFloat(((count / total) * 100).toFixed(1)) : 0;
    }),
    backgroundColor: colors[si],
    stack: 's',
  }));

  new Chart(document.getElementById('chart-severity-mode'), {
    type: 'bar',
    data: { labels: modeLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, max: 100, grid: { color: '#f0f3f6' },
             ticks: { callback: v => `${v}%` } },
      },
    },
  });
}

function buildFactorChart(crashes) {
  const FACTORS = [
    { key: 'DR_DRINK',  label: 'Impaired (alcohol)' },
    { key: 'DR_DRUG',   label: 'Impaired (drugs)' },
    { key: 'SPEED',     label: 'Speeding' },
    { key: 'CELL_PHONE',label: 'Cell phone' },
    { key: 'TEXTING',   label: 'Texting' },
  ];

  const total = crashes.length;
  const data = FACTORS.map(fac => {
    // 'Y ' = yes, 'N ' = no, 'U ' = unknown — exclude unknowns from denominator
    const known = crashes.filter(f => {
      const v = (f.properties[fac.key] || '').trim();
      return v === 'Y' || v === 'N';
    });
    const yes = known.filter(f => (f.properties[fac.key] || '').trim() === 'Y').length;
    return known.length > 0 ? parseFloat(((yes / known.length) * 100).toFixed(1)) : 0;
  });

  new Chart(document.getElementById('chart-factors'), {
    type: 'bar',
    data: {
      labels: FACTORS.map(f => f.label),
      datasets: [{ label: '% of crashes', data, backgroundColor: CLR.blue, borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw}% of crashes (known reports)` } } },
      scales: {
        x: { grid: { color: '#f0f3f6' }, ticks: { callback: v => `${v}%` } },
        y: { grid: { display: false } },
      },
    },
  });
}

function buildWeekdayChart(crashes) {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const pedData  = DAYS.map(d => crashes.filter(f => f.properties.DAY_WEEK?.trim() === d && f.properties.ACC_TYPE === 'Pedestrian').length);
  const bikeData = DAYS.map(d => crashes.filter(f => f.properties.DAY_WEEK?.trim() === d && f.properties.ACC_TYPE === 'Pedalcycle').length);

  new Chart(document.getElementById('chart-weekday'), {
    type: 'bar',
    data: {
      labels: DAYS,
      datasets: [
        { label: 'Pedestrian', data: pedData,  backgroundColor: CLR.ped,  stack: 't' },
        { label: 'Bicycle',    data: bikeData, backgroundColor: CLR.bike, stack: 't' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, grid: { color: '#f0f3f6' }, ticks: { precision: 0 } },
      },
    },
  });
}

// =====================================================
// TAB 5 — RISK & EQUITY
// =====================================================

async function initRiskMap(crashes) {
  const map = L.map('map-risk', { center: JOPLIN, zoom: 12 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd', maxZoom: 20,
  }).addTo(map);

  const noteEl = document.getElementById('risk-map-note');

  // Load bike facility layers
  let facilityPoints = []; // flat array of [lat, lon] for distance checks
  try {
    const [sidewalk, road] = await Promise.all([
      fetchJSON(DATA_SOURCES.cityBikeLanesSidewalk),
      fetchJSON(DATA_SOURCES.cityBikeLanesRoad),
    ]);

    const drawLine = (f, color, dashArray) => {
      if (!f.geometry) return;
      const coords = geomToLatLng(f.geometry);
      if (!coords) return;
      L.polyline(coords, { color, weight: 3, opacity: 0.85, dashArray })
        .addTo(map);
      // Sample points every ~20m for proximity check
      sampleLinePoints(coords, facilityPoints);
    };

    (sidewalk.features || []).forEach(f => {
      const isTrail = /trail/i.test(f.properties?.StreetName || '');
      drawLine(f, isTrail ? '#16a34a' : '#14b8a6', isTrail ? null : '6 4');
    });
    (road.features || []).forEach(f => drawLine(f, '#0d9488', null));

    noteEl.textContent = `${facilityPoints.length.toLocaleString()} facility sample points loaded`;

    // Compute % crashes without nearby facility
    computeFacilityGap(crashes, facilityPoints);
  } catch (err) {
    console.warn('Bike facility load failed:', err);
    noteEl.textContent = 'Bike facility data unavailable.';
    document.getElementById('no-facility-pct').textContent = 'N/A';
  }

  // Plot crash markers
  crashes.forEach(f => {
    if (sevClass(f.properties.SEVERITY) === 'pdo') return; // only injury/fatal on this map
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const on  = normStreet(p.ON_STREET);
    const at  = normStreet(p.AT_STREET);
    const loc = on && at ? `${on} @ ${at}` : on || at || 'Unknown';
    const sc  = sevClass(p.SEVERITY);
    const popup = `<div class="crash-popup">
      <div class="crash-popup-type ${sc}">${sevLabel(p.SEVERITY)}</div>
      <div class="crash-popup-loc">${escHtml(loc)}</div>
      <div class="crash-popup-meta">${p.ACC_TYPE || ''} · ${p.ACC_DATE || ''}</div>
    </div>`;
    L.marker([lat, lon], { icon: crashCircle(p.SEVERITY) })
      .bindPopup(popup, { maxWidth: 240 })
      .addTo(map);
  });

  // Load schools
  loadSchoolData(crashes, map);
}

function sampleLinePoints(latlngs, out) {
  // latlngs is array of [lat, lon] or nested arrays
  const flat = flattenCoords(latlngs);
  for (let i = 0; i < flat.length - 1; i++) {
    const [lat1, lon1] = flat[i];
    const [lat2, lon2] = flat[i + 1];
    const segLen = distMFast(lat1, lon1, lat2, lon2);
    const steps  = Math.max(1, Math.floor(segLen / 20));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      out.push([lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t]);
    }
  }
}

function flattenCoords(coords) {
  if (!Array.isArray(coords)) return [];
  if (typeof coords[0] === 'number') return [coords];
  if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') return coords;
  return coords.flatMap(flattenCoords);
}

function geomToLatLng(geometry) {
  if (!geometry) return null;
  const t = geometry.type;
  if (t === 'LineString') return geometry.coordinates.map(c => [c[1], c[0]]);
  if (t === 'MultiLineString') return geometry.coordinates.map(line => line.map(c => [c[1], c[0]]));
  return null;
}

function computeFacilityGap(crashes, facilityPoints) {
  if (!facilityPoints.length) return;
  const THRESHOLD_M = 50;

  let noFacility = 0;
  crashes.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    let minDist = Infinity;
    for (let i = 0; i < facilityPoints.length; i++) {
      const d = distMFast(lat, lon, facilityPoints[i][0], facilityPoints[i][1]);
      if (d < minDist) minDist = d;
      if (minDist < THRESHOLD_M) break; // found one close enough
    }
    if (minDist >= THRESHOLD_M) noFacility++;
  });

  const pct = Math.round((noFacility / crashes.length) * 100);
  document.getElementById('no-facility-pct').textContent = `${pct}%`;
}

async function loadSchoolData(crashes, map) {
  const loadingEl = document.getElementById('school-loading');
  const chartWrap = document.getElementById('school-chart-wrap');

  try {
    const schoolGJ = await fetchJSON(DATA_SOURCES.schools);
    const schools = (schoolGJ.features || []).filter(f => f.geometry?.coordinates);

    const QUARTER_MILE_M = 402;

    const ranked = schools.map(s => {
      const [slon, slat] = s.geometry.coordinates;
      const name = s.properties.NAME || 'Unknown School';
      const nearby = crashes.filter(f => {
        const [clon, clat] = f.geometry.coordinates;
        return distMFast(slat, slon, clat, clon) <= QUARTER_MILE_M;
      });
      const fatalNearby = nearby.filter(f => sevClass(f.properties.SEVERITY) === 'fatal').length;
      return { name, count: nearby.length, fatals: fatalNearby, lat: slat, lon: slon };
    })
    .filter(s => s.count > 0)
    .sort((a, b) => b.count - a.count || b.fatals - a.fatals)
    .slice(0, 12);

    // Add school circles to map
    ranked.forEach(s => {
      L.circle([s.lat, s.lon], {
        radius: QUARTER_MILE_M,
        color: '#1370AF', fillColor: '#1370AF', fillOpacity: 0.07,
        weight: 1.5, dashArray: '5 4',
      }).addTo(map);
      L.circleMarker([s.lat, s.lon], {
        radius: 5, color: '#fff', fillColor: '#1370AF', fillOpacity: 1, weight: 2,
      }).bindPopup(`<div class="crash-popup"><div class="crash-popup-loc">${escHtml(s.name)}</div><div class="crash-popup-meta">${s.count} crashes within ¼ mi${s.fatals ? ` · ${s.fatals} fatal` : ''}</div></div>`, { maxWidth: 220 }).addTo(map);
    });

    loadingEl.style.display = 'none';
    chartWrap.style.display = 'block';

    new Chart(document.getElementById('chart-schools'), {
      type: 'bar',
      data: {
        labels: ranked.map(s => s.name),
        datasets: [
          { label: 'Injury crashes', data: ranked.map(s => s.count - s.fatals), backgroundColor: CLR.amber, stack: 'sc', borderRadius: 3 },
          { label: 'Fatal crashes',  data: ranked.map(s => s.fatals),           backgroundColor: CLR.fatal, stack: 'sc', borderRadius: 3 },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          x: { stacked: true, grid: { color: '#f0f3f6' }, ticks: { precision: 0 } },
          y: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
        },
      },
    });
  } catch (err) {
    console.warn('School data load failed:', err);
    loadingEl.textContent = 'School data unavailable.';
  }
}

// =====================================================
// HELPERS
// =====================================================

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// =====================================================
// BOOT
// =====================================================
document.addEventListener('DOMContentLoaded', main);
