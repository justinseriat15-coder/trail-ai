import {
  isRun, paceStr, km, durStr, dayStr, parseLocal,
  weeklyVolume, loadVsUsual, loadReading, easyShare, easyShareReading,
  aerobicEngine, engineReading, todayVerdict, sessionReading,
  timeInZones, decoupling, zoneBounds, METRIC_INFO,
} from './analytics.js';

const $ = (id) => document.getElementById(id);
const fr = (x) => String(x);
const state = { mode: null, profile: null, activities: [], insights: null, selectedId: null, chat: [], charts: {} };

// ---------- Metric explanations (info tips with a live "what this means" line) ----------
const tipRefs = {};

function closeTips(except) {
  document.querySelectorAll('.tip.open').forEach((t) => { if (t !== except) t.classList.remove('open'); });
}
document.addEventListener('click', () => closeTips());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTips(); });

function makeTip(key) {
  const info = METRIC_INFO[key];
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tip';
  b.setAttribute('aria-label', `About ${info.name}`);
  const dot = document.createElement('i');
  dot.textContent = 'i';
  dot.setAttribute('aria-hidden', 'true');
  const bub = document.createElement('span');
  bub.className = 'tip-bubble';
  bub.setAttribute('role', 'tooltip');
  const title = document.createElement('b');
  title.textContent = info.name;
  const what = document.createElement('span');
  what.textContent = info.what;
  const live = document.createElement('em');
  live.textContent = info.meaning;
  bub.append(title, what, live);
  b.append(dot, bub);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const was = b.classList.contains('open');
    closeTips();
    if (!was) b.classList.add('open');
  });
  tipRefs[key] = { live };
  return b;
}

function attachTips() {
  document.querySelectorAll('[data-metric]').forEach((el) => {
    const label = el.querySelector('.kpi-label');
    if (label) label.appendChild(makeTip(el.dataset.metric));
  });
}

// ---------- Theme for charts (reads CSS tokens so there is one source of truth) ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function chartDefaults() {
  const C = window.Chart;
  C.defaults.color = css('--text-3');
  C.defaults.font.family = "'Inter', system-ui, sans-serif";
  C.defaults.font.size = 11;
  C.defaults.borderColor = css('--border');
  C.defaults.plugins.legend.display = false;
  C.defaults.plugins.tooltip.backgroundColor = css('--surface');
  C.defaults.plugins.tooltip.borderColor = css('--border-strong');
  C.defaults.plugins.tooltip.borderWidth = 1;
  C.defaults.plugins.tooltip.titleColor = css('--text');
  C.defaults.plugins.tooltip.bodyColor = css('--text-2');
  C.defaults.plugins.tooltip.padding = 10;
  C.defaults.plugins.tooltip.displayColors = false;
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation.duration = 400;
}
const gridX = { grid: { display: false }, border: { display: false } };
const gridY = { grid: { color: css('--chart-grid') }, border: { display: false }, ticks: { maxTicksLimit: 4 } };

function draw(key, cfg) {
  state.charts[key]?.destroy();
  state.charts[key] = new window.Chart($(key), cfg);
}

// Direct label on the final point of a series - no legends anywhere.
const endLabelPlugin = {
  id: 'endLabel',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts?.text) return;
    const di = opts.dataset ?? 0;
    const meta = chart.getDatasetMeta(di);
    const data = chart.data.datasets[di].data;
    let pt = null;
    for (let i = meta.data.length - 1; i >= 0; i--) {
      if (data[i] != null && meta.data[i]) { pt = meta.data[i]; break; }
    }
    if (!pt) return;
    const { ctx } = chart;
    ctx.save();
    ctx.font = `600 12px 'Inter', sans-serif`;
    ctx.fillStyle = opts.color || css('--text');
    ctx.textAlign = 'right';
    ctx.fillText(opts.text, pt.x - 8, pt.y - 10);
    ctx.restore();
  },
};

// ---------- Boot ----------
async function boot() {
  attachTips();
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
  $('mode-pill').textContent = mode === 'demo' ? 'Demo' : `Strava · ${me.athlete?.firstname || ''}`;
  $('mode-pill').classList.toggle('live', mode === 'live');
  $('logout-btn').hidden = mode !== 'live';
  initChat();
  await loadData();
}

function showLandingNotice(code) {
  const msg = {
    denied: 'Strava login cancelled.',
    invalid_state: 'Login session expired, please try again.',
    missing_scope: "Allow access to your activities so the analysis can work.",
    exchange_failed: "Strava refused the connection. The app is limited to the owner's account in developer mode, try the demo.",
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
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    state.profile = data.profile;
    state.activities = data.activities;
    state.insights = data.insights || { perActivity: {} };
    const latest = data.activities[0]?.start_date_local?.slice(0, 10);
    const latestStr = latest ? parseLocal(latest).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    $('app-sub').textContent = `${data.athlete?.firstname || (state.mode === 'demo' ? 'Demo athlete' : 'Athlete')}${latestStr ? ` · data through ${latestStr}` : ''}`;
    $('loading').hidden = true;
    $('data').hidden = false;
    chartDefaults();
    render();
  } catch (e) {
    $('loading').hidden = true;
    $('error').hidden = false;
    $('error').textContent = `Could not load data: ${e.message}`;
  }
}

// Annotate activities with stream-derived zone seconds from the server.
function annotatedActivities() {
  return state.activities.map((a) => ({ ...a, zoneSecs: state.insights.perActivity[a.id]?.zoneSecs || null }));
}

// ---------- Dashboard ----------
function render() {
  const { hrMax, hrRest } = state.profile;
  const acts = state.activities;
  const runs7 = acts.filter((a) => isRun(a) && Date.now() - parseLocal(a.start_date_local) < 7 * 86400000);

  // --- Metrics for the new model
  const weeks = weeklyVolume(acts, 12);
  const lv = loadVsUsual(acts, hrMax, hrRest);
  const es = easyShare(annotatedActivities());
  const eng = aerobicEngine(acts, hrMax);
  const climbWeeks = weeks.map((w) => {
    let gain = 0, secs = 0;
    for (const a of acts) {
      const info = state.insights.perActivity[a.id];
      if (!info?.climbs?.length) continue;
      const ws = new Date(w.week + 'T00:00'), we = new Date(ws); we.setDate(we.getDate() + 7);
      const d = parseLocal(a.start_date_local);
      if (d < ws || d >= we) continue;
      for (const c of info.climbs) { gain += c.gain; secs += c.seconds; }
    }
    return { week: w.week, vertMph: secs >= 300 && gain > 0 ? Math.round(gain / (secs / 3600)) : null };
  });
  const ct = climbTrendLocal(climbWeeks);

  // --- Today verdict
  const lastRun = acts.filter(isRun)[0];
  const hoursAgo = lastRun ? (Date.now() - parseLocal(lastRun.start_date_local)) / 3600000 : null;
  const v = todayVerdict({ deltaPct: lv.deltaPct, engineChangePct: eng.changePct, easySharePct: es.d28.pct, hoursAgo });
  const chip = $('t-chip');
  chip.textContent = v.decision;
  chip.className = `today-chip ${v.tone}`;
  $('t-sentence').textContent = v.sentence;
  const nums = [];
  if (lv.deltaPct != null) nums.push([`${lv.deltaPct > 0 ? '+' : ''}${lv.deltaPct}%`, 'load vs usual']);
  if (eng.changePct != null) nums.push([`${eng.changePct > 0 ? '+' : ''}${eng.changePct}%`, 'aerobic engine']);
  $('t-nums').replaceChildren(...nums.map(([b, s]) => {
    const d = document.createElement('div');
    const bb = document.createElement('b'); bb.textContent = b;
    const ss = document.createElement('span'); ss.textContent = s;
    d.append(bb, ss);
    return d;
  }));

  // --- KPIs
  const hours7 = runs7.reduce((s, a) => s + a.moving_time, 0) / 3600;
  const dplus7 = Math.round(runs7.reduce((s, a) => s + (a.total_elevation_gain || 0), 0));
  $('k-week').innerHTML = `${hours7.toFixed(1)} <small>h · ${dplus7.toLocaleString('en-GB')} m D+</small>`;
  $('k-week-sub').textContent = `${runs7.length} session${runs7.length === 1 ? '' : 's'} in the last 7 days`;
  if (tipRefs.week) tipRefs.week.live.textContent = `Right now: ${hours7.toFixed(1)} hours and ${dplus7} metres of climbing in the last 7 days.`;

  const lr = loadReading(lv.deltaPct);
  $('k-load').textContent = lv.deltaPct == null ? '—' : `${lv.deltaPct > 0 ? '+' : ''}${lv.deltaPct}%`;
  const loadSub = $('k-load-sub');
  loadSub.textContent = lr.label.replace(/^.*?vs your usual: /, '');
  loadSub.className = `kpi-sub status ${lr.level}`;
  if (tipRefs.load) tipRefs.load.live.textContent = `Right now: ${lr.sentence}`;

  const esr = easyShareReading(es.d28.pct);
  $('k-easy').textContent = es.d28.pct == null ? '—' : `${es.d28.pct}%`;
  const easySub = $('k-easy-sub');
  easySub.textContent = es.d28.pct == null ? 'no HR data' : `of running easy, 28 days`;
  easySub.className = `kpi-sub status ${esr.level}`;
  if (tipRefs.easy) tipRefs.easy.live.textContent = es.d28.pct == null
    ? 'No heart-rate data in the window.'
    : `Right now: ${es.d28.pct}% of running time in Z1-Z2 over 28 days (target ~80%), from ${es.d28.covered} of ${es.d28.sessions} sessions with heart-rate data.`;

  const lastVert = [...climbWeeks].reverse().find((w) => w.vertMph != null)?.vertMph;
  $('k-climb').textContent = lastVert == null ? '—' : `${lastVert} m/h`;
  $('k-climb-sub').textContent = ct.changePct == null
    ? (lastVert == null ? 'no sustained climbs lately' : 'not enough climbing for a trend')
    : `${ct.changePct > 0 ? 'up' : 'down'} ${Math.abs(ct.changePct)}% over 12 weeks`;
  if (tipRefs.climb) tipRefs.climb.live.textContent = lastVert == null
    ? 'No sustained climbs (50 m or more at 5% or steeper) in the recent sessions.'
    : `Right now: about ${lastVert} vertical metres per hour on sustained climbs.`;

  if (eng.latestSecPerKm) {
    const m = Math.floor(eng.latestSecPerKm / 60), s2 = String(Math.round(eng.latestSecPerKm % 60)).padStart(2, '0');
    $('k-engine').innerHTML = `${m}:${s2} <small>/km at ${eng.refHr} bpm</small>`;
    $('k-engine-sub').textContent = eng.changePct == null ? 'not enough flat easy runs' : `${engineReading(eng.changePct)} (${eng.changePct > 0 ? '+' : ''}${eng.changePct}%)`;
  } else {
    $('k-engine').textContent = '—';
    $('k-engine-sub').textContent = 'not enough flat easy runs';
  }
  if (tipRefs.engine) tipRefs.engine.live.textContent = eng.latestSecPerKm
    ? 'Only flat, easy runs of 20 minutes or more feed this, so hilly runs never inflate it.'
    : 'Needs a few flat, easy runs of 20 minutes or more.';

  // --- Weekly hours + D+
  const label = (iso) => new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  draw('c-week', {
    type: 'bar',
    data: {
      labels: weeks.map((w) => label(w.week)),
      datasets: [
        {
          type: 'line', label: 'D+', data: weeks.map((w, i) => (i === weeks.length - 1 ? null : w.dplus)), yAxisID: 'y1',
          borderColor: css('--moss'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: .3,
        },
        {
          label: 'Hours', data: weeks.map((w) => w.hours),
          backgroundColor: weeks.map((_, i) => (i === weeks.length - 1 ? css('--brand') : 'rgba(32,29,22,.82)')),
          borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom', maxBarThickness: 30,
        },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...gridX, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 8 } },
        y: { ...gridY, title: { display: true, text: 'hours' }, beginAtZero: true },
        y1: { position: 'right', grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 4 }, title: { display: true, text: 'm D+' }, beginAtZero: true },
      },
      plugins: { endLabel: { dataset: 0, text: 'D+', color: css('--moss') }, tooltip: { callbacks: {
        title: (it) => `Week of ${it[0].label}${it[0].dataIndex === weeks.length - 1 ? ' (in progress)' : ''}`,
        label: (it) => { const w = weeks[it.dataIndex]; return it.datasetIndex === 0 ? `${w.dplus.toLocaleString('en-GB')} m of climbing` : `${w.hours} h · ${w.km} km · ${w.count} session${w.count === 1 ? '' : 's'}`; },
      } } },
    },
    plugins: [endLabelPlugin],
  });

  // --- Climbing speed trend
  const cw = climbWeeks;
  draw('c-climb', {
    type: 'line',
    data: {
      labels: cw.map((w) => w.week),
      datasets: [{ data: cw.map((w) => w.vertMph), borderColor: css('--brand'), borderWidth: 2, tension: .3, spanGaps: true, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: css('--surface'), pointBorderColor: css('--brand'), pointBorderWidth: 2 }],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ...gridX, ticks: { maxTicksLimit: 4, callback(v) { return label(this.getLabelForValue(v)); } } }, y: { ...gridY, title: { display: true, text: 'm/h' } } },
      plugins: { endLabel: { text: lastVert != null ? `${lastVert} m/h` : '', color: css('--brand-2') }, tooltip: { callbacks: {
        title: (it) => `Week of ${label(cw[it[0].dataIndex].week)}`,
        label: (it) => it.raw == null ? 'no sustained climbs' : `${it.raw} vertical metres per hour`,
      } } },
    },
    plugins: [endLabelPlugin],
  });

  // --- Aerobic engine trend (pace at easy HR; up = faster)
  const ep = eng.points;
  draw('c-engine', {
    type: 'line',
    data: {
      labels: ep.map((p) => p.date),
      datasets: [
        { data: ep.map((p) => p.secPerKm), showLine: false, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: css('--surface'), pointBorderColor: css('--text-3'), pointBorderWidth: 1.5 },
        { data: ep.map((p) => p.rollingSecPerKm), borderColor: css('--brand'), borderWidth: 2, pointRadius: 0, tension: .35 },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...gridX, ticks: { maxTicksLimit: 4, callback(v) { return dayStr(this.getLabelForValue(v) + 'T12:00:00').slice(4); } } },
        y: { ...gridY, reverse: true, ticks: { maxTicksLimit: 4, callback: (val) => { const m = Math.floor(val / 60); return `${m}:${String(Math.round(val % 60)).padStart(2, '0')}`; } } },
      },
      plugins: { endLabel: { dataset: 1, text: eng.latestSecPerKm ? `${Math.floor(eng.latestSecPerKm / 60)}:${String(Math.round(eng.latestSecPerKm % 60)).padStart(2, '0')}/km` : '', color: css('--brand-2') }, tooltip: { callbacks: {
        title: (it) => dayStr(ep[it[0].dataIndex].date + 'T12:00:00'),
        label: (it) => { const sec = it.raw; return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}/km at ${eng.refHr} bpm${it.datasetIndex === 1 ? ' (rolling)' : ''}`; },
      } } },
    },
    plugins: [endLabelPlugin],
  });

  // --- Easy-share bars
  const bar = $('easybar');
  const rows = [
    ['7 days', es.d7],
    ['28 days', es.d28],
  ];
  bar.replaceChildren(...rows.map(([lbl, d]) => {
    const row = document.createElement('div');
    row.className = 'easybar-row';
    const l = document.createElement('span'); l.textContent = lbl;
    const track = document.createElement('div'); track.className = 'easybar-track';
    if (d.pct != null) {
      const fill = document.createElement('div');
      fill.className = `easybar-fill${d.pct < 68 ? ' low' : ''}`;
      fill.style.width = `${d.pct}%`;
      track.appendChild(fill);
    }
    const target = document.createElement('div');
    target.className = 'easybar-target';
    target.style.left = '80%';
    target.title = 'Target ~80%';
    track.appendChild(target);
    const val = document.createElement('b');
    val.innerHTML = d.pct == null ? '—' : `${d.pct}% <span>(${d.covered}/${d.sessions} runs)</span>`;
    row.append(l, track, val);
    return row;
  }));
  $('easybar-foot').textContent = es.d28.pct == null
    ? 'Needs sessions recorded with heart rate.'
    : `Target ~80% easy. ${esr.label}. Based on ${es.d28.covered} of ${es.d28.sessions} sessions with heart-rate data in 28 days.`;

  // --- Recent sessions
  const tbody = $('runs');
  tbody.replaceChildren();
  for (const a of acts.filter(isRun).slice(0, 15)) {
    const tr = document.createElement('tr');
    tr.dataset.id = a.id;
    tr.tabIndex = 0;
    const cells = [dayStr(a.start_date_local), a.name];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 1) td.className = 'name';
      tr.appendChild(td);
    });
    const sparkTd = document.createElement('td');
    const spark = state.insights.perActivity[a.id]?.spark;
    if (spark) sparkTd.appendChild(sparkSvg(spark));
    tr.appendChild(sparkTd);
    const nums = [fr(km(a.distance)), paceStr(a.average_speed),
      a.average_heartrate ? Math.round(averageHR(a)) : '—', Math.round(a.total_elevation_gain || 0)];
    nums.forEach((c) => {
      const td = document.createElement('td');
      td.textContent = c;
      td.className = 'r';
      tr.appendChild(td);
    });
    tr.addEventListener('click', () => openDetail(a.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(a.id); });
    tbody.appendChild(tr);
  }
}

const averageHR = (a) => a.average_heartrate;

// Weekly climbing-speed trend + overall change (gain-weighted).
function climbTrendLocal(perWeek) {
  const pts = perWeek.filter((w) => w.vertMph != null);
  let changePct = null;
  if (pts.length >= 4) {
    const n = Math.max(1, Math.floor(pts.length / 3));
    const avg = (arr) => arr.reduce((s, p) => s + p.vertMph, 0) / arr.length;
    changePct = +(((avg(pts.slice(-n)) - avg(pts.slice(0, n))) / avg(pts.slice(0, n))) * 100).toFixed(1);
  }
  return { points: pts, changePct };
}

// ---------- Small SVG helpers ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function mk(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}
const pathFrom = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

function sparkSvg(spark) {
  const svg = mk('svg', { viewBox: '0 0 72 22', class: 'spark', 'aria-hidden': 'true' });
  const pts = spark.map((y, i) => [(i / (spark.length - 1)) * 72, 20 - y * 18]);
  mk('polyline', { points: pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ') }, svg);
  return svg;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Activity detail ----------
async function openDetail(id) {
  const a = state.activities.find((x) => String(x.id) === String(id));
  if (!a) return;
  state.selectedId = a.id;
  document.querySelectorAll('.runs tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(a.id)));
  const card = $('detail');
  card.hidden = false;
  $('d-title').textContent = `${a.name} · ${dayStr(a.start_date_local)}`;
  $('d-hero').replaceChildren();
  $('d-reading').textContent = '';
  setStats(a, null);
  buildRoute(a.id);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const r = await fetch(`/api/streams?source=${state.mode}&id=${encodeURIComponent(a.id)}`);
    const { streams, error } = await r.json();
    if (!r.ok) throw new Error(error);
    if (state.selectedId !== a.id) return;
    const info = state.insights.perActivity[a.id] || {};
    setStats(a, streams, info);
    buildHero(streams, info.climbs || []);
    renderZones(streams);
    const zones = info.zoneSecs;
    const flat = ((a.total_elevation_gain || 0) / (a.distance / 1000)) <= 15;
    const dec = flat ? decoupling(streams) : null;
    $('d-reading').textContent = sessionReading(a, { zones, climbs: info.climbs || [], dec, flat, hrMax: state.profile.hrMax });
  } catch (e) {
    $('d-zones').textContent = `Streams unavailable (${e.message}).`;
  }
}

function setStats(a, streams, info = {}) {
  const dplusPerKm = (a.total_elevation_gain || 0) / (a.distance / 1000);
  const flat = dplusPerKm <= 15;
  const dec = streams && flat ? decoupling(streams) : null;
  const items = [
    [`${fr(km(a.distance))} km`, 'distance'],
    [durStr(a.moving_time), 'moving time'],
    [`${paceStr(a.average_speed)}/km`, 'average pace'],
    [a.average_heartrate ? `${Math.round(a.average_heartrate)} bpm` : '—', 'average HR'],
    [`${Math.round(a.total_elevation_gain || 0)} m`, 'elevation gain'],
  ];
  if (info.vertMph != null) items.push([`${info.vertMph} m/h`, 'climbing speed', 'climb']);
  if (flat) items.push([streams ? (dec == null ? 'n/a' : `${dec}%`) : '…', 'Pa:HR decoupling', 'decoupling']);
  const box = $('d-stats');
  const cells = items.map(([val, lab, metric]) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = val;
    const s = document.createElement('span'); s.textContent = lab;
    if (metric) s.appendChild(makeTip(metric));
    d.append(b, s);
    return d;
  });
  box.replaceChildren(...cells);
}

// The signature screen: elevation hero + HR/pace on one distance axis.
function buildHero(streams, climbs) {
  const box = $('d-hero');
  box.replaceChildren();
  const { distance: dist, altitude: alt, heartrate: hr, velocity_smooth: vel } = streams;
  if (!dist || !alt) return;
  const W = 800, H = 210, padT = 36, padB = 22;
  const step = Math.max(1, Math.floor(dist.length / 400));
  const pts = [];
  for (let i = 0; i < dist.length; i += step) pts.push({ km: dist[i] / 1000, alt: alt[i], hr: hr?.[i], v: vel?.[i] });
  const xMax = pts.at(-1).km || 1;
  const yMin = Math.min(...pts.map((p) => p.alt));
  const yMax = Math.max(...pts.map((p) => p.alt));
  const ySpan = (yMax - yMin) || 1;
  const X = (kmv) => (kmv / xMax) * W;
  const Y = (av) => padT + (1 - (av - yMin) / ySpan) * (H - padT - padB);

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Elevation profile of the session' });
  const defs = mk('defs', {}, svg);
  const grad = mk('linearGradient', { id: 'dgrad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  mk('stop', { offset: '0', 'stop-color': '#d63f17', 'stop-opacity': '.22' }, grad);
  mk('stop', { offset: '1', 'stop-color': '#d63f17', 'stop-opacity': '0' }, grad);

  // Climb highlights behind the line
  for (const c of climbs) {
    mk('rect', { x: X(c.startKm), y: padT - 14, width: Math.max(2, X(c.endKm) - X(c.startKm)), height: H - padT - padB + 14, class: 'phero-climb' }, svg);
  }
  // Area + line
  const line = pts.map((p) => [X(p.km), Y(p.alt)]);
  mk('path', { d: `${pathFrom(line)} L${W},${H - padB + 8} L0,${H - padB + 8} Z`, class: 'phero-area' }, svg);
  mk('path', { d: pathFrom(line), class: 'phero-line' }, svg);

  // Annotations: the biggest climbs, plus km ticks
  const big = [...climbs].sort((a, b) => b.gain - a.gain).slice(0, 2);
  big.forEach((c) => {
    const x = X(c.endKm);
    const altTop = pts.reduce((best, p) => (Math.abs(p.km - c.endKm) < Math.abs(best.km - c.endKm) ? p : best), pts[0]).alt;
    mk('circle', { cx: x, cy: Y(altTop), r: 4, class: 'phero-dot' }, svg);
    const anchor = x > W - 120 ? 'end' : 'middle';
    const tx = x > W - 120 ? x + 4 : x;
    const t1 = mk('text', { x: tx, y: Y(altTop) - 22, 'text-anchor': anchor, class: 'phero-annot' }, svg);
    t1.textContent = `Climb · ${c.gain} m D+`;
    const t2 = mk('text', { x: tx, y: Y(altTop) - 10, 'text-anchor': anchor, class: 'phero-annot sub' }, svg);
    t2.textContent = `${c.vertMph} m/h vertical`;
  });
  const kmEvery = Math.max(1, Math.round(xMax / 6));
  for (let k = 0; k <= xMax; k += kmEvery) {
    const edge = k === 0 ? 'start' : (k + kmEvery > xMax ? 'end' : 'middle');
    const t = mk('text', { x: k === 0 ? 2 : (edge === 'end' ? W - 2 : X(k)), y: H - 6, 'text-anchor': edge, class: 'phero-tick' }, svg);
    t.textContent = `${k} km`;
  }
  box.appendChild(svg);

  // HR and pace, same distance axis
  if (hr) box.appendChild(subChart(pts, (p) => p.hr, 'phero-hr', 'bpm', W, X));
  if (vel) box.appendChild(subChart(pts, (p) => (p.v > 0.5 ? 1000 / p.v / 60 : null), 'phero-pace', 'min/km', W, X, true));
}

function subChart(pts, get, cls, unit, W, X, reverse = false) {
  const H = 74, padT = 8, padB = 14;
  const vals = pts.map(get).filter((x) => x != null);
  if (!vals.length) return document.createDocumentFragment();
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || 1) * 0.15;
  lo -= pad; hi += pad;
  const Y = (v) => reverse
    ? padT + ((v - lo) / (hi - lo)) * (H - padT - padB)
    : padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${unit} over the session` });
  const line = pts.filter((p) => get(p) != null).map((p) => [X(p.km), Y(get(p))]);
  mk('path', { d: pathFrom(line), class: cls }, svg);
  const loT = mk('text', { x: W - 2, y: Y(lo) + 3, 'text-anchor': 'end', class: 'phero-tick' }, svg);
  loT.textContent = unit === 'bpm' ? `${Math.round(lo)} bpm` : `${paceFromMinPerKm(lo)}`;
  const hiT = mk('text', { x: W - 2, y: Y(hi) - 3, 'text-anchor': 'end', class: 'phero-tick' }, svg);
  hiT.textContent = unit === 'bpm' ? `${Math.round(hi)} bpm` : `${paceFromMinPerKm(hi)}`;
  return svg;
}

const paceFromMinPerKm = (mpk) => `${Math.floor(mpk)}:${String(Math.round((mpk % 1) * 60)).padStart(2, '0')}`;

// Invented route shape on a contour background (demo routes are fictional by design).
function buildRoute(id) {
  const svg = $('d-route');
  svg.replaceChildren();
  const rand = mulberry32(Number(id) || 1);
  const loop = (rBase, wobble, phase) => {
    const N = 10;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      const r = rBase * (1 + (rand() - 0.5) * wobble);
      pts.push([150 + Math.cos(a + phase) * r, 150 + Math.sin(a + phase) * r * 0.86]);
    }
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < N; i++) {
      const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
      d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d + 'Z';
  };
  for (let c = 0; c < 4; c++) mk('path', { d: loop(118 + c * 16, 0.12, c * 0.9), class: 'route-contour' }, svg);
  const d = loop(80, 0.55, rand() * 6);
  mk('path', { d, class: 'route-line' }, svg);
  const m = d.match(/M([\d.]+),([\d.]+)/);
  mk('circle', { cx: m[1], cy: m[2], r: 5, class: 'route-start' }, svg);
  const lbl = mk('text', { x: 12, y: 288, class: 'route-label' }, svg);
  lbl.textContent = 'Route · fictional in demo';
}

function renderZones(streams) {
  const z = timeInZones(streams, state.profile.hrMax);
  const bounds = zoneBounds(state.profile.hrMax);
  const box = $('d-zones');
  if (!z) { box.textContent = 'No heart-rate data for this session.'; return; }
  const bar = document.createElement('div'); bar.className = 'zone-bar';
  const legend = document.createElement('div'); legend.className = 'zone-legend';
  z.forEach((x, i) => {
    if (x.pct > 0) {
      const seg = document.createElement('div');
      seg.style.flex = x.pct;
      seg.style.background = `var(--z${i + 1})`;
      seg.title = `Z${i + 1}: ${x.pct}%`;
      bar.appendChild(seg);
    }
    const item = document.createElement('span');
    item.innerHTML = `<i style="background:var(--z${i + 1})"></i>`;
    item.append(`Z${i + 1} ${bounds[i].min}-${bounds[i].max} · ${x.pct}%`);
    legend.appendChild(item);
  });
  box.replaceChildren(bar, legend);
}

// ---------- Chat ----------
function initChat() {
  addMsg('assistant', state.mode === 'demo'
    ? "I'm the demo athlete's coach. I have their training load, aerobic efficiency and last 15 sessions. Describe a session as if it were yours, or ask a question."
    : 'Connected to your Strava data. Tell me about your session ("good run this morning, heavy legs at the start…") and I\'ll find which one it is.');
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); send($('chat-text').value); });
  $('chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('chat-text').value); } });
  $('chat-text').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; });
  $('chips').addEventListener('click', (e) => { if (e.target.dataset.q) send(e.target.dataset.q); });
  $('d-close').addEventListener('click', () => { $('detail').hidden = true; state.selectedId = null; document.querySelectorAll('.runs tr.sel').forEach((t) => t.classList.remove('sel')); });
  $('d-ask').addEventListener('click', () => send('Analyse the selected session: quality of the aerobic work, decoupling, time in zones, and what I should take away from it.'));
  $('logout-btn').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
  // The floating coach button is a shortcut to the coach; once the coach panel
  // is on screen it only gets in the way (it covered the Send button).
  const fab = document.querySelector('.coach-fab');
  if (fab && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => fab.classList.toggle('fab-hidden', es[0].isIntersecting), { threshold: 0.05 }).observe($('coach'));
  }
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
  const steps = addSteps();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
      body: JSON.stringify({ source: state.mode, messages: state.chat, activityId: state.selectedId }),
    });
    const isStream = (r.headers.get('content-type') || '').includes('text/event-stream') && r.body;
    if (!r.ok || !isStream) {
      const data = await r.json();
      typing.remove();
      if (!r.ok) { steps.remove(); throw new Error(data.error || `Error ${r.status}`); }
      (data.steps || []).forEach((label) => steps.add(label));
      steps.finish();
      state.chat.push({ role: 'assistant', content: data.reply });
      addMsg('assistant', data.reply);
      if (data.model) $('chat-model').textContent = data.model;
    } else {
      let bubble = null;
      let acc = '';
      const answer = await readCoachStream(r.body, {
        onStep: (label) => steps.add(label),
        onDelta: (t) => {
          typing.remove();
          acc += t;
          if (!bubble) bubble = addMsg('assistant', '');
          bubble.innerHTML = renderMarkdown(acc);
          bubble.classList.add('streaming');
          $('chat-log').scrollTop = $('chat-log').scrollHeight;
        },
      });
      typing.remove();
      if (bubble) bubble.classList.remove('streaming');
      if (!answer.text) steps.remove(); else steps.finish();
      if (answer.error) throw new Error(answer.error);
      state.chat.push({ role: 'assistant', content: answer.text });
      if (bubble) bubble.innerHTML = renderMarkdown(answer.text);
      else addMsg('assistant', answer.text);
      if (answer.model) $('chat-model').textContent = answer.model;
    }
  } catch (e) {
    typing.remove();
    steps.remove();
    state.chat.pop();
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

function addSteps() {
  const div = document.createElement('div');
  div.className = 'msg agent-steps';
  div.hidden = true;
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return {
    add(label) {
      const line = document.createElement('div');
      line.textContent = label;
      div.appendChild(line);
      div.hidden = false;
      $('chat-log').scrollTop = $('chat-log').scrollHeight;
    },
    finish() { div.classList.add('done'); },
    remove() { div.remove(); },
  };
}

async function readCoachStream(body, { onStep, onDelta } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line.slice(6)); } catch { continue; }
      if (obj.type === 'step') onStep?.(obj.label);
      else if (obj.type === 'delta') onDelta?.(obj.text);
      else if (obj.type === 'reply' || obj.type === 'error') answer = obj;
    }
  }
  return answer;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg assistant typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return div;
}

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
