// Single entry point for "give me the athlete's data", demo or live.
// Both paths return the same shape, so every downstream consumer is source-agnostic.
import { demoActivities, demoStreams, DEMO_PROFILE } from '../public/js/demo-data.js';
import { liveSession, fetchActivities, fetchStreams, hrProfile, isOwner } from './strava.js';

const publicFields = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_')));

export async function loadAthlete(req, res, source) {
  if (source === 'demo') {
    const activities = demoActivities();
    return {
      mode: 'demo',
      owner: false,
      athlete: { firstname: DEMO_PROFILE.firstname },
      profile: { hrMax: DEMO_PROFILE.hrMax, hrRest: DEMO_PROFILE.hrRest },
      activities,
      publicActivities: activities.map(publicFields),
    };
  }
  const session = await liveSession(req, res);
  if (!session) throw Object.assign(new Error('Not connected to Strava'), { status: 401 });
  const activities = await fetchActivities(session);
  return {
    mode: 'live',
    owner: isOwner(session),
    athlete: session.athlete,
    profile: hrProfile(session, activities),
    activities,
    publicActivities: activities,
    session,
  };
}

export async function loadStreams(ctx, id) {
  if (ctx.mode === 'demo') {
    const a = ctx.activities.find((x) => String(x.id) === String(id));
    if (!a) throw Object.assign(new Error('Unknown activity'), { status: 404 });
    return demoStreams(a);
  }
  if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('Invalid id'), { status: 400 });
  return fetchStreams(ctx.session, id);
}
