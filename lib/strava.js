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

// Default: last ~120 days (enough for a 28-day chronic load + 16-week trends).
// The agent's list_activities tool passes an explicit after/before window and a type filter.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export async function fetchActivities(session, { after, before, type } = {}) {
  const afterTs = after && DAY.test(after)
    ? Math.floor(new Date(`${after}T00:00:00Z`).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 120 * 86400;
  const beforeTs = before && DAY.test(before) ? Math.floor(new Date(`${before}T23:59:59Z`).getTime() / 1000) : null;
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const qs = `after=${afterTs}${beforeTs ? `&before=${beforeTs}` : ''}&per_page=100&page=${page}`;
    const batch = await get(session, `/athlete/activities?${qs}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all
    .map((a) => Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? null])))
    .filter((a) => !type || a.type === type || a.sport_type === type)
    .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
}

// 5-minute in-memory cache of the activity list, per athlete + query.
// Same caveat as the rate limiter: per warm instance, best-effort against Strava's quota.
const LIST_TTL = 5 * 60 * 1000;
const listCache = new Map();
export async function fetchActivitiesCached(session, opts = {}) {
  const key = `${session.athlete?.id}|${opts.after || ''}|${opts.before || ''}|${opts.type || ''}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.t < LIST_TTL) return hit.data;
  const data = await fetchActivities(session, opts);
  listCache.set(key, { t: Date.now(), data });
  return data;
}

// One activity in full, for the agent's get_activity_details tool: splits and laps
// are only on this endpoint, not on the list endpoint. Trimmed to what the coach needs.
export async function fetchActivityDetail(session, id) {
  const a = await get(session, `/activities/${encodeURIComponent(id)}`);
  const split = (s) => ({
    km: +((s.distance || 0) / 1000).toFixed(2),
    pace: s.average_speed ? Math.round(1000 / s.average_speed) : null, // seconds per km
    hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
  });
  return {
    id: a.id,
    name: a.name,
    splits: Array.isArray(a.splits_metric) ? a.splits_metric.slice(0, 40).map(split) : [],
    laps: Array.isArray(a.laps) ? a.laps.slice(0, 20).map((l) => ({ name: l.name, ...split(l) })) : [],
  };
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
