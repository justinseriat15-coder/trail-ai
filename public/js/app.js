import {
  isRun, paceStr, km, durStr, dayStr, parseLocal,
  weeklyVolume, efTrend, efChange, acwrSeries, acwrStatus, consecutiveRunDays,
  efficiencyFactor, decoupling, timeInZones, streamSeries, zoneBounds,
} from './analytics.js';

const $ = (id) => document.getElementById(id);
const fr = (x) => String(x).replace('.', ',');
const state = { mode: null, profile: null, activities: [], selectedId: null, chat: [], charts: {} };

// ---------- Theme for charts (reads CSS tokens so there is one source of truth) ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function chartDefaults() {
  const C = window.Chart;
  C.defaults.color = css('--text-3');
  C.defaults.font.family = "'DM Mono', monospace";
  C.defaults.font.size = 11;
  C.defaults.borderColor = css('--border');
  C.defaults.plugins.legend.display = false;
  C.defaults.plugins.tooltip.backgroundColor = css('--surface-2');
  C.defaults.plugins.tooltip.borderColor = css('--border');
  C.defaults.plugins.tooltip.borderWidth = 1;
  C.defaults.plugins.tooltip.titleColor = css('--text');
  C.defaults.plugins.tooltip.bodyColor = css('--text-2');
  C.defaults.plugins.tooltip.padding = 10;
  C.defaults.plugins.tooltip.displayColors = false;
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation.duration = 400;
}
const gridX = { grid: { display: false }, border: { display: false } };
const gridY = { grid: { color: 'rgba(255,255,255,.06)' }, border: { display: false }, ticks: { maxTicksLimit: 5 } };

function draw(key, cfg) {
  state.charts[key]?.destroy();
  state.charts[key] = new window.Chart($(key), cfg);
}

// Horizontal "good zone" band drawn behind a chart (used for ACWR 0.8–1.3).
const bandPlugin = {
  id: 'band',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts?.from) return;
    const { ctx, chartArea: a, scales: { y } } = chart;
    ctx.save();
    ctx.fillStyle = opts.color;
    const top = y.getPixelForValue(opts.to), bottom = y.getPixelForValue(opts.from);
    ctx.fillRect(a.left, top, a.right - a.left, bottom - top);
    ctx.restore();
  },
};

// ---------- Boot ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  const auth = params.get('auth');
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({ connected: false }));
  let mode = params.get('mode');
  if (!mode && me.connected) mode = 'live';
  if (mode === 'live' && !me.connected) mode = null;

  if (!mode) {
    $('landing').hidden = false;
    if (auth) showLandingNotice(auth);
    return;
  }
  history.replaceState({}, '', `/?mode=${mode}`);
  state.mode = mode;
  $('app').hidden = false;
  $('demo-banner').hidden = mode !== 'demo';
  $('mode-pill').hidden = false;
  $('mode-pill').textContent = mode === 'demo' ? 'Démo' : `Strava · ${me.athlete?.firstname || ''}`;
  $('mode-pill').classList.toggle('live', mode === 'live');
  $('logout-btn').hidden = mode !== 'live';
  initChat();
  await loadData();
}

function showLandingNotice(code) {
  const msg = {
    denied: 'Connexion Strava annulée.',
    invalid_state: 'Session de connexion expirée, réessaie.',
    missing_scope: "Autorise l'accès aux activités pour que l'analyse fonctionne.",
    exchange_failed: "Strava a refusé la connexion. L'app est limitée au compte du propriétaire en mode développeur, explore la démo.",
  }[code];
  if (!msg) return;
  const p = document.createElement('p');
  p.className = 'error-box';
  p.style.marginTop = '16px';
  p.textContent = msg;
  document.querySelector('.hero').appendChild(p);
}

async function loadData() {
  try {
    const r = await fetch(`/api/activities?source=${state.mode}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
    state.profile = data.profile;
    state.activities = data.activities;
    $('loading').hidden = true;
    $('data').hidden = false;
    chartDefaults();
    render();
  } catch (e) {
    $('loading').hidden = true;
    $('error').hidden = false;
    $('error').textContent = `Impossible de charger les données: ${e.message}`;
  }
}

// ---------- Dashboard ----------
function render() {
  const { hrMax, hrRest } = state.profile;
  const acts = state.activities;

  // KPIs
  const weeks = weeklyVolume(acts, 12);
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const last7 = acts.filter((a) => isRun(a) && parseLocal(a.start_date_local) >= sevenDaysAgo);
  $('k-vol').textContent = `${fr(km(last7.reduce((s, a) => s + a.distance, 0)))} km`;
  $('k-vol-sub').textContent = `${last7.length} séance${last7.length > 1 ? 's' : ''} · ${Math.round(last7.reduce((s, a) => s + (a.total_elevation_gain || 0), 0))} m D+`;

  const acwr = acwrSeries(acts, hrMax, hrRest, 56);
  const now = acwr[acwr.length - 1];
  const st = acwrStatus(now?.ratio);
  $('k-acwr').textContent = now?.ratio != null ? now.ratio.toFixed(2).replace('.', ',') : '—';
  $('k-acwr-sub').textContent = st.label;
  $('k-acwr-sub').className = `kpi-sub status ${st.level}`;

  const trend = efTrend(acts, hrMax);
  const chg = efChange(trend);
  $('k-ef').textContent = trend.length ? trend.at(-1).rolling.toFixed(2).replace('.', ',') : '—';
  $('k-ef-sub').textContent = chg == null ? 'pas assez de footings plats' : `${chg > 0 ? '+' : ''}${String(chg).replace('.', ',')} % sur la période`;

  const consec = consecutiveRunDays(acts);
  $('k-consec').textContent = consec;
  const consecSub = $('k-consec-sub');
  consecSub.textContent = consec >= 3 ? 'max sur 14 j · densité élevée' : 'max sur 14 j';
  consecSub.className = consec >= 3 ? 'kpi-sub status serious' : 'kpi-sub';

  // Weekly volume
  const label = (iso) => new Date(iso + 'T00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  draw('c-volume', {
    type: 'bar',
    data: {
      labels: weeks.map((w) => label(w.week)),
      datasets: [{
        data: weeks.map((w) => w.km),
        backgroundColor: weeks.map((_, i) => (i === weeks.length - 1 ? css('--series-1-soft') : css('--series-1'))),
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', maxBarThickness: 34,
      }],
    },
    options: {
      scales: { x: { ...gridX, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 8 } }, y: { ...gridY, title: { display: true, text: 'km' } } },
      plugins: { tooltip: { callbacks: {
        title: (it) => `Semaine du ${it[0].label}${it[0].dataIndex === weeks.length - 1 ? ' (en cours)' : ''}`,
        label: (it) => { const w = weeks[it.dataIndex]; return [`${fr(w.km)} km · ${fr(w.hours)} h`, `${w.dplus} m D+ · ${w.count} séance${w.count > 1 ? 's' : ''}`]; },
      } } },
    },
  });

  // EF trend
  draw('c-ef', {
    type: 'line',
    data: {
      labels: trend.map((p) => p.date),
      datasets: [
        { data: trend.map((p) => p.ef), showLine: false, pointRadius: 3.5, pointHoverRadius: 6, pointBackgroundColor: css('--series-1-soft'), pointBorderWidth: 0 },
        { data: trend.map((p) => p.rolling), borderColor: css('--series-1'), borderWidth: 2, pointRadius: 0, tension: .35 },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ...gridX, ticks: { maxTicksLimit: 5, callback(v) { return label(this.getLabelForValue(v)); } } }, y: gridY },
      plugins: { tooltip: { callbacks: {
        title: (it) => dayStr(trend[it[0].dataIndex].date + 'T12:00:00'),
        label: (it) => { const p = trend[it.dataIndex]; return it.datasetIndex === 0 ? `EF ${fr(p.ef)} · ${p.pace}/km à ${p.hr} bpm` : `Moyenne glissante ${fr(p.rolling)}`; },
      } } },
    },
  });

  // ACWR
  const series = acwr.filter((p) => p.ratio != null);
  draw('c-acwr', {
    type: 'line',
    data: { labels: series.map((p) => p.date), datasets: [{ data: series.map((p) => p.ratio), borderColor: css('--series-1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: .3 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...gridX, ticks: { maxTicksLimit: 5, callback(v) { return label(this.getLabelForValue(v)); } } },
        y: { ...gridY, suggestedMin: 0.5, suggestedMax: 1.6 },
      },
      plugins: {
        band: { from: 0.8, to: 1.3, color: 'rgba(12,163,12,.10)' },
        tooltip: { callbacks: {
          title: (it) => dayStr(series[it[0].dataIndex].date + 'T12:00:00'),
          label: (it) => { const p = series[it.dataIndex]; return [`Ratio ${fr(p.ratio)} · ${acwrStatus(p.ratio).label}`, `Aiguë ${p.acute} · Chronique ${p.chronic}`]; },
        } },
      },
    },
    plugins: [bandPlugin],
  });

  // Runs table
  const tbody = $('runs');
  tbody.replaceChildren();
  for (const a of acts.filter(isRun).slice(0, 15)) {
    const tr = document.createElement('tr');
    tr.dataset.id = a.id;
    tr.tabIndex = 0;
    const ef = efficiencyFactor(a);
    const cells = [dayStr(a.start_date_local), a.name, fr(km(a.distance)), paceStr(a.average_speed),
      a.average_heartrate ? Math.round(a.average_heartrate) : '—', Math.round(a.total_elevation_gain || 0), ef ? fr(ef.toFixed(2)) : '—'];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 1) td.className = 'name';
      if (i >= 2) td.className = 'r';
      tr.appendChild(td);
    });
    tr.addEventListener('click', () => openDetail(a.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(a.id); });
    tbody.appendChild(tr);
  }
}

// ---------- Activity detail (streams) ----------
async function openDetail(id) {
  const a = state.activities.find((x) => String(x.id) === String(id));
  if (!a) return;
  state.selectedId = a.id;
  document.querySelectorAll('.runs tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(a.id)));
  const card = $('detail');
  card.hidden = false;
  $('d-title').textContent = `${a.name} · ${dayStr(a.start_date_local)}`;
  $('d-zones').replaceChildren();
  setStats(a, null);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const r = await fetch(`/api/streams?source=${state.mode}&id=${encodeURIComponent(a.id)}`);
    const { streams, error } = await r.json();
    if (!r.ok) throw new Error(error);
    if (state.selectedId !== a.id) return;
    setStats(a, streams);
    renderZones(streams);
    renderStreamCharts(streams);
  } catch (e) {
    $('d-zones').textContent = `Streams indisponibles (${e.message}).`;
  }
}

function setStats(a, streams) {
  const dec = streams ? decoupling(streams) : null;
  const items = [
    [`${fr(km(a.distance))} km`, 'distance'],
    [durStr(a.moving_time), 'temps en mouvement'],
    [`${paceStr(a.average_speed)}/km`, 'allure moyenne'],
    [a.average_heartrate ? `${Math.round(a.average_heartrate)} bpm` : '—', 'FC moyenne'],
    [`${Math.round(a.total_elevation_gain || 0)} m`, 'dénivelé positif'],
    [dec == null ? (streams ? 'n/a' : '…') : `${String(dec).replace('.', ',')} %`, 'découplage Pa:FC'],
  ];
  const box = $('d-stats');
  box.replaceChildren(...items.map(([v, l]) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = v;
    const s = document.createElement('span'); s.textContent = l;
    d.append(b, s);
    return d;
  }));
}

function renderZones(streams) {
  const z = timeInZones(streams, state.profile.hrMax);
  const bounds = zoneBounds(state.profile.hrMax);
  const box = $('d-zones');
  if (!z) { box.textContent = 'Pas de données cardio pour cette séance.'; return; }
  const bar = document.createElement('div'); bar.className = 'zone-bar';
  const legend = document.createElement('div'); legend.className = 'zone-legend';
  z.forEach((x, i) => {
    if (x.pct > 0) {
      const seg = document.createElement('div');
      seg.style.flex = x.pct;
      seg.style.background = `var(--z${i + 1})`;
      seg.title = `Z${i + 1}: ${x.pct} %`;
      bar.appendChild(seg);
    }
    const item = document.createElement('span');
    item.innerHTML = `<i style="background:var(--z${i + 1})"></i>`;
    item.append(`Z${i + 1} ${bounds[i].min}-${bounds[i].max} · ${String(x.pct).replace('.', ',')} %`);
    legend.appendChild(item);
  });
  box.replaceChildren(bar, legend);
}

function renderStreamCharts(streams) {
  const pts = streamSeries(streams, 220);
  const hasKm = pts.length && pts[0].km != null;
  const labels = pts.map((p) => (hasKm ? fr(p.km.toFixed(1)) : Math.round(p.t / 60)));
  const unit = hasKm ? 'km' : 'min';
  const xAxis = { ...gridX, ticks: { maxTicksLimit: 6, maxRotation: 0, callback(v) { return `${this.getLabelForValue(v)} ${unit}`; } } };
  draw('c-hr', {
    type: 'line',
    data: { labels, datasets: [{ data: pts.map((p) => p.hr), borderColor: css('--series-1'), borderWidth: 2, pointRadius: 0, tension: .25 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: xAxis, y: { ...gridY, title: { display: true, text: 'bpm' } } },
      plugins: { tooltip: { callbacks: { title: (it) => `${it[0].label} ${unit}`, label: (it) => `FC ${it.raw} bpm · ${paceStr(pts[it.dataIndex].v)}/km` } } },
    },
  });
  draw('c-pace', {
    type: 'line',
    data: { labels, datasets: [{ data: pts.map((p) => (p.v > 0.5 ? +(1000 / p.v / 60).toFixed(2) : null)), borderColor: css('--text-3'), borderWidth: 1.5, pointRadius: 0, tension: .25, spanGaps: true }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ...xAxis, ticks: { display: false } }, y: { ...gridY, reverse: true, title: { display: true, text: 'min/km' }, ticks: { maxTicksLimit: 3, callback: (v) => paceStr(1000 / (v * 60)) } } },
      plugins: { tooltip: { callbacks: { title: (it) => `${it[0].label} ${unit}`, label: (it) => `Allure ${paceStr(pts[it.dataIndex].v)}/km` } } },
    },
  });
}

// ---------- Chat ----------
function initChat() {
  addMsg('assistant', state.mode === 'demo'
    ? "Je suis le coach de l'athlète démo. J'ai sa charge, son efficacité aérobie et ses 15 dernières séances. Décris une séance comme si c'était la tienne, ou pose une question."
    : 'Connecté à tes données Strava. Raconte ta séance ("bonne sortie ce matin, jambes lourdes au début…") et je retrouve laquelle c\'est.');
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); send($('chat-text').value); });
  $('chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('chat-text').value); } });
  $('chat-text').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; });
  $('chips').addEventListener('click', (e) => { if (e.target.dataset.q) send(e.target.dataset.q); });
  $('d-close').addEventListener('click', () => { $('detail').hidden = true; state.selectedId = null; document.querySelectorAll('.runs tr.sel').forEach((t) => t.classList.remove('sel')); });
  $('d-ask').addEventListener('click', () => send('Analyse la séance sélectionnée: qualité du travail aérobie, découplage, temps en zones, et ce que je dois en retenir.'));
  $('logout-btn').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
}

let busy = false;
async function send(text) {
  text = (text || '').trim();
  if (!text || busy) return;
  busy = true;
  $('chat-send').disabled = true;
  $('chat-text').value = '';
  $('chat-text').style.height = 'auto';
  addMsg('user', text);
  state.chat.push({ role: 'user', content: text });
  const typing = addTyping();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: state.mode, messages: state.chat, activityId: state.selectedId }),
    });
    const data = await r.json();
    typing.remove();
    if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
    state.chat.push({ role: 'assistant', content: data.reply });
    addMsg('assistant', data.reply);
    if (data.model) $('chat-model').textContent = data.model;
  } catch (e) {
    typing.remove();
    state.chat.pop(); // keep the history alternating user/assistant
    addMsg('assistant', e.message, true);
  } finally {
    busy = false;
    $('chat-send').disabled = false;
    $('chat-text').focus();
  }
}

function addMsg(role, text, isError = false) {
  const div = document.createElement('div');
  div.className = `msg ${role}${isError ? ' error' : ''}`;
  if (role === 'assistant' && !isError) div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return div;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg assistant typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return div;
}

// Tiny, safe markdown: escape everything first, then allow bold, lists and paragraphs.
function renderMarkdown(src) {
  const esc = src.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/^#{1,4}\s*/, '');
  const out = [];
  let list = null;
  for (const line of esc.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (m) { (list ||= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

boot();
