// Live eval: runs the eval questions through the real agent loop + real model.
// Skipped unless ANTHROPIC_API_KEY is set (npm run eval). Uses demo data only,
// so it never touches Strava and costs a handful of Haiku calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { runCoachAgent } from '../lib/agent.js';
import { buildSystemPrompt } from '../lib/coach.js';
import { demoActivities } from '../public/js/demo-data.js';
import { EVAL_QUESTIONS } from './eval-questions.mjs';

const KEY = process.env.ANTHROPIC_API_KEY;
const opts = { skip: !KEY };

const ctx = {
  mode: 'demo', owner: false,
  athlete: { firstname: 'Demo athlete' },
  profile: { hrMax: 196, hrRest: 48 },
  activities: demoActivities(),
};

for (const { q, expect } of EVAL_QUESTIONS) {
  test(`eval [${expect}]: ${q}`, opts, async () => {
    const client = new Anthropic({ apiKey: KEY });
    const out = await runCoachAgent({
      client,
      model: process.env.ANTHROPIC_DEMO_MODEL || 'claude-haiku-4-5-20251001',
      system: buildSystemPrompt(ctx),
      messages: [{ role: 'user', content: q }],
      ctx,
    });
    const fetched = out.steps.length > 0;
    assert.equal(fetched, expect === 'fetch',
      `expected ${expect}, got ${out.steps.map((s) => s.tool).join(', ') || 'no tools'}; reply: ${out.reply?.slice(0, 120)}`);
  });
}
