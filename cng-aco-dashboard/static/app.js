'use strict';
/* =====================================================================
   Gas Distribution · ACO Route Command Center  (front-end)
   Leaflet map + vanilla JS panels, talks to the Flask API in server.py
   ===================================================================== */
const COLORS = ['#22d3ee', '#fb923c', '#a3e635', '#e879f9', '#60a5fa', '#facc15', '#f87171', '#2dd4bf'];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const F = {
  rp: n => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID'),
  rpS: n => { n = n || 0; return n >= 1e6 ? 'Rp ' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? 'Rp ' + Math.round(n / 1e3) + 'K' : 'Rp ' + Math.round(n); },
  km: n => (n || 0).toFixed(1) + ' km',
  pct: n => Math.round((n || 0) * 100) + '%',
  h: n => { const m = Math.round((n || 0) * 60); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; },
  clock: h => { const m = Math.round((((h % 24) + 24) % 24) * 60); return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); },
};
const S = {
  nodes: [], vehicles: [], settings: {}, run: null, runs: [], events: [], version: 0, overrides: 0,
  filter: { day: 'all' }, hidden: new Set(), sel: null, addMode: false, editMode: false, road: false,
  busy: false, job: null, pick: null, pinned: false, tab: 'itin', sizing: null, live: null, auto: false, legResult: null,
};
const plan = () => S.run && S.run.plan;
const isStale = () => !!(S.run && S.run.data_version !== S.version);
const colorOf = r => COLORS[r.color_idx % COLORS.length];
const routeKey = (d, r) => d + ':' + r.vehicle_id;

function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4200);
}
async function api(path, method = 'GET', body) {
  const o = { method, headers: {} };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch('/api' + path, o); let j = {};
  try { j = await r.json(); } catch (e) { /* empty */ }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/* ---------------------------------------------------------------- state loading */
async function loadState() {
  const st = await api('/state');
  Object.assign(S, { nodes: st.nodes, vehicles: st.vehicles, settings: st.settings, runs: st.runs, events: st.events, version: st.data_version, overrides: st.edge_overrides });
  if (!S.roadInit) { S.roadInit = true; S.road = !!st.settings.use_osrm; $('#road-toggle').checked = S.road; }
  if (!S.pinned || !S.run) S.run = st.run;
  if (S.run && S.pinned) { const r = S.runs.find(x => x.id === S.run.id); if (!r) { S.pinned = false; S.run = st.run; } }
  renderAll();
  $$('.modal-back').forEach(b => b._refresh && b._refresh());
}
async function changed(msg) {
  await loadState();
  if (msg) toast(msg);
  if (S.auto && !S.busy) optimize();
}

/* ---------------------------------------------------------------- SVG helpers */
function lineSVG(series, { w = 300, h = 104, colors = ['#22d3ee', '#fb923c'], dashed = [false, true], labels = null, fmt = F.rpS } = {}) {
  const all = series.flat().filter(v => isFinite(v)); if (!all.length) return '';
  let mn = Math.min(...all), mx = Math.max(...all); if (mx === mn) { mx += 1; mn -= 1; }
  const L = 44, R = 8, T = 8, B = labels ? 18 : 8, pw = w - L - R, ph = h - T - B;
  const n = Math.max(...series.map(s => s.length));
  const X = i => L + (n <= 1 ? pw / 2 : i * pw / (n - 1)), Y = v => T + ph - (v - mn) / (mx - mn) * ph;
  let g = '';
  for (let k = 0; k <= 2; k++) { const v = mn + (mx - mn) * k / 2, y = Y(v); g += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" stroke="rgba(120,180,255,.12)"/><text x="${L - 5}" y="${y + 3}" fill="#7f93ad" font-size="8.5" text-anchor="end">${fmt(v)}</text>`; }
  if (labels) labels.forEach((t, i) => { g += `<text x="${X(i)}" y="${h - 4}" fill="#7f93ad" font-size="8.5" text-anchor="middle">${t}</text>`; });
  series.forEach((s, k) => {
    const pts = s.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    if (k === 0 && s.length > 1) g += `<polygon points="${X(0)},${T + ph} ${pts} ${X(s.length - 1)},${T + ph}" fill="url(#lg${colors[0].slice(1)})" opacity=".35"/>`;
    g += `<polyline points="${pts}" fill="none" stroke="${colors[k]}" stroke-width="2" ${dashed[k] ? 'stroke-dasharray="4 3"' : ''} style="filter:drop-shadow(0 0 4px ${colors[k]})"/>`;
    if (s.length === 1) g += `<circle cx="${X(0)}" cy="${Y(s[0])}" r="3" fill="${colors[k]}"/>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}"><defs><linearGradient id="lg${colors[0].slice(1)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[0]}" stop-opacity="0"/></linearGradient></defs>${g}</svg>`;
}
function dayBarsSVG(days) {
  const vals = days.map(d => d.cost + d.labor), cum = []; vals.reduce((a, v, i) => (cum[i] = a + v), 0);
  const w = 300, h = 112, L = 44, R = 8, T = 8, B = 18, pw = w - L - R, ph = h - T - B, mx = Math.max(...cum, 1);
  const bw = Math.min(34, pw / vals.length * .6), X = i => L + pw / vals.length * (i + .5), Y = v => T + ph - v / mx * ph;
  let g = '';
  for (let k = 0; k <= 2; k++) { const v = mx * k / 2, y = Y(v); g += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" stroke="rgba(120,180,255,.12)"/><text x="${L - 5}" y="${y + 3}" fill="#7f93ad" font-size="8.5" text-anchor="end">${F.rpS(v).replace('Rp ', '')}</text>`; }
  vals.forEach((v, i) => { g += `<rect x="${X(i) - bw / 2}" y="${Y(v)}" width="${bw}" height="${T + ph - Y(v)}" rx="3" fill="url(#bg1)" style="filter:drop-shadow(0 0 5px rgba(34,211,238,.5))"/><text x="${X(i)}" y="${h - 4}" fill="#7f93ad" font-size="8.5" text-anchor="middle">D${days[i].day}</text>`; });
  const pts = cum.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
  g += `<polyline points="${pts}" fill="none" stroke="#fb923c" stroke-width="2" style="filter:drop-shadow(0 0 4px #fb923c)"/>` + cum.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="2.6" fill="#fb923c"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}"><defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#2563eb" stop-opacity=".5"/></linearGradient></defs>${g}</svg>`;
}
function ringSVG(frac, color, size = 54) {
  const r = 22, c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 54 54"><circle cx="27" cy="27" r="${r}" fill="none" stroke="rgba(120,180,255,.15)" stroke-width="5"/><circle cx="27" cy="27" r="${r}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * Math.min(Math.max(frac, 0), 1)).toFixed(1)} ${c}" transform="rotate(-90 27 27)" style="filter:drop-shadow(0 0 4px ${color})"/></svg>`;
}
const LV = { critical: '#ef4444', warning: '#f59e0b', normal: '#34d399' };

/* ---------------------------------------------------------------- left panels */
function miniMapSVG() {
  const p = plan(), W = 300, H = 112, pad = 10;
  const pts = []; const routes = [];
  if (p) p.days.forEach(d => { if (S.filter.day !== 'all' && String(d.day) !== String(S.filter.day)) return; d.routes.forEach(r => { routes.push(r); r.stops.forEach(s => pts.push(s)); }); });
  if (!pts.length) S.nodes.filter(n => n.active).forEach(n => pts.push(n));
  if (!pts.length) return '';
  const lat0 = pts.reduce((a, s) => a + s.lat, 0) / pts.length, k = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map(s => s.lng * k), ys = pts.map(s => -s.lat);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = Math.min((W - 2 * pad) / ((x1 - x0) || 1), (H - 2 * pad) / ((y1 - y0) || 1));
  const ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * sc) / 2;
  const P = s => [ox + (s.lng * k - x0) * sc, oy + (-s.lat - y0) * sc];
  let g = '';
  routes.forEach(r => { const c = colorOf(r); g += `<polyline points="${r.stops.map(s => P(s).join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="1.8" opacity=".9" style="filter:drop-shadow(0 0 3px ${c})"/>`; });
  const seen = new Set();
  pts.forEach(s => { const id = s.node_id ?? s.id; if (seen.has(id)) return; seen.add(id); const [x, y] = P(s);
    g += (s.kind === 'depot') ? `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="2" fill="#22d3ee"/>` : `<circle cx="${x}" cy="${y}" r="2.6" fill="#0b1626" stroke="#9fc4ff" stroke-width="1.2"/>`; });
  return `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
}
function renderFleet() {
  const p = plan(), sm = p && p.summary, act = S.vehicles.filter(v => v.active);
  let h = `<div class="statrow">
    <div class="stat"><label>Trucks</label><b class="c-cyan">${sm ? sm.vehicles_used : 0}<small>/${act.length}</small></b></div>
    <div class="stat"><label>Avg Load</label><b class="c-green">${sm ? F.pct(sm.avg_utilization) : '–'}</b></div>
    <div class="stat"><label>Speed</label><b class="c-orange">${sm ? Math.round(sm.avg_speed) : '–'}<small>km/h</small></b></div></div>
    <div class="minimap">${miniMapSVG()}</div>`;
  act.forEach((v, k) => {
    const rs = p ? p.days.flatMap(d => d.routes).filter(r => r.vehicle_id === v.id) : [];
    const util = rs.length ? rs.reduce((a, r) => a + r.utilization, 0) / rs.length : 0;
    const km = rs.reduce((a, r) => a + r.km, 0), hrs = rs.reduce((a, r) => a + r.hours, 0);
    const c = COLORS[k % COLORS.length];
    h += `<div class="truck ${S.hidden.has(v.id) ? 'off' : ''}"><span class="dot" style="background:${c};color:${c}"></span><span class="nm">${esc(v.name)}</span>
      <span class="meta">${rs.length} trip${rs.length === 1 ? '' : 's'} · ${km.toFixed(0)} km · ${F.h(hrs)}</span>
      <div class="bar"><i style="width:${Math.round(util * 100)}%;background:linear-gradient(90deg,${c},#2563eb)"></i></div></div>`;
  });
  $('#fleet-body').innerHTML = h;
}
function renderUrgency() {
  const cust = S.nodes.filter(n => n.kind === 'customer' && n.active).sort((a, b) => b.gamma - a.gamma);
  const crit = cust.filter(n => n.level === 'critical').length, warn = cust.filter(n => n.level === 'warning').length;
  const tile = n => `<div class="tile" data-fly="${n.id}"><div class="ring">${ringSVG(n.gamma - 1, LV[n.level])}<b style="color:${LV[n.level]}">${n.gamma.toFixed(2)}</b></div>
    <div class="nm" title="${esc(n.name)}">${esc(n.name)}</div><div class="cv">${n.days_cover == null ? '–' : n.days_cover.toFixed(1) + ' d cover'}</div></div>`;
  let h = `<div class="tiles">${cust.slice(0, 4).map(tile).join('')}</div>
    <div class="alertfoot">Alerts: <span class="pill red">${crit}</span> Critical <span class="pill amber">${warn}</span> Warning</div>
    <div class="sec" style="margin-top:12px">NEXT IN LINE</div>`;
  cust.slice(4, 14).forEach(n => {
    h += `<div class="truck" data-fly="${n.id}" style="cursor:pointer"><span class="dot" style="background:${LV[n.level]};color:${LV[n.level]}"></span><span class="nm" style="font-size:11px">${esc(n.name)}</span>
      <span class="meta">γ ${n.gamma.toFixed(2)} · ${n.days_cover == null ? '–' : n.days_cover.toFixed(1) + 'd'}</span></div>`;
  });
  if (!cust.length) h = '<div class="muted">No active customers. Add stops to begin.</div>';
  $('#urg-body').innerHTML = h;
}

/* ---------------------------------------------------------------- map */
let map, nodeLayer, routeLayer, previewLayer, markers = {}, roadCache = {}, roadChain = Promise.resolve();
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([-7.6, 112.65], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { subdomains: 'abc', maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  routeLayer = L.layerGroup().addTo(map); nodeLayer = L.layerGroup().addTo(map); previewLayer = L.layerGroup().addTo(map);
  map.on('click', e => {
    if (S.pick) { const cb = S.pick.cb; endPick(); cb(e.latlng); }
    else if (S.addMode) openStopForm(null, { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) });
  });
  window.addEventListener('resize', () => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 200);
}
function visibleRoutes() {
  const out = []; const p = plan(); if (!p) return out;
  p.days.forEach(d => { if (S.filter.day !== 'all' && String(d.day) !== String(S.filter.day)) return; d.routes.forEach(r => { if (!S.hidden.has(r.vehicle_id)) out.push({ day: d.day, r }); }); });
  return out;
}
function nodeRoutes() {
  const m = {}; const p = plan(); if (!p) return m;
  p.days.forEach(d => d.routes.forEach(r => r.stops.forEach((s, i) => { if (s.kind !== 'depot') m[s.node_id] = { day: d.day, r, i, s, color: colorOf(r) }; })));
  return m;
}
function bearing(a, b) { const k = Math.cos(a[0] * Math.PI / 180); return Math.atan2((b[1] - a[1]) * k, b[0] - a[0]) * 180 / Math.PI; }
function drawRoutes() {
  routeLayer.clearLayers(); S.drawTok = (S.drawTok || 0) + 1;
  visibleRoutes().forEach(({ day, r }) => {
    const key = routeKey(day, r), col = colorOf(r), dim = S.sel && S.sel !== key;
    let pts = r.stops.map(s => [s.lat, s.lng]);
    const glow = L.polyline(pts, { color: col, weight: 9, opacity: dim ? .06 : .16, className: 'route-glow', interactive: false }).addTo(routeLayer);
    const flow = L.polyline(pts, { color: col, weight: 3, opacity: dim ? .22 : .95, className: 'route-flow' }).addTo(routeLayer);
    [glow, flow].forEach(l => l._path && l._path.style.setProperty('--c', col));
    flow.on('click', () => selectRoute(key));
    flow.bindTooltip(`<b>${esc(r.vehicle_name)}</b> · Day ${day}<br>${F.km(r.km)} · ${F.h(r.hours)} · ${F.rp(r.cost)}<br>Load ${r.load.toFixed(0)} m³ (${F.pct(r.utilization)})`, { sticky: true, className: 'tip' });
    if (S.road) {
      const tok = S.drawTok;
      roadChain = roadChain.then(async () => {
        const all = [];
        for (let i = 0; i < pts.length - 1; i++) {
          if (tok !== S.drawTok) return;
          const g = await legGeometry(pts[i], pts[i + 1], r.stops[i + 1].leg.mode);
          all.push(...(g || [pts[i], pts[i + 1]]));
          glow.setLatLngs(all); flow.setLatLngs(all);
        }
      }).catch(() => { });
    } else if (!dim) {
      for (let i = 0; i < pts.length - 1; i++) {
        const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2], b = bearing(pts[i], pts[i + 1]);
        L.marker(mid, { interactive: false, icon: L.divIcon({ className: '', iconSize: [11, 11], iconAnchor: [5, 5], html: `<div style="transform:rotate(${b}deg);font-size:11px;line-height:11px;color:${col};text-shadow:0 0 6px ${col};text-align:center">▲</div>` }) }).addTo(routeLayer);
      }
    }
  });
}
async function legGeometry(p, q, mode) {
  const key = 'rg2:' + [p, q].map(x => x[0].toFixed(5) + ',' + x[1].toFixed(5)).join('>') + ':' + mode;
  if (roadCache[key] !== undefined) return roadCache[key];
  try { const c = localStorage.getItem(key); if (c) return (roadCache[key] = JSON.parse(c)); } catch (e) { /* ignore */ }
  const base = `https://router.project-osrm.org/route/v1/driving/${p[1]},${p[0]};${q[1]},${q[0]}?overview=full&geometries=geojson`;
  let geom = null;
  for (const url of mode === 'nontoll' ? [base + '&exclude=toll', base] : [base]) {
    try {
      const j = await (await fetch(url)).json();
      if (j.code === 'Ok') { geom = j.routes[0].geometry.coordinates.map(c => [+c[1].toFixed(5), +c[0].toFixed(5)]); break; }
    } catch (e) { /* try next */ }
    await sleep(150);
  }
  roadCache[key] = geom;
  if (geom) { try { localStorage.setItem(key, JSON.stringify(geom)); } catch (e) { /* quota */ } }
  await sleep(120);
  return geom;
}
function nodePopup(n, ri) {
  const dc = n.days_cover == null ? '–' : n.days_cover.toFixed(1) + ' days';
  let h = `<b>${esc(n.name)}</b><br><span class="muted">${n.kind === 'depot' ? 'Depot' : 'Customer'} · ${esc(n.region)}</span>`;
  if (n.kind === 'customer') h += `<br>Demand <b>${n.demand}</b> m³ · Stock ${n.stock}/${n.stock_max}<br>Urgency γ <b style="color:${LV[n.level]}">${n.gamma.toFixed(2)}</b> · cover ${dc}<br>Window ${F.clock(n.tw_open)}–${F.clock(n.tw_close)}`;
  if (ri) h += `<hr style="border:0;border-top:1px solid rgba(120,180,255,.2)"><span style="color:${ri.color}">●</span> ${esc(ri.r.vehicle_name)} · Day ${ri.day} · stop #${ri.i}<br>ETA <b>${F.clock(ri.s.arrive)}</b> → depart ${F.clock(ri.s.finish)}${ri.s.risk ? '<br><span class="c-red">⚠ stock-out before delivery</span>' : ''}`;
  h += `<div class="pop-actions"><button class="btn sm" data-pop="edit" data-id="${n.id}">Edit</button><button class="btn sm danger" data-pop="del" data-id="${n.id}">Delete</button></div>`;
  return h;
}
function drawNodes() {
  nodeLayer.clearLayers(); markers = {}; const info = nodeRoutes();
  const top3 = S.nodes.filter(n => n.active && n.kind === 'customer' && n.level === 'critical').sort((a, b) => b.gamma - a.gamma).slice(0, 3).map(n => n.id);
  S.nodes.forEach(n => {
    const ri = info[n.id]; let cls = 'mk', label = '', color = '';
    if (n.kind === 'depot') { cls += ' depot'; label = '⌂'; }
    else if (ri) {
      color = ri.color; label = ri.i;
      const hide = (S.filter.day !== 'all' && String(ri.day) !== String(S.filter.day)) || S.hidden.has(ri.r.vehicle_id);
      if (hide) cls += ' off';
    } else cls += ' idle';
    if (!n.active) cls += ' off';
    if (n.kind === 'customer' && n.level === 'critical') cls += ' crit'; else if (n.level === 'warning') cls += ' warn';
    const m = L.marker([n.lat, n.lng], { draggable: S.editMode, riseOnHover: true,
      icon: L.divIcon({ className: '', iconSize: n.kind === 'depot' ? [34, 34] : [26, 26], iconAnchor: n.kind === 'depot' ? [17, 17] : [13, 13], html: `<div class="${cls}" style="${color ? '--c:' + color : ''}">${label}</div>` }) }).addTo(nodeLayer);
    m.bindPopup(() => nodePopup(n, nodeRoutes()[n.id]), { maxWidth: 280 });
    if (top3.includes(n.id)) m.bindTooltip(`<b>${esc(n.name.length > 22 ? n.name.slice(0, 21) + '…' : n.name)}</b>: <span class="r">STOCK-OUT RISK</span>`, { permanent: true, direction: 'top', className: 'callout', offset: [0, -14] });
    else m.bindTooltip(esc(n.name), { direction: 'top', className: 'tip', offset: [0, -12] });
    m.on('dragend', async e => {
      const ll = e.target.getLatLng();
      try { await api('/nodes/' + n.id, 'PUT', { lat: ll.lat, lng: ll.lng, auto_region: true }); await changed('Moved ' + n.name); } catch (er) { toast(er.message, true); loadState(); }
    });
    markers[n.id] = m;
  });
}
function renderLegend() {
  const act = S.vehicles.filter(v => v.active);
  $('#map-legend').innerHTML = act.map((v, k) => `<div class="${S.hidden.has(v.id) ? 'hid' : ''}" data-leg="${v.id}"><i style="background:${COLORS[k % COLORS.length]};color:${COLORS[k % COLORS.length]}"></i>${esc(v.name)}</div>`).join('') +
    `<div style="cursor:default"><span style="color:#ef4444">◉</span> Critical stock</div><div style="cursor:default"><span style="color:#22d3ee">⌂</span> Depot</div>`;
}
function renderMapHead() {
  const sm = plan() && plan().summary;
  $('#mh-date').textContent = new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const al = computeAlerts().filter(a => a.lvl !== 'info').length;
  let c = '';
  if (sm) {
    c += `<div class="chip"><span class="d" style="background:${sm.sla_ok ? '#34d399' : '#ef4444'};box-shadow:0 0 8px ${sm.sla_ok ? '#34d399' : '#ef4444'}"></span><b style="color:${sm.sla_ok ? '#34d399' : '#ef4444'}">${sm.days} day${sm.days > 1 ? 's' : ''}</b> (SLA ≤ ${sm.sla_days})</div>
      <div class="chip">Cost <b class="c-orange">${F.rp(sm.total_cost)}</b></div><div class="chip">Dist <b>${F.km(sm.distance)}</b></div>
      <div class="chip">Drive <b>${F.h(sm.drive_hours)}</b></div><div class="chip">Avg <b>${Math.round(sm.avg_speed)}</b> km/h</div>`;
  } else c += `<div class="chip"><span class="d" style="background:#f59e0b"></span>No plan yet — press <b>Optimize</b></div>`;
  c += `<div class="chip"><b class="${al ? 'c-red' : 'c-green'}">${al}</b> Active Alerts</div>`;
  $('#mh-chips').innerHTML = c;
  const sel = $('#day-filter'), nd = plan() ? plan().days.length : 0;
  sel.innerHTML = '<option value="all">All days</option>' + Array.from({ length: nd }, (_, i) => `<option value="${i + 1}">Day ${i + 1}</option>`).join('');
  if (S.filter.day !== 'all' && +S.filter.day > nd) S.filter.day = 'all';
  sel.value = S.filter.day;
}
function setBanner() {
  const b = $('#map-banner'); let txt = '', cls = '';
  if (S.pick) txt = S.pick.msg; else if (S.addMode) txt = '⊕ Click anywhere on the map to add a new stop (ESC to cancel)';
  else if (S.editMode) txt = '✥ Edit mode: drag any marker to move that stop';
  else if (isStale()) { txt = '⚠ Data changed since the last optimization — click here to re-optimize'; cls = 'stale'; }
  b.className = 'map-banner' + (txt ? ' show ' : ' ') + cls; b.textContent = txt;
  $('#map').classList.toggle('picking', !!(S.pick || S.addMode));
  $('#t-add').classList.toggle('on', S.addMode); $('#t-edit').classList.toggle('on', S.editMode);
}
function renderMap() { drawRoutes(); drawNodes(); renderLegend(); renderMapHead(); setBanner(); }
function fitView(anim = true) {
  const vr = visibleRoutes(); let pts = vr.flatMap(({ r }) => r.stops.map(s => [s.lat, s.lng]));
  if (!pts.length) pts = S.nodes.filter(n => n.active).map(n => [n.lat, n.lng]); if (!pts.length) return;
  const dh = $('#drawer').classList.contains('min') ? 60 : 250;
  map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [60, 70], paddingBottomRight: [60, dh + 20], maxZoom: 13, animate: anim });
}
function selectRoute(key) {
  S.sel = S.sel === key ? null : key; drawRoutes(); renderDrawer();
  if (S.sel) { const f = visibleRoutes().find(x => routeKey(x.day, x.r) === S.sel); if (f) map.fitBounds(L.latLngBounds(f.r.stops.map(s => [s.lat, s.lng])), { paddingTopLeft: [60, 70], paddingBottomRight: [60, 270], maxZoom: 13 }); }
}
function flyTo(id) { const n = S.nodes.find(x => x.id === +id); if (!n) return; map.flyTo([n.lat, n.lng], 13, { duration: .7 }); setTimeout(() => markers[n.id] && markers[n.id].openPopup(), 750); }

/* ---------------------------------------------------------------- right panels */
function renderCost() {
  const sm = plan() && plan().summary, el = $('#cost-body');
  if (!sm) { el.innerHTML = '<div class="muted" style="padding:14px 0">Run the optimizer to see cost analytics.</div>'; return; }
  const t = sm.grand_total || 1, pc = x => Math.round(x / t * 100);
  el.innerHTML = `<div class="row" style="justify-content:space-between;align-items:flex-end"><div><div class="muted" style="font-size:10px;letter-spacing:.08em">TOTAL LOGISTICS COST</div><div class="big">${F.rp(sm.grand_total)}</div></div>
      <div style="text-align:right"><div class="muted" style="font-size:10px">PER m³</div><div class="mono c-cyan" style="font-size:14px;font-weight:700">${F.rp(sm.load ? sm.grand_total / sm.load : 0)}</div></div></div>
    <div class="stack"><i style="width:${pc(sm.fuel_cost)}%;background:#22d3ee"></i><i style="width:${pc(sm.toll_cost)}%;background:#f59e0b"></i><i style="width:${pc(sm.labor_cost)}%;background:#a78bfa"></i></div>
    <div class="trio"><div><span style="color:#22d3ee">●</span> Fuel<b>${pc(sm.fuel_cost)}%</b></div><div><span style="color:#f59e0b">●</span> Toll<b>${pc(sm.toll_cost)}%</b></div><div><span style="color:#a78bfa">●</span> Labor<b>${pc(sm.labor_cost)}%</b></div></div>
    <div class="chart" style="margin-top:8px">${dayBarsSVG(plan().days)}</div>
    <div class="kpi2">
      <div class="kv"><span>Distance</span><b class="mono">${F.km(sm.distance)}</b></div><div class="kv"><span>Fuel</span><b class="mono">${sm.liters.toFixed(0)} L</b></div>
      <div class="kv"><span>CO₂</span><b class="mono">${sm.co2_kg.toFixed(0)} kg</b></div><div class="kv"><span>Delivered</span><b class="mono">${sm.load.toFixed(0)} m³</b></div>
      <div class="kv"><span>Urgency penalty</span><b class="mono">${F.rpS(sm.penalty)}</b></div><div class="kv"><span>Stock-out risks</span><b class="mono ${sm.stockout_risks ? 'c-red' : 'c-green'}">${sm.stockout_risks}</b></div>
      <div class="kv"><span>Shift hours</span><b class="mono">${F.h(sm.shift_hours)}</b></div><div class="kv"><span>Policy</span><b class="mono">${esc(sm.policy)}</b></div>
      <div class="kv" style="grid-column:1/3"><span>Road data</span><b class="mono ${sm.road_source === 'osrm' ? 'c-green' : 'c-orange'}">${sm.road_source === 'osrm' ? '✓ Real roads (OSRM)' : '⚠ Estimated (offline / disabled)'}</b></div>
    </div>`;
}
function buildOpt() {
  $('#opt-body').innerHTML = `<div class="g3"><label class="fld">Ants<input id="o-ants" type="number" min="3" max="300"></label><label class="fld">Iterations<input id="o-it" type="number" min="1" max="1000"></label><label class="fld">Seed<input id="o-seed" placeholder="random"></label></div>
    <div class="row" style="margin-top:9px"><button class="btn primary" id="o-run">▶ Optimize</button><button class="btn" id="o-stop" disabled>■ Stop</button><label class="chk" style="font-size:11px"><input type="checkbox" id="o-auto"> Auto re-run on changes</label></div>
    <div class="progress"><i id="o-prog"></i></div><div class="muted mono" id="o-status" style="font-size:10.5px;min-height:15px"></div><div class="chart" id="o-chart"></div>`;
  $('#o-run').onclick = optimize; $('#o-stop').onclick = () => S.job && api('/jobs/' + S.job + '/cancel', 'POST');
  $('#o-auto').onchange = e => { S.auto = e.target.checked; };
  $('#size-body').innerHTML = `<div class="row" style="justify-content:space-between"><span class="muted" style="font-size:11px">Re-solve with 1…N trucks</span><button class="btn sm" id="s-run">Analyze 1–6</button></div><div id="s-res"></div>`;
  $('#s-run').onclick = () => runSizing(6);
}
function syncOptInputs() {
  const a = S.settings.aco || {}; const set = (id, v) => { const e = $(id); if (e && document.activeElement !== e && !e.dataset.dirty) e.value = v ?? ''; };
  set('#o-ants', a.ants); set('#o-it', a.iterations); set('#o-seed', a.seed);
  ['#o-ants', '#o-it', '#o-seed'].forEach(i => $(i).oninput = e => { e.target.dataset.dirty = 1; });
}
function renderConv(best, mean) {
  const el = $('#o-chart'); if (!el) return;
  el.innerHTML = best && best.length ? lineSVG([best, mean && mean.length ? mean : best], { labels: null }) + '<div class="row" style="font-size:10px;color:#7f93ad;gap:12px"><span style="color:#22d3ee">━ best</span><span style="color:#fb923c">┅ colony mean</span><span style="margin-left:auto">convergence (Rp)</span></div>' : '<div class="muted" style="font-size:11px;padding:8px 0">Convergence curve appears here.</div>';
}
function renderOpt() {
  syncOptInputs(); if (!S.busy) { const c = S.run && S.run.convergence; renderConv(c && c.best, c && c.mean); }
}
function renderSizing() {
  const el = $('#s-res'); if (!el) return; const rows = S.sizing;
  if (!rows) { el.innerHTML = '<div class="fc"><div class="fcard">Find how many trucks you need to meet the SLA</div></div>'; return; }
  const okRows = rows.filter(r => r.sla_ok), best = okRows.length ? okRows.reduce((a, r) => (r.grand_total < a.grand_total ? r : a)) : null;
  el.innerHTML = `<div class="fc">${rows.map(r => `<div class="fcard ${r.sla_ok ? 'ok' : 'bad'} ${best && best.trucks === r.trucks ? 'best' : ''}">${r.trucks} 🚚<b>${r.days}d</b>${F.rpS(r.grand_total).replace('Rp ', '')}<br>${F.pct(r.utilization)}</div>`).join('')}</div>
    <div class="muted" style="font-size:10px;margin-top:6px">${best ? `✓ Cheapest within ${S.settings.sla_days}-day SLA: <b class="c-green">${best.trucks} truck(s)</b>` : '✗ No fleet size meets the SLA'}</div>`;
}
function renderLog() {
  $('#log-body').innerHTML = '<div class="log">' + S.events.map(e => `<div class="${e.level}"><i></i><time>${esc((e.ts || '').slice(11, 16))}</time><span>${esc(e.message)}</span></div>`).join('') + '</div>';
}
function computeAlerts() {
  const a = [], p = plan();
  S.nodes.filter(n => n.active && n.kind === 'customer' && n.level === 'critical').sort((x, y) => y.gamma - x.gamma)
    .forEach(n => a.push({ lvl: 'critical', title: n.name, msg: `Critical stock · urgency γ ${n.gamma.toFixed(2)} · cover ${n.days_cover == null ? '–' : n.days_cover.toFixed(1) + ' d'}`, node: n.id }));
  S.nodes.filter(n => n.active && n.kind === 'customer' && n.level === 'warning')
    .forEach(n => a.push({ lvl: 'warning', title: n.name, msg: `Low stock · urgency γ ${n.gamma.toFixed(2)} · cover ${n.days_cover == null ? '–' : n.days_cover.toFixed(1) + ' d'}`, node: n.id }));
  if (p) {
    const sm = p.summary;
    if (!sm.sla_ok) a.unshift({ lvl: 'critical', title: 'SLA breach', msg: `Plan needs ${sm.days} days, SLA is ${sm.sla_days}. Add trucks (see Fleet Sizing).` });
    p.days.forEach(d => d.routes.forEach(r => r.stops.filter(s => s.risk).forEach(s => a.push({ lvl: 'critical', title: s.name + ' — stock-out risk', msg: `Delivered on day ${d.day} but stock cover is only ${s.days_cover} days`, node: s.node_id }))));
    p.unserved.forEach(u => a.push({ lvl: 'critical', title: u.name + ' — unserved', msg: u.reason, node: u.node_id }));
  }
  if (isStale()) a.unshift({ lvl: 'info', title: 'Plan outdated', msg: 'Stops, fleet or settings changed since the last optimization.' });
  return a;
}
function renderTop() {
  const n = computeAlerts().filter(a => a.lvl !== 'info').length;
  const b = $('#alert-badge'); b.textContent = n; b.style.display = n ? '' : 'none';
}
function renderAll() { renderTop(); renderFleet(); renderUrgency(); renderMap(); renderDrawer(); renderCost(); renderOpt(); renderSizing(); renderLog(); }

/* ---------------------------------------------------------------- drawer: itinerary + leg analyzer */
function renderDrawer() {
  $$('.drawer-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  const body = $('#drawer-body');
  if (S.tab === 'leg') return renderLeg(body);
  previewLayer && previewLayer.clearLayers();
  if (!plan()) { body.innerHTML = '<div class="muted">No optimized plan yet. Press <b>▶ Optimize</b> in the ACO Optimizer panel.</div>'; return; }
  const vr = visibleRoutes();
  if (!vr.length) { body.innerHTML = '<div class="muted">All routes are hidden by the current filters.</div>'; return; }
  const cur = vr.find(x => routeKey(x.day, x.r) === S.sel) || vr[0], r = cur.r;
  let h = '<div class="rchips">' + vr.map(({ day, r: rr }) => { const k = routeKey(day, rr); return `<div class="rchip ${k === routeKey(cur.day, r) ? 'sel' : ''}" data-route="${k}"><i style="background:${colorOf(rr)};box-shadow:0 0 8px ${colorOf(rr)}"></i>D${day} · ${esc(rr.vehicle_name)} · ${F.rpS(rr.cost)}</div>`; }).join('') + '</div>';
  h += `<div class="row" style="font-size:11px;margin:2px 0 6px;gap:16px"><span>Load <b class="mono">${r.load.toFixed(0)}/${r.capacity.toFixed(0)} m³</b> (${F.pct(r.utilization)})</span><span>Distance <b class="mono">${F.km(r.km)}</b></span><span>Cost <b class="mono c-orange">${F.rp(r.cost)}</b> <small>(fuel ${F.rpS(r.fuel)} · toll ${F.rpS(r.toll)})</small></span><span>Duration <b class="mono">${F.h(r.hours)}</b> <small>(drive ${F.h(r.drive_hours)} · service ${F.h(r.service_hours)}${r.wait_hours > .01 ? ' · wait ' + F.h(r.wait_hours) : ''})</small></span><span>Back at depot <b class="mono">${F.clock(r.end)}</b></span></div>`;
  h += '<table class="t"><thead><tr><th>#</th><th>Stop</th><th>Arrive</th><th>Service</th><th>Depart</th><th class="r">Leg km</th><th class="r">Leg time</th><th class="r">Leg cost</th><th>Road</th><th class="r">Load</th><th class="r">γ</th><th></th></tr></thead><tbody>';
  r.stops.forEach((s, i) => {
    const lg = s.leg, last = i === r.stops.length - 1 && s.kind === 'depot' && i > 0;
    h += `<tr data-fly="${s.node_id}" style="cursor:pointer"><td>${s.kind === 'depot' ? '⌂' : i}</td><td><b>${esc(s.name)}</b>${last ? ' <small>(return)</small>' : ''}</td><td class="mono">${i ? F.clock(s.arrive) : '–'}</td><td class="mono">${s.kind === 'depot' ? '–' : F.h(s.finish - s.start) + (s.wait > .01 ? ' <small>+wait ' + F.h(s.wait) + '</small>' : '')}</td><td class="mono">${F.clock(s.finish)}</td>
      <td class="r mono">${lg ? lg.km.toFixed(1) : ''}</td><td class="r mono">${lg ? F.h(lg.hours) : ''}</td><td class="r mono">${lg ? F.rp(lg.cost) : ''}</td><td>${lg ? `<span class="tag ${lg.mode}">${lg.mode === 'toll' ? 'TOLL' : 'NON-TOLL'}</span>` : ''}</td>
      <td class="r mono">${s.kind === 'depot' ? '' : s.load_after.toFixed(0)}</td><td class="r mono" style="color:${s.gamma >= 1.75 ? '#ef4444' : s.gamma >= 1.4 ? '#f59e0b' : '#34d399'}">${s.kind === 'depot' ? '' : s.gamma.toFixed(2)}</td><td>${s.risk ? '<span class="tag risk">STOCK-OUT RISK</span>' : ''}</td></tr>`;
  });
  body.innerHTML = h + '</tbody></table>';
}
function renderLeg(body) {
  const act = S.nodes.filter(n => n.active), v = S.vehicles.filter(x => x.active), ls = S.legSel || {};
  const opt = (arr, sel) => arr.map(n => `<option value="${n.id}" ${+sel === n.id ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
  body.innerHTML = `<div class="row" style="align-items:flex-end"><label class="fld" style="flex:1;min-width:170px">From<select id="lg-a">${opt(act, ls.a || (act[0] && act[0].id))}</select></label>
    <label class="fld" style="flex:1;min-width:170px">To<select id="lg-b">${opt(act, ls.b || (act[1] && act[1].id))}</select></label>
    <label class="fld" style="min-width:140px">Truck<select id="lg-v">${opt(v, ls.v)}</select></label><button class="btn primary" id="lg-go">Compare routes</button></div><div id="lg-res">${S.legResult || ''}</div>`;
  $('#lg-go').onclick = async () => {
    const a = $('#lg-a').value, b = $('#lg-b').value, vv = $('#lg-v').value; S.legSel = { a, b, v: vv };
    try {
      const j = await api(`/leg?a=${a}&b=${b}&vehicle=${vv}`);
      S.legResult = `<div class="legcards">${j.options.map(o => `<div class="legcard ${o.mode === j.chosen ? 'rec' : ''}"><h4>${o.mode === 'toll' ? '🛣 Toll road' : '🛤 Non-toll road'}${o.mode === j.chosen ? `<span class="pill green">RECOMMENDED · ${esc(j.policy)}</span>` : ''}</h4>
        <div class="kv"><span>Distance</span><b class="mono">${F.km(o.km)}</b></div><div class="kv"><span>Travel time</span><b class="mono">${F.h(o.hours)}</b></div>
        <div class="kv"><span>Fuel</span><b class="mono">${F.rp(o.fuel)}</b></div><div class="kv"><span>Toll fee</span><b class="mono">${F.rp(o.toll)}</b></div>
        <div class="kv"><span><b>Total cost</b></span><b class="mono c-orange">${F.rp(o.cost)}</b></div></div>`).join('')}</div>`;
      $('#lg-res').innerHTML = S.legResult;
      previewLayer.clearLayers();
      const pts = [[j.a.lat, j.a.lng], [j.b.lat, j.b.lng]];
      const line = L.polyline(pts, { color: '#f0abfc', weight: 4, dashArray: '6 8', opacity: .95 }).addTo(previewLayer);
      pts.forEach((p, i) => L.circleMarker(p, { radius: 6, color: '#f0abfc', fillColor: '#0b1626', fillOpacity: 1 }).addTo(previewLayer).bindTooltip(i ? j.b.name : j.a.name));
      if (S.settings.use_osrm) legGeometry(pts[0], pts[1], j.chosen).then(g => { if (g) { line.setLatLngs(g); line.setStyle({ dashArray: null }); map.fitBounds(L.latLngBounds(g), { paddingTopLeft: [80, 80], paddingBottomRight: [80, 300], maxZoom: 12 }); } });
      map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [80, 80], paddingBottomRight: [80, 300], maxZoom: 12 });
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------------------------------------------------------- jobs: optimize / sizing */
async function runJob(path, body, tick) {
  const { job_id } = await api(path, 'POST', body); S.job = job_id;
  for (;;) { await sleep(300); const j = await api('/jobs/' + job_id); tick && tick(j); if (j.status !== 'running') { S.job = null; return j; } }
}
function setBusy(b, label) {
  S.busy = b; $('#o-run').disabled = b; $('#s-run').disabled = b; $('#o-stop').disabled = !b;
  const st = $('.status'); st.classList.toggle('busy', b); $('#sys-status').textContent = b ? (label || 'OPTIMIZING') : 'OPERATIONAL';
  if (!b) { $('#o-prog').style.width = '0'; }
}
async function optimize() {
  if (S.busy) return; setBusy(true);
  const body = { ants: +$('#o-ants').value || 30, iterations: +$('#o-it').value || 100 }; const sd = $('#o-seed').value.trim(); if (sd !== '') body.seed = +sd;
  try {
    $('#o-status').textContent = 'Starting colony…';
    const j = await runJob('/optimize', body, j => {
      $('#o-prog').style.width = Math.round(j.progress * 100) + '%';
      $('#o-status').textContent = j.iter ? `iter ${j.iter}/${j.total} · best ${F.rp(j.best)}` : 'Building graph…';
      renderConv(j.history, j.mean_hist);
    });
    if (j.status === 'error') throw new Error(j.error);
    S.pinned = false; S.sel = null; await loadState(); fitView();
    const sm = plan().summary;
    toast(j.status === 'cancelled' ? 'Stopped — showing best plan so far' : `Optimized: ${F.rp(sm.total_cost)} · ${sm.days} day(s) · ${sm.distance.toFixed(0)} km`, j.status === 'cancelled' ? false : !sm.sla_ok);
    $('#o-status').textContent = `done in ${sm.runtime}s · ${sm.iterations} iterations`;
  } catch (e) { toast(e.message, true); $('#o-status').textContent = e.message; }
  finally { setBusy(false); }
}
function setProg(p, msg) { ['#o-prog', '#fz-prog'].forEach(i => { const e = $(i); if (e) e.style.width = Math.round(p * 100) + '%'; }); const m = $('#fz-msg'); if (m && msg !== undefined) m.textContent = msg; }
const refreshModals = () => $$('.modal-back').forEach(b => b._refresh && b._refresh());
async function runSizing(max = 6) {
  if (S.busy) return; setBusy(true, 'ANALYZING'); max = +max || 6;
  try {
    $('#s-res').innerHTML = `<div class="muted" style="font-size:11px;padding:8px 0">Solving fleet sizes 1…${max} …</div>`;
    const j = await runJob('/sizing', { max_trucks: max }, j => setProg(j.progress, `Fleet size ${j.iter || 0}/${max}`));
    if (j.status === 'error') throw new Error(j.error);
    S.sizing = j.result && j.result.rows; renderSizing(); await loadState();
  } catch (e) { toast(e.message, true); renderSizing(); }
  finally { setBusy(false); setProg(0, ''); refreshModals(); }
}
async function runScenarios(group = 'all') {
  if (S.busy) return; setBusy(true, 'SIMULATING');
  try {
    const j = await runJob('/scenarios', { group }, j => setProg(j.progress, `Scenario ${j.iter || 0}/${j.total || '…'}`));
    if (j.status === 'error') throw new Error(j.error);
    const rows = (j.result && j.result.rows) || [], groups = new Set(rows.map(r => r.group));
    S.scen = (S.scen || []).filter(r => !groups.has(r.group)).concat(rows); await loadState();
  } catch (e) { toast(e.message, true); }
  finally { setBusy(false); setProg(0, ''); refreshModals(); }
}

/* ---------------------------------------------------------------- modal system */
function modal({ title, body, footer = '', w = 780, onMount, refresh, full = false }) {
  const back = document.createElement('div'); back.className = 'modal-back';
  back.innerHTML = `<div class="modal${full ? ' full' : ''}" style="--w:${w}px"><header><h2>${title}</h2><button class="x">×</button></header><div class="modal-body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
  $('#modal-root').appendChild(back);
  const close = () => back.remove();
  $('.x', back).onclick = close; back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back._refresh = refresh; onMount && onMount(back, close); return { el: back, close };
}
const closeAllModals = () => $$('.modal-back').forEach(b => b.remove());
function startPick(cb, msg) { S.pick = { cb, msg }; closeAllModals(); setBanner(); }
function endPick() { S.pick = null; setBanner(); }

/* ---- stops manager */
function openStops() {
  let q = '', f = 'all', root = null;
  const m = modal({
    title: 'MANAGE STOPS · DYNAMIC DATABASE', w: 1080,
    body: `<div class="toolbar"><input id="st-q" placeholder="Search stops…" style="min-width:220px"><select id="st-f"><option value="all">All stops</option><option value="customer">Customers</option><option value="critical">Critical stock</option><option value="inactive">Inactive</option></select><span class="grow-sp" style="flex:1"></span><button class="btn" id="st-map">⊕ Add by clicking map</button><button class="btn primary" id="st-add">＋ Add stop</button></div><div id="st-table"></div>`,
    refresh: () => fill(),
    onMount: (el) => {
      root = el;
      $('#st-q', el).oninput = e => { q = e.target.value.toLowerCase(); fill(); }; $('#st-f', el).onchange = e => { f = e.target.value; fill(); };
      $('#st-add', el).onclick = () => openStopForm(null);
      $('#st-map', el).onclick = () => startPick(ll => openStopForm(null, { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }), '⊕ Click the map to place the new stop (ESC to cancel)');
      fill();
    },
  });
  function fill() {
    const el = root && $('#st-table', root); if (!el) return;
    const rows = S.nodes.filter(n => (!q || n.name.toLowerCase().includes(q) || n.region.toLowerCase().includes(q)) && (f === 'all' || (f === 'customer' && n.kind === 'customer') || (f === 'critical' && n.level === 'critical' && n.kind === 'customer') || (f === 'inactive' && !n.active)));
    el.innerHTML = `<div class="muted" style="font-size:11px;margin-bottom:6px">${rows.length} of ${S.nodes.length} stops · edit demand & stock inline — changes save instantly</div><table class="t"><thead><tr><th>Stop</th><th>Region</th><th>Kind</th><th class="r">Demand m³</th><th class="r">Stock m³</th><th class="r">γ</th><th class="r">Cover</th><th>Window</th><th>On</th><th></th></tr></thead><tbody>` +
      rows.map(n => `<tr class="${n.active ? '' : 'off'}"><td><b>${esc(n.name)}</b><br><small>${n.lat.toFixed(4)}, ${n.lng.toFixed(4)}</small></td><td>${esc(n.region)}</td><td>${n.kind}</td>
        <td class="r">${n.kind === 'customer' ? `<input class="inl" type="number" min="0" value="${n.demand}" data-id="${n.id}" data-f="demand">` : '–'}</td>
        <td class="r">${n.kind === 'customer' ? `<input class="inl" type="number" min="0" value="${n.stock}" data-id="${n.id}" data-f="stock">` : '–'}</td>
        <td class="r mono" style="color:${LV[n.level]}">${n.kind === 'customer' ? n.gamma.toFixed(2) : '–'}</td><td class="r mono">${n.days_cover == null ? '–' : n.days_cover.toFixed(1) + 'd'}</td><td class="mono">${F.clock(n.tw_open)}–${F.clock(n.tw_close)}</td>
        <td><input type="checkbox" ${n.active ? 'checked' : ''} data-id="${n.id}" data-f="active"></td>
        <td style="white-space:nowrap"><button class="btn sm" data-a="loc" data-id="${n.id}">⌖</button> <button class="btn sm" data-a="edit" data-id="${n.id}">Edit</button> <button class="btn sm danger" data-a="del" data-id="${n.id}">✕</button></td></tr>`).join('') + '</tbody></table>';
    $$('input[data-f]', el).forEach(i => i.onchange = async () => {
      try { await api('/nodes/' + i.dataset.id, 'PUT', { [i.dataset.f]: i.type === 'checkbox' ? i.checked : i.value }); await changed(); } catch (e) { toast(e.message, true); loadState(); }
    });
    $$('button[data-a]', el).forEach(b => b.onclick = async () => {
      const n = S.nodes.find(x => x.id === +b.dataset.id);
      if (b.dataset.a === 'edit') openStopForm(n);
      else if (b.dataset.a === 'loc') { closeAllModals(); flyTo(n.id); }
      else if (confirm(`Delete "${n.name}"?`)) { try { await api('/nodes/' + n.id, 'DELETE'); await changed('Deleted ' + n.name); } catch (e) { toast(e.message, true); } }
    });
  }
}
function openStopForm(node, draft = {}) {
  const n = Object.assign({ kind: 'customer', region: '', lat: '', lng: '', demand: 220, stock: '', stock_max: '', stock_min: '', daily_use: '', tw_open: 8, tw_close: 18, active: true, name: '' }, node || {}, draft);
  const fld = (id, label, val, type = 'number', extra = '') => `<label class="fld">${label}<input id="sf-${id}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(val)}" ${extra}></label>`;
  const m = modal({
    title: node ? 'EDIT STOP' : 'ADD NEW STOP', w: 640,
    body: `<div class="fld" style="margin-bottom:10px">Find address (OpenStreetMap)<div class="row"><input id="sf-q" placeholder="e.g. Jatim Park 3, Batu" style="flex:1;background:rgba(2,8,18,.7);border:1px solid rgba(120,180,255,.2);border-radius:8px;padding:6px 8px;color:var(--text)"><button class="btn" id="sf-search">Search</button><button class="btn" id="sf-pick">⊕ Pick on map</button></div><div id="sf-res" class="sr" style="display:none"></div></div>
      <div class="g2">${fld('name', 'Name', n.name, 'text')}<label class="fld">Kind<select id="sf-kind"><option value="customer" ${n.kind === 'customer' ? 'selected' : ''}>Customer</option><option value="depot" ${n.kind === 'depot' ? 'selected' : ''}>Depot</option></select></label></div>
      <div class="g3" style="margin-top:8px">${fld('lat', 'Latitude', n.lat)}${fld('lng', 'Longitude', n.lng)}<label class="fld">Toll zone / region<select id="sf-region">${['', 'SBY', 'PANDAAN', 'MALANG', 'BATU', 'OTHER'].map(r => `<option value="${r}" ${n.region === r ? 'selected' : ''}>${r || 'Auto-detect'}</option>`).join('')}</select></label></div>
      <div class="sec">DEMAND &amp; STOCK (m³)</div><div class="g4">${fld('demand', 'Delivery demand', n.demand)}${fld('stock', 'Stock now', n.stock, 'number', 'placeholder="auto"')}${fld('stock_max', 'Stock max', n.stock_max, 'number', 'placeholder="auto"')}${fld('stock_min', 'Stock min', n.stock_min, 'number', 'placeholder="auto"')}</div>
      <div class="g4" style="margin-top:8px">${fld('daily_use', 'Daily use', n.daily_use, 'number', 'placeholder="auto"')}${fld('tw_open', 'Opens (clock h)', n.tw_open)}${fld('tw_close', 'Closes (clock h)', n.tw_close)}<label class="fld">Active<select id="sf-active"><option value="1" ${n.active ? 'selected' : ''}>Yes</option><option value="0" ${n.active ? '' : 'selected'}>No</option></select></label></div>`,
    footer: '<button class="btn" id="sf-cancel">Cancel</button><button class="btn primary" id="sf-save">Save stop</button>',
    onMount: (el, close) => {
      const v = id => $('#sf-' + id, el).value;
      $('#sf-cancel', el).onclick = close;
      $('#sf-search', el).onclick = async () => {
        const q = v('q').trim(); if (!q) return; const box = $('#sf-res', el); box.style.display = 'block'; box.innerHTML = '<div>Searching…</div>';
        try {
          const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=id&q=' + encodeURIComponent(q))).json();
          box.innerHTML = r.length ? r.map((x, i) => `<div data-i="${i}">${esc(x.display_name)}</div>`).join('') : '<div>No results</div>';
          $$('div[data-i]', box).forEach(d => d.onclick = () => { const x = r[+d.dataset.i]; $('#sf-lat', el).value = (+x.lat).toFixed(6); $('#sf-lng', el).value = (+x.lon).toFixed(6); if (!v('name')) $('#sf-name', el).value = x.display_name.split(',')[0]; box.style.display = 'none'; });
        } catch (e) { box.innerHTML = '<div>Search failed (offline?) — use "Pick on map" or type coordinates.</div>'; }
      };
      $('#sf-pick', el).onclick = () => {
        const d = { kind: v('kind'), name: v('name'), region: v('region'), demand: v('demand'), stock: v('stock'), stock_max: v('stock_max'), stock_min: v('stock_min'), daily_use: v('daily_use'), tw_open: v('tw_open'), tw_close: v('tw_close'), active: v('active') === '1' };
        startPick(ll => openStopForm(node, Object.assign(d, { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) })), '⊕ Click the map to set the stop location (ESC to cancel)');
      };
      $('#sf-save', el).onclick = async () => {
        const p = { name: v('name'), kind: v('kind'), lat: v('lat'), lng: v('lng'), demand: v('kind') === 'depot' ? 0 : v('demand'), stock: v('stock'), stock_max: v('stock_max'), stock_min: v('stock_min'), daily_use: v('daily_use'), tw_open: v('tw_open'), tw_close: v('tw_close'), active: v('active') === '1' };
        if (v('region')) p.region = v('region'); else p.auto_region = true;
        try {
          if (node) await api('/nodes/' + node.id, 'PUT', p); else await api('/nodes', 'POST', p);
          close(); S.addMode = false; await changed(node ? 'Stop updated' : 'Stop added — re-run the optimizer to include it'); if (!node) { const nn = S.nodes.find(x => x.name === p.name); nn && flyTo(nn.id); }
        } catch (e) { toast(e.message, true); }
      };
    },
  });
}

/* ---- fleet manager */
function openFleet() {
  modal({
    title: 'FLEET MANAGER', w: 760, refresh: () => fill(), body: '<div id="fl-table"></div><div class="sec">ADD TRUCK</div><div class="row"><label class="fld">Name<input id="fl-n" value="CNG-TRUCK-0' + (S.vehicles.length + 1) + '"></label><label class="fld">Capacity m³<input id="fl-c" type="number" value="5000"></label><label class="fld">Fuel km/L<input id="fl-k" type="number" step="0.1" value="3.5"></label><button class="btn primary" id="fl-add" style="align-self:flex-end">＋ Add truck</button></div>',
    onMount: el => {
      $('#fl-add', el).onclick = async () => { try { await api('/vehicles', 'POST', { name: $('#fl-n', el).value, capacity: $('#fl-c', el).value, km_per_l: $('#fl-k', el).value }); await changed('Truck added'); $('#fl-n', el).value = 'CNG-TRUCK-0' + (S.vehicles.length + 1); } catch (e) { toast(e.message, true); } };
      fill();
      function fill() {
        $('#fl-table', el).innerHTML = '<table class="t"><thead><tr><th>Truck</th><th>Capacity m³</th><th>Fuel km/L</th><th>Active</th><th></th></tr></thead><tbody>' + S.vehicles.map(v => `<tr><td><input class="inl" style="width:150px" value="${esc(v.name)}" data-id="${v.id}" data-f="name"></td><td><input class="inl" type="number" value="${v.capacity}" data-id="${v.id}" data-f="capacity"></td><td><input class="inl" type="number" step="0.1" value="${v.km_per_l}" data-id="${v.id}" data-f="km_per_l"></td><td><input type="checkbox" ${v.active ? 'checked' : ''} data-id="${v.id}" data-f="active"></td><td><button class="btn sm danger" data-del="${v.id}">✕</button></td></tr>`).join('') + '</tbody></table>';
        $$('input[data-f]', el).forEach(i => i.onchange = async () => { try { await api('/vehicles/' + i.dataset.id, 'PUT', { [i.dataset.f]: i.type === 'checkbox' ? i.checked : i.value }); await changed(); } catch (e) { toast(e.message, true); loadState(); } });
        $$('button[data-del]', el).forEach(b => b.onclick = async () => { if (confirm('Delete this truck?')) { await api('/vehicles/' + b.dataset.del, 'DELETE'); await changed('Truck deleted'); } });
      }
    },
  });
}

/* ---- settings */
const SCHEMA = [
  ['COST MODEL', [['fuel_price', 'Fuel price (Rp/L)'], ['route_policy', 'Toll vs non-toll policy', 'select', ['cheapest', 'fastest', 'balanced']], ['value_of_time', 'Value of time (Rp/h, balanced)'], ['driver_cost_per_hour', 'Driver cost (Rp/h)'], ['urgency_penalty', 'Urgency delay penalty (Rp)'], ['co2_per_liter', 'CO₂ per litre (kg)']]],
  ['ROAD MODEL (used when no CSV override exists)', [['urban_speed', 'Urban speed km/h'], ['nontoll_speed', 'Non-toll speed km/h'], ['toll_speed', 'Toll speed km/h'], ['urban_factor', 'Urban road factor'], ['nontoll_factor', 'Non-toll road factor'], ['toll_factor', 'Toll road factor'], ['truck_time_factor', 'Truck time factor (× car time)'], ['use_osrm', 'Use real road distances & times (OSRM, needs internet)', 'check']]],
  ['OPERATIONS', [['max_shift', 'Max shift (h)'], ['shift_start', 'Shift start (clock h)'], ['filling_minutes', 'Filling minutes per unit'], ['filling_unit', 'Filling unit (m³)'], ['sla_days', 'SLA (days)'], ['max_days', 'Max planning days']]],
  ['ANT COLONY', [['aco.alpha', 'α pheromone'], ['aco.beta_cost', 'β₁ cost'], ['aco.beta_dist', 'β₂ distance'], ['aco.eps_time', 'ε time'], ['aco.delta_urgency', 'δ urgency'], ['aco.theta_load', 'θ load'], ['aco.rho', 'ρ evaporation'], ['aco.Q', 'Q deposit'], ['aco.ants', 'Ants'], ['aco.iterations', 'Iterations'], ['aco.elitist', 'Elitist weight'], ['aco.local_search', '2-opt + relocate local search', 'check'], ['aco.seed', 'Random seed (blank = random)']]],
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function openSettings() {
  const s = S.settings;
  let body = SCHEMA.map(([t, items]) => `<div class="sec">${t}</div><div class="g3">` + items.map(([k, l, type, opts]) => {
    const v = getPath(s, k);
    if (type === 'select') return `<label class="fld">${l}<select data-k="${k}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (type === 'check') return `<label class="fld">${l}<select data-k="${k}" data-bool="1"><option value="1" ${v ? 'selected' : ''}>On</option><option value="0" ${v ? '' : 'selected'}>Off</option></select></label>`;
    return `<label class="fld">${l}<input data-k="${k}" type="${k === 'aco.seed' ? 'text' : 'number'}" step="any" value="${v ?? ''}"></label>`;
  }).join('') + '</div>').join('');
  body += '<div class="sec">TOLL FEES BETWEEN ZONES (Rp, per truck)</div><div class="g3">' + Object.entries(s.toll_table).map(([k, v]) => `<label class="fld">${k}<input type="number" data-toll="${k}" value="${v}"></label>`).join('') + '</div>';
  modal({
    title: 'SETTINGS', w: 880, body, footer: '<span class="muted" style="margin-right:auto;font-size:11px">Saving marks the current plan as outdated.</span><button class="btn" id="se-cancel">Cancel</button><button class="btn primary" id="se-save">Save settings</button>',
    onMount: (el, close) => {
      $('#se-cancel', el).onclick = close;
      $('#se-save', el).onclick = async () => {
        const patch = { aco: {}, toll_table: {} };
        $$('[data-k]', el).forEach(i => {
          const k = i.dataset.k; let v = i.value;
          if (i.dataset.bool) v = v === '1'; else if (i.tagName === 'INPUT') { v = v === '' ? null : parseFloat(v); if (k === 'aco.seed' && i.value.trim() === '') v = null; if (v !== null && isNaN(v)) return; }
          if (k.startsWith('aco.')) patch.aco[k.slice(4)] = v; else patch[k] = v;
        });
        $$('[data-toll]', el).forEach(i => { patch.toll_table[i.dataset.toll] = parseFloat(i.value) || 0; });
        try { await api('/settings', 'PUT', patch); close(); $$('#o-ants,#o-it,#o-seed').forEach(e => delete e.dataset.dirty); await changed('Settings saved'); } catch (e) { toast(e.message, true); }
      };
    },
  });
}

/* ---- reports: run history + matrices */
function openReports() {
  let tab = 'runs', matrix = null, metric = 'dist', root = null;
  const m = modal({
    title: 'REPORTS', w: 1000, refresh: () => draw(),
    body: '<div class="tabs"><button data-t="runs" class="active">Run history</button><button data-t="matrix">Distance / time / cost matrix</button></div><div id="rp-body"></div>',
    onMount: el => { root = el; $$('.tabs button', el).forEach(b => b.onclick = () => { tab = b.dataset.t; $$('.tabs button', el).forEach(x => x.classList.toggle('active', x === b)); draw(); }); draw(); },
  });
  async function draw() {
    const el = root && $('#rp-body', root); if (!el) return;
    if (tab === 'runs') {
      el.innerHTML = S.runs.length ? '<table class="t"><thead><tr><th>#</th><th>When</th><th class="r">Cost</th><th class="r">Distance</th><th class="r">Days</th><th class="r">Trips</th><th class="r">Util</th><th class="r">Risks</th><th>SLA</th><th></th></tr></thead><tbody>' + S.runs.map(r => { const s = r.summary; return `<tr class="${S.run && S.run.id === r.id ? 'hl' : ''}"><td>#${r.id}</td><td>${esc(r.created_at)}</td><td class="r mono">${F.rp(s.total_cost)}</td><td class="r mono">${F.km(s.distance)}</td><td class="r mono">${s.days}</td><td class="r mono">${s.routes}</td><td class="r mono">${F.pct(s.avg_utilization)}</td><td class="r mono">${s.stockout_risks}</td><td>${s.sla_ok ? '<span class="pill green">OK</span>' : '<span class="pill red">BREACH</span>'}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-load="${r.id}">Load</button> <a class="btn sm" href="/api/runs/${r.id}/export.csv" style="text-decoration:none">CSV</a> <button class="btn sm danger" data-del="${r.id}">✕</button></td></tr>`; }).join('') + '</tbody></table>' : '<div class="muted">No runs yet.</div>';
      $$('[data-load]', el).forEach(b => b.onclick = async () => { try { S.run = await api('/runs/' + b.dataset.load); S.pinned = S.run.id !== S.runs[0].id; S.sel = null; renderAll(); fitView(); m.close(); toast('Loaded run #' + S.run.id + (isStale() ? ' (outdated vs current data)' : '')); } catch (e) { toast(e.message, true); } });
      $$('[data-del]', el).forEach(b => b.onclick = async () => { await api('/runs/' + b.dataset.del, 'DELETE'); if (S.run && S.run.id === +b.dataset.del) { S.pinned = false; S.run = null; } await loadState(); });
    } else {
      el.innerHTML = '<div class="muted">Loading…</div>';
      try { matrix = matrix || await api('/matrix'); } catch (e) { el.innerHTML = `<div class="c-red">${esc(e.message)}</div>`; return; }
      const mt = matrix, M = { dist: mt.dist, time: mt.time, cost: mt.cost }[metric];
      const flat = M.flatMap((r, i) => r.filter((_, j) => i !== j)), mn = Math.min(...flat), mx = Math.max(...flat);
      const fmtc = v => metric === 'cost' ? Math.round(v / 1000) + 'k' : metric === 'time' ? v.toFixed(1) : Math.round(v);
      el.innerHTML = `<div class="toolbar"><select id="mx-m"><option value="dist" ${metric === 'dist' ? 'selected' : ''}>Distance (km)</option><option value="time" ${metric === 'time' ? 'selected' : ''}>Time (h)</option><option value="cost" ${metric === 'cost' ? 'selected' : ''}>Cost (Rp thousand)</option></select><span class="muted" style="font-size:11px">Truck: ${esc(mt.vehicle)} · policy-selected road per leg · ${S.overrides} CSV overrides</span></div><div style="overflow:auto;max-height:60vh"><table class="t heat"><thead><tr><th></th>${mt.names.map(n => `<th title="${esc(n)}">${esc(n.slice(0, 9))}</th>`).join('')}</tr></thead><tbody>` +
        M.map((r, i) => `<tr><th title="${esc(mt.names[i])}">${esc(mt.names[i].slice(0, 16))}</th>` + r.map((v, j) => { const t = mx > mn ? (v - mn) / (mx - mn) : 0; return i === j ? '<td></td>' : `<td style="background:hsla(${140 - t * 140},70%,38%,.55)" title="${esc(mt.names[i])} → ${esc(mt.names[j])}${mt.mode[i][j] ? ' (toll)' : ''}">${fmtc(v)}${mt.mode[i][j] ? '<sup>T</sup>' : ''}</td>`; }).join('') + '</tr>').join('') + '</tbody></table></div>';
      $('#mx-m', el).onchange = e => { metric = e.target.value; draw(); };
    }
  }
}
function openAlerts() {
  const al = computeAlerts(); const icon = { critical: '🔴', warning: '🟠', info: '🔵' };
  const m = modal({ title: `ALERTS · ${al.filter(a => a.lvl !== 'info').length} ACTIVE`, w: 680, body: al.length ? al.map((a, i) => `<div class="alert-item ${a.lvl}" data-i="${i}"><div>${icon[a.lvl]}</div><div><b>${esc(a.title)}</b><br><span class="muted">${esc(a.msg)}</span></div></div>`).join('') : '<div class="muted">All clear — no active alerts.</div>' });
  $$('.alert-item', m.el).forEach(d => d.onclick = () => { const a = al[+d.dataset.i]; if (a.node) { m.close(); flyTo(a.node); } });
}
function openImport() {
  modal({
    title: 'IMPORT NOTEBOOK CSV DATA', w: 600,
    body: `<p class="muted" style="margin-top:0">Upload the same files your notebook used. Route legs become <b>manual overrides</b> (real toll/non-toll cost &amp; distance) that replace the estimated road model for those pairs; stock rows update stock levels.</p>
      <label class="fld">data_rute.csv <small>(Rute, Biaya_BBM_NonTol, Jarak_NonTol, Total_Biaya_Jalur_Tol, Jarak_Tol)</small><input type="file" id="im-r" accept=".csv"></label><br>
      <label class="fld">data_stok.csv <small>(Nama_Pelanggan, Sisa_Stok, Stok_Max, Stok_Min)</small><input type="file" id="im-s" accept=".csv"></label>`,
    footer: '<button class="btn primary" id="im-go">Import</button>',
    onMount: (el, close) => {
      $('#im-go', el).onclick = async () => {
        const fd = new FormData(); if ($('#im-r', el).files[0]) fd.append('routes', $('#im-r', el).files[0]); if ($('#im-s', el).files[0]) fd.append('stock', $('#im-s', el).files[0]);
        try { const r = await (await fetch('/api/import/csv', { method: 'POST', body: fd })).json(); close(); await changed(`Imported ${r.edges} route legs, ${r.stock} stock rows`); } catch (e) { toast(e.message, true); }
      };
    },
  });
}

/* ---------------------------------------------------------------- global events */
function bind() {
  const dd = $('#menu-dd');
  $('#btn-menu').onclick = e => { e.stopPropagation(); dd.classList.toggle('open'); };
  document.addEventListener('click', e => {
    if (!e.target.closest('.menu-wrap')) dd.classList.remove('open');
    const ex = e.target.closest('[data-expand]'); if (ex) { EXPAND[ex.dataset.expand](); return; }
    const t = e.target.closest('[data-fly]'); if (t) { if (t.closest('.modal-back')) closeAllModals(); flyTo(t.dataset.fly); }
    const p = e.target.closest('[data-pop]');
    if (p) { const n = S.nodes.find(x => x.id === +p.dataset.id); map.closePopup(); if (p.dataset.pop === 'edit') openStopForm(n); else if (confirm(`Delete "${n.name}"?`)) api('/nodes/' + n.id, 'DELETE').then(() => changed('Deleted ' + n.name)).catch(er => toast(er.message, true)); }
    const l = e.target.closest('[data-leg]'); if (l) { const id = +l.dataset.leg; S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id); renderFleet(); renderMap(); renderDrawer(); }
    const rc = e.target.closest('[data-route]'); if (rc) { S.sel = rc.dataset.route; drawRoutes(); renderDrawer(); }
  });
  dd.onclick = async e => {
    const a = e.target.dataset.act; if (!a) return; dd.classList.remove('open');
    if (a === 'import') openImport();
    else if (a === 'export-csv') S.run ? (location.href = `/api/runs/${S.run.id}/export.csv`) : toast('Nothing to export yet', true);
    else if (a === 'export-json') { if (!S.run) return toast('Nothing to export yet', true); const u = URL.createObjectURL(new Blob([JSON.stringify(S.run, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: u, download: `route_plan_run_${S.run.id}.json` }).click(); }
    else if (a === 'clear-edges') { await api('/edges', 'DELETE'); await changed('Route overrides cleared'); }
    else if (a === 'reset' && confirm('Reset ALL data (stops, trucks, runs, settings) to the demo dataset?')) { await api('/reset', 'POST'); S.pinned = false; S.sizing = null; S.run = null; await loadState(); fitView(); toast('Demo data restored'); }
  };
  $$('[data-nav]').forEach(b => b.onclick = () => {
    const k = b.dataset.nav; if (k === 'dashboard') { closeAllModals(); return; }
    ({ alerts: openAlerts, stops: openStops, fleet: openFleet, reports: openReports, settings: openSettings })[k]();
  });
  $('#t-zoom-in').onclick = () => map.zoomIn(); $('#t-zoom-out').onclick = () => map.zoomOut(); $('#t-fit').onclick = () => fitView();
  $('#t-add').onclick = () => { S.addMode = !S.addMode; if (S.addMode) S.editMode = false; renderMap(); };
  $('#t-edit').onclick = () => { S.editMode = !S.editMode; if (S.editMode) S.addMode = false; renderMap(); };
  $('#map-banner').onclick = () => { if (isStale() && !S.addMode && !S.editMode && !S.pick) optimize(); };
  $('#day-filter').onchange = e => { S.filter.day = e.target.value; S.sel = null; renderFleet(); renderMap(); renderDrawer(); fitView(); };
  $('#road-toggle').onchange = e => { S.road = e.target.checked; drawRoutes(); if (S.road) toast('Drawing routes along real roads (first time takes a few seconds, then cached)…'); };
  $$('.drawer-tabs [data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderDrawer(); });
  $('#drawer-toggle').onclick = () => { const d = $('#drawer'); d.classList.toggle('min'); $('#drawer-toggle').textContent = d.classList.contains('min') ? '⌃' : '⌄'; document.documentElement.style.setProperty('--drawer-h', (d.classList.contains('min') ? 36 : 230) + 12 + 'px'); };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (S.pick) endPick(); else if (S.addMode) { S.addMode = false; setBanner(); } else { const ms = $$('.modal-back'); ms.length && ms[ms.length - 1].remove(); }
  });
}


/* ---------------------------------------------------------------- expanded analysis windows */
const routeList = () => plan() ? plan().days.flatMap(d => d.routes.map(r => ({ day: d.day, r }))) : [];
const noPlan = '<div class="muted" style="padding:30px;text-align:center">No optimized plan yet — press <b>▶ Optimize</b> first.</div>';
const kpi = (l, v, cls = '', sub = '') => `<div class="kpicard"><label>${l}</label><b class="${cls}">${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
const tabsHTML = (tabs, cur) => `<div class="tabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${k === cur ? 'active' : ''}">${l}</button>`).join('')}</div>`;
function tabbed(m, tabs, draw) {
  let cur = tabs[0][0]; const root = m.el;
  const paint = () => { $('.tabhost', root).innerHTML = tabsHTML(tabs, cur); $$('.tabhost .tabs button', root).forEach(b => b.onclick = () => { cur = b.dataset.t; paint(); }); $('.tabbody', root).innerHTML = draw(cur); wire(cur); };
  let wire = () => { };
  return { paint, setWire: f => { wire = f; }, tab: () => cur };
}
function custCosts() {
  const out = [];
  routeList().forEach(({ day, r }) => r.stops.forEach((s, i) => {
    if (s.kind === 'depot' || !s.leg) return;
    let c = s.leg.cost, k = s.leg.km; const nx = r.stops[i + 1]; if (nx && nx.kind === 'depot' && nx.leg) { c += nx.leg.cost; k += nx.leg.km; }
    out.push({ name: s.name, day, truck: r.vehicle_name, demand: s.demand, cost: c, km: k, perm3: s.demand ? c / s.demand : 0, gamma: s.gamma, risk: s.risk });
  }));
  return out;
}
function insights() {
  const p = plan(); if (!p) return []; const sm = p.summary, R = routeList(), out = [], mx = +S.settings.max_shift || 10;
  const shiftUtil = R.length ? R.reduce((a, x) => a + x.r.hours, 0) / R.length / mx : 0, cap = sm.avg_utilization;
  if (shiftUtil > cap + .25) out.push({ t: 'warn', m: `<b>Time-limited, not capacity-limited.</b> Shifts are ${F.pct(shiftUtil)} full but trucks are only ${F.pct(cap)} loaded. More trucks or a longer shift will help; bigger tanks won't.` });
  else if (cap > shiftUtil + .25) out.push({ t: 'warn', m: `<b>Capacity-limited.</b> Trucks are ${F.pct(cap)} loaded while shifts are only ${F.pct(shiftUtil)} used. Larger tanks or extra trucks would cut trips.` });
  else out.push({ t: 'good', m: `Balanced plan: shifts ${F.pct(shiftUtil)} used, trucks ${F.pct(cap)} loaded.` });
  out.push(sm.sla_ok ? { t: 'good', m: `Finishes in <b>${sm.days} day(s)</b> — ${sm.sla_days - sm.days} day(s) of headroom against the ${sm.sla_days}-day SLA.` } : { t: 'bad', m: `<b>SLA breach:</b> needs ${sm.days} days but the SLA is ${sm.sla_days}. Check Fleet Sizing for how many trucks fix this.` });
  if (sm.stockout_risks) out.push({ t: 'bad', m: `<b>${sm.stockout_risks} customer(s)</b> will run out of stock before delivery. Add trucks or raise the urgency penalty (see What-if scenarios).` });
  if (sm.vehicles_used < sm.fleet_size) out.push({ t: 'info', m: `${sm.fleet_size - sm.vehicles_used} truck(s) are not used in this plan.` });
  if (sm.toll_cost > 0) out.push({ t: 'info', m: `Toll fees are ${F.pct(sm.toll_cost / (sm.total_cost || 1))} of road cost (${F.rp(sm.toll_cost)}).` });
  const cc = custCosts().sort((a, b) => b.perm3 - a.perm3)[0]; if (cc) out.push({ t: 'info', m: `Most expensive customer to serve: <b>${esc(cc.name)}</b> at ${F.rp(cc.perm3)} per m³ (${F.rp(cc.cost)} for ${cc.demand} m³).` });
  return out;
}
const insightsHTML = () => insights().map(i => `<div class="insight ${i.t}">${i.m}</div>`).join('');

/* ---- COST ANALYTICS (full) */
function openCostFull() {
  const m = modal({ title: 'COST ANALYTICS · DETAILED', full: true, w: 1380, refresh: () => tb.paint(), body: '<div class="tabhost"></div><div class="tabbody"></div>' });
  const tabs = [['ov', 'Overview'], ['truck', 'By truck'], ['cust', 'By customer'], ['mode', 'Toll vs non-toll'], ['day', 'By day']];
  const tb = tabbed(m, tabs, t => {
    const p = plan(); if (!p) return noPlan; const sm = p.summary, R = routeList();
    if (t === 'ov') {
      const T = sm.grand_total || 1, pc = x => Math.round(x / T * 100);
      return `<div class="kpis">${kpi('Total cost', F.rp(sm.grand_total), 'c-orange')}${kpi('Cost per m³', F.rp(sm.load ? sm.grand_total / sm.load : 0), 'c-cyan', sm.load.toFixed(0) + ' m³ delivered')}${kpi('Distance', F.km(sm.distance), '', F.rp(sm.distance ? sm.total_cost / sm.distance : 0) + ' / km')}${kpi('Shift hours', F.h(sm.shift_hours), '', 'drive ' + F.h(sm.drive_hours))}${kpi('Fuel', sm.liters.toFixed(0) + ' L', '', sm.co2_kg.toFixed(0) + ' kg CO₂')}${kpi('Urgency penalty', F.rpS(sm.penalty), '', 'virtual cost')}${kpi('Stock-out risks', sm.stockout_risks, sm.stockout_risks ? 'c-red' : 'c-green')}${kpi('Road data', sm.road_source === 'osrm' ? 'Real roads' : 'Estimated', sm.road_source === 'osrm' ? 'c-green' : 'c-orange')}</div>
        <div class="split"><div><div class="card"><h4>COST PER DAY &amp; CUMULATIVE</h4><div class="big-chart">${dayBarsSVG(p.days)}</div></div>
        <div class="card"><h4>COST COMPOSITION</h4><div class="stack" style="height:14px"><i style="width:${pc(sm.fuel_cost)}%;background:#22d3ee"></i><i style="width:${pc(sm.toll_cost)}%;background:#f59e0b"></i><i style="width:${pc(sm.labor_cost)}%;background:#a78bfa"></i></div>
        <div class="legendrow"><span><i style="background:#22d3ee"></i>Fuel ${F.rp(sm.fuel_cost)} (${pc(sm.fuel_cost)}%)</span><span><i style="background:#f59e0b"></i>Toll ${F.rp(sm.toll_cost)} (${pc(sm.toll_cost)}%)</span><span><i style="background:#a78bfa"></i>Labor ${F.rp(sm.labor_cost)} (${pc(sm.labor_cost)}%)</span></div></div></div>
        <div><div class="card"><h4>DECISION INSIGHTS</h4>${insightsHTML()}</div></div></div>`;
    }
    if (t === 'truck') {
      const by = {}; R.forEach(({ r }) => { const o = by[r.vehicle_name] = by[r.vehicle_name] || { n: 0, km: 0, h: 0, cost: 0, fuel: 0, toll: 0, labor: 0, load: 0, cap: 0, ci: r.color_idx }; o.n++; o.km += r.km; o.h += r.hours; o.cost += r.cost; o.fuel += r.fuel; o.toll += r.toll; o.labor += r.labor; o.load += r.load; o.cap += r.capacity; });
      const mx = Math.max(...Object.values(by).map(o => o.cost), 1);
      return `<table class="t"><thead><tr><th>Truck</th><th class="r">Trips</th><th class="r">Distance</th><th class="r">Hours</th><th class="r">Load m³</th><th class="r">Util</th><th class="r">Fuel</th><th class="r">Toll</th><th class="r">Labor</th><th class="r">Total</th><th class="r">Rp / m³</th><th style="width:200px">Share</th></tr></thead><tbody>${Object.entries(by).map(([k, o]) => `<tr><td><span style="color:${COLORS[o.ci % COLORS.length]}">●</span> <b>${esc(k)}</b></td><td class="r mono">${o.n}</td><td class="r mono">${F.km(o.km)}</td><td class="r mono">${F.h(o.h)}</td><td class="r mono">${o.load.toFixed(0)}</td><td class="r mono">${F.pct(o.load / o.cap)}</td><td class="r mono">${F.rp(o.fuel)}</td><td class="r mono">${F.rp(o.toll)}</td><td class="r mono">${F.rp(o.labor)}</td><td class="r mono c-orange">${F.rp(o.cost + o.labor)}</td><td class="r mono">${F.rp(o.load ? (o.cost + o.labor) / o.load : 0)}</td><td><span class="hb" style="width:${o.cost / mx * 100}%"></span></td></tr>`).join('')}</tbody></table>`;
    }
    if (t === 'cust') {
      const c = custCosts().sort((a, b) => b.perm3 - a.perm3), mx = Math.max(...c.map(x => x.perm3), 1);
      return `<div class="muted" style="font-size:11px;margin-bottom:8px">Cost to serve = the leg into the stop (plus the return leg for the last stop of a route). Ranked by cost per m³ — expensive customers are candidates for bigger or less frequent drops.</div><table class="t"><thead><tr><th>#</th><th>Customer</th><th>Day</th><th>Truck</th><th class="r">Demand</th><th class="r">Leg km</th><th class="r">Cost</th><th class="r">Rp / m³</th><th style="width:180px"></th><th class="r">γ</th><th></th></tr></thead><tbody>${c.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.name)}</b></td><td>D${x.day}</td><td>${esc(x.truck)}</td><td class="r mono">${x.demand}</td><td class="r mono">${x.km.toFixed(1)}</td><td class="r mono">${F.rp(x.cost)}</td><td class="r mono c-orange">${F.rp(x.perm3)}</td><td><span class="hb o" style="width:${x.perm3 / mx * 100}%"></span></td><td class="r mono">${x.gamma.toFixed(2)}</td><td>${x.risk ? '<span class="tag risk">RISK</span>' : ''}</td></tr>`).join('')}</tbody></table>`;
    }
    if (t === 'mode') {
      const agg = { toll: { n: 0, km: 0, h: 0, c: 0, fee: 0 }, nontoll: { n: 0, km: 0, h: 0, c: 0, fee: 0 } }, tolls = [];
      R.forEach(({ day, r }) => r.stops.forEach((s, i) => { if (!s.leg) return; const a = agg[s.leg.mode]; a.n++; a.km += s.leg.km; a.h += s.leg.hours; a.c += s.leg.cost; a.fee += s.leg.toll; if (s.leg.mode === 'toll') tolls.push({ day, truck: r.vehicle_name, from: r.stops[i - 1].name, to: s.name, ...s.leg }); }));
      const row = (l, a, cls) => `<tr><td><span class="tag ${cls}">${l}</span></td><td class="r mono">${a.n}</td><td class="r mono">${F.km(a.km)}</td><td class="r mono">${F.h(a.h)}</td><td class="r mono">${F.rp(a.c)}</td><td class="r mono">${F.rp(a.fee)}</td></tr>`;
      return `<div class="card"><h4>ROAD CHOICE SUMMARY (policy: ${esc(sm.policy)})</h4><table class="t"><thead><tr><th>Road type</th><th class="r">Legs</th><th class="r">Distance</th><th class="r">Drive time</th><th class="r">Cost</th><th class="r">Toll fees</th></tr></thead><tbody>${row('NON-TOLL', agg.nontoll, 'nontoll')}${row('TOLL', agg.toll, 'toll')}</tbody></table></div>
        <div class="card"><h4>TOLL LEGS USED</h4>${tolls.length ? `<table class="t"><thead><tr><th>Day</th><th>Truck</th><th>From</th><th>To</th><th class="r">km</th><th class="r">Time</th><th class="r">Fuel</th><th class="r">Toll</th></tr></thead><tbody>${tolls.map(x => `<tr><td>D${x.day}</td><td>${esc(x.truck)}</td><td>${esc(x.from)}</td><td>${esc(x.to)}</td><td class="r mono">${x.km.toFixed(1)}</td><td class="r mono">${F.h(x.hours)}</td><td class="r mono">${F.rp(x.fuel)}</td><td class="r mono">${F.rp(x.toll)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No toll roads were chosen. Try the "Fastest road" or "Balanced" policy under Fleet Sizing → What-if scenarios to see the time-vs-cost trade-off.</div>'}</div>`;
    }
    return `<table class="t"><thead><tr><th>Day</th><th class="r">Trips</th><th class="r">Distance</th><th class="r">Longest shift</th><th class="r">Load m³</th><th class="r">Road cost</th><th class="r">Labor</th><th class="r">Penalty</th></tr></thead><tbody>${p.days.map(d => `<tr><td><b>Day ${d.day}</b></td><td class="r mono">${d.routes.length}</td><td class="r mono">${F.km(d.km)}</td><td class="r mono">${F.h(d.hours)}</td><td class="r mono">${d.load.toFixed(0)}</td><td class="r mono c-orange">${F.rp(d.cost)}</td><td class="r mono">${F.rp(d.labor)}</td><td class="r mono">${F.rpS(d.penalty)}</td></tr>`).join('')}</tbody></table>`;
  });
  tb.paint();
}

/* ---- FLEET SIZING + WHAT-IF (full) */
function sizingChartSVG(rows) {
  const w = 760, h = 260, L = 60, R = 46, T = 16, B = 30, pw = w - L - R, ph = h - T - B, mx = Math.max(...rows.map(r => r.grand_total), 1), md = Math.max(...rows.map(r => r.days), 1);
  const bw = Math.min(46, pw / rows.length * .55), X = i => L + pw / rows.length * (i + .5), Y = v => T + ph - v / mx * ph, YD = d => T + ph - d / (md * 1.1) * ph;
  let g = ''; for (let k = 0; k <= 3; k++) { const v = mx * k / 3, y = Y(v); g += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" stroke="rgba(120,180,255,.12)"/><text x="${L - 6}" y="${y + 3}" fill="#7f93ad" font-size="10" text-anchor="end">${F.rpS(v).replace('Rp ', '')}</text>`; }
  rows.forEach((r, i) => { g += `<rect x="${X(i) - bw / 2}" y="${Y(r.grand_total)}" width="${bw}" height="${T + ph - Y(r.grand_total)}" rx="4" fill="${r.sla_ok ? 'url(#szg)' : 'url(#szr)'}"/><text x="${X(i)}" y="${h - 10}" fill="#9fb4d0" font-size="11" text-anchor="middle">${r.trucks} truck${r.trucks > 1 ? 's' : ''}</text>`; });
  const pts = rows.map((r, i) => `${X(i)},${YD(r.days)}`).join(' ');
  g += `<polyline points="${pts}" fill="none" stroke="#fb923c" stroke-width="2.5" style="filter:drop-shadow(0 0 5px #fb923c)"/>` + rows.map((r, i) => `<circle cx="${X(i)}" cy="${YD(r.days)}" r="4" fill="#fb923c"/><text x="${X(i)}" y="${YD(r.days) - 9}" fill="#fdba74" font-size="10.5" text-anchor="middle" font-weight="700">${r.days}d</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}"><defs><linearGradient id="szg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#2563eb" stop-opacity=".45"/></linearGradient><linearGradient id="szr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#7f1d1d" stop-opacity=".5"/></linearGradient></defs>${g}</svg>`;
}
function scenarioTable(rows) {
  const names = { policy: 'ROAD POLICY (toll vs non-toll)', shift: 'SHIFT LENGTH', fuel: 'FUEL PRICE', penalty: 'URGENCY PENALTY' };
  return ['policy', 'shift', 'fuel', 'penalty'].map(g => {
    const rs = rows.filter(r => r.group === g); if (!rs.length) return '';
    const cur = rs.find(r => r.current), ok = rs.filter(r => r.sla_ok), best = ok.length ? ok.reduce((a, r) => r.grand_total < a.grand_total ? r : a) : null, mx = Math.max(...rs.map(r => r.grand_total));
    return `<div class="card"><h4>${names[g]}</h4><table class="t"><thead><tr><th>Scenario</th><th class="r">Days</th><th class="r">Total cost</th><th class="r">Δ vs current</th><th style="width:150px"></th><th class="r">Distance</th><th class="r">Shift hrs</th><th class="r">Util</th><th class="r">Risks</th><th>SLA</th></tr></thead><tbody>${rs.map(r => {
      const d = cur ? (r.grand_total - cur.grand_total) / cur.grand_total : 0;
      return `<tr class="${best === r ? 'best-row' : ''}"><td><b>${esc(r.label)}</b>${r.current ? '<span class="cur-tag">CURRENT</span>' : ''}${best === r ? ' <span style="color:#34d399">★ best</span>' : ''}</td><td class="r mono">${r.days}</td><td class="r mono c-orange">${F.rp(r.grand_total)}</td><td class="r mono" style="color:${d > .005 ? '#f87171' : d < -.005 ? '#34d399' : '#7f93ad'}">${r.current ? '–' : (d > 0 ? '+' : '') + (d * 100).toFixed(1) + '%'}</td><td><span class="hb ${r.sla_ok ? '' : 'o'}" style="width:${r.grand_total / mx * 100}%"></span></td><td class="r mono">${F.km(r.distance)}</td><td class="r mono">${F.h(r.shift_hours)}</td><td class="r mono">${F.pct(r.utilization)}</td><td class="r mono ${r.risks ? 'c-red' : ''}">${r.risks}</td><td>${r.sla_ok ? '<span class="pill green">OK</span>' : '<span class="pill red">BREACH</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }).join('');
}
function openSizingFull() {
  const m = modal({ title: 'FLEET SIZING &amp; WHAT-IF SCENARIOS', full: true, w: 1380, refresh: () => tb.paint(), body: '<div class="tabhost"></div><div class="tabbody"></div>' });
  const tb = tabbed(m, [['fleet', 'Fleet size'], ['scen', 'What-if scenarios']], t => {
    const prog = '<div class="progress"><i id="fz-prog"></i></div><div class="muted mono" id="fz-msg" style="font-size:11px;min-height:15px"></div>';
    if (t === 'fleet') {
      const rows = S.sizing, ok = rows ? rows.filter(r => r.sla_ok) : [], best = ok.length ? ok.reduce((a, r) => r.grand_total < a.grand_total ? r : a) : null;
      return `<div class="toolbar"><span class="muted">Re-solve the whole plan with 1…N identical trucks (SLA = ${S.settings.sla_days} days)</span><span style="flex:1"></span><select id="fz-max"><option>4</option><option selected>6</option><option>8</option><option>10</option></select><button class="btn primary" id="fz-run" ${S.busy ? 'disabled' : ''}>▶ Analyze fleet size</button></div>${prog}
        ${rows ? `<div class="split"><div class="card"><h4>COST (bars) AND DAYS TO COMPLETE (line)</h4><div class="big-chart">${sizingChartSVG(rows)}</div><div class="legendrow"><span><i style="background:#22d3ee"></i>meets SLA</span><span><i style="background:#ef4444"></i>breaches SLA</span><span><i style="background:#fb923c"></i>days</span></div></div>
        <div><div class="card"><h4>RECOMMENDATION</h4>${best ? `<div class="insight good">Cheapest fleet that meets the ${S.settings.sla_days}-day SLA: <b>${best.trucks} truck(s)</b> — ${best.days} day(s), ${F.rp(best.grand_total)}.</div>` : '<div class="insight bad">No tested fleet size meets the SLA. Extend the shift or relax the SLA.</div>'}${(() => { const c = rows.filter(r => r.sla_ok); if (c.length > 1 && best) { const f = c[0]; return best !== f ? `<div class="insight">Minimum trucks for SLA: <b>${f.trucks}</b> (${F.rp(f.grand_total)}). The cheapest option costs ${F.rp(f.grand_total - best.grand_total)} less.</div>` : ''; } return ''; })()}<div class="insight info">Adding trucks beyond the point where days stop falling only adds idle capacity.</div></div></div></div>
        <table class="t"><thead><tr><th>Trucks</th><th class="r">Days</th><th class="r">Total cost</th><th class="r">Distance</th><th class="r">Avg load</th><th class="r">Risks</th><th>SLA</th></tr></thead><tbody>${rows.map(r => `<tr class="${best && best.trucks === r.trucks ? 'best-row' : ''}"><td><b>${r.trucks}</b>${best && best.trucks === r.trucks ? ' <span style="color:#34d399">★</span>' : ''}</td><td class="r mono">${r.days}</td><td class="r mono c-orange">${F.rp(r.grand_total)}</td><td class="r mono">${F.km(r.distance)}</td><td class="r mono">${F.pct(r.utilization)}</td><td class="r mono ${r.risks ? 'c-red' : ''}">${r.risks}</td><td>${r.sla_ok ? '<span class="pill green">OK</span>' : '<span class="pill red">BREACH</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="muted" style="padding:20px">Press <b>Analyze fleet size</b> to compare 1…N trucks.</div>'}`;
    }
    return `<div class="toolbar"><span class="muted">Each scenario re-solves the plan with one setting changed (same random seed) so you can compare fairly.</span><span style="flex:1"></span>${[['policy', 'Road policy'], ['shift', 'Shift length'], ['fuel', 'Fuel price'], ['penalty', 'Urgency penalty']].map(([k, l]) => `<button class="btn sm" data-sc="${k}" ${S.busy ? 'disabled' : ''}>${l}</button>`).join('')}<button class="btn primary" data-sc="all" ${S.busy ? 'disabled' : ''}>▶ Run all scenarios</button></div>${prog}${S.scen && S.scen.length ? scenarioTable(S.scen) : '<div class="muted" style="padding:20px">Run the scenarios to see how toll policy, shift length, fuel price and the urgency penalty change cost, days and stock-out risk.</div>'}`;
  });
  tb.setWire(() => {
    const r = $('#fz-run', m.el); if (r) r.onclick = () => runSizing($('#fz-max', m.el).value);
    $$('[data-sc]', m.el).forEach(b => b.onclick = () => runScenarios(b.dataset.sc));
  });
  tb.paint();
}

/* ---- ACO OPTIMIZER (full) */
function openOptFull() {
  const m = modal({ title: 'ACO OPTIMIZER · CONVERGENCE &amp; RUN COMPARISON', full: true, w: 1380, refresh: () => tb.paint(), body: '<div class="tabhost"></div><div class="tabbody"></div>' });
  const tb = tabbed(m, [['conv', 'Convergence'], ['cmp', 'Compare runs']], t => {
    if (t === 'conv') {
      const run = S.run, c = run && run.convergence; if (!c || !c.best.length) return noPlan;
      const b = c.best, fin = b[b.length - 1], at = b.findIndex(v => v <= fin + .01) + 1, imp = (b[0] - fin) / b[0], sm = run.summary, pr = run.params || {};
      return `<div class="kpis">${kpi('Best objective', F.rp(fin), 'c-orange')}${kpi('Converged at', 'iter ' + at, '', 'of ' + b.length)}${kpi('Improvement', (imp * 100).toFixed(1) + '%', 'c-green', 'first → last iteration')}${kpi('Runtime', (sm.runtime || 0) + ' s')}${kpi('Run', '#' + run.id, '', esc(run.created_at))}</div>
        <div class="split"><div class="card"><h4>BEST-SO-FAR vs COLONY MEAN</h4><div class="big-chart">${lineSVG([b, c.mean], { w: 760, h: 300 })}</div><div class="legendrow"><span><i style="background:#22d3ee"></i>best so far</span><span><i style="background:#fb923c"></i>colony mean (a shrinking gap = colony converging)</span></div></div>
        <div class="card"><h4>PARAMETERS USED</h4><table class="t"><tbody>${Object.entries(pr).map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="r mono">${esc(v === null ? 'random' : v)}</td></tr>`).join('')}</tbody></table>
        <div class="insight ${at > b.length * .9 ? 'warn' : 'good'}" style="margin-top:10px">${at > b.length * .9 ? 'Still improving at the end — try more iterations.' : `Converged after ${at} iterations; extra iterations are unlikely to help.`}</div></div></div>`;
    }
    const rs = S.runs.slice(0, 14).reverse(); if (!rs.length) return '<div class="muted" style="padding:20px">No runs yet.</div>';
    const best = Math.min(...rs.map(r => r.summary.total_cost)), mx = Math.max(...rs.map(r => r.summary.total_cost));
    return `<div class="card"><h4>COST OF EACH RUN (latest ${rs.length})</h4><div class="big-chart">${lineSVG([rs.map(r => r.summary.total_cost)], { w: 900, h: 200, labels: rs.map(r => '#' + r.id), colors: ['#22d3ee'], dashed: [false] })}</div></div>
      <table class="t"><thead><tr><th>Run</th><th>When</th><th class="r">Cost</th><th class="r">vs best</th><th style="width:150px"></th><th class="r">Days</th><th class="r">Distance</th><th class="r">Util</th><th class="r">Risks</th><th>Roads</th><th></th></tr></thead><tbody>${[...rs].reverse().map(r => { const s = r.summary; return `<tr class="${s.total_cost === best ? 'best-row' : ''}"><td>#${r.id}</td><td>${esc(r.created_at)}</td><td class="r mono c-orange">${F.rp(s.total_cost)}</td><td class="r mono">${s.total_cost === best ? '★ best' : '+' + ((s.total_cost - best) / best * 100).toFixed(1) + '%'}</td><td><span class="hb" style="width:${s.total_cost / mx * 100}%"></span></td><td class="r mono">${s.days}</td><td class="r mono">${F.km(s.distance)}</td><td class="r mono">${F.pct(s.avg_utilization)}</td><td class="r mono">${s.stockout_risks}</td><td>${s.road_source === 'osrm' ? 'OSRM' : 'est.'}</td><td><button class="btn sm" data-ld="${r.id}">Load on map</button></td></tr>`; }).join('')}</tbody></table>`;
  });
  tb.setWire(() => $$('[data-ld]', m.el).forEach(b => b.onclick = async () => { S.run = await api('/runs/' + b.dataset.ld); S.pinned = S.run.id !== S.runs[0].id; S.sel = null; renderAll(); fitView(); m.close(); toast('Loaded run #' + S.run.id); }));
  tb.paint();
}

/* ---- FLEET STATUS (full): timeline / Gantt */
function ganttSVG() {
  const R = routeList(); if (!R.length) return ''; const st = +S.settings.shift_start, mx = +S.settings.max_shift;
  const end = Math.max(st + mx, ...R.map(x => x.r.end)) + .3, w = 1100, L = 150, RR = 20, T = 28, rh = 30, h = T + R.length * rh + 10, X = t => L + (t - st) / (end - st) * (w - L - RR);
  let g = ''; for (let t = Math.ceil(st); t <= end; t++) g += `<line x1="${X(t)}" x2="${X(t)}" y1="${T - 6}" y2="${h - 6}" stroke="rgba(120,180,255,.12)"/><text x="${X(t)}" y="${T - 12}" fill="#7f93ad" font-size="10" text-anchor="middle">${String(t % 24).padStart(2, '0')}:00</text>`;
  g += `<line x1="${X(st + mx)}" x2="${X(st + mx)}" y1="${T - 6}" y2="${h - 6}" stroke="#ef4444" stroke-dasharray="4 4"/><text x="${X(st + mx)}" y="${h + 4}" fill="#f87171" font-size="9" text-anchor="middle">max shift</text>`;
  R.forEach(({ day, r }, i) => {
    const y = T + i * rh; g += `<text x="${L - 10}" y="${y + 14}" fill="#c9d9ee" font-size="11" text-anchor="end"><tspan fill="${colorOf(r)}">●</tspan> D${day} · ${esc(r.vehicle_name.replace('CNG-', ''))}</text>`;
    const seg = (a, b, c, tip) => b - a > .004 ? `<rect x="${X(a)}" y="${y + 3}" width="${Math.max(1, X(b) - X(a))}" height="18" rx="3" fill="${c}"><title>${tip}</title></rect>` : '';
    let prev = r.stops[0].finish;
    r.stops.forEach((s, k) => { if (!k) return; g += seg(prev, s.arrive, '#3b82f6', `Drive ${F.h(s.arrive - prev)} → ${esc(s.name)}`); g += seg(s.arrive, s.start, '#f59e0b', `Wait ${F.h(s.start - s.arrive)} at ${esc(s.name)}`); if (s.kind !== 'depot') g += seg(s.start, s.finish, '#34d399', `Filling ${F.h(s.finish - s.start)} at ${esc(s.name)} (${s.demand} m³)`); prev = s.finish; });
  });
  return `<svg class="gantt" viewBox="0 0 ${w} ${h + 8}">${g}</svg>`;
}
function openFleetFull() {
  modal({ title: 'FLEET STATUS · TIMELINE &amp; UTILISATION', full: true, w: 1380, refresh: () => draw(), body: '<div id="ff"></div>', onMount: () => draw() });
  function draw() {
    const el = $('#ff'); if (!el) return; if (!plan()) { el.innerHTML = noPlan; return; }
    const R = routeList(), sm = plan().summary, mx = +S.settings.max_shift;
    el.innerHTML = `<div class="kpis">${kpi('Trucks used', sm.vehicles_used + ' / ' + sm.fleet_size, 'c-cyan')}${kpi('Trips', sm.routes)}${kpi('Avg load', F.pct(sm.avg_utilization), 'c-green')}${kpi('Avg shift used', F.pct(R.reduce((a, x) => a + x.r.hours, 0) / R.length / mx), 'c-orange')}${kpi('Avg speed', Math.round(sm.avg_speed) + ' km/h')}</div>
      <div class="card"><h4>SHIFT TIMELINE (each bar = one truck on one day)</h4><div class="legendrow"><span><i style="background:#3b82f6"></i>driving</span><span><i style="background:#34d399"></i>filling at customer</span><span><i style="background:#f59e0b"></i>waiting for time window</span></div><div class="big-chart">${ganttSVG()}</div></div>
      <div class="split"><div class="card"><h4>TRIPS</h4><table class="t"><thead><tr><th>Day</th><th>Truck</th><th class="r">Stops</th><th class="r">Load</th><th class="r">Capacity used</th><th class="r">Km</th><th class="r">Hours</th><th class="r">Slack</th><th class="r">Back</th></tr></thead><tbody>${R.map(({ day, r }) => `<tr><td>D${day}</td><td><span style="color:${colorOf(r)}">●</span> ${esc(r.vehicle_name)}</td><td class="r mono">${r.stops.length - 2}</td><td class="r mono">${r.load.toFixed(0)}</td><td class="r mono">${F.pct(r.utilization)} <span class="hb g" style="width:${r.utilization * 50}px"></span></td><td class="r mono">${r.km.toFixed(0)}</td><td class="r mono">${F.h(r.hours)}</td><td class="r mono ${mx - r.hours < .5 ? 'c-orange' : ''}">${F.h(Math.max(0, mx - r.hours))}</td><td class="r mono">${F.clock(r.end)}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h4>DECISION INSIGHTS</h4>${insightsHTML()}</div></div>`;
  }
}

/* ---- STOCK URGENCY (full) */
function openUrgFull() {
  modal({ title: 'STOCK URGENCY · ALL CUSTOMERS', full: true, w: 1380, refresh: () => draw(), body: '<div id="uf"></div>', onMount: () => draw() });
  function draw() {
    const el = $('#uf'); if (!el) return; const info = nodeRoutes(), c = S.nodes.filter(n => n.kind === 'customer' && n.active).sort((a, b) => b.gamma - a.gamma);
    const crit = c.filter(n => n.level === 'critical').length, warn = c.filter(n => n.level === 'warning').length, risk = c.filter(n => info[n.id] && info[n.id].s.risk).length;
    el.innerHTML = `<div class="kpis">${kpi('Customers', c.length)}${kpi('Critical', crit, 'c-red', 'γ ≥ 1.75')}${kpi('Warning', warn, 'c-orange', 'γ ≥ 1.40')}${kpi('Stock-out before delivery', plan() ? risk : '–', risk ? 'c-red' : 'c-green')}${kpi('Total demand', c.reduce((a, n) => a + n.demand, 0).toFixed(0) + ' m³')}</div>
      <table class="t"><thead><tr><th>Customer</th><th>Region</th><th class="r">γ</th><th>Level</th><th>Stock (white mark = minimum)</th><th class="r">Stock / max</th><th class="r">Cover</th><th class="r">Demand</th><th>Planned</th><th>Window</th><th></th></tr></thead><tbody>${c.map(n => { const ri = info[n.id], pctS = n.stock_max ? Math.min(100, n.stock / n.stock_max * 100) : 0, minP = n.stock_max ? n.stock_min / n.stock_max * 100 : 0;
        return `<tr data-fly="${n.id}" style="cursor:pointer"><td><b>${esc(n.name)}</b></td><td>${esc(n.region)}</td><td class="r mono" style="color:${LV[n.level]}">${n.gamma.toFixed(2)}</td><td><span class="pill ${n.level === 'critical' ? 'red' : n.level === 'warning' ? 'amber' : 'green'}">${n.level.toUpperCase()}</span></td><td><span class="stockbar"><i style="width:${pctS}%;background:${LV[n.level]}"></i><u style="left:${minP}%"></u></span></td><td class="r mono">${n.stock} / ${n.stock_max}</td><td class="r mono">${n.days_cover == null ? '–' : n.days_cover.toFixed(1) + ' d'}</td><td class="r mono">${n.demand}</td><td>${ri ? `<span style="color:${ri.color}">●</span> Day ${ri.day} · ${F.clock(ri.s.arrive)}` : '<span class="muted">not planned</span>'}</td><td class="mono">${F.clock(n.tw_open)}–${F.clock(n.tw_close)}</td><td>${ri && ri.s.risk ? '<span class="tag risk">STOCK-OUT RISK</span>' : ''}</td></tr>`; }).join('')}</tbody></table>`;
  }
}

/* ---- ACTIVITY LOG (full) */
function openLogFull() {
  modal({ title: 'ACTIVITY LOG', w: 900, full: true, refresh: () => fill(), body: '<div id="lf"></div>', onMount: () => fill() });
  function fill() { const el = $('#lf'); if (el) el.innerHTML = '<table class="t"><thead><tr><th>Time</th><th>Level</th><th>Event</th></tr></thead><tbody>' + S.events.map(e => `<tr><td class="mono">${esc(e.ts)}</td><td><span class="tag ${e.level === 'warn' ? 'toll' : e.level === 'error' ? 'risk' : 'nontoll'}">${esc(e.level.toUpperCase())}</span></td><td>${esc(e.message)}</td></tr>`).join('') + '</tbody></table>'; }
}
const EXPAND = { cost: openCostFull, size: openSizingFull, opt: openOptFull, fleet: openFleetFull, urg: openUrgFull, log: openLogFull };

/* ---------------------------------------------------------------- boot */
(async function boot() {
  if (typeof L === 'undefined') { document.body.insertAdjacentHTML('afterbegin', '<div style="padding:30px;color:#fca5a5">Leaflet failed to load — the map needs internet access (unpkg.com CDN).</div>'); return; }
  initMap(); buildOpt(); bind();
  try { await loadState(); fitView(false); } catch (e) { toast('Cannot reach API: ' + e.message, true); }
})();
