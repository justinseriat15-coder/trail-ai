// POST /api/chat { source, messages:[{role,content}], activityId? } → coach reply.
// The model only ever sees data the server fetched itself.
// Agent loop: one call decides whether to use the three data tools (lib/agent.js).
// Clients that send Accept: text/event-stream get the visible steps as SSE events
// while the agent works, then the reply as the final event; others get plain JSON.
import Anthropic from '@anthropic-ai/sdk';
import { handler, json, readJson, clientIp } from '../lib/http.js';
import { loadAthlete, loadStreams } from '../lib/data.js';
import { buildSystemPrompt } from '../lib/coach.js';
import { computeInsights } from '../lib/insights.js';
import { runCoachAgent } from '../lib/agent.js';
import { rateLimit } from '../lib/ratelimit.js';

const MAX_TURNS = 12;
const MAX_CHARS = 2000;

// Repair, don't reject. Earlier builds could strand an empty assistant turn in
// the browser's history (a starved reply was stored as ""), and strict
// alternation checks then rejected every later message with "Invalid
// conversation format". Blank turns are dropped and adjacent same-role turns
// merged, so those existing histories keep working; nothing is deleted from
// what the user actually wrote.
export function validate(messages) {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages required'), { status: 400 });
  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.trim();
    if (!content) continue; // blank turn (broken-history recovery)
    if (content.length > MAX_CHARS) throw Object.assign(new Error(`Message too long (max ${MAX_CHARS} chars)`), { status: 400 });
    const prev = clean.at(-1);
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${content}`;
    else clean.push({ role: m.role, content });
  }
  const recent = clean.slice(-MAX_TURNS);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  if (!recent.length) throw Object.assign(new Error('messages required'), { status: 400 });
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
  // Insights (zone time, climbs) feed the coach's summary; cached, shared with the dashboard.
  ctx.insights = await computeInsights(ctx).catch(() => null);
  const system = buildSystemPrompt(ctx, { activityId: body.activityId, streams, perActivity: ctx.insights?.perActivity });

  const model = ctx.mode === 'demo'
    ? process.env.ANTHROPIC_DEMO_MODEL || 'claude-haiku-4-5-20251001'
    : process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

  // Privacy-safe request metrics: token/latency aggregates only - never message
  // content, athlete identity, or auth data. Powers real-mode cost evidence.
  const logMetrics = (ok, startedAt, out, extra = {}) => {
    const u = (out && out.usage) || {};
    console.log('chat_metrics', JSON.stringify({
      ok, mode: ctx.mode, model,
      duration_ms: Date.now() - startedAt,
      input_tokens: u.input_tokens, output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      thinking_tokens: u.thinking_tokens,
      steps: out && out.steps ? out.steps.length : 0,
      reply_chars: out && typeof out.reply === 'string' ? out.reply.length : 0,
      ...extra,
    }));
  };

  const startedAt = Date.now();
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
      logMetrics(true, startedAt, out);
      send({ type: 'reply', text: out.reply, model, usage: out.usage, steps: out.steps.map((s) => s.label) });
    } catch (e) {
      console.error('Anthropic error', e?.status, e?.error?.error?.type || e?.name);
      logMetrics(false, startedAt, null, { error_type: e?.error?.error?.type || e?.name });
      send({ type: 'error', error: 'The AI coach is currently unavailable.' });
    }
    return res.end();
  }

  try {
    const out = await runCoachAgent({ client, model, system, messages, ctx });
    logMetrics(true, startedAt, out);
    json(res, 200, { reply: out.reply, model, usage: out.usage, steps: out.steps.map((s) => s.label) });
  } catch (e) {
    console.error('Anthropic error', e?.status, e?.error?.error?.type || e?.name);
    logMetrics(false, startedAt, null, { error_type: e?.error?.error?.type || e?.name });
    json(res, 502, { error: 'The AI coach is currently unavailable.' });
  }
});
