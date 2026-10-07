// Analytics engine — pure functions, shared by the browser and the serverless API.
// No DOM, no network: everything here is deterministic and unit-testable.

export const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);

export function isRun(a) {
  return RUN_TYPES.has(a.sport_type) || RUN_TYPES.has(a.type);
}

// ---------- Formatting ----------
export function paceStr(mps) {
  if (!mps || mps <= 0) return '—';
  const s = 1000 / mps;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r === 60 ? `${m + 1}:00` : `${m}:${String(r).padStart(2, '0')}`;
}
export const km = (m) => (m / 1000).toFixed(1);
export function durStr(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}
export function dayStr(iso) {
  return parseLocal(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---------- Heart-rate zones (% of HRmax, 5-zone model) ----------
export const ZONE_PCTS = [0, 0.70, 0.78, 0.85, 0.92]; // lower bounds of Z1..Z5

export function zoneBounds(hrMax) {
  return ZONE_PCTS.map((p, i) => ({
    zone: i + 1,
    min: Math.round(p * hrMax),
    max: i < 4 ? Math.round(ZONE_PCTS[i + 1] * hrMax) - 1 : hrMax,
  }));
}

export function zoneOf(hr, hrMax) {
  const r = hr / hrMax;
  let z = 1;
  for (let i = 1; i < ZONE_PCTS.length; i++) if (r >= ZONE_PCTS[i]) z = i + 1;
  return z;
}

// ---------- Training load ----------
// Banister TRIMP (male coefficients): minutes × HRr × 0.64 × e^(1.92·HRr)
export function trimp(a, hrMax, hrRest) {
  if (!a.average_heartrate || !a.moving_time) return null;
  const hrr = Math.min(Math.max((a.average_heartrate - hrRest) / (hrMax - hrRest), 0), 1);
  return (a.moving_time / 60) * hrr * 0.64 * Math.exp(1.92 * hrr);
}

const DAY = 86400000;

// Strava's start_date_local is wall-clock time with a misleading "Z" suffix:
// strip it so it is read as local time, not UTC.
export const parseLocal = (iso) => new Date(typeof iso === 'string' ? iso.replace(/Z$/, '') : iso);
const startOfDay = (d) => { const x = parseLocal(d); x.setHours(0, 0, 0, 0); return x; };
export const ymd = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

export function weekStart(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
  return x;
}

// Acute:Chronic Workload Ratio, rolling (acute = 7 d sum, chronic = 28 d sum / 4).
// Returns one point per day for the last `days` days.
export function acwrSeries(activities, hrMax, hrRest, days = 56, now = new Date()) {
  const today = startOfDay(now).getTime();
  const span = days + 28;
  const load = new Array(span).fill(0);
  for (const a of activities) {
    const t = trimp(a, hrMax, hrRest);
    if (t == null) continue;
    const idx = Math.floor((today - startOfDay(a.start_date_local).getTime()) / DAY);
    if (idx >= 0 && idx < span) load[idx] += t;
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    let acute = 0, chronic = 0;
    for (let k = i; k < i + 7; k++) acute += load[k];
    for (let k = i; k < i + 28; k++) chronic += load[k];
    chronic /= 4;
    out.push({
      date: ymd(new Date(today - i * DAY)),
      acute: Math.round(acute),
      chronic: Math.round(chronic),
      ratio: chronic > 0 ? +(acute / chronic).toFixed(2) : null,
    });
  }
  return out;
}

export function acwrStatus(r) {
  if (r == null) return { level: 'neutral', label: 'Historique insuffisant' };
  if (r < 0.8) return { level: 'warning', label: 'Sous-charge' };
  if (r <= 1.3) return { level: 'good', label: 'Zone optimale' };
  if (r <= 1.5) return { level: 'serious', label: 'Charge élevée' };
  return { level: 'critical', label: 'Risque de blessure' };
}

// ---------- Aerobic efficiency ----------
// Efficiency Factor = speed (m/min) / average HR. Higher = more speed per heartbeat.
export function efficiencyFactor(a) {
  if (!a.average_heartrate || !a.average_speed) return null;
  return (a.average_speed * 60) / a.average_heartrate;
}

// EF is only comparable on similar efforts: steady runs ≥ 20 min, mostly aerobic,
// on low-gradient terrain (≤ 15 m D+ per km), otherwise climbing inflates HR.
export function isComparableEasyRun(a, hrMax) {
  if (!isRun(a) || !a.average_heartrate || a.moving_time < 1200) return false;
  const dplusPerKm = (a.total_elevation_gain || 0) / (a.distance / 1000);
  return dplusPerKm <= 15 && a.average_heartrate / hrMax < 0.82;
}

export function efTrend(activities, hrMax, window = 4) {
  const pts = activities
    .filter((a) => isComparableEasyRun(a, hrMax))
    .sort((x, y) => parseLocal(x.start_date_local) - parseLocal(y.start_date_local))
    .map((a) => ({ id: a.id, date: a.start_date_local.slice(0, 10), ef: +efficiencyFactor(a).toFixed(3), hr: Math.round(a.average_heartrate), pace: paceStr(a.average_speed) }));
  pts.forEach((p, i) => {
    const s = pts.slice(Math.max(0, i - window + 1), i + 1);
    p.rolling = +(s.reduce((t, x) => t + x.ef, 0) / s.length).toFixed(3);
  });
  return pts;
}

// Percentage change of the rolling EF between the first and last third of the series.
export function efChange(trend) {
  if (trend.length < 6) return null;
  const n = Math.floor(trend.length / 3);
  const avg = (arr) => arr.reduce((s, p) => s + p.ef, 0) / arr.length;
  const first = avg(trend.slice(0, n));
  const last = avg(trend.slice(-n));
  return +(((last - first) / first) * 100).toFixed(1);
}

// ---------- Weekly aggregates ----------
export function weeklyVolume(activities, weeks = 12, now = new Date()) {
  const ws = weekStart(now);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(ws); start.setDate(start.getDate() - i * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const runs = activities.filter((a) => isRun(a) && parseLocal(a.start_date_local) >= start && parseLocal(a.start_date_local) < end);
    out.push({
      week: ymd(start),
      km: +(runs.reduce((s, a) => s + a.distance, 0) / 1000).toFixed(1),
      dplus: Math.round(runs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0)),
      hours: +(runs.reduce((s, a) => s + a.moving_time, 0) / 3600).toFixed(1),
      count: runs.length,
    });
  }
  return out;
}

// Max consecutive days with a run, within the last 14 days.
export function consecutiveRunDays(activities, now = new Date()) {
  const today = startOfDay(now).getTime();
  const days = new Set(activities.filter(isRun).map((a) => Math.floor((today - startOfDay(a.start_date_local).getTime()) / DAY)).filter((d) => d >= 0 && d < 14));
  let best = 0, cur = 0;
  for (let d = 13; d >= 0; d--) { cur = days.has(d) ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
}

// ---------- Stream analysis (per-second data of one activity) ----------
// streams: { time:[s], heartrate:[bpm], velocity_smooth:[m/s], altitude:[m] }

// Aerobic decoupling (Pa:HR): EF of the 2nd half vs the 1st half, after a 10-min warm-up.
// < 5 % = good aerobic durability for that duration.
export function decoupling(streams) {
  const { time, heartrate: hr, velocity_smooth: v } = streams || {};
  if (!time || !hr || !v || time.length < 60) return null;
  const idx = time.map((t, i) => i).filter((i) => time[i] >= 600 && v[i] > 1 && hr[i] > 60);
  if (idx.length < 60) return null;
  const mid = Math.floor(idx.length / 2);
  const ef = (ids) => {
    const sv = ids.reduce((s, i) => s + v[i], 0) / ids.length;
    const sh = ids.reduce((s, i) => s + hr[i], 0) / ids.length;
    return sv / sh;
  };
  const ef1 = ef(idx.slice(0, mid));
  const ef2 = ef(idx.slice(mid));
  return +(((ef1 - ef2) / ef1) * 100).toFixed(1);
}

export function timeInZones(streams, hrMax) {
  const { time, heartrate: hr } = streams || {};
  if (!time || !hr) return null;
  const secs = [0, 0, 0, 0, 0];
  for (let i = 1; i < time.length; i++) {
    const dt = Math.min(time[i] - time[i - 1], 30);
    secs[zoneOf(hr[i], hrMax) - 1] += dt;
  }
  const total = secs.reduce((a, b) => a + b, 0) || 1;
  return secs.map((s, i) => ({ zone: i + 1, seconds: s, pct: +((s / total) * 100).toFixed(1) }));
}

// Downsample streams to ~n points for charting (km-indexed pace + HR).
export function streamSeries(streams, n = 200) {
  const { time, heartrate: hr, velocity_smooth: v, distance: d } = streams || {};
  if (!time || !hr) return [];
  const step = Math.max(1, Math.floor(time.length / n));
  const out = [];
  for (let i = 0; i < time.length; i += step) {
    const sl = (arr) => arr ? arr.slice(i, i + step) : [];
    const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    out.push({ t: time[i], km: d ? +(d[i] / 1000).toFixed(2) : null, hr: Math.round(mean(sl(hr))), v: mean(sl(v)) });
  }
  return out;
}

// ---------- Compact summary (fed to the LLM, also shown in the UI) ----------
export function buildSummary(activities, { hrMax, hrRest, now = new Date() }) {
  const runs = activities.filter(isRun).sort((a, b) => parseLocal(b.start_date_local) - parseLocal(a.start_date_local));
  const acwr = acwrSeries(activities, hrMax, hrRest, 28, now);
  const latest = acwr[acwr.length - 1];
  const trend = efTrend(activities, hrMax);
  const weeks = weeklyVolume(activities, 8, now);
  return {
    hrMax, hrRest,
    zones: zoneBounds(hrMax),
    acwr: latest,
    acwrStatus: acwrStatus(latest?.ratio),
    efChangePct: efChange(trend),
    efLast: trend.slice(-6),
    weeks,
    consecutiveRunDays14d: consecutiveRunDays(activities, now),
    recentRuns: runs.slice(0, 15).map((a) => ({
      id: a.id,
      date: a.start_date_local.slice(0, 10),
      name: a.name,
      type: a.sport_type || a.type,
      km: +km(a.distance),
      duration: durStr(a.moving_time),
      pace: paceStr(a.average_speed),
      hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      hrMax: a.max_heartrate ? Math.round(a.max_heartrate) : null,
      dplus: Math.round(a.total_elevation_gain || 0),
      ef: efficiencyFactor(a) ? +efficiencyFactor(a).toFixed(3) : null,
      trimp: trimp(a, hrMax, hrRest) ? Math.round(trimp(a, hrMax, hrRest)) : null,
    })),
  };
}
