// POST /api/auth/logout → clears the session cookie.
import { handler, json } from '../../lib/http.js';
import { destroySession } from '../../lib/session.js';

export default handler(['POST'], async (req, res) => {
  destroySession(res);
  json(res, 200, { ok: true });
});
