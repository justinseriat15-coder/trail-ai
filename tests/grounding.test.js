// Offline unit tests for the history-grounding changes: exact data coverage in
// the system prompt, and tool outputs kept on agent steps for the eval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../lib/coach.js';
import { runCoachAgent } from '../lib/agent.js';
import { demoActivities } from '../public/js/demo-data.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const demoCtx = () => ({
  mode: 'demo', owner: false,
  athlete: { firstname: 'Demo athlete' },
  profile: { hrMax: 196, hrRest: 48 },
  activities: demoActivities(NOW),
});

test('system prompt states the exact data coverage', () => {
  const ctx = demoCtx();
  const prompt = buildSystemPrompt(ctx);
  const dates = ctx.activities.map((a) => String(a.start_date_local).slice(0, 10)).sort();
  assert.match(prompt, /## Data coverage/);
  assert.ok(prompt.includes(`${dates[0]} to ${dates.at(-1)}`), 'overall range named with real dates');
  assert.ok(prompt.includes(`${ctx.activities.length} sessions`), 'session count stated');
  assert.match(prompt, /recent-sessions list covers \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
});

test('system prompt requires tool retrieval outside the coverage, never estimates', () => {
  const prompt = buildSystemPrompt(demoCtx());
  assert.match(prompt, /outside that range[\s\S]*call list_activities or compute_stats BEFORE answering/i);
  assert.match(prompt, /cannot be retrieved[\s\S]*[Nn]ever estimate/);
  assert.match(prompt, /if a number is not in the summary or in a tool result, do not quote it/i);
});

test('system prompt with no sessions says so instead of implying coverage', () => {
  const ctx = { ...demoCtx(), activities: [] };
  const prompt = buildSystemPrompt(ctx);
  assert.match(prompt, /No sessions are loaded/);
});

test('agent steps carry tool outputs for the grounding eval', async () => {
  const ctx = demoCtx();
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls++;
        if (calls === 1) {
          return {
            stop_reason: 'tool_use',
            usage: {},
            content: [{ type: 'tool_use', id: 'tu_1', name: 'list_activities', input: { after: '2026-10-10', before: '2026-10-14' } }],
          };
        }
        return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Grounded answer.' }] };
      },
    },
  };
  const out = await runCoachAgent({ client, model: 'mock', system: 'sys', messages: [{ role: 'user', content: 'q' }], ctx, effort: null, thinking: null });
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].tool, 'list_activities');
  assert.ok(Array.isArray(out.steps[0].output.activities), 'raw tool result kept on the step');
  assert.ok(out.steps[0].output.count >= 1);
});
