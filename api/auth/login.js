// GET /api/auth/login → redirects to Strava's consent screen.
// A random `state` is stored in a short-lived httpOnly cookie and checked on callback (CSRF protection).
import crypto from 'node:crypto';
import { handler, redirect, setCookie, appUrl, requireEnv } from '../../lib/http.js';

export default handler(['GET'], async (req, res) => {
  requireEnv('STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'SESSION_SECRET');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'tai_oauth_state', state, { maxAge: 600 });
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${appUrl(req)}/api/auth/callback`,
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state,
  });
  redirect(res, `https://www.strava.com/oauth/authorize?${params}`);
});
