// Adversarial tests for the numeric-grounding validator used by the pre-merge
// eval. Two classes, kept distinct on purpose:
//   CAUGHT   - fabrication patterns the validator must flag;
//   UNCAUGHT - patterns token matching structurally cannot catch. These tests
//     pin the known limits so nobody reads the eval as stronger than it is;
//     they are the documented gap list, reviewed on every gate run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ungroundedNumbers } from './eval-grounding.test.js';

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
