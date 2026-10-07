import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../public/js/analytics.js';
import { demoActivities, demoStreams } from '../public/js/demo-data.js';

const NOW = new Date('2026-10-07T12:00:00');

test('pace formatting', () => {
  assert.equal(A.paceStr(1000 / 372), '6:12');
  assert.equal(A.paceStr(1000 / 359.8), '6:00'); // rounding never yields "5:60"
  assert.equal(A.paceStr(0), '—');
});

test('zones are contiguous and end at HRmax', () => {
  const z = A.zoneBounds(200);
  assert.equal(z.length, 5);
  for (let i = 1; i < 5; i++) assert.equal(z[i].min, z[i - 1].max + 1);
  assert.equal(z[4].max, 200);
  assert.equal(A.zoneOf(147, 200), 2);
});

test('TRIMP grows with intensity at equal duration', () => {
  const easy = A.trimp({ average_heartrate: 140, moving_time: 3600 }, 200, 50);
  const hard = A.trimp({ average_heartrate: 170, moving_time: 3600 }, 200, 50);
  assert.ok(hard > easy * 1.5);
  assert.equal(A.trimp({ moving_time: 3600 }, 200, 50), null);
});

test('ACWR ≈ 1 for a perfectly steady load', () => {
  const acts = [];
  for (let d = 0; d < 60; d += 2) {
    const t = new Date(NOW); t.setDate(t.getDate() - d);
    acts.push({ type: 'Run', start_date_local: t.toISOString(), moving_time: 3600, average_heartrate: 145, distance: 10000 });
  }
  const last = A.acwrSeries(acts, 200, 50, 14, NOW).at(-1);
  assert.ok(Math.abs(last.ratio - 1) < 0.2, `ratio ${last.ratio}`);
  assert.equal(A.acwrStatus(last.ratio).level, 'good');
  assert.equal(A.acwrStatus(1.7).level, 'critical');
});

test('EF only counts flat, aerobic, ≥ 20 min runs', () => {
  const base = { type: 'Run', average_heartrate: 145, moving_time: 3000, distance: 8000 };
  assert.ok(A.isComparableEasyRun({ ...base, total_elevation_gain: 40 }, 200));
  assert.ok(!A.isComparableEasyRun({ ...base, total_elevation_gain: 400 }, 200)); // hilly
  assert.ok(!A.isComparableEasyRun({ ...base, moving_time: 900 }, 200));          // too short
  assert.ok(!A.isComparableEasyRun({ ...base, average_heartrate: 175 }, 200));    // not aerobic
});

test('demo athlete shows aerobic progression', () => {
  const acts = demoActivities(NOW);
  assert.ok(acts.length > 40);
  const chg = A.efChange(A.efTrend(acts, 196));
  assert.ok(chg > 3, `EF change ${chg}`);
});

test('decoupling detects cardiac drift', () => {
  const n = 720, time = [], hr = [], v = [];
  for (let i = 0; i < n; i++) { time.push(i * 5); v.push(2.7); hr.push(140 + 14 * (i / n)); } // +10 % HR drift
  const d = A.decoupling({ time, heartrate: hr, velocity_smooth: v });
  assert.ok(d > 3 && d < 8, `decoupling ${d}`);
  const flat = A.decoupling({ time, heartrate: hr.map(() => 145), velocity_smooth: v });
  assert.equal(flat, 0);
});

test('time in zones sums to ~100 %', () => {
  const a = demoActivities(NOW)[0];
  const z = A.timeInZones(demoStreams(a), 196);
  const total = z.reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(total - 100) < 0.5);
});

test('Strava local dates are not shifted by timezone', () => {
  assert.equal(A.parseLocal('2026-10-07T07:30:00Z').getHours(), 7);
});
