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

// Low-volume variant for the grounding regression suite (CI only, not served
// to demo visitors): a fictional athlete whose recent weeks sit at 20-40 km,
// with one light historical month of a few short runs plus strength sessions.
// Shape anonymized from a real support case in which the coach answered a
// light-month question with an invented "current 60-70 km/week" comparison -
// this fixture lets the gate prove that claim can never be grounded again.
// All names, dates and figures are synthetic.
export function demoActivitiesLowVolume(now = new Date()) {
  const rand = mulberry32(7);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const WEEKS = 16;
  const out = [];
  let id = 700000;
  const LV_NAMES = ['Easy run', 'Morning jog', 'Lunch run', 'Easy loop', 'Park run', 'Recovery run'];
  for (let w = WEEKS - 1; w >= 0; w--) {
    // Oldest 4 weeks are the light month: 1-2 short runs + a strength session.
    const light = w >= WEEKS - 4;
    const runsThisWeek = light ? 1 + Math.floor(rand() * 2) : 3;
    const dows = [1, 3, 6].slice(0, runsThisWeek);
    for (const dow of dows) {
      const d = new Date(monday); d.setDate(d.getDate() - w * 7 + dow);
      if (d > today) continue;
      d.setHours(18, Math.floor(rand() * 50), 0, 0);
      const kmRun = light ? 3.5 + rand() * 4 : 6 + rand() * 9;
      const minutes = kmRun * (5.6 + rand() * 1.2);
      const hr = 138 + rand() * 22;
      const dplus = 30 + rand() * 120;
      const moving = Math.round(minutes * 60);
      out.push({
        id: id++,
        name: LV_NAMES[Math.floor(rand() * LV_NAMES.length)],
        type: 'Run', sport_type: 'Run',
        start_date_local: toLocalIso(d),
        distance: Math.round(kmRun * 1000),
        moving_time: moving,
        elapsed_time: moving + Math.round(rand() * 180),
        average_speed: +(kmRun * 1000 / moving).toFixed(3),
        average_heartrate: +hr.toFixed(1),
        max_heartrate: Math.round(hr + 12 + rand() * 14),
        total_elevation_gain: Math.round(dplus),
        _kind: 'easy',
        _drift: 0.03 + rand() * 0.02,
      });
    }
    if (light && rand() < 0.75) {
      const d = new Date(monday); d.setDate(d.getDate() - w * 7 + 4);
      if (d <= today) {
        d.setHours(19, Math.floor(rand() * 40), 0, 0);
        const moving = Math.round((19 + rand() * 3) * 60);
        out.push({
          id: id++,
          name: 'Strength session',
          type: 'WeightTraining', sport_type: 'WeightTraining',
          start_date_local: toLocalIso(d),
          distance: 0,
          moving_time: moving,
          elapsed_time: moving,
          average_speed: 0,
          average_heartrate: +(105 + rand() * 12).toFixed(1),
          max_heartrate: 0,
          total_elevation_gain: 0,
          _kind: 'strength',
          _drift: 0,
        });
      }
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

  // Pass 1: terrain. The profile must agree with the session name: an
  // out-and-back has ONE summit, a loop has 1-3 climbs and comes home low.
  const outback = /out-and-back/i.test(activity.name || '');
  const raw = new Array(N).fill(20);
  if (dplus > 0 && outback) {
    const summit = Math.floor(N * (0.5 + rand() * 0.12));
    const knee = Math.floor(summit * (0.3 + rand() * 0.2));
    const knots = [
      [0, 0],
      [knee, dplus * (0.28 + rand() * 0.15)],
      [Math.floor(summit * 0.8), dplus * (0.7 + rand() * 0.12)],
      [summit, dplus],
      [summit + Math.max(2, Math.floor(N * 0.02)), dplus * (0.93 + rand() * 0.04)],
      [Math.floor(summit + (N - summit) * 0.5), dplus * (0.4 + rand() * 0.1)],
      [N - 1, dplus * (0.02 + rand() * 0.05)],
    ];
    for (let i = 0; i < N; i++) {
      let s0 = knots[0], s1 = knots[knots.length - 1];
      for (let kI = 0; kI < knots.length - 1; kI++) {
        if (i >= knots[kI][0] && i <= knots[kI + 1][0]) { s0 = knots[kI]; s1 = knots[kI + 1]; break; }
      }
      const span = Math.max(1, s1[0] - s0[0]);
      raw[i] = 20 + s0[1] + ((s1[1] - s0[1]) * (i - s0[0])) / span
        + (i <= summit
            ? Math.sin((i / Math.max(30, summit)) * Math.PI * 5 + 0.9) * dplus * 0.045
            : Math.sin(i / 41 + 0.3) * dplus * 0.012)
        + Math.sin(i / 23 + 1.7) * 1.4 + Math.sin(i / 7 + 0.4) * 0.6 + (rand() - 0.5) * 0.7;
    }
  } else if (dplus > 0) {
    const isLoop = /loop/i.test(activity.name || '');
    const nMaj = dplus > 600 ? 2 + Math.floor(rand() * 2) : dplus > 150 ? 1 + Math.floor(rand() * 2) : 1;
    const shares = Array.from({ length: nMaj }, () => 0.6 + rand() * 0.8);
    const totShare = shares.reduce((x, y) => x + y, 0);
    const knots = [[0, 0]];
    let alt = 0, pos = 0;
    for (let m = 0; m < nMaj; m++) {
      // Loops reserve the last stretch to come back down to the start.
      const blockLen = Math.floor((N / nMaj) * (0.8 + rand() * 0.4) * (isLoop ? 0.82 : 1));
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
    if (isLoop) {
      knots.push([Math.min(pos, N - 3), alt], [N - 1, dplus * 0.02 * rand()]);
    } else {
      knots.push([N - 1, alt]);
    }
    for (let i = 0; i < N; i++) {
      let s0 = knots[0], s1 = knots[knots.length - 1];
      for (let kI = 0; kI < knots.length - 1; kI++) {
        if (i >= knots[kI][0] && i <= knots[kI + 1][0]) { s0 = knots[kI]; s1 = knots[kI + 1]; break; }
      }
      const span = Math.max(1, s1[0] - s0[0]);
      raw[i] = 20 + s0[1] + ((s1[1] - s0[1]) * (i - s0[0])) / span
        + Math.sin((i / N) * Math.PI * 6 + 1.2) * dplus * 0.03
        + Math.sin(i / 23 + 1.7) * 2.2 + Math.sin(i / 7 + 0.4) * 0.8 + (rand() - 0.5) * 0.8;
    }
  }
  let rawAsc = 0;
  for (let i = 1; i < N; i++) rawAsc += Math.max(0, raw[i] - raw[i - 1]);
  const k = rawAsc > 0 && dplus > 0 ? dplus / rawAsc : 0;
  const base = Math.min(...raw);
  for (let i = 0; i < N; i++) altitude.push(+((raw[i] - base) * k + 20).toFixed(1));

  // Pass 2: pace and HR against the real grade of that terrain.
  // Grade is smoothed over ~30 s; pace follows it quickly, HR follows slowly
  // (real HR rises over 1-2 min into a climb, falls faster on the way down).
  // Pace-vs-grade curve, HR response, pauses and noise calibrated against
  // real trail-running stream data (36 runs, Oct 2026).
  const isInt = activity._kind === 'intervals';
  const SG = 6; // 6 samples * 5 s = 30 s smoothing
  const smGrade = (i) => {
    let acc = 0, n = 0;
    for (let j = Math.max(1, i - SG + 1); j <= i; j++) {
      const step = Math.max(1, (j * 5 * activity.average_speed) - ((j - 1) * 5 * activity.average_speed));
      acc += (altitude[j] - altitude[j - 1]) / step; n++;
    }
    return n ? acc / n : 0;
  };
  // Measured pace factor (sec/km relative to flat) per smoothed grade.
  // Descents are NOT faster: runners hold back downhill (factor >= 1).
  const PACE_CURVE = [
    [-0.25, 1.18], [-0.10, 1.10], [-0.05, 1.06], [-0.03, 1.02], [-0.01, 0.98],
    [0, 1.0], [0.01, 1.01], [0.02, 1.08], [0.03, 1.13], [0.04, 1.27],
    [0.05, 1.51], [0.06, 1.8], [0.08, 2.3], [0.10, 2.8], [0.12, 3.3], [0.25, 4.2],
  ];
  const paceFactor = (g) => {
    for (let k = 0; k < PACE_CURVE.length - 1; k++) {
      const [g0, f0] = PACE_CURVE[k], [g1, f1] = PACE_CURVE[k + 1];
      if (g >= g0 && g <= g1) return f0 + ((f1 - f0) * (g - g0)) / (g1 - g0);
    }
    return PACE_CURVE[PACE_CURVE.length - 1][1];
  };
  // Measured pauses: ~2.6 stops per hour, median ~18 s. Schedule them up
  // front (not during intervals), then hold speed at 0 through each stop.
  const stops = [];
  if (!isInt && activity.moving_time > 1200) {
    const nStops = Math.max(0, Math.round((activity.moving_time / 3600) * 2.6 * (0.6 + rand() * 0.8)));
    for (let k = 0; k < nStops; k++) {
      const at = 600 + Math.floor(rand() * Math.max(1, activity.moving_time - 900));
      stops.push({ start: at, end: at + 10 + Math.round(rand() * 16) }); // 10-26 s, median ~18 s
    }
  }
  const stoppedAt = (t) => stops.some((s) => t >= s.start && t < s.end);
  let dist = 0, hr = 105, t = 0;
  const vRaw = [];
  for (let i = 0; i < N; i++) {
    const frac = i / N;
    let targetV = activity.average_speed;
    let targetHr = activity.average_heartrate * (1 - (activity._drift || 0.03) / 2 + (activity._drift || 0.03) * frac);
    if (isInt && t > 900 && t < activity.moving_time - 600) {
      const on = Math.floor((t - 900) / 180) % 2 === 0;
      targetV *= on ? 1.22 : 0.78;
      targetHr *= on ? 1.08 : 0.93;
    }
    if (t < 600) { targetV *= 0.9; targetHr *= 0.9 + 0.1 * (t / 600); }
    const g = Math.max(-0.25, Math.min(0.25, smGrade(i)));
    let v, hrT;
    if (stoppedAt(t)) {
      v = 0;
      hrT = DEMO_PROFILE.hrRest + (hr - DEMO_PROFILE.hrRest) * 0.7; // recovery during a stop
    } else {
      const floor = g > 0.12 ? 1.0 : 0.8; // hiking on steep ground is still ~1 m/s, not a crawl
      v = Math.max(floor, (targetV / paceFactor(g)) * (0.94 + rand() * 0.12));
      hrT = targetHr * (1 + g * 1.1);
    }
    const hrTarget = Math.min(hrT, DEMO_PROFILE.hrMax - 2);
    // Measured HR lag: rise tau ~42 s, fall tau ~26 s (per 5 s sample).
    const rate = hrTarget > hr ? 0.115 : 0.19;
    hr += (hrTarget - hr) * rate + (rand() - 0.5) * 1.2;
    hr = Math.min(hr, DEMO_PROFILE.hrMax - 2); // never above the athlete's own max
    dist += v * 5;
    t += 5;
    vRaw.push(v);
    time.push(t); heartrate.push(Math.round(hr));
    distance.push(dist);
  }
  // Smooth pace over a rolling ~30 s window (what a watch shows), then
  // rescale distance so the stream ends EXACTLY on the declared distance.
  const scale = activity.distance / dist;
  for (let i = 0; i < N; i++) {
    let acc = 0, n = 0;
    for (let j = Math.max(0, i - SG + 1); j <= i; j++) { acc += vRaw[j]; n++; }
    // Smoothing is trailing: a stop reads as 0 during the stop, then pace ramps back up.
    velocity_smooth.push(stoppedAt(time[i]) ? 0 : +(Math.max(0.4, (acc / n) * scale)).toFixed(2));
    distance[i] = Math.round(distance[i] * scale);
  }
  distance[N - 1] = activity.distance;
  return { time, heartrate, velocity_smooth, distance, altitude };
}
