// Stream-derived extras for the dashboard: per-activity zone seconds, climb
// analysis and elevation sparklines. Demo streams are synthetic (free); live
// streams are one Strava call per recent run, cached in memory per athlete.
import { demoStreams } from '../public/js/demo-data.js';
import { fetchStreams } from './strava.js';
import { timeInZones, climbSegments, climbingSpeed, sparkPoints, isRun } from '../public/js/analytics.js';

const cache = new Map(); // `${mode}:${athlete}` -> { t, data }
const TTL = 300_000;
const WINDOW_DAYS = 84; // 12 weeks

export async function computeInsights(ctx) {
  const key = `${ctx.mode}:${ctx.athlete?.id || 'demo'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;

  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  const recent = ctx.activities.filter(
    (a) => isRun(a) && new Date(String(a.start_date_local).replace('Z$', '')) >= cutoff,
  );
  const perActivity = {};
  for (const a of recent) {
    try {
      const streams = ctx.mode === 'demo' ? demoStreams(a) : await fetchStreams(ctx.session, a.id);
      const zones = timeInZones(streams, ctx.profile.hrMax);
      const climbs = climbSegments(streams);
      perActivity[a.id] = {
        zoneSecs: zones ? zones.map((z) => z.seconds) : null,
        climbs,
        vertMph: climbingSpeed(climbs),
        spark: sparkPoints(streams),
      };
    } catch {
      perActivity[a.id] = { zoneSecs: null, climbs: [], vertMph: null, spark: null };
    }
  }
  const data = { perActivity };
  cache.set(key, { t: Date.now(), data });
  return data;
}
