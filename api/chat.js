// POST /api/chat { source, messages:[{role,content}], activityId? } → coach reply.
// The model only ever sees data the server fetched itself.
// Agent loop: one call decides whether to use the three data tools (lib/agent.js).
// Clients that send Accept: text/event-stream get the visible steps as SSE events
// while the agent works, then the reply as the final event; others get plain JSON.
import Anthropic from '@anthropic-ai/sdk';
import { handler, json, readJson, clientIp } from '../lib/http.js';
import { loadAthlete, loadStreams } from '../lib/data.js';
import { buildSystemPrompt } from '../lib/coach.js';
import { runCoachAgent } from '../lib/agent.js';
import { rateLimit } from '../lib/ratelimit.js';

const MAX_TURNS = 12;
const MAX_CHARS = 2000;

function validate(messages) {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages required'), { status: 400 });
  const recent = messages.slice(-MAX_TURNS);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  for (const [i, m] of recent.entries()) {
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (m?.role !== expected || typeof m.content !== 'string' || !m.content.trim()) {
      throw Object.assign(new Error('Invalid conversation format'), { status: 400 });
    }
    if (m.content.length > MAX_CHARS) throw Object.assign(new Error(`Message too long (max ${MAX_CHARS} chars)`), { status: 400 });
  }
  if (recent.at(-1)?.role !== 'user') throw Object.assign(new Error('Last message must be from the user'), { status: 400 });
  return recent;
}

export default handler(['POST'], async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return json(res, 503, { error: 'AI coach not configured (ANTHROPIC_API_KEY missing).' });
  const body = await readJson(req);
  const source = body.source === 'live' ? 'live' : 'demo';
  const messages = validate(body.messages);

  const ctx = await loadAthlete(req, res, source);
  const ip = clientIp(req);
  const rl = ctx.mode === 'demo'
    ? rateLimit(`demo:${ip}`, { limit: 15, windowMs: 3600_000 })
    : rateLimit(`live:${ctx.athlete?.id}`, { limit: 80, windowMs: 3600_000 });
  if (!rl.ok) return json(res, 429, { error: `Limit reached, try again in ${Math.ceil(rl.retryAfter / 60)} min.` });
  if (ctx.mode === 'demo' && !rateLimit('demo:global', { limit: 300, windowMs: 86400_000 }).ok) {
    return json(res, 429, { error: 'Daily demo quota reached.' });
  }

  let streams = null;
  if (body.activityId) streams = await loadStreams(ctx, body.activityId).catch(() => null);
  const system = buildSystemPrompt(ctx, { activityId: body.activityId, streams });

  const model = ctx.mode === 'demo'
    ? process.env.ANTHROPIC_DEMO_MODEL || 'claude-haiku-4-5-20251001'
    : process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if ((req.headers.accept || '').includes('text/event-stream')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const out = await runCoachAgent({
        client, model, system, messages, ctx,
        onStep: (label) => send({ type: 'step', label }),
        onText: (t) => send({ type: 'delta', text: t }),
      });
      send({ type: 'reply', text: out.reply, model, usage: out.usage, steps: out.steps.map((s) => s.label) });
    } catch (e) {
      console.error('Anthropic error', e?.status, e?.error?.error?.type || e?.name);
      send({ type: 'error', error: 'The AI coach is currently unavailable.' });
    }
    return res.end();
  }

  try {
    const out = await runCoachAgent({ client, model, system, messages, ctx });
    json(res, 200, { reply: out.reply, model, usage: out.usage, steps: out.steps.map((s) => s.label) });
  } catch (e) {
    console.error('Anthropic error', e?.status, e?.error?.error?.type || e?.name);
    json(res, 502, { error: 'The AI coach is currently unavailable.' });
  }
});
