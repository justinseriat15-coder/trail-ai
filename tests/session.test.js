import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
const { seal, unseal } = await import('../lib/session.js');

test('session round-trips', () => {
  const s = { access_token: 'a', refresh_token: 'r', expires_at: 1, athlete: { id: 7 } };
  assert.deepEqual(unseal(seal(s)), s);
});

test('session is opaque (tokens not readable)', () => {
  assert.ok(!seal({ refresh_token: 'SUPERSECRET' }).includes('SUPERSECRET'));
});

test('tampered session is rejected', () => {
  const t = seal({ a: 1 });
  const bad = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
  assert.equal(unseal(bad), null);
});

test('session sealed with another key is rejected', () => {
  const t = seal({ a: 1 });
  process.env.SESSION_SECRET = 'another-secret-'.padEnd(40, 'y');
  assert.equal(unseal(t), null);
});
