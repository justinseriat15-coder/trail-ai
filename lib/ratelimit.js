// Best-effort in-memory fixed-window rate limiter.
// Serverless instances are ephemeral, so this caps bursts per warm instance —
// enough to stop casual abuse of the public demo chat. For hard guarantees,
// swap for a shared store (Upstash Redis / Vercel KV) — same interface.
const buckets = new Map();

export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (b.count >= limit) return { ok: false, retryAfter: Math.ceil((b.reset - now) / 1000) };
  b.count++;
  return { ok: true, remaining: limit - b.count };
}
