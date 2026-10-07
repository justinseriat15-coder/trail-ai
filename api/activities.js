// GET /api/activities?source=demo|live → activities + HR profile for the dashboard.
import { handler, json, query } from '../lib/http.js';
import { loadAthlete } from '../lib/data.js';

export default handler(['GET'], async (req, res) => {
  const source = query(req).source === 'live' ? 'live' : 'demo';
  const ctx = await loadAthlete(req, res, source);
  json(res, 200, { mode: ctx.mode, athlete: { firstname: ctx.athlete?.firstname }, profile: ctx.profile, activities: ctx.publicActivities });
});
