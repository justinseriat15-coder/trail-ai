// Deterministic demo dataset: a fictional trail runner, 16 weeks of training.
// Same seed → same data, so the public demo is stable and reproducible.
// Shape matches the Strava API (SummaryActivity / activity streams) so the
// exact same analytics code runs on demo and live data.

export const DEMO_PROFILE = { firstname: 'Demo athlete', hrMax: 196, hrRest: 48 };

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Session name pools, so weeks do not read as copy-paste.
const NAMES = {
  easy: ['Easy run Z2', 'Recovery jog', 'Easy loop', 'Shakeout run', 'Easy run Z2', 'Morning miles'],
  intervals: ['Threshold 3×10 min', 'Intervals 6×3 min', 'Hill reps 8×45 s', 'Tempo 20 min', 'Threshold 2×15 min'],
  long: ['Long trail run', 'Ridge loop', 'Long run - forest trails', 'Summit out-and-back', 'Long trail run'],
};

// Weekly template (0 = Monday). Never two running days in a row except the weekend block.
const TEMPLATE = [
  { dow: 1, kind: 'easy' },
  { dow: 3, kind: 'intervals' },
  { dow: 5, kind: 'easy' },
  { dow: 6, kind: 'long' },
];

export function demoActivities(now = new Date()) {
  const rand = mulberry32(42);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const WEEKS = 16;
  const out = [];
  let id = 900000;

  for (let w = WEEKS - 1; w >= 0; w--) {
    const progress = (WEEKS - 1 - w) / (WEEKS - 1);          // 0 → 1 over the block
    const recoveryWeek = (WEEKS - 1 - w) % 4 === 3;           // 3:1 loading pattern
    const load = recoveryWeek ? 0.7 : 1;
    const efBase = 1.04 + 0.11 * progress;                    // aerobic adaptation (m/min per bpm)

    for (const s of TEMPLATE) {
      const d = new Date(monday); d.setDate(d.getDate() - w * 7 + s.dow);
      if (d > today) continue;
      if (rand() < 0.07) continue;                            // missed session
      d.setHours(s.kind === 'long' ? 8 : 18, Math.floor(rand() * 50), 0, 0);

      let minutes, hr, dplus, name;
      if (s.kind === 'easy') {
        minutes = (42 + 18 * progress) * load + rand() * 6;
        hr = 143 + rand() * 6;
        dplus = 20 + rand() * 60;
        name = NAMES.easy[Math.floor(rand() * NAMES.easy.length)];
      } else if (s.kind === 'intervals') {
        minutes = (45 + 10 * progress) * load;
        hr = 158 + rand() * 6;
        dplus = 30 + rand() * 40;
        name = NAMES.intervals[Math.floor(rand() * NAMES.intervals.length)];
      } else {
        minutes = (65 + 70 * progress) * load + rand() * 10;
        hr = 146 + rand() * 7;
        dplus = (250 + 650 * progress) * load + rand() * 80;
        name = NAMES.long[Math.floor(rand() * NAMES.long.length)];
      }
      const climbPenalty = Math.min(dplus / (minutes / 6) / 60, 0.12); // hills slow you down
      const ef = efBase * (s.kind === 'intervals' ? 1.06 : 1) * (1 - climbPenalty) * (0.97 + rand() * 0.06);
      const speed = (ef * hr) / 60;                                    // m/s
      const moving = Math.round(minutes * 60);
      out.push({
        id: id++,
        name,
        type: s.kind === 'long' ? 'TrailRun' : 'Run',
        sport_type: s.kind === 'long' ? 'TrailRun' : 'Run',
        start_date_local: toLocalIso(d),
        distance: Math.round(speed * moving),
        moving_time: moving,
        elapsed_time: moving + Math.round(rand() * 240),
        average_speed: +speed.toFixed(3),
        average_heartrate: +hr.toFixed(1),
        max_heartrate: Math.round(hr + 12 + rand() * 14),
        total_elevation_gain: Math.round(dplus),
        _kind: s.kind,
        _drift: s.kind === 'long' ? 0.09 - 0.06 * progress : 0.05 - 0.035 * progress,
      });
    }
  }
  return out.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
}

function toLocalIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00Z`;
}

// Synthetic 5-second streams. Terrain is generated first and rescaled so the
// accumulated ascent matches the activity's D+; pace and HR then respond to
// the actual grade with a first-order lag, plus realistic noise and drift.
export function demoStreams(activity) {
  const rand = mulberry32(activity.id);
  const N = Math.floor(activity.moving_time / 5);
  const time = [], heartrate = [], velocity_smooth = [], distance = [], altitude = [];
  const dplus = activity.total_elevation_gain || 0;

  // Pass 1: terrain. Real trail runs are a few dominant climbs, not even
  // rolling: build 1-3 major climbs with irregular slopes, then noise.
  const raw = new Array(N).fill(20);
  if (dplus > 0) {
    const nMaj = dplus > 600 ? 2 + Math.floor(rand() * 2) : dplus > 150 ? 1 + Math.floor(rand() * 2) : 1;
    const shares = Array.from({ length: nMaj }, () => 0.6 + rand() * 0.8);
    const totShare = shares.reduce((x, y) => x + y, 0);
    const knots = [[0, 0]];
    let alt = 0, pos = 0;
    for (let m = 0; m < nMaj; m++) {
      const blockLen = Math.floor((N / nMaj) * (0.8 + rand() * 0.4));
      const climbLen = Math.max(24, Math.floor(blockLen * (0.45 + rand() * 0.2)));
      const share = dplus * (shares[m] / totShare);
      const k1 = pos + Math.floor(climbLen * (0.3 + rand() * 0.3));
      const k2 = pos + climbLen;
      knots.push([k1, alt + share * (0.3 + rand() * 0.4)], [k2, alt + share]);
      alt += share;
      const drop = share * (0.7 + rand() * 0.3);
      const dLen = Math.max(1, blockLen - climbLen);
      const d1 = k2 + Math.floor(dLen * (0.4 + rand() * 0.3));
      knots.push([d1, alt - drop * 0.6], [pos + blockLen, alt - drop]);
      alt -= drop;
      pos += blockLen;
    }
    knots.push([N - 1, alt]);
    for (let i = 0; i < N; i++) {
      let s0 = knots[0], s1 = knots[knots.length - 1];
      for (let kI = 0; kI < knots.length - 1; kI++) {
        if (i >= knots[kI][0] && i <= knots[kI + 1][0]) { s0 = knots[kI]; s1 = knots[kI + 1]; break; }
      }
      const span = Math.max(1, s1[0] - s0[0]);
      raw[i] = 20 + s0[1] + ((s1[1] - s0[1]) * (i - s0[0])) / span
        + Math.sin(i / 23 + 1.7) * 2.2 + Math.sin(i / 7 + 0.4) * 0.8 + (rand() - 0.5) * 0.8;
    }
  }
  let rawAsc = 0;
  for (let i = 1; i < N; i++) rawAsc += Math.max(0, raw[i] - raw[i - 1]);
  const k = rawAsc > 0 && dplus > 0 ? dplus / rawAsc : 0;
  const base = Math.min(...raw);
  for (let i = 0; i < N; i++) altitude.push(+((raw[i] - base) * k + 20).toFixed(1));

  // Pass 2: pace and HR against the real grade of that terrain.
  const isInt = activity._kind === 'intervals';
  let dist = 0, hr = 105;
  for (let i = 0; i < N; i++) {
    const t = i * 5;
    const frac = i / N;
    let targetV = activity.average_speed;
    let targetHr = activity.average_heartrate * (1 - (activity._drift || 0.03) / 2 + (activity._drift || 0.03) * frac);
    if (isInt && t > 900 && t < activity.moving_time - 600) {
      const on = Math.floor((t - 900) / 180) % 2 === 0;
      targetV *= on ? 1.22 : 0.78;
      targetHr *= on ? 1.08 : 0.93;
    }
    if (t < 600) { targetV *= 0.9; targetHr *= 0.9 + 0.1 * (t / 600); }
    const step = i > 0 ? Math.max(1, distance[i - 1] - (distance[i - 2] || 0)) : 5;
    const grade = i > 0 ? (altitude[i] - altitude[i - 1]) / step : 0;
    const g = Math.max(-0.25, Math.min(0.25, grade));
    const v = Math.max(0.8, targetV * (1 - g * 3.2) * (0.97 + rand() * 0.06));
    hr += (targetHr * (1 + g * 1.1) - hr) * 0.08 + (rand() - 0.5) * 1.6;
    hr = Math.min(hr, DEMO_PROFILE.hrMax - 2); // never above the athlete's own max
    dist += v * 5;
    time.push(t); heartrate.push(Math.round(hr)); velocity_smooth.push(+v.toFixed(2));
    distance.push(Math.round(dist));
  }
  return { time, heartrate, velocity_smooth, distance, altitude };
}
