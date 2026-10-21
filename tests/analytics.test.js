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

test('ACWR readings match the load zones', () => {
  assert.match(A.acwrReading(null), /Not enough history/);
  assert.match(A.acwrReading(0.7), /deload/);
  assert.match(A.acwrReading(1.08), /zone to train in/);
  assert.match(A.acwrReading(1.4), /Hold volume steady/);
  assert.match(A.acwrReading(1.6), /Ease off/);
});

test('decoupling readings match the thresholds', () => {
  assert.match(A.decouplingReading(null), /Not enough/);
  assert.match(A.decouplingReading(3.1), /Excellent/);
  assert.match(A.decouplingReading(4.2), /Good/);
  assert.match(A.decouplingReading(6), /Noticeable/);
  assert.match(A.decouplingReading(9), /Strong/);
});

test('every dashboard metric has a plain-language explanation', () => {
  for (const k of ['week', 'load', 'easy', 'climb', 'engine', 'race', 'decoupling', 'zones']) {
    assert.ok(A.METRIC_INFO[k]?.what?.length > 20, `${k} what`);
    assert.ok(A.METRIC_INFO[k]?.meaning?.length > 20, `${k} meaning`);
  }
});

// ---------- Phase 2: the five-question model ----------

test('loadVsUsual: steady training reads ~0%, a spike reads high', () => {
  const mk = (d, trimpLike = 1) => {
    const t = new Date(NOW); t.setDate(t.getDate() - d);
    return { type: 'Run', start_date_local: t.toISOString(), moving_time: 3600 * trimpLike, average_heartrate: 145, distance: 10000 };
  };
  const steady = [];
  for (let d = 0; d < 35; d++) steady.push(mk(d));
  const lv = A.loadVsUsual(steady, 200, 50, NOW);
  assert.equal(lv.deltaPct, 0);
  const spiky = steady.map((a, i) => (i < 7 ? { ...a, moving_time: a.moving_time * 2 } : a));
  assert.equal(A.loadVsUsual(spiky, 200, 50, NOW).deltaPct, 100);
  assert.equal(A.loadVsUsual([], 200, 50, NOW).deltaPct, null);
});

test('loadReading: bands map to the right tone', () => {
  assert.equal(A.loadReading(null).level, 'neutral');
  assert.equal(A.loadReading(9).level, 'good');
  assert.equal(A.loadReading(20).level, 'warning');
  assert.equal(A.loadReading(35).level, 'serious');
  assert.equal(A.loadReading(60).level, 'serious');
  assert.equal(A.loadReading(-20).level, 'good');
});

test('easyShare: aggregates zone seconds and reports coverage honestly', () => {
  const mk = (d, zoneSecs) => {
    const t = new Date(NOW); t.setDate(t.getDate() - d);
    return { type: 'Run', start_date_local: t.toISOString(), zoneSecs };
  };
  const acts = [
    mk(1, [1800, 600, 300, 0, 0]),   // 89% easy
    mk(3, [600, 0, 0, 600, 0]),      // 50% easy
    mk(10, null),                    // no HR: counted as session, not covered
    mk(20, [2400, 0, 0, 0, 0]),      // 100% easy
  ];
  const es = A.easyShare(acts, NOW);
  assert.equal(es.d7.sessions, 2);
  assert.equal(es.d7.covered, 2);
  assert.equal(es.d7.pct, 77); // (2400+600) / (2700+1200)
  assert.equal(es.d28.sessions, 4);
  assert.equal(es.d28.covered, 3);
  assert.equal(A.easyShare([mk(1, null)], NOW).d7.pct, null);
});

test('climbSegments: finds a sustained 200 m climb, rejects short rollers', () => {
  const time = [], distance = [], altitude = [];
  for (let t = 0; t < 4000; t++) {
    time.push(t); distance.push(t);
    altitude.push(t < 1000 ? 100 : t < 3000 ? 100 + ((t - 1000) / 2000) * 200 : 300);
  }
  const segs = A.climbSegments({ time, distance, altitude });
  assert.equal(segs.length, 1);
  assert.ok(segs[0].gain >= 180 && segs[0].gain <= 210, `gain ${segs[0].gain}`);
  assert.ok(segs[0].vertMph >= 300 && segs[0].vertMph <= 420, `vert ${segs[0].vertMph}`);
  assert.ok(segs[0].endKm > segs[0].startKm);
  // 30 m bumps never qualify
  const rollAlt = altitude.map((a, i) => a + (i % 100 < 50 ? 30 : 0));
  const flatRollers = { time: time.slice(0, 600), distance: distance.slice(0, 600), altitude: rollAlt.slice(0, 600).map((_, i) => (i % 100 < 50 ? 30 : 0)) };
  assert.equal(A.climbSegments(flatRollers).length, 0);
  assert.equal(A.climbSegments(null).length, 0);
});

test('climbingSpeed: null without enough climbing', () => {
  assert.equal(A.climbingSpeed([]), null);
  assert.equal(A.climbingSpeed([{ gain: 60, seconds: 100 }]), null); // < 5 min
  assert.equal(A.climbingSpeed([{ gain: 200, seconds: 2000 }]), 360);
});

test('aerobicEngine: pace at easy HR from flat easy runs only', () => {
  const mk = (d, speed = 10000 / 3000) => {
    const t = new Date(NOW); t.setDate(t.getDate() - d);
    return { id: d, type: 'Run', start_date_local: t.toISOString(), distance: 10000, moving_time: 10000 / speed, average_speed: speed, average_heartrate: 130, total_elevation_gain: 100 };
  };
  const runs = [];
  for (let d = 0; d < 40; d += 3) runs.push(mk(d));
  const eng = A.aerobicEngine(runs, 196);
  assert.equal(eng.refHr, 145);
  assert.ok(eng.points.length >= 10);
  assert.ok(eng.latestSecPerKm > 0);
  assert.ok(Math.abs(eng.changePct) < 2, `constant speed should read steady, got ${eng.changePct}`);
  // faster later runs -> engine improving
  const improving = runs.map((a) => ({ ...a, average_speed: a.average_speed * (a.id < 20 ? 1.15 : 1) }));
  assert.ok(A.aerobicEngine(improving, 196).changePct > 3);
  assert.equal(A.aerobicEngine([], 196).latestSecPerKm, null);
});

test('todayVerdict: load drives the decision, deterministically', () => {
  assert.deepEqual(
    (({ decision, tone }) => ({ decision, tone }))(A.todayVerdict({ deltaPct: 50, engineChangePct: 5, easySharePct: 80, hoursAgo: 48 })),
    { decision: 'Rest', tone: 'serious' });
  assert.deepEqual(
    (({ decision, tone }) => ({ decision, tone }))(A.todayVerdict({ deltaPct: 35, engineChangePct: 5, easySharePct: 80, hoursAgo: 48 })),
    { decision: 'Easy day', tone: 'warning' });
  assert.deepEqual(
    (({ decision, tone }) => ({ decision, tone }))(A.todayVerdict({ deltaPct: null, engineChangePct: null, easySharePct: null, hoursAgo: null })),
    { decision: 'Easy day', tone: 'neutral' });
  const ok = A.todayVerdict({ deltaPct: 5, engineChangePct: 6, easySharePct: 82, hoursAgo: 40 });
  assert.equal(ok.decision, 'Train');
  assert.equal(ok.tone, 'good');
  assert.ok(ok.numbers.length >= 2);
  const stale = A.todayVerdict({ deltaPct: 5, engineChangePct: -5, easySharePct: 80, hoursAgo: 40 });
  assert.equal(stale.decision, 'Easy day'); // engine slipping overrides a fine load
});

test('sessionReading: a climb day reads as a climb day', () => {
  const a = { name: 'Summit', total_elevation_gain: 900, distance: 15000, average_heartrate: 150 };
  const txt = A.sessionReading(a, { zones: [1800, 1200, 600, 0, 0], climbs: [{ gain: 400, seconds: 2000 }, { gain: 300, seconds: 1500 }], dec: null, flat: false, hrMax: 196 });
  assert.match(txt, /climb day/);
  assert.match(txt, /900 m/);
  const flatRun = { name: 'Easy', total_elevation_gain: 80, distance: 10000, average_heartrate: 130 };
  assert.match(A.sessionReading(flatRun, { zones: null, climbs: [], dec: 3.2, flat: true, hrMax: 196 }), /durable/);
  assert.match(A.sessionReading(flatRun, { zones: null, climbs: [], dec: 8, flat: true, hrMax: 196 }), /still costs you/);
});

test('sparkPoints: normalized 0-1 elevation samples', () => {
  const pts = A.sparkPoints({ altitude: Array.from({ length: 24 }, (_, i) => i * 10) }, 24);
  assert.equal(pts.length, 24);
  assert.equal(pts[0], 0);
  assert.equal(pts[23], 1);
  assert.equal(A.sparkPoints({ altitude: [5] }), null);
});

test('demo streams stay honest: stream ascent matches activity D+', () => {
  const acts = demoActivities().filter((a) => a.sport === 'run').slice(0, 8);
  for (const a of acts) {
    const s = demoStreams(a);
    const segs = A.climbSegments(s);
    // generated stream ascent must match the declared elevation gain closely
    const alt = s.altitude;
    let ascent = 0;
    for (let i = 1; i < alt.length; i++) if (alt[i] > alt[i - 1]) ascent += alt[i] - alt[i - 1];
    assert.ok(Math.abs(ascent - a.total_elevation_gain) <= 3, `${a.name}: stream ascent ${ascent} vs D+ ${a.total_elevation_gain}`);
    if (a.total_elevation_gain >= 400) assert.ok(segs.length >= 1, `${a.name}: expected sustained climbs`);
    if (a.total_elevation_gain <= 120) assert.equal(segs.length, 0, `${a.name}: easy flat run should have no climbs`);
  }
});

// ---------- Rollout fixes from Justin's design review (21 Oct) ----------

test('todayVerdict: an easy day justifies itself with load + easy share', () => {
  const v = A.todayVerdict({ deltaPct: 33, engineChangePct: 8, easySharePct: 60, hoursAgo: 30 });
  assert.equal(v.decision, 'Easy day');
  assert.deepEqual(v.numbers.map((n) => n[1]), ['load vs usual', 'easy share']);
  const t = A.todayVerdict({ deltaPct: 5, engineChangePct: 6, easySharePct: 82, hoursAgo: 40 });
  assert.deepEqual(t.numbers.map((n) => n[1]), ['load vs usual', 'aerobic engine']);
  const noHist = A.todayVerdict({ deltaPct: null, engineChangePct: null, easySharePct: null, hoursAgo: null });
  assert.equal(noHist.numbers.length, 0);
});

test('climbTrend: rolling median shrugs off one-off weeks, first 4 vs last 4', () => {
  const weeks = [600, 610, 590, 605, 900, 615, 700, 720, 710, 730, 725, 735]
    .map((v, i) => ({ week: `2026-07-${String(6 + i * 7).padStart(2, '0')}`, vertMph: v }));
  const ct = A.climbTrend(weeks);
  const spikeIdx = 4;
  assert.ok(ct.points[spikeIdx].rolling < 700, `median at spike week ${ct.points[spikeIdx].rolling}`);
  assert.ok(ct.changePct > 10, `changePct ${ct.changePct}`);
  assert.equal(A.climbTrend(weeks.slice(0, 4)).changePct, null);
});

test('demo streams: distance matches the declared distance exactly', () => {
  const acts = demoActivities().filter((a) => a.sport === 'run').slice(0, 10);
  for (const a of acts) {
    const s = demoStreams(a);
    assert.equal(s.distance.at(-1), a.distance, `${a.name}: stream ends at ${s.distance.at(-1)} vs declared ${a.distance}`);
  }
});

test('demo streams: an out-and-back has one summit, a loop comes home low', () => {
  const acts = demoActivities();
  const ob = acts.find((a) => /out-and-back/i.test(a.name));
  const s = demoStreams(ob);
  const peakIdx = s.altitude.indexOf(Math.max(...s.altitude));
  assert.ok(peakIdx / s.altitude.length > 0.4 && peakIdx / s.altitude.length < 0.7, 'summit near the middle');
  const segs = A.climbSegments(s);
  assert.ok(segs.length <= 2, `out-and-back should read as one main climb, got ${segs.length}`);
  const loop = acts.find((a) => /loop/i.test(a.name) && a.total_elevation_gain > 200);
  if (loop) {
    const sl = demoStreams(loop);
    assert.ok(sl.altitude.at(-1) - sl.altitude[0] < 150, `loop ends ${sl.altitude.at(-1) - sl.altitude[0]} m above start`);
  }
});

test('demo streams: HR rises into a climb over ~1-2 min, never instantly', () => {
  const acts = demoActivities();
  const ob = acts.find((a) => /out-and-back/i.test(a.name));
  const s = demoStreams(ob);
  // find the steepest sustained ramp and check HR does not jump >8 bpm in 30 s on it
  let worst = 0;
  for (let i = 6; i < s.heartrate.length; i++) {
    const gain = s.altitude[i] - s.altitude[i - 6];
    if (gain > 12) worst = Math.max(worst, s.heartrate[i] - s.heartrate[i - 6]);
  }
  assert.ok(worst <= 10, `HR jumped ${worst} bpm in 30 s on a ramp`);
});

// ---------- Race readiness ----------

test('race readiness: empty history gives no gauge', () => {
  const r = A.raceReadiness([], { now: NOW });
  assert.equal(r.overall, null);
  assert.match(r.sentence, /Not enough/);
});

test('race readiness: a fully prepared athlete hits 100', () => {
  const acts = [];
  for (let w = 0; w < 12; w++) {
    const t = new Date(NOW); t.setDate(t.getDate() - w * 7);
    acts.push({ type: 'Run', start_date_local: t.toISOString(), moving_time: 20000, distance: 55000, total_elevation_gain: 2600, average_heartrate: 150 });
  }
  const r = A.raceReadiness(acts, { climbNow: 600, now: NOW });
  assert.equal(r.parts.distance.pct, 100);
  assert.equal(r.parts.vertWeek.pct, 100);
  assert.equal(r.parts.climb.pct, 100);
  assert.equal(r.overall, 100);
  assert.match(r.sentence, /All three boxes ticked/);
});

test('race readiness: shortest long run is named as the gap', () => {
  const acts = [];
  for (let w = 0; w < 12; w++) {
    const t = new Date(NOW); t.setDate(t.getDate() - w * 7);
    acts.push({ type: 'Run', start_date_local: t.toISOString(), moving_time: 3600, distance: 10000, total_elevation_gain: 2600, average_heartrate: 145 });
  }
  const r = A.raceReadiness(acts, { climbNow: 600, now: NOW });
  assert.equal(r.parts.distance.pct, 20); // 10 km of 50 km
  assert.match(r.sentence, /long run is the gap/);
});

test('race demand: 2,500 m inside 50 km at 8 km/h is 400 m/h', () => {
  assert.equal(A.raceDemandMph(), 400);
});

test('race readiness works on the demo dataset', () => {
  const r = A.raceReadiness(demoActivities(), { climbNow: 726, now: new Date('2026-10-20T12:00:00') });
  assert.ok(r.overall > 0 && r.overall < 100, `overall ${r.overall}`);
  assert.ok(r.parts.distance.have > 15, `longest ${r.parts.distance.have}`);
  assert.match(r.sentence, /gap/);
});

// ---------- Climbing-speed guard ----------
test('climb trend: fewer than 4 climbing weeks gives no line and no number', () => {
  const weeks = Array.from({ length: 12 }, (_, i) => ({ week: `2026-08-${String(i + 1).padStart(2, '0')}`, vertMph: i === 3 ? 600 : i === 5 ? 650 : null }));
  const t = A.climbTrend(weeks);
  assert.equal(t.enough, false);
  assert.equal(t.weeksWithData, 2);
  assert.ok(t.points.every((p) => p.rolling == null));
  assert.equal(A.climbNowOf(t), null);
});

test('climb trend: rolling line stops at the last real week', () => {
  const weeks = Array.from({ length: 12 }, (_, i) => ({ week: `w${i}`, vertMph: i < 6 ? 500 + i * 10 : null }));
  const t = A.climbTrend(weeks);
  assert.equal(t.enough, true);
  assert.ok(t.points.slice(6).every((p) => p.rolling == null));
  assert.ok(t.points[5].rolling != null);
  assert.equal(A.climbNowOf(t), t.points[5].rolling);
});

// ---------- Easy-share colour rule ----------
test('easy share: two levels only, green at 80%+ and ochre below', () => {
  assert.equal(A.easyShareLevel(null), 'neutral');
  for (const p of [100, 90, 80]) assert.equal(A.easyShareLevel(p), 'good');
  for (const p of [79, 71, 68, 66, 40]) assert.equal(A.easyShareLevel(p), 'warning');
  for (const p of [90, 80, 79, 71, 66, 40]) assert.equal(A.easyShareReading(p).level, A.easyShareLevel(p));
});
