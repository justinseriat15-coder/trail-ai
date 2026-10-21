import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoachAgent, executeTool, stepLabel, TOOLS } from '../lib/agent.js';
import { buildSystemPrompt } from '../lib/coach.js';
import { loadAthlete } from '../lib/data.js';
import * as A from '../public/js/analytics.js';
import { demoActivities, demoStreams } from '../public/js/demo-data.js';
import { EVAL_QUESTIONS } from './eval-questions.mjs';

const NOW = new Date('2026-10-21T12:00:00Z');
const demoCtx = () => ({
  mode: 'demo',
  owner: false,
  athlete: { firstname: 'Demo athlete' },
  profile: { hrMax: 196, hrRest: 48 },
  activities: demoActivities(NOW),
});
const budget = () => ({ left: 6 });

// --- tool definitions ---

test('three tools with the agreed names', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['compute_stats', 'get_activity_details', 'list_activities']);
  for (const t of TOOLS) assert.ok(t.description && t.input_schema, `${t.name} fully specified`);
});

// --- list_activities on the deterministic demo dataset ---

test('list_activities filters by date window on demo data', async () => {
  const out = await executeTool(demoCtx(), 'list_activities', { after: '2026-10-10', before: '2026-10-14' }, budget());
  assert.ok(out.count >= 1);
  for (const a of out.activities) assert.ok(a.date >= '2026-10-10' && a.date <= '2026-10-14', a.date);
});

test('list_activities filters by type and returns a trimmed shape', async () => {
  const out = await executeTool(demoCtx(), 'list_activities', { type: 'TrailRun' }, budget());
  assert.ok(out.count >= 1);
  for (const a of out.activities) {
    assert.equal(a.type, 'TrailRun');
    assert.deepEqual(Object.keys(a).sort(), ['date', 'ef', 'gain', 'hr', 'id', 'km', 'min', 'name', 'pace', 'trimp', 'type']);
    for (const v of Object.values(a)) assert.ok(typeof v !== 'object', 'no nested raw Strava blobs');
  }
});

test('list_activities outside the dataset says so instead of inventing data', async () => {
  const out = await executeTool(demoCtx(), 'list_activities', { after: '2024-01-01', before: '2024-01-31' }, budget());
  assert.equal(out.activities.length, 0);
  assert.match(out.note, /No sessions/);
});

// --- get_activity_details ---

test('get_activity_details matches analytics on the same demo session', async () => {
  const ctx = demoCtx();
  const a = ctx.activities.find((x) => x.average_heartrate);
  const out = await executeTool(ctx, 'get_activity_details', { id: a.id }, budget());
  assert.equal(out.id, a.id);
  const expectDec = A.decoupling(demoStreams(a));
  assert.equal(out.decouplingPct, expectDec);
  assert.equal(out.zones.length, 5);
  assert.ok(Math.abs(out.zones.reduce((s, z) => s + z.pct, 0) - 100) <= 1);
});

test('get_activity_details rejects an unknown demo id', async () => {
  const out = await executeTool(demoCtx(), 'get_activity_details', { id: 999999 }, budget());
  assert.match(out.error, /No session/);
});

// --- compute_stats ---

test('compute_stats acwr equals the shared analytics series', async () => {
  const ctx = demoCtx();
  const out = await executeTool(ctx, 'compute_stats', { metric: 'acwr', days: 28 }, budget());
  const expected = A.acwrSeries(ctx.activities, 196, 48, 28);
  assert.deepEqual(out.series, expected);
});

test('compute_stats weekly_volume window and unknown metric', async () => {
  const ctx = demoCtx();
  const out = await executeTool(ctx, 'compute_stats', { metric: 'weekly_volume', days: 56 }, budget());
  assert.equal(out.weeks.length, 8);
  const bad = await executeTool(ctx, 'compute_stats', { metric: 'vo2max' }, budget());
  assert.match(bad.error, /Unknown metric/);
});

// --- the loop ---

const mockClient = (script) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return script[Math.min(calls.length - 1, script.length - 1)](req);
      },
    },
  };
};
const toolUse = (name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
});
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

test('one round trip: tool result goes back and the answer comes out', async () => {
  const client = mockClient([
    () => toolUse('compute_stats', { metric: 'acwr', days: 28 }),
    () => text('Your ACWR is 1.08, in the optimal zone.'),
  ]);
  const labels = [];
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'How is my load trending?' }],
    onStep: (l) => labels.push(l),
  });
  assert.equal(out.reply, 'Your ACWR is 1.08, in the optimal zone.');
  assert.equal(out.calls, 2);
  assert.deepEqual(labels, ['Computing ACWR series over 28 days…']);
  // assistant turn went back verbatim, then one user message with the tool result
  const convo = client.calls[1].messages;
  assert.equal(convo.at(-2).role, 'assistant');
  assert.equal(convo.at(-1).role, 'user');
  assert.equal(convo.at(-1).content[0].type, 'tool_result');
  const payload = JSON.parse(convo.at(-1).content[0].content);
  assert.ok(Array.isArray(payload.series));
  // second cache breakpoint on the latest tool result
  assert.deepEqual(convo.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
});

test('the 8-call cap: a model that never stops is cut off, final call has no tools', async () => {
  const client = mockClient([() => toolUse('compute_stats', { metric: 'summary' })]);
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'Loop forever please' }],
  });
  assert.equal(out.calls, 8);
  assert.equal(client.calls.length, 8);
  for (const c of client.calls.slice(0, 7)) assert.ok(c.tools, 'tools offered before the final call');
  assert.equal(client.calls[7].tools, undefined, 'final call is made without tools');
});

test('a direct answer uses no tool and costs one call', async () => {
  const client = mockClient([() => text('Solid week: 46 km, ACWR in the zone.')]);
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'How was this week?' }],
  });
  assert.equal(out.calls, 1);
  assert.equal(out.steps.length, 0);
});

test('streamed replies: text deltas reach onText and the final reply is whole', async () => {
  const finalMsg = text('Hello world, keep it easy.');
  const client = {
    messages: {
      stream: (req) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world, keep it easy.' } };
          yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } };
        },
        finalMessage: async () => finalMsg,
      }),
      create: async () => { throw new Error('create should not be used when streaming'); },
    },
  };
  const deltas = [];
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'How was this week?' }],
    onText: (t) => deltas.push(t),
  });
  assert.deepEqual(deltas, ['Hello ', 'world, keep it easy.']); // thinking deltas never surface
  assert.equal(out.reply, 'Hello world, keep it easy.');
});

// --- step labels come from the tool_use block, not model text ---

test('step labels are built from tool name + inputs', () => {
  const ctx = demoCtx();
  const one = ctx.activities[0];
  assert.equal(
    stepLabel({ name: 'list_activities', input: { after: '2026-09-01', type: 'Run' } }, ctx),
    'Fetching activities (2026-09-01 → today), Run only…');
  assert.equal(
    stepLabel({ name: 'get_activity_details', input: { id: one.id } }, ctx),
    `Analysing "${one.name}" (${String(one.start_date_local).slice(0, 10)}) second by second…`);
  assert.equal(
    stepLabel({ name: 'compute_stats', input: { metric: 'ef_trend' } }, ctx),
    'Computing efficiency trend over 56 days…');
});

// --- prompt guarantees ---

test('system prompt advertises the tools and states the coverage boundary', () => {
  const p = buildSystemPrompt(demoCtx());
  for (const t of ['list_activities', 'get_activity_details', 'compute_stats']) assert.ok(p.includes(t), t);
  assert.match(p, /Never assume data you have not retrieved/);
});

test('ATHLETE_CONTEXT never reaches the prompt in demo or for non-owners', () => {
  process.env.ATHLETE_CONTEXT = 'SECRET-INJURY-HISTORY';
  const demo = buildSystemPrompt(demoCtx());
  assert.ok(!demo.includes('SECRET-INJURY-HISTORY'));
  const nonOwner = buildSystemPrompt({ ...demoCtx(), mode: 'live', owner: false });
  assert.ok(!nonOwner.includes('SECRET-INJURY-HISTORY'));
  const owner = buildSystemPrompt({ ...demoCtx(), mode: 'live', owner: true });
  assert.ok(owner.includes('SECRET-INJURY-HISTORY'));
  delete process.env.ATHLETE_CONTEXT;
});

// --- eval set shape (the runner itself needs a real API key) ---

test('eval set: 10 questions, each expecting fetch or direct', () => {
  assert.equal(EVAL_QUESTIONS.length, 10);
  for (const e of EVAL_QUESTIONS) {
    assert.ok(e.q.length > 10);
    assert.ok(['fetch', 'direct'].includes(e.expect), e.q);
  }
});
