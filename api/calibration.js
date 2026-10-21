// GET /api/calibration (owner only) → calibration aggregates as a JSON download.
// Pulls the owner's ~40 most recent runs and ONLY the six stream types approved
// for demo-generator calibration (time, heartrate, altitude, velocity_smooth,
// grade_smooth, cadence). Location streams (latlng) are never requested.
// Streams are aggregated in memory per activity and discarded immediately;
// nothing raw is stored, logged, or returned. Temporary endpoint for the
// Phase 2 rollout - remove once the generator is calibrated.
import { handler, json } from '../lib/http.js';
import { liveSession, fetchActivities, fetchRawStreams, isOwner } from '../lib/strava.js';
import { createAccumulator, addStreams, finalize } from '../lib/calibration.js';

export const config = { maxDuration: 60 };

const CALIBRATION_KEYS = 'time,heartrate,altitude,velocity_smooth,grade_smooth,cadence';
const MAX_RUNS = 40;
const CONCURRENCY = 6;

export default handler(['GET'], async (req, res) => {
  const session = await liveSession(req, res).catch(() => null);
  if (!session) return json(res, 401, { error: 'Log in first: open /api/auth/login, authorize, then come back here.' });
  if (!isOwner(session)) return json(res, 403, { error: 'Owner only.' });

  const activities = await fetchActivities(session, {});
  const runs = activities
    .filter((a) => a.type === 'Run' && a.distance >= 2000 && a.moving_time >= 600)
    .slice(0, MAX_RUNS);

  const acc = createAccumulator();
  const errors = [];
  for (let i = 0; i < runs.length; i += CONCURRENCY) {
    await Promise.all(runs.slice(i, i + CONCURRENCY).map(async (run) => {
      try {
        const streams = await fetchRawStreams(session, run.id, CALIBRATION_KEYS);
        addStreams(acc, streams); // streams go out of scope here and are not retained
      } catch (e) {
        acc.skipped++;
        errors.push(String(run.id));
      }
    }));
  }

  const out = {
    purpose: 'demo-generator calibration only - aggregates, no raw streams, no location data',
    generatedAt: new Date().toISOString(),
    runsConsidered: runs.length,
    runsUsed: acc.used,
    runsSkipped: acc.skipped,
    ...finalize(acc),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="trail-calibration.json"');
  json(res, 200, out);
});
