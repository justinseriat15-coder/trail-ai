import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccumulator, addStreams, finalize, rollingMean, findSegments } from '../lib/calibration.js';

// Synthetic stream builder: n seconds at 1 Hz.
function streams({ n = 1200, gradeFn = () => 0, speedFn = () => 3.3, hrFn = () => 140, cadenceFn = () => 168 }) {
  const time = [], heartrate = [], altitude = [], velocity_smooth = [], grade_smooth = [], cadence = [];
  let alt = 100;
  for (let i = 0; i < n; i++) {
    const g = gradeFn(i), v = speedFn(i);
    time.push(i);
    altitude.push(alt += g * v);
    velocity_smooth.push(v);
    grade_smooth.push(g);
    heartrate.push(hrFn(i));
    cadence.push(cadenceFn(i));
  }
  return { time, heartrate, altitude, velocity_smooth, grade_smooth, cadence };
}

test('rollingMean trails by the window and tolerates nulls', () => {
  const m = rollingMean([1, 2, 3, 4, null, 6], 3);
  assert.equal(m[2], 2);
  assert.equal(Math.round(m[5] * 10) / 10, Math.round(((4 + 6) / 2) * 10) / 10);
});

test('findSegments detects a sustained climb entered from flat ground', () => {
  const g = Array(600).fill(0).concat(Array(300).fill(0.06), Array(300).fill(0));
  const sm = rollingMean(g, 30);
  const segs = findSegments(sm, 0.03, 120, 1);
  assert.equal(segs.length, 1);
  assert.ok(Math.abs(segs[0].start - 628) < 35); // 30 s smoothing delays detection
});

test('HR rise time-constant is recovered from a synthetic climb', () => {
  const TAU = 110;
  // 10 min flat, then 8 min at 6% grade; HR follows a first-order response
  const hr = (i) => {
    const flat = 135, target = 172;
    if (i < 600 + 28) return flat; // segment detected ~28 s after grade changes
    return target - (target - flat) * Math.exp(-(i - 628) / TAU);
  };
  const s = streams({ n: 1200, gradeFn: (i) => (i >= 600 ? 0.06 : 0), hrFn: hr, speedFn: (i) => (i >= 600 ? 2.8 : 3.3) });
  const acc = addStreams(createAccumulator(), s);
  const out = finalize(acc);
  assert.ok(out.hrLag.riseTauSec !== null, 'a tau was estimated');
  assert.ok(Math.abs(out.hrLag.riseTauSec - TAU) <= 25, `tau ${out.hrLag.riseTauSec} within 25 s of ${TAU}`);
  assert.equal(out.hrLag.climbSamples, 1);
});

test('pace-vs-grade factors are relative to flat pace', () => {
  // flat 3.3 m/s, climbs at 2.475 m/s => factor 3.3/2.475 = 1.333
  const s = streams({ n: 1200, gradeFn: (i) => (i >= 600 ? 0.075 : 0), speedFn: (i) => (i >= 600 ? 2.475 : 3.3) });
  const out = finalize(addStreams(createAccumulator(), s));
  const up = out.paceVsGrade.find((b) => b.grade === 0.075);
  assert.ok(up, 'uphill bucket exists');
  assert.ok(Math.abs(up.paceFactor - 1.333) < 0.08, `factor ${up.paceFactor}`);
});

test('hiking shows as walking fraction on steep grades', () => {
  const s = streams({ n: 1200, gradeFn: (i) => (i >= 600 ? 0.15 : 0), speedFn: (i) => (i >= 600 ? 1.3 : 3.3) });
  const out = finalize(addStreams(createAccumulator(), s));
  const steep = out.paceVsGrade.find((b) => b.grade === 0.15);
  assert.ok(steep.walkFraction > 0.9, `walk fraction ${steep.walkFraction}`);
  assert.ok(out.hiking.onsetGrade <= 0.15);
});

test('pauses are counted with duration', () => {
  const speedFn = (i) => (i >= 300 && i < 345) || (i >= 700 && i < 720) ? 0.1 : 3.3; // 45 s and 20 s stops
  const s = streams({ n: 1200, speedFn });
  const out = finalize(addStreams(createAccumulator(), s));
  assert.equal(out.pauses.stops, 2);
  assert.ok(Math.abs(out.pauses.medianStopSec - 32.5) <= 1);
});

test('short or broken streams are skipped, not crashed on', () => {
  const acc = createAccumulator();
  addStreams(acc, { time: [1, 2, 3] });
  addStreams(acc, streams({}));
  assert.equal(acc.used, 1);
  assert.equal(acc.skipped, 1);
});
