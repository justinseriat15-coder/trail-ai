// GET /api/me → who is connected (never exposes tokens).
import { handler, json } from '../lib/http.js';
import { readSession } from '../lib/session.js';
import { isOwner } from '../lib/strava.js';

export default handler(['GET'], async (req, res) => {
  const s = process.env.SESSION_SECRET ? readSession(req) : null;
  if (!s?.refresh_token) return json(res, 200, { connected: false });
  json(res, 200, { connected: true, athlete: { firstname: s.athlete?.firstname }, owner: isOwner(s) });
});
