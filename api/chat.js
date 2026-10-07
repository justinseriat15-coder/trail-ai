// POST /api/chat { source, messages:[{role,content}], activityId? } → coach reply.
// The model only ever sees data the server fetched itself.
import { handler, json, readJson, clientIp } from '../lib/http.js';
import { loadAthlete, loadStreams } from '../lib/data.js';
import { buildSystemPrompt } from '../lib/coach.js';
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
  if (!process.env.ANTHROPIC_API_KEY) return json(res, 503, { error: 'Coach IA non configuré (ANTHROPIC_API_KEY manquante).' });
  const body = await readJson(req);
  const source = body.source === 'live' ? 'live' : 'demo';
  const messages = validate(body.messages);

  const ctx = await loadAthlete(req, res, source);
  const ip = clientIp(req);
  const rl = ctx.mode === 'demo'
    ? rateLimit(`demo:${ip}`, { limit: 15, windowMs: 3600_000 })
    : rateLimit(`live:${ctx.athlete?.id}`, { limit: 80, windowMs: 3600_000 });
  if (!rl.ok) return json(res, 429, { error: `Limite atteinte, réessaie dans ${Math.ceil(rl.retryAfter / 60)} min.` });
  if (ctx.mode === 'demo' && !rateLimit('demo:global', { limit: 300, windowMs: 86400_000 }).ok) {
    return json(res, 429, { error: 'Quota quotidien de la démo atteint.' });
  }

  let streams = null;
  if (body.activityId) streams = await loadStreams(ctx, body.activityId).catch(() => null);
  const system = buildSystemPrompt(ctx, { activityId: body.activityId, streams });

  const model = ctx.mode === 'demo'
    ? process.env.ANTHROPIC_DEMO_MODEL || 'claude-haiku-4-5-20251001'
    : process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      // The system prompt is identical across turns of a conversation → cache it.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Anthropic error', r.status, data?.error?.type);
    return json(res, 502, { error: 'Le coach IA est indisponible pour le moment.' });
  }
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  json(res, 200, { reply: text, model, usage: data.usage });
});
