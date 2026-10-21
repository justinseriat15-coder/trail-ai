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
  return parseLocal(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
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
  if (r == null) return { level: 'neutral', label: 'Not enough history' };
  if (r < 0.8) return { level: 'warning', label: 'Under-loaded' };
  if (r <= 1.3) return { level: 'good', label: 'Optimal zone' };
  if (r <= 1.5) return { level: 'serious', label: 'High load' };
  return { level: 'critical', label: 'Injury risk' };
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
export function buildSummary(activities, { hrMax, hrRest, now = new Date(), perActivity = {}, race = null } = {}) {
  const runs = activities.filter(isRun).sort((a, b) => parseLocal(b.start_date_local) - parseLocal(a.start_date_local));
  const lv = loadVsUsual(activities, hrMax, hrRest, now);
  const es = easyShare(activities.map((a) => ({ ...a, zoneSecs: perActivity[a.id]?.zoneSecs || null })), now);
  const eng = aerobicEngine(activities, hrMax);
  const climb = climbTrend(weeklyClimbSpeed(activities, perActivity, 12, now));
  const climbNow = climbNowOf(climb);
  const weeks = weeklyVolume(activities, 8, now);
  return {
    hrMax, hrRest,
    zones: zoneBounds(hrMax),
    load: lv,
    loadReading: loadReading(lv.deltaPct),
    easyShare: es,
    engine: eng,
    climb, climbNow,
    race: race ? raceReadiness(activities, { race, climbNow, now }) : null,
    weeks,
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
    })),
  };
}

// ---------- Metric explanations (dashboard tooltips and readings) ----------
// Pure data + pure functions so they are unit-testable and shared with the server.
export const METRIC_INFO = {
  decoupling: {
    name: 'Cardiac decoupling (Pa:HR)',
    what: 'How much your heart rate drifts upward at a steady effort, comparing the second half of the session with the first (after a 10-minute warm-up).',
    meaning: 'Under 5% means good aerobic durability for that duration. Higher means the aerobic base is still developing for that distance.',
  },
  zones: {
    name: 'Heart-rate zones',
    what: 'Time spent in each of 5 zones, set as a percentage of your max heart rate.',
    meaning: 'Easy days should sit mostly in Z1-Z2. An "easy" run with a lot of Z3 or above was not actually easy.',
  },
  week: {
    name: 'Last 7 days',
    what: 'Total time on feet and elevation gained in the last 7 days, all run types.',
    meaning: 'The raw amount of work. Compare it with "load vs usual" to see whether this is more or less than your body is used to.',
  },
  load: {
    name: 'Load vs usual',
    what: 'Training load (heart-rate based) of the last 7 days compared with your average 7-day load over the 4 weeks before them.',
    meaning: 'Roughly -10% to +15% is the range to build in. Big spikes are what gets runners hurt.',
  },
  easy: {
    name: 'Easy share',
    what: 'Percentage of running time spent in heart-rate zones 1-2, from sessions with heart-rate data.',
    meaning: 'Around 80% easy keeps hard days hard and easy days easy. Green at 80% or more, ochre below.',
  },
  climb: {
    name: 'Climbing speed',
    what: 'Vertical metres gained per hour on sustained climbs (50 m or more of gain at 3% or steeper).',
    meaning: 'The trail-specific fitness number: if it climbs over weeks, your uphill engine is getting stronger.',
  },
  race: {
    name: 'Race readiness',
    what: 'Two rules of thumb over the last 12 weeks against your target race: your longest run, and your biggest week of climbing vs the race total D+. Up to 60 km the longest run is compared with 2/3 of the race distance; for ultras that rule stops scaling, so it becomes time on feet: longest run vs about 5.5 hours (back-to-back long days matter too, but are not measured).',
    meaning: 'No average: the score is the weaker of the two, because a race is only as doable as its limiting factor. Both targets are rules of thumb, not predictions. Climbing speed is shown for context and is not scored: training speed on short fresh climbs is not comparable to race-average climbing speed.',
  },
  engine: {
    name: 'Aerobic engine',
    what: 'Your pace at your easy heart rate, from flat, easy runs of 20 minutes or more.',
    meaning: 'If this pace gets faster over weeks at the same heart rate, your aerobic base is improving. Hilly and hard runs are excluded.',
  },
};


// One-line "what this means for you" reading of the current ACWR ratio.
export function acwrReading(r) {
  if (r == null) return 'Not enough history yet: the ratio needs about 4 weeks of training data.';
  if (r < 0.8) return 'Load is below what your body is used to. Fine for a deload week, not for building fitness.';
  if (r <= 1.3) return 'Load matches what your body is adapted to. This is the zone to train in.';
  if (r <= 1.5) return 'Load is rising faster than your 4-week average. Hold volume steady this week.';
  return 'Load is rising fast relative to your base. Ease off: cut volume or intensity this week.';
}

// One-line reading of a Pa:HR decoupling value, in percent.
export function decouplingReading(d) {
  if (d == null) return 'Not enough steady heart-rate data to measure drift for this session.';
  if (d < 3.5) return 'Excellent aerobic durability for this duration.';
  if (d < 5) return 'Good aerobic durability for this duration.';
  if (d < 7) return 'Noticeable cardiac drift: the aerobic base is still developing, so keep long runs easy.';
  return 'Strong cardiac drift: slow down or shorten steady efforts until this comes back under 5%.';
}

// ======================================================================
// Phase 2: simple, trail-first metrics. Same maths as before where the
// brief says so (load ratio = ACWR windows), plain language on top.
// ======================================================================

// Load vs usual: rolling 7-day TRIMP against the average of the four
// 7-day windows before it (rolling, so mid-week reads stay honest).
export function loadVsUsual(activities, hrMax, hrRest, now = new Date()) {
  const today = startOfDay(now).getTime();
  const load = new Array(35).fill(0);
  for (const a of activities) {
    const t = trimp(a, hrMax, hrRest);
    if (t == null) continue;
    const idx = Math.floor((today - startOfDay(a.start_date_local).getTime()) / DAY);
    if (idx >= 0 && idx < 35) load[idx] += t;
  }
  const current = load.slice(0, 7).reduce((s, x) => s + x, 0);
  let prev = 0;
  for (let w = 0; w < 4; w++) prev += load.slice(7 + w * 7, 14 + w * 7).reduce((s, x) => s + x, 0);
  const usual = prev / 4;
  if (usual <= 0) return { current: Math.round(current), usual: 0, deltaPct: null };
  return { current: Math.round(current), usual: Math.round(usual), deltaPct: Math.round(((current - usual) / usual) * 100) };
}

export function loadReading(deltaPct) {
  if (deltaPct == null) return { label: 'Not enough history yet', level: 'neutral', sentence: 'A few weeks of training and this reads itself.' };
  const vs = `${deltaPct > 0 ? '+' : ''}${deltaPct}% vs your usual`;
  if (deltaPct <= -40) return { label: `${vs}: a real dip`, level: 'neutral', sentence: 'Fine if this was a planned easy week; a missed one is a nudge to get back out.' };
  if (deltaPct <= -15) return { label: `${vs}: lighter`, level: 'good', sentence: 'Lighter than usual. Good for absorbing the recent work.' };
  if (deltaPct < 15) return { label: `${vs}: fine`, level: 'good', sentence: 'Right where your body expects it.' };
  if (deltaPct < 30) return { label: `${vs}: building`, level: 'warning', sentence: 'Building. Keep the hard days hard and the easy days easy.' };
  return { label: `${vs}: ease off`, level: 'serious', sentence: 'A big jump for one week. Cut something before it cuts you.' };
}

// Easy share: % of running time in Z1-Z2, aggregated over windows.
// Each activity carries zoneSecs ([s1..s5]) computed from its streams.
export function easyShare(annotated, now = new Date()) {
  const today = startOfDay(now).getTime();
  const agg = (days) => {
    let easy = 0, tot = 0, covered = 0, sessions = 0;
    for (const a of annotated) {
      const idx = Math.floor((today - startOfDay(a.start_date_local).getTime()) / DAY);
      if (idx < 0 || idx >= days) continue;
      sessions++;
      if (!a.zoneSecs) continue;
      covered++;
      easy += a.zoneSecs[0] + a.zoneSecs[1];
      tot += a.zoneSecs.reduce((s, x) => s + x, 0);
    }
    return { pct: tot ? Math.round((easy / tot) * 100) : null, covered, sessions };
  };
  return { d7: agg(7), d28: agg(28) };
}

// One rule for every easy-share colour (KPI dot, bars, text), two levels only:
// 80% or more is on target (moss green), below 80% is ochre. Red is reserved
// for the athlete's own data and actions, never an alarm.
export const EASY_TARGET = 80;
export function easyShareLevel(pct, target = EASY_TARGET) {
  if (pct == null) return 'neutral';
  return pct >= target ? 'good' : 'warning';
}

export function easyShareReading(pct, target = EASY_TARGET) {
  const level = easyShareLevel(pct, target);
  if (level === 'neutral') return { label: 'no HR data', level };
  if (level === 'good') return { label: `${pct}% easy: on target`, level };
  return { label: `${pct}% easy: below target`, level };
}

// Sustained climbs from altitude + distance streams: gain >= 50 m at an
// average grade >= 3%, with 60 s altitude smoothing (barometer/GPS noise).
export function climbSegments(streams, { minGain = 50, minGrade = 0.03, minDescent = 10 } = {}) {
  const { time, distance: dist, altitude: alt } = streams || {};
  if (!time || !dist || !alt || time.length < 20) return [];
  const W = 12;
  const sm = alt.map((_, i) => {
    const s = alt.slice(Math.max(0, i - W), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
  const segs = [];
  let segStart = 0, peakIdx = 0;
  const close = () => {
    // The climb starts at its base (last lowest point before the peak), not at
    // the previous segment boundary - flat run-in must not dilute the numbers.
    let base = Infinity, baseIdx = segStart;
    for (let i = segStart; i <= peakIdx; i++) if (sm[i] <= base) { base = sm[i]; baseIdx = i; }
    const gain = sm[peakIdx] - base;
    const distM = dist[peakIdx] - dist[baseIdx];
    const secs = time[peakIdx] - time[baseIdx];
    if (gain >= minGain && distM >= 200 && gain / distM >= minGrade && secs >= 120) {
      segs.push({
        startKm: +(dist[baseIdx] / 1000).toFixed(2),
        endKm: +(dist[peakIdx] / 1000).toFixed(2),
        gain: Math.round(gain),
        seconds: Math.round(secs),
        vertMph: Math.round(gain / (secs / 3600)),
      });
    }
  };
  for (let i = 1; i < sm.length; i++) {
    if (sm[i] > sm[peakIdx]) { peakIdx = i; continue; } // strictly higher: a plateau must not dilute vertical speed
    if (sm[peakIdx] - sm[i] >= minDescent) { close(); segStart = i; peakIdx = i; }
  }
  close();
  return segs;
}

// One vertical speed figure per activity: climb metres per hour on the
// sustained climbs only (null when the run has none).
export function climbingSpeed(segments) {
  const gain = segments.reduce((s, c) => s + c.gain, 0);
  const secs = segments.reduce((s, c) => s + c.seconds, 0);
  return secs >= 300 && gain > 0 ? Math.round(gain / (secs / 3600)) : null;
}

// 12-week trend of climbing speed (gain-weighted per week) + overall change.
// Weekly climbing speed (vertical m/h) per week, from detected climbs.
// perActivity maps activity id -> { climbs } (from lib/insights.js).
export function weeklyClimbSpeed(activities, perActivity = {}, weeks = 12, now = new Date()) {
  return weeklyVolume(activities, weeks, now).map((w) => {
    let gain = 0, secs = 0;
    const ws = new Date(w.week + 'T00:00'), we = new Date(ws); we.setDate(we.getDate() + 7);
    for (const a of activities) {
      const info = perActivity[a.id];
      if (!info?.climbs?.length) continue;
      const d = parseLocal(a.start_date_local);
      if (d < ws || d >= we) continue;
      for (const c of info.climbs) { gain += c.gain; secs += c.seconds; }
    }
    return { week: w.week, vertMph: secs >= 300 && gain > 0 ? Math.round(gain / (secs / 3600)) : null };
  });
}

// Climbing-speed trend from weekly vertMph values. Needs MIN_CLIMB_WEEKS weeks
// with sustained climbs before it draws a line or states a trend (same idea as
// the aerobic engine guard): two points are a coincidence, not a trend.
// The rolling line is a 3-week median that exists only on weeks with data, so
// it never extends past the last real point. change = mean of first 4 vs last
// 4 weeks with data (needs 6).
export const MIN_CLIMB_WEEKS = 4;
export function climbTrend(perWeek) {
  const pts = perWeek.map((w) => ({ ...w }));
  const vals = pts.map((w) => w.vertMph);
  const have = pts.filter((w) => w.vertMph != null);
  const enough = have.length >= MIN_CLIMB_WEEKS;
  const med = vals.map((v, i) => {
    if (!enough || v == null) return null;
    const win = vals.slice(Math.max(0, i - 2), i + 1).filter((x) => x != null).sort((a, b) => a - b);
    return win.length ? win[Math.floor(win.length / 2)] : null;
  });
  pts.forEach((w, i) => { w.rolling = med[i]; });
  let changePct = null;
  if (have.length >= 6) {
    const avg = (arr) => arr.reduce((t, w) => t + w.vertMph, 0) / arr.length;
    const first = avg(have.slice(0, 4)), last = avg(have.slice(-4));
    changePct = +(((last - first) / first) * 100).toFixed(1);
  }
  return { points: pts, changePct, enough, weeksWithData: have.length };
}

// The number shown as "climbing speed now": latest rolling value, or null while
// there are too few climbing weeks.
export function climbNowOf(trend) {
  if (!trend.enough) return null;
  return [...trend.points].reverse().find((w) => w.rolling != null)?.rolling ?? null;
}

export function aerobicEngine(activities, hrMax) {
  const refHr = Math.round(hrMax * 0.74);
  const trend = efTrend(activities, hrMax);
  const toPace = (ef) => Math.round(60000 / (ef * refHr)); // sec per km
  const points = trend.map((p) => ({ date: p.date, secPerKm: toPace(p.ef), rollingSecPerKm: toPace(p.rolling) }));
  const latest = points.length ? points[points.length - 1] : null;
  return {
    refHr,
    points,
    latestSecPerKm: latest?.rollingSecPerKm ?? null,
    changePct: efChange(trend),
  };
}

export function engineReading(changePct) {
  if (changePct == null) return 'not enough flat easy runs yet';
  if (changePct >= 3) return 'improving';
  if (changePct <= -3) return 'slipping';
  return 'holding steady';
}

// The "Today" verdict: one decision and one sentence, from the numbers only.
// Deterministic - demo needs no model call, live regenerates on new data.
export function todayVerdict({ deltaPct, engineChangePct, easySharePct, hoursAgo }) {
  const loadNum = deltaPct != null ? [`${deltaPct > 0 ? '+' : ''}${deltaPct}%`, 'load vs usual'] : null;
  const engNum = engineChangePct != null ? [`${engineChangePct > 0 ? '+' : ''}${engineChangePct}%`, 'aerobic engine'] : null;
  const easyNum = easySharePct != null ? [`${easySharePct}%`, 'easy share'] : null;
  if (deltaPct == null) {
    return { decision: 'Easy day', tone: 'neutral', sentence: 'Not enough history to judge the load yet. Keep today easy and let the data build up.', numbers: [] };
  }
  if (deltaPct >= 45) {
    return { decision: 'Rest', tone: 'serious', sentence: `Load is ${deltaPct}% above your usual. That is spike territory: today is for recovery, not for proving anything.`, numbers: [loadNum, easyNum || engNum].filter(Boolean) };
  }
  if (deltaPct >= 30) {
    return { decision: 'Easy day', tone: 'warning', sentence: `Load is ${deltaPct}% above your usual. If you go out, keep it short and genuinely easy.`, numbers: [loadNum, easyNum || engNum].filter(Boolean) };
  }
  if (deltaPct <= -40) {
    return { decision: 'Train', tone: 'good', sentence: `A lighter spell (${deltaPct}% vs your usual). If that was planned, good - if not, today is a good day to get back out.`, numbers: [loadNum, easyNum || engNum].filter(Boolean) };
  }
  if (engineChangePct != null && engineChangePct <= -3) {
    return { decision: 'Easy day', tone: 'neutral', sentence: 'Load is fine but the aerobic engine has dipped. Keep today aerobic and honest.', numbers: [loadNum, engNum].filter(Boolean) };
  }
  const engineBit = engineChangePct != null && engineChangePct >= 3 ? ' and the engine is still improving' : '';
  const freshBit = hoursAgo != null && hoursAgo < 20 ? ' Legs had less than a day since the last one - keep it steady.' : '';
  return { decision: 'Train', tone: 'good', sentence: `Load is where your body expects it${engineBit}. Green light.${freshBit}`, numbers: [loadNum, engNum || easyNum].filter(Boolean) };
}

// Short coach reading of one session, from its own numbers.
export function sessionReading(a, { zones, climbs, dec, flat, hrMax }) {
  const dplus = Math.round(a.total_elevation_gain || 0);
  const v = climbingSpeed(climbs || []);
  const easyPct = zones ? Math.round(((zones[0] + zones[1]) / zones.reduce((s, x) => s + x, 0)) * 100) : null;
  if (!flat && v) {
    const hrBit = easyPct != null && easyPct >= 70 ? ' Heart rate stayed under control on the climbs.' : easyPct != null && easyPct < 50 ? ' Heart rate ran high for an easy-looking day - the climbs asked for it.' : '';
    return `A proper climb day: ${dplus} m at ${v} m/h of vertical speed.${hrBit} This is the work that builds trail legs.`;
  }
  if (flat && dec != null) {
    const easyBit = easyPct != null ? ` ${easyPct}% of the time in Z1-Z2.` : '';
    return dec < 5
      ? `A steady aerobic session with ${dec}% drift: durable at this duration.${easyBit}`
      : `Drift of ${dec}% says this duration still costs you.${easyBit} Keep the next one slower.`;
  }
  if (a.average_heartrate && a.average_heartrate / hrMax >= 0.85) {
    return 'A quality day: real intensity, honestly done. The easy days around it are what make it count.';
  }
  return 'An ordinary, useful session. Consistency is the whole trick.';
}

// Elevation sparkline points for lists: n evenly-sampled altitudes, 0-1.
export function sparkPoints(streams, n = 24) {
  const alt = streams?.altitude;
  if (!alt || alt.length < 2) return null;
  const step = Math.max(1, Math.floor(alt.length / n));
  const pts = [];
  for (let i = 0; i < alt.length && pts.length < n; i += step) pts.push(alt[i]);
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  return pts.map((a) => +((a - min) / span).toFixed(3));
}

// ---------- Race readiness ----------
// Two rules of thumb, scored by the weakest link (a race is only as doable as
// its limiting factor, so there is no average):
//  1. Longest run in 12 weeks. Up to ULTRA_FROM_KM it is measured in km vs 2/3
//     of the race distance (a 50K build peaks around 33 km). Above that the
//     2/3 rule stops scaling (117 km for a 175K), so the check switches to time
//     on feet: longest run vs about 5.5 h. Back-to-back long days matter for
//     ultras too, but they are not measured here.
//  2. Biggest week of climbing in 12 weeks vs the race's total D+.
// Each check is capped at 100%; the score is the lower of the two.
// Climbing speed is shown as context only: training speed on short fresh
// climbs is not comparable to race-average climbing speed, so it is not scored.
export const LONG_RUN_SHARE = 2 / 3;
export const ULTRA_FROM_KM = 60;
export const TIME_ON_FEET_H = 5.5;
export const isUltra = (race) => race.distanceKm > ULTRA_FROM_KM;
// Fictional race, used for the demo only. hours = target moving time (display only).
export const DEMO_RACE = { name: 'fictional 50K', distanceKm: 50, dplusM: 2500, hours: 7 };

// Validate a race target from any source (the RACE_TARGET env var).
// Accepts { name, km, dplus, hours } or the long key names. Returns a clean
// object or null. hours is optional (display only).
export function sanitizeRace(r) {
  if (!r || typeof r !== 'object') return null;
  const num = (v, lo, hi) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const distanceKm = num(r.distanceKm ?? r.km, 5, 400);
  const dplusM = num(r.dplusM ?? r.dplus ?? r.dPlus, 0, 30000);
  if (distanceKm == null || dplusM == null) return null;
  const hours = num(r.hours, 0.5, 72);
  const name = String(r.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'my race';
  const out = { name, distanceKm: +distanceKm.toFixed(1), dplusM: Math.round(dplusM), hours: hours == null ? null : +hours.toFixed(2) };
  const d = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? new Date(`${r.date}T00:00:00Z`) : null;
  if (d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === r.date) out.date = r.date;
  return out;
}

// "33 weeks to go" for a race with an ISO date. No date, or a date in the past,
// means no label. Whole weeks, rounded down; under a week it says so in days.
export function weeksToGo(race, now = new Date()) {
  if (!race || !race.date) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((new Date(`${race.date}T00:00:00Z`).getTime() - today) / 86400000);
  if (days < 0) return null;
  if (days === 0) return 'Race day';
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} to go`;
  const w = Math.floor(days / 7);
  return `${w} week${w === 1 ? '' : 's'} to go`;
}

export function longRunTargetKm(race = DEMO_RACE) {
  return Math.round(race.distanceKm * LONG_RUN_SHARE);
}

export function raceReadiness(activities, { race = DEMO_RACE, climbNow = null, now = new Date() } = {}) {
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 84); // 12 weeks
  const runs = activities.filter((a) => isRun(a) && parseLocal(a.start_date_local) >= cutoff);
  const longestKm = runs.length ? Math.max(...runs.map((a) => a.distance / 1000)) : 0;
  const biggestDplus = weeklyVolume(activities, 12, now).reduce((m, w) => Math.max(m, w.dplus), 0);
  const cap = (x) => Math.max(0, Math.min(100, Math.round(x * 100)));
  const needKm = longRunTargetKm(race);
  const longestH = runs.length ? Math.max(...runs.map((a) => a.moving_time / 3600)) : 0;
  const ultra = isUltra(race);
  const parts = {
    distance: ultra
      ? { label: 'Longest run (time on feet)', unit: 'h', have: +longestH.toFixed(1), need: TIME_ON_FEET_H, pct: cap(longestH / TIME_ON_FEET_H) }
      : { label: 'Long run', unit: 'km', have: +longestKm.toFixed(1), need: needKm, pct: cap(longestKm / needKm) },
    vertWeek: { label: 'Biggest D+ week', have: biggestDplus, need: race.dplusM, pct: race.dplusM > 0 ? cap(biggestDplus / race.dplusM) : 100 },
  };
  const context = { climbSpeed: climbNow };
  if (longestKm === 0 && parts.vertWeek.have === 0) {
    return { race, parts, context, limiting: null, score: null, sentence: 'Not enough training data yet to judge race readiness.' };
  }
  const entries = Object.entries(parts);
  const [key, weakest] = entries.reduce((m, e) => (e[1].pct < m[1].pct ? e : m), entries[0]);
  const limiting = { key, label: weakest.label, pct: weakest.pct };
  const fmt = (n) => n.toLocaleString('en-GB');
  let sentence;
  if (limiting.pct >= 100) {
    sentence = 'No weak link: the longest run and the biggest climbing week both reach the rules of thumb for this race.';
  } else if (key === 'distance') {
    sentence = ultra
      ? `Limiting factor: time on feet. ${parts.distance.have} h longest run in 12 weeks against about ${TIME_ON_FEET_H} h for an ultra. Build it first, and add back-to-back long days.`
      : `Limiting factor: the long run. ${parts.distance.have} km longest in 12 weeks against a ${needKm} km target (2/3 of ${race.distanceKm} km). Build it first.`;
  } else {
    sentence = `Limiting factor: climbing volume. ${fmt(parts.vertWeek.have)} m D+ in the biggest week against the ${fmt(race.dplusM)} m the race packs into one day.`;
  }
  return { race, parts, context, limiting, score: limiting.pct, sentence };
}

// ---------- Distance axis ticks for the session profile ----------
// Ticks sit at their true position (km / total). The last label is the exact
// end of the run ("20.4 km"), anchored at the right edge; a regular tick that
// would collide with it is dropped, so no label ever sits at the wrong place.
export function axisTicks(xMax, maxTicks = 6) {
  const nice = [0.5, 1, 2, 5, 10, 20, 25, 50];
  const step = nice.find((n) => xMax / n <= maxTicks) ?? Math.ceil(xMax / maxTicks);
  const ticks = [];
  for (let k = 0; k < xMax - 1e-9; k += step) ticks.push({ km: +k.toFixed(2), anchor: k === 0 ? 'start' : 'middle' });
  const endLabel = Number.isInteger(xMax) ? String(xMax) : xMax.toFixed(1);
  const kept = ticks.filter((t) => t.km === 0 || xMax - t.km >= step * 0.45);
  kept.push({ km: xMax, anchor: 'end', label: `${endLabel} km`, isEnd: true });
  return kept.map((t) => ({ label: t.label || `${t.km} km`, ...t }));
}
