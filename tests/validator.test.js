// Adversarial tests for the numeric-grounding validator used by the pre-merge
// eval. Two classes, kept distinct on purpose:
//   CAUGHT   - fabrication patterns the validator must flag;
//   UNCAUGHT - patterns token matching structurally cannot catch. These tests
//     pin the known limits so nobody reads the eval as stronger than it is;
//     they are the documented gap list, reviewed on every gate run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
