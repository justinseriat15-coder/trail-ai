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
        name = 'Easy run Z2';
      } else if (s.kind === 'intervals') {
        minutes = (45 + 10 * progress) * load;
        hr = 158 + rand() * 6;
        dplus = 30 + rand() * 40;
        name = progress < 0.5 ? 'Intervals 6×3 min' : 'Threshold 3×10 min';
      } else {
        minutes = (65 + 70 * progress) * load + rand() * 10;
        hr = 146 + rand() * 7;
        dplus = (250 + 650 * progress) * load + rand() * 80;
        name = 'Long trail run';
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

// Synthetic 5-second streams with realistic cardiac drift and terrain noise.
export function demoStreams(activity) {
  const rand = mulberry32(activity.id);
  const N = Math.floor(activity.moving_time / 5);
  const time = [], heartrate = [], velocity_smooth = [], distance = [], altitude = [];
  let dist = 0, alt = 20, hr = 105;
  const isInt = activity._kind === 'intervals';
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
    const grade = Math.sin(i / 37) * (activity.total_elevation_gain / (activity.distance / 1000)) / 400;
    const v = Math.max(0.8, targetV * (1 - grade * 4) * (0.97 + rand() * 0.06));
    hr += (targetHr * (1 + grade * 1.5) - hr) * 0.08 + (rand() - 0.5) * 1.5;
    dist += v * 5; alt = Math.max(0, alt + grade * v * 5);
    time.push(t); heartrate.push(Math.round(hr)); velocity_smooth.push(+v.toFixed(2));
    distance.push(Math.round(dist)); altitude.push(+alt.toFixed(1));
  }
  return { time, heartrate, velocity_smooth, distance, altitude };
}
