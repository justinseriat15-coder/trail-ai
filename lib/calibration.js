// Calibration aggregation for the demo-data generator.
// Pure functions over the six allowed Strava stream types (time, heartrate,
// altitude, velocity_smooth, grade_smooth, cadence). Raw streams are consumed
// one activity at a time by api/calibration.js and discarded immediately -
// only these aggregates leave the server. No latlng is ever requested.

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Median absolute deviation: a noise estimate that ignores real surges.
const madSigma = (xs) => {
  const m = median(xs);
  if (m === null) return null;
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
};

// Trailing rolling mean; null-padded where a stream is missing.
export function rollingMean(xs, win) {
  const out = new Array(xs.length).fill(null);
  let sum = 0, n = 0;
  const q = [];
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    q.push(v);
    if (v != null) { sum += v; n++; }
    if (q.length > win) {
      const old = q.shift();
      if (old != null) { sum -= old; n--; }
    }
    if (q.length === win && n > win * 0.6) out[i] = sum / n;
  }
  return out;
}

// Sustained climbs: 30 s-smoothed grade >= minGrade for >= minLen seconds,
// entered from flatter ground (previous 60 s mean grade < minGrade/2).
export function findSegments(smoothGrade, minGrade, minLen, sign = 1) {
  const segs = [];
  let start = -1;
  for (let i = 0; i <= smoothGrade.length; i++) {
    const g = i < smoothGrade.length ? smoothGrade[i] : null;
    const on = g != null && sign * g >= minGrade;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start >= minLen) {
        const pre = smoothGrade.slice(Math.max(0, start - 60), start).filter((v) => v != null);
        const preMean = pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : 0;
        if (sign * preMean < minGrade / 2) segs.push({ start, end: i });
      }
      start = -1;
    }
  }
  return segs;
}

// Time for HR to cover 63% of its eventual change after a gradient step
// (one time-constant of an exponential response). Returns seconds or null.
function tauForSegment(hr, hrSmooth, seg, rise) {
  const w0 = hr.slice(Math.max(0, seg.start - 30), seg.start).filter((v) => v != null);
  const horizon = Math.min(seg.end, seg.start + 300);
  const w1 = hrSmooth.slice(Math.max(seg.start, horizon - 60), horizon).filter((v) => v != null);
  if (w0.length < 10 || w1.length < 10) return null;
  const base = w0.reduce((a, b) => a + b, 0) / w0.length;
  const plateau = w1.reduce((a, b) => a + b, 0) / w1.length;
  const delta = rise ? plateau - base : base - plateau;
  if (delta < 6) return null; // no real response to fit
  const target = rise ? base + 0.632 * delta : base - 0.632 * delta;
  for (let i = seg.start; i < horizon; i++) {
    const v = hrSmooth[i];
    if (v != null && (rise ? v >= target : v <= target)) return i - seg.start;
  }
  return null;
}

export function createAccumulator() {
  return {
    used: 0, skipped: 0,
    riseTaus: [], fallTaus: [],
    gradeBuckets: new Map(), // grade bin -> { factors: [], speeds: [], walk: 0, moving: 0 }
    hrDiffs: [], speedResid: [],
    stops: 0, stopSecs: [], movingSec: 0, elapsedSec: 0, stoppedSec: 0,
    cadFlat: [], cadClimb: [],
    hrMaxSeen: 0,
  };
}

const GRADE_BIN = 0.025; // 2.5% buckets
const WALK_SPEED = 1.6;  // m/s; below this on a climb we call it hiking
const STOP_SPEED = 0.5;  // m/s; below this = stopped
const MIN_RUN_SPEED = 2.2; // m/s; samples slower than this are not "running pace"

export function addStreams(acc, streams) {
  const { time, heartrate, altitude, velocity_smooth: speed, grade_smooth: grade, cadence } = streams;
  if (!time || !speed || !grade || !heartrate || time.length < 600) { acc.skipped++; return acc; }
  const n = time.length;
  const gSmooth = rollingMean(grade, 30);
  const hrSmooth = rollingMean(heartrate, 15);
  const vSmooth = rollingMean(speed, 15);

  // HR lag on sustained climbs / descents
  for (const seg of findSegments(gSmooth, 0.03, 120, 1)) {
    const tau = tauForSegment(heartrate, hrSmooth, seg, true);
    if (tau != null && tau >= 10 && tau <= 300) acc.riseTaus.push(tau);
  }
  for (const seg of findSegments(gSmooth, 0.03, 120, -1)) {
    const tau = tauForSegment(heartrate, hrSmooth, seg, false);
    if (tau != null && tau >= 5 && tau <= 300) acc.fallTaus.push(tau);
  }

  // Per-activity flat running pace anchors the pace-vs-grade curve
  const flatPaces = [];
  for (let i = 0; i < n; i++) {
    if (gSmooth[i] != null && Math.abs(gSmooth[i]) < 0.02 && speed[i] > MIN_RUN_SPEED) {
      flatPaces.push(1000 / speed[i]); // sec/km
    }
  }
  const flatPace = median(flatPaces);

  // Pace vs grade + hiking + noise + cadence
  for (let i = 30; i < n; i++) {
    const g = gSmooth[i];
    if (g == null) continue;
    const bin = Math.round(g / GRADE_BIN) * GRADE_BIN;
    let b = acc.gradeBuckets.get(bin);
    if (!b) { b = { factors: [], speeds: [], walk: 0, moving: 0 }; acc.gradeBuckets.set(bin, b); }
    const v = speed[i];
    if (v > STOP_SPEED) {
      b.moving++;
      b.speeds.push(v);
      if (v < WALK_SPEED) b.walk++;
      if (flatPace && v > MIN_RUN_SPEED && Math.abs(g) < 0.20) b.factors.push((1000 / v) / flatPace);
    }
    if (heartrate[i] != null && heartrate[i - 1] != null) acc.hrDiffs.push(heartrate[i] - heartrate[i - 1]);
    if (vSmooth[i] != null && speed[i] > STOP_SPEED) acc.speedResid.push(speed[i] - vSmooth[i]);
    if (cadence && cadence[i] != null && v > MIN_RUN_SPEED) {
      if (Math.abs(g) < 0.02) acc.cadFlat.push(cadence[i]);
      else if (g > 0.05) acc.cadClimb.push(cadence[i]);
    }
    if (heartrate[i] != null && heartrate[i] > acc.hrMaxSeen) acc.hrMaxSeen = heartrate[i];
  }

  // Pauses: speed under STOP_SPEED sustained >= 10 s
  let stopStart = -1;
  for (let i = 0; i <= n; i++) {
    const stopped = i < n && speed[i] < STOP_SPEED;
    if (stopped && stopStart < 0) stopStart = i;
    if (!stopped && stopStart >= 0) {
      const dur = time[i - 1] - time[stopStart];
      if (dur >= 10) { acc.stops++; acc.stopSecs.push(dur); acc.stoppedSec += dur; }
      stopStart = -1;
    }
  }
  acc.elapsedSec += time[n - 1] - time[0];
  acc.movingSec += n - (acc.stoppedSec || 0);
  acc.used++;
  return acc;
}

const round = (x, d = 2) => (x == null ? null : +x.toFixed(d));

export function finalize(acc) {
  const buckets = [...acc.gradeBuckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([g, b]) => ({
      grade: round(g, 3),
      paceFactor: round(median(b.factors), 3), // 1 = same pace as flat running
      medianSpeed: round(median(b.speeds)),
      walkFraction: round(b.moving ? b.walk / b.moving : null, 3),
      samples: b.moving,
    }))
    .filter((b) => b.samples >= 60);
  // Hiking onset: shallowest grade where at least a third of moving time is walking
  const onset = buckets.filter((b) => b.grade > 0.04 && b.walkFraction != null && b.walkFraction >= 0.33);
  const steep = buckets.filter((b) => b.grade >= 0.12 && b.medianSpeed != null);
  return {
    hrLag: {
      riseTauSec: round(median(acc.riseTaus), 0),
      fallTauSec: round(median(acc.fallTaus), 0),
      climbSamples: acc.riseTaus.length,
      descentSamples: acc.fallTaus.length,
    },
    paceVsGrade: buckets,
    hiking: {
      onsetGrade: onset.length ? onset[0].grade : null,
      steepMedianSpeed: round(median(steep.map((b) => b.medianSpeed))),
    },
    noise: { hrStepSigma: round(madSigma(acc.hrDiffs)), speedResidualSigma: round(madSigma(acc.speedResid), 3) },
    pauses: {
      stops: acc.stops,
      stopsPerHour: acc.elapsedSec ? round(acc.stops / (acc.elapsedSec / 3600)) : null,
      medianStopSec: round(median(acc.stopSecs), 0),
      stoppedFraction: acc.elapsedSec ? round(acc.stoppedSec / acc.elapsedSec, 3) : null,
    },
    cadence: { flat: round(median(acc.cadFlat), 0), climb: round(median(acc.cadClimb), 0) },
    hrMaxObserved: acc.hrMaxSeen || null,
  };
}
