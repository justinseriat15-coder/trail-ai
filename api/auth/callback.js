// GET /api/auth/callback?code&state&scope → exchanges the code server-side, opens the session.
import { handler, redirect, parseCookies, clearCookie, query } from '../../lib/http.js';
import { exchangeCode, sessionFromToken } from '../../lib/strava.js';
import { writeSession } from '../../lib/session.js';

export default handler(['GET'], async (req, res) => {
  const { code, state, scope, error } = query(req);
  const expected = parseCookies(req).tai_oauth_state;
  clearCookie(res, 'tai_oauth_state');
  if (error) return redirect(res, '/?auth=denied');
  if (!code || !state || !expected || state !== expected) return redirect(res, '/?auth=invalid_state');
  if (!scope?.includes('activity:read')) return redirect(res, '/?auth=missing_scope');
  const t = await exchangeCode(code).catch(() => null);
  if (!t) return redirect(res, '/?auth=exchange_failed');
  writeSession(res, sessionFromToken(t, t.athlete));
  redirect(res, '/?mode=live');
});
