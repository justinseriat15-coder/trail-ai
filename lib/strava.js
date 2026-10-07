// Strava API client: token exchange, transparent refresh, and data fetching.
import { readSession, writeSession } from './session.js';

const OAUTH = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';

async function tokenRequest(params) {
  const r = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw Object.assign(new Error('Strava token request failed'), { status: 401, detail: data });
  return data;
}

export const exchangeCode = (code) => tokenRequest({ code, grant_type: 'authorization_code' });
export const refresh = (refresh_token) => tokenRequest({ refresh_token, grant_type: 'refresh_token' });

export function sessionFromToken(t, athlete) {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    athlete: athlete ? { id: athlete.id, firstname: athlete.firstname } : undefined,
  };
}

// Returns a session with a valid access token, refreshing (and re-sealing the cookie) if needed.
export async function liveSession(req, res) {
  const s = readSession(req);
  if (!s?.refresh_token) return null;
  if (Date.now() / 1000 < s.expires_at - 300) return s;
  const t = await refresh(s.refresh_token);
  const next = { ...sessionFromToken(t), athlete: s.athlete };
  writeSession(res, next);
  return next;
}

async function get(session, path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (r.status === 401) throw Object.assign(new Error('Strava authorization revoked'), { status: 401 });
  if (r.status === 429) throw Object.assign(new Error('Strava rate limit reached, retry in a few minutes'), { status: 429 });
  if (!r.ok) throw Object.assign(new Error(`Strava error ${r.status}`), { status: 502 });
  return r.json();
}

const FIELDS = ['id', 'name', 'type', 'sport_type', 'start_date_local', 'distance', 'moving_time', 'elapsed_time',
  'average_speed', 'average_heartrate', 'max_heartrate', 'total_elevation_gain'];

// Last ~120 days of activities (enough for a 28-day chronic load + 16-week trends).
export async function fetchActivities(session, days = 120) {
  const after = Math.floor(Date.now() / 1000) - days * 86400;
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await get(session, `/athlete/activities?after=${after}&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all
    .map((a) => Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? null])))
    .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
}

export async function fetchStreams(session, id) {
  const keys = 'time,heartrate,velocity_smooth,distance,altitude';
  const data = await get(session, `/activities/${encodeURIComponent(id)}/streams?keys=${keys}&key_by_type=true`);
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.data]));
}

export function isOwner(session) {
  return !!(session?.athlete?.id && process.env.OWNER_ATHLETE_ID && String(session.athlete.id) === String(process.env.OWNER_ATHLETE_ID));
}

// HR profile: env for the owner, otherwise inferred from the data.
export function hrProfile(session, activities) {
  if (isOwner(session) && process.env.HR_MAX) {
    return { hrMax: Number(process.env.HR_MAX), hrRest: Number(process.env.HR_REST || 50) };
  }
  const observed = Math.max(0, ...activities.map((a) => a.max_heartrate || 0));
  return { hrMax: observed > 150 ? observed : 190, hrRest: 55 };
}
