// Adversarial tests for the numeric-grounding validator used by the pre-merge
// eval. Two classes, kept distinct on purpose:
//   CAUGHT   - fabrication patterns the validator must flag;
//   UNCAUGHT - patterns token matching structurally cannot catch. These tests
//     pin the known limits so nobody reads the eval as stronger than it is;
//     they are the documented gap list, reviewed on every gate run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ungroundedNumbers, numbersOf, stripCalendar, outsidePeriodDates } from './eval-grounding.test.js';

// A corpus as the eval builds it: data-section numbers + tool results,
// calendar-date numbers already excluded (see eval-grounding.test.js).
const CORPUS = [196, 48, 80, 294, 1430, 175, 16, 21, 478, 468, 553, 305, 12.4, 437, 6.8, 49, 57];

test('CAUGHT: fabricated weekly figure never retrieved', () => {
  const bad = ungroundedNumbers('Your best August week was 612 m of gain.', CORPUS);
  assert.deepEqual(bad, [612]);
});

test('CAUGHT: user-supplied figure cannot self-ground', () => {
  // Question: "Did I really run 612 m in one August week?" - the number came
  // from the user, not the data; agreeing with it must still fail.
  const bad = ungroundedNumbers('Yes, you ran 612 m that week.', CORPUS);
  assert.deepEqual(bad, [612]);
});

test('CAUGHT: plausible-sounding invented climbing speed', () => {
  const bad = ungroundedNumbers('Your climbing speed in August was 512 m/h.', CORPUS);
  assert.deepEqual(bad, [512]);
});

test('CAUGHT: mis-sum beyond rounding tolerance', () => {
  // True total of retrieved gains is 437+57 = 494; 520 is off by >1%.
  const bad = ungroundedNumbers('Those two sessions total 520 m of gain.', [437, 57, 494]);
  assert.deepEqual(bad, [520]);
});

test('CAUGHT: calendar dates are exempt but metrics are not', () => {
  const bad = ungroundedNumbers('On 2026-08-16 you climbed 999 m.', CORPUS);
  assert.deepEqual(bad, [999]);
});

test('UNCAUGHT (known limit): a real number attributed to the wrong period passes', () => {
  // 468 m is a real retrieved figure - but for a September week, not August.
  // Token matching cannot detect the swap; period attribution is guarded by
  // the separate period assertion, not by numeric grounding.
  const bad = ungroundedNumbers('Your best August week had 468 m of gain.', CORPUS);
  assert.deepEqual(bad, []);
});

test('UNCAUGHT (known limit): a real number with the wrong unit passes', () => {
  // 294 m is the biggest D+ week; quoted as a climbing speed it is nonsense,
  // but the token 294 is grounded.
  const bad = ungroundedNumbers('Your climbing speed is 294 m/h.', CORPUS);
  assert.deepEqual(bad, []);
});

test('UNCAUGHT (known limit): prescribed advice numbers in the closing blocks are exempt', () => {
  const reply = 'Your load is +21% vs usual, ease off.\n\nDo 37 minutes very easy tomorrow.';
  const bad = ungroundedNumbers(reply, CORPUS);
  assert.deepEqual(bad, []);
});

// --- demo cost guardrails (owner decision 2026-11-11) ---

test('demo per-IP limit is 20 questions per day, global 300/day kept', () => {
  const src = readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes('rateLimit(`demo:${ip}`, { limit: 20, windowMs: 86400_000 })'), 'per-IP 20/day');
  assert.ok(src.includes("rateLimit('demo:global', { limit: 300, windowMs: 86400_000 })"), 'global 300/day');
});

test('billing/credit failures pause the coach cleanly, never an error', () => {
  const src = readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes('COACH_PAUSED'), 'paused copy exists');
  assert.ok(/credit balance\|billing\|payment required/i.test(src), 'billing detection');
  assert.ok(src.includes("{ type: 'paused', text: COACH_PAUSED }"), 'SSE paused event');
  assert.ok(src.includes('json(res, 200, { paused: true, reply: COACH_PAUSED, model })'), 'JSON paused reply');
});

// --- hard eval cost cap: the stop lands BEFORE the expense ---

test('cost cap: no paid call starts when the measured worst case exceeds the cap', async () => {
  const { runCoachAgent } = await import('../lib/agent.js');
  let paidCalls = 0;
  const fakeClient = {
    messages: {
      countTokens: async () => ({ input_tokens: 50000 }), // measured, not assumed
      create: async () => { paidCalls++; throw new Error('must never be called'); },
    },
  };
  const ctx = { mode: 'demo', owner: false, athlete: {}, profile: {}, activities: [] };
  await assert.rejects(
    runCoachAgent({
      client: fakeClient, model: 'claude-sonnet-5-5', system: 's',
      messages: [{ role: 'user', content: 'q' }], ctx,
      costBudget: { spent: 1.90, capUsd: 2.0, priceIn: 2e-6, priceOut: 10e-6 },
    }),
    (e) => e.code === 'EVAL_COST_CAP',
  );
  assert.equal(paidCalls, 0, 'no paid call may start once the cap cannot fit its worst case');
});

test('zone labels are labels, not data claims; figures around them still checked', () => {
  // Regression for CI run #1 (2026-11-11): a correct "stayed in Z2" read from
  // the profile's zone table failed because any session dated on the 2nd of a
  // month evicts 2 from the corpus as a calendar number. Zone references are
  // labels like "Week 3"; the checkable claim is the HR figure next to them.
  const good = ungroundedNumbers('HR 147 average, so you stayed in Z2 for the average; 20.4 km in 2h17.', [147, 20.4, 137]);
  assert.deepEqual(good, []);
  const bad = ungroundedNumbers('HR 147 average (Z2), but you ran 21.1 km.', [147, 20.4, 137]);
  assert.deepEqual(bad, [21.1]);
  // A combined range label is also a label.
  const range = ungroundedNumbers('68.8% of time in Z1-Z2.', [68.8]);
  assert.deepEqual(range, []);
});

test('CAUGHT: invented current-volume comparison on a low-volume athlete', () => {
  // Pins the 2026-11-11 production miss: asked about a light August, the live
  // coach wrote "nowhere near your current 60-70 km/week" when no week in the
  // data reaches 60 km. Against a low-volume corpus, 60 and 70 must flag.
  const lowVolumeCorpus = [196, 48, 21.2, 509, 125, 7, 4.1, 3.6, 6.5, 38.3, 39.5, 56.0, 27.7, 3.4, 45];
  const bad = ungroundedNumbers('Running volume was very low. It was nowhere near your current 60-70 km/week.', lowVolumeCorpus);
  assert.deepEqual(bad, [60, 70]);
  const good = ungroundedNumbers('Running volume was very low next to your current 38.3 km week.', lowVolumeCorpus);
  assert.deepEqual(good, []);
});

test('UNCAUGHT: speculative causes are textual - only their numbers are gated', () => {
  // "or to eating less than 2 h before running": the checker can flag the 2
  // if ungrounded, but the speculation itself is wording, not a number. This
  // stays a documented gap; the prompt rule against inventing causes is the
  // mitigation, and human review of failures remains part of the gate.
  const bad = ungroundedNumbers('That points to lower fitness then, or to eating less than 2 h before running.', [158, 135]);
  assert.deepEqual(bad, [2]);
});

test('corpus building: calendar-collision no longer evicts a genuine figure', () => {
  // CI run 43013295670 (2026-11-11) failed a correctly quoted 'Load vs usual:
  // -5%' because the weekly-volume row for the week of 2026-10-05 put 5 into
  // the calendar set, and the corpus filter evicted VALUES, not occurrences.
  const dataSections = [
    '## Load and trends',
    'Load vs usual: -5% (-5% vs your usual: fine).',
    '',
    '## Weekly volume',
    '- 2026-10-05 | 3 sessions | 3.2 h | 270 m',
    '- 2026-09-03 | 4 sessions | 3.7 h | 324 m',
  ].join('\n');
  const corpus = numbersOf(stripCalendar(dataSections));
  assert.ok(corpus.includes(5), 'genuine -5% load figure must ground');
  assert.ok(corpus.includes(3.2) && corpus.includes(270), 'real row figures still ground');
  const good = ungroundedNumbers('Load vs usual is -5%, which is fine.', corpus);
  assert.deepEqual(good, []);
});

test('corpus building: date digits alone still cannot ground a fabrication', () => {
  // The point of the old filter: a '03' inside 2026-09-03 must not ground an
  // invented '3 sessions'. Occurrence-level stripping keeps that protection.
  const dataSections = '## Recent sessions\n- 2026-09-03 | Easy run | 8.2 km | 51 min';
  const corpus = numbersOf(stripCalendar(dataSections));
  assert.ok(!corpus.includes(3), 'day 03 of a date must not enter the corpus');
  const bad = ungroundedNumbers('You did 3 sessions that week, totalling 8.2 km.', corpus);
  assert.deepEqual(bad, [3]);
});

test('period assertion: closing advice may cite current data, analysis may not fold periods', () => {
  // CI run 43014738961 (2026-11-11): a correct thin-July answer failed because
  // its closing recommendation cited the athlete's actual last run
  // (2026-11-10, HR 154). Forward-looking advice grounded in current data is
  // not a claim about July - the assertion checks the analysis body only.
  const good = [
    'The data for July 2026 is thin: only 2026-07-28 and 2026-07-31 are recorded, 7.4 km in total.',
    '',
    'For your next session, keep HR under 149: your last run on 2026-11-10 averaged 154.',
  ].join('\n');
  assert.deepEqual(outsidePeriodDates(good, '2026-07'), []);
  // The defect class stays caught: August weeks folded into a July account.
  const bad = [
    'July had 4 sessions: 2026-07-28, 2026-07-31, and the stronger 2026-08-05 and 2026-08-12 weeks.',
    '',
    'Next session: keep it easy.',
  ].join('\n');
  assert.deepEqual(outsidePeriodDates(bad, '2026-07'), ['2026-08', '2026-08']);
  // Single-block replies are fully checked, advice or not.
  assert.deepEqual(outsidePeriodDates('July was thin; your run on 2026-11-10 averaged 154.', '2026-07'), ['2026-11']);
});
