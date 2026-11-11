import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoachAgent, executeTool, stepLabel, TOOLS } from '../lib/agent.js';
import { buildSystemPrompt } from '../lib/coach.js';
import { loadAthlete, envRace } from '../lib/data.js';
import * as A from '../public/js/analytics.js';
const { DEMO_RACE } = A;
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
    assert.deepEqual(Object.keys(a).sort(), ['date', 'gain', 'hr', 'id', 'km', 'min', 'name', 'pace', 'type']);
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

test('compute_stats engine_trend matches the shared analytics function', async () => {
  const ctx = demoCtx();
  const out = await executeTool(ctx, 'compute_stats', { metric: 'engine_trend', days: 28 }, budget());
  const expected = A.aerobicEngine(ctx.activities, 196);
  assert.deepEqual(out.points, expected.points);
  assert.equal(out.changePct, expected.changePct);
});

test('compute_stats summary speaks the new model', async () => {
  const ctx = demoCtx();
  const out = await executeTool(ctx, 'compute_stats', { metric: 'summary' }, budget());
  assert.ok(out.load && typeof out.load.deltaPct === 'number');
  assert.ok(out.engine && 'latestSecPerKm' in out.engine);
  assert.ok(!('acwr' in out) && !('efChangePct' in out) && !JSON.stringify(out).includes('trimp'));
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
    () => toolUse('compute_stats', { metric: 'summary', days: 28 }),
    () => text('Your load is 33% above your usual - cut the week back.'),
  ]);
  const labels = [];
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'How is my load trending?' }],
    onStep: (l) => labels.push(l),
  });
  assert.equal(out.reply, 'Your load is 33% above your usual - cut the week back.');
  assert.equal(out.calls, 2);
  assert.deepEqual(labels, ['Computing training summary over 28 days…']);
  // assistant turn went back verbatim, then one user message with the tool result
  const convo = client.calls[1].messages;
  assert.equal(convo.at(-2).role, 'assistant');
  assert.equal(convo.at(-1).role, 'user');
  assert.equal(convo.at(-1).content[0].type, 'tool_result');
  const payload = JSON.parse(convo.at(-1).content[0].content);
  assert.ok(typeof payload.load?.deltaPct === 'number' && Array.isArray(payload.weeks));
  // second cache breakpoint on the latest tool result
  assert.deepEqual(convo.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
});

test('the 8-call cap: a model that never stops is cut off, final call has no tools', async () => {
  const calls = [];
  const client = { calls, messages: { create: async (req) => {
    calls.push(req);
    return calls.length < 8 ? toolUse('compute_stats', { metric: 'summary' }) : text('Forced answer without tools.');
  } } };
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'Loop forever please' }],
  });
  assert.equal(out.calls, 8);
  assert.equal(calls.length, 8);
  for (const c of calls.slice(0, 7)) assert.ok(c.tools, 'tools offered before the final call');
  assert.equal(calls[7].tools, undefined, 'final call is made without tools');
  assert.equal(out.reply, 'Forced answer without tools.');
});

test('a model that still calls a tool on the forced final call errors instead of an empty reply', async () => {
  const client = mockClient([() => toolUse('compute_stats', { metric: 'summary' })]);
  await assert.rejects(
    runCoachAgent({ client, model: 'm', system: 's', ctx: demoCtx(), messages: [{ role: 'user', content: 'Loop forever please' }] }),
    /empty reply/);
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
    stepLabel({ name: 'compute_stats', input: { metric: 'climb_trend' } }, ctx),
    'Computing climbing-speed trend over 56 days…');
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
  assert.equal(EVAL_QUESTIONS.length, 11);
  for (const e of EVAL_QUESTIONS) {
    assert.ok(e.q.length > 10);
    assert.ok(['fetch', 'direct'].includes(e.expect), e.q);
  }
});

// --- race readiness in the coach ---

test('compute_stats race_readiness: demo uses the fictional race, live without a target says none is set', async () => {
  const demo = demoCtx();
  demo.race = DEMO_RACE;
  const out = await executeTool(demo, 'compute_stats', { metric: 'race_readiness' }, budget());
  assert.equal(out.race.name, 'fictional 50K');
  assert.ok(out.limiting.label);
  assert.equal(out.parts.distance.need, 33);
  assert.equal(out.parts.climb, undefined);
  const live = demoCtx();
  live.race = null;
  const none = await executeTool(live, 'compute_stats', { metric: 'race_readiness' }, budget());
  assert.match(none.error, /No race target/);
});

test('system prompt carries the race target and the limiting factor, never an average', () => {
  const ctx = demoCtx();
  ctx.race = DEMO_RACE;
  const p = buildSystemPrompt(ctx);
  assert.match(p, /Race readiness \(rules of thumb\): limiting factor/);
  assert.match(p, /fictional, demo only/);
  assert.match(p, /Never give an average/);
  assert.match(p, /context, not scored/);
  ctx.race = null;
  assert.match(buildSystemPrompt(ctx), /No race target is set/);
});

test('race target comes from the RACE_TARGET env var, server-side only; bad JSON means no race', () => {
  const ok = envRace({ RACE_TARGET: JSON.stringify({ name: 'My 50K', km: 52, dplus: 2800, hours: 8 }) });
  assert.deepEqual(ok, { name: 'My 50K', distanceKm: 52, dplusM: 2800, hours: 8 });
  assert.equal(envRace({}), null);
  assert.equal(envRace({ RACE_TARGET: 'not json' }), null);
  assert.equal(envRace({ RACE_TARGET: '{"km":50}' }), null);
});

// --- thinking models (claude-sonnet-5-5): budget, starvation, recovery ---

import { validate } from '../api/chat.js';

const thinking = (t = 'let me think') => ({ type: 'thinking', thinking: t, signature: 'sig' });

test('thinking blocks ride the loop: echoed back verbatim, never in the reply', async () => {
  const client = mockClient([
    () => ({ stop_reason: 'tool_use', content: [thinking(), { type: 'tool_use', id: 'tu_1', name: 'compute_stats', input: { metric: 'summary' } }] }),
    () => ({ stop_reason: 'end_turn', content: [thinking('wrapping up'), { type: 'text', text: 'Load is 33% up. Cut back.' }] }),
  ]);
  const out = await runCoachAgent({
    client, model: 'claude-sonnet-5-5', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'How is my load?' }],
  });
  assert.equal(out.reply, 'Load is 33% up. Cut back.');
  assert.ok(!out.reply.includes('let me think') && !out.reply.includes('wrapping up'));
  const convo = client.calls[1].messages;
  assert.equal(convo.at(-2).role, 'assistant');
  assert.deepEqual(convo.at(-2).content[0], thinking(), 'thinking block preserved verbatim for the next call');
  assert.equal(convo.at(-1).content[0].type, 'tool_result');
});

test('coach defaults: medium effort, thinking between tools, 4096 token budget', async () => {
  const client = mockClient([() => text('ok')]);
  await runCoachAgent({ client, model: 'm', system: 's', ctx: demoCtx(), messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(client.calls[0].max_tokens, 4096);
  assert.deepEqual(client.calls[0].output_config, { effort: 'medium' });
  assert.deepEqual(client.calls[0].thinking, { type: 'between_tools' });
});

test('max_tokens with thinking-only content retries once with double budget', async () => {
  const client = mockClient([
    () => ({ stop_reason: 'max_tokens', content: [thinking()] }), // starved: zero text
    () => text('Recovered answer.'),
  ]);
  const out = await runCoachAgent({
    client, model: 'm', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'Hard question' }],
  });
  assert.equal(out.reply, 'Recovered answer.');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].max_tokens, 4096);
  assert.equal(client.calls[1].max_tokens, 8192, 'retry doubles the budget, capped');
  // the truncated turn was NOT echoed into the conversation
  assert.equal(client.calls[1].messages.length, 1);
});

test('max_tokens starvation at the cap is an explicit error, never an empty reply', async () => {
  const client = mockClient([() => ({ stop_reason: 'max_tokens', content: [thinking()] })]);
  await assert.rejects(
    runCoachAgent({ client, model: 'm', system: 's', ctx: demoCtx(), messages: [{ role: 'user', content: 'Hard question' }] }),
    /token budget/);
  assert.equal(client.calls.length, 2, 'one bounded retry, no loop');
});

test('an end_turn with no text is an explicit error, never an empty reply', async () => {
  const client = mockClient([() => ({ stop_reason: 'end_turn', content: [thinking()] })]);
  await assert.rejects(
    runCoachAgent({ client, model: 'm', system: 's', ctx: demoCtx(), messages: [{ role: 'user', content: 'Hi' }] }),
    /empty reply/);
});

// --- validate(): repair broken histories instead of rejecting them ---

test('validate passes a normal alternating conversation unchanged', () => {
  const msgs = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];
  assert.deepEqual(validate(msgs), msgs);
});

test('validate recovers a history with a stranded empty assistant turn', () => {
  // the exact state the bug left behind: blank assistant turn between two user turns
  const out = validate([
    { role: 'user', content: 'Am I ready for my race?' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'How does my load compare to usual?' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /Am I ready for my race\?/);
  assert.match(out[0].content, /How does my load compare to usual\?/);
});

test('validate drops blank/invalid turns and leading assistant turns', () => {
  const out = validate([
    { role: 'assistant', content: 'welcome' },
    { role: 'user', content: '   ' },
    { role: 'user', content: 'real question' },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: 'real question' }]);
});

test('validate still requires a user message to end on and caps length', () => {
  assert.throws(() => validate([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]), /Last message must be from the user/);
  assert.throws(() => validate([{ role: 'user', content: 'x'.repeat(2001) }]), /too long/);
  assert.throws(() => validate([]), /messages required/);
  assert.throws(() => validate('nope'), /messages required/);
});

test('models that reject effort/thinking knobs are retried without them, once per process', async () => {
  const calls = [];
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const client = { calls, messages: { create: async (req) => {
    calls.push(req);
    if (req.output_config) throw bad('This model does not support the effort parameter.');
    if (req.thinking) throw bad('"thinking.type.between_tools" is not supported for this model.');
    return text('Plain answer.');
  } } };
  const out = await runCoachAgent({
    client, model: 'haiku-test-double', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(out.reply, 'Plain answer.');
  assert.ok(calls[0].output_config && calls[0].thinking);
  assert.ok(!calls[1].output_config && calls[1].thinking);
  assert.ok(!calls[2].output_config && !calls[2].thinking);
  // remembered for the rest of the process: next question sends no knobs at all
  const out2 = await runCoachAgent({
    client, model: 'haiku-test-double', system: 's', ctx: demoCtx(),
    messages: [{ role: 'user', content: 'Again' }],
  });
  assert.equal(out2.reply, 'Plain answer.');
  assert.equal(calls.length, 4);
  assert.ok(!calls[3].output_config && !calls[3].thinking);
});
