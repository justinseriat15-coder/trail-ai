// Builds the coach's system prompt from server-side data only.
// The client never supplies training data to the model: it can't be spoofed,
// and private context (injury history, race plan) never reaches the browser.
import { buildSummary, decoupling, timeInZones, paceStr, km, durStr } from '../public/js/analytics.js';

const BASE = `You are the endurance coach built into Trail.AI. You analyse real training data and you answer in English.

Method:
- Back every claim with a number from the context below (date, HR, pace, load, easy share, climbing speed, engine pace). Never invent data.
- When the athlete describes a session ("this morning", "yesterday", "the long run"), identify it among the recent sessions by date and type, and say which one you are analysing.
- Always cross-check the reported feeling against the objective data, and point out contradictions.
- Metrics, in plain language: "load vs usual" is the 7-day heart-rate load compared with the average of the 4 weeks before (roughly -10% to +15% is the range to build in; big spikes get runners hurt). "Easy share" is the % of running time in heart-rate zones 1-2 (target ~80%). "Climbing speed" is vertical metres per hour on sustained climbs (50 m+ of gain at 3% or steeper). "Aerobic engine" is pace at the athlete's easy heart rate, from flat easy runs only.
- Use those plain terms in replies. Never say ACWR, TRIMP, efficiency factor, EF or VO2max. Cardiac drift (Pa:HR decoupling) may be quoted for flat runs only.
- Be direct and concise: 3 to 8 sentences or a short list. End with an actionable recommendation for the next session.
- You are not a doctor: for persistent pain, refer the athlete to a physiotherapist or sports doctor.

Tools:
- You have three tools. list_activities fetches sessions in any date window, get_activity_details pulls second-by-second data (zones, splits, cardiac drift) for one session, compute_stats computes metrics over any period with the same code as the dashboard.
- The summary below covers roughly the last 15 sessions and 16 weeks. When a question goes beyond it (older history, a specific past period, a session not listed), fetch what you need with the tools. Never assume data you have not retrieved.
- When the answer is already in the summary, answer directly without calling a tool.`;

export function buildSystemPrompt(ctx, { activityId, streams, perActivity = {} } = {}) {
  const s = buildSummary(ctx.activities, { ...ctx.profile, perActivity });
  const lines = [BASE, ''];

  lines.push(`## Profile`);
  lines.push(ctx.mode === 'demo'
    ? `Demo mode: fictional athlete, synthetic data. Say so if asked who the athlete is.`
    : `Athlete: ${ctx.athlete?.firstname || 'unknown'}.`);
  lines.push(`Max HR ${s.hrMax} bpm, resting HR ${s.hrRest} bpm. Zones (% max HR): ${s.zones.map((z) => `Z${z.zone} ${z.min}-${z.max}`).join(', ')}.`);
  lines.push(`Today's date: ${new Date().toISOString().slice(0, 10)}.`);

  if (ctx.owner && process.env.ATHLETE_CONTEXT) {
    lines.push('', '## Athlete private context (history, injuries, goals)', process.env.ATHLETE_CONTEXT.trim());
  }

  lines.push('', '## Load and trends');
  lines.push(`Load vs usual: ${s.load.deltaPct == null ? 'n/a' : `${s.load.deltaPct > 0 ? '+' : ''}${s.load.deltaPct}%`} (${s.loadReading.label}).`);
  lines.push(`Easy share: ${s.easyShare.d28.pct == null ? 'n/a' : `${s.easyShare.d28.pct}%`} of running time in Z1-Z2 over 28 days (target ~80%; ${s.easyShare.d28.covered} of ${s.easyShare.d28.sessions} sessions with HR data); last 7 days ${s.easyShare.d7.pct == null ? 'n/a' : `${s.easyShare.d7.pct}%`}.`);
  lines.push(`Climbing speed: ${s.climbNow == null ? 'n/a' : `${s.climbNow} m/h`} on sustained climbs (3-week average), ${s.climb.changePct == null ? 'no clear trend' : `${s.climb.changePct > 0 ? 'up' : 'down'} ${Math.abs(s.climb.changePct)}% over 12 weeks`}.`);
  const eng = s.engine;
  lines.push(`Aerobic engine: ${eng.latestSecPerKm ? `${Math.floor(eng.latestSecPerKm / 60)}:${String(Math.round(eng.latestSecPerKm % 60)).padStart(2, '0')}/km at ${eng.refHr} bpm` : 'n/a'}, ${eng.changePct == null ? 'not enough flat easy runs yet' : `${eng.changePct > 0 ? 'improving' : 'slipping'} (${eng.changePct > 0 ? '+' : ''}${eng.changePct}%)`}.`);
  lines.push(`Weekly volume (last 8 weeks, the last one is in progress): ${s.weeks.map((w) => `${w.week}: ${w.hours} h/${w.dplus} m gain/${w.count} sessions`).join(' | ')}.`);

  lines.push('', '## Recent sessions (most recent first)');
  for (const r of s.recentRuns) {
    lines.push(`- ${r.date} | ${r.name} (${r.type}) | ${r.km} km | ${r.duration} | ${r.pace}/km | HR ${r.hr ?? 'n/a'} (max ${r.hrMax ?? 'n/a'}) | gain ${r.dplus} m | id ${r.id}`);
  }

  if (activityId && streams) {
    const a = ctx.activities.find((x) => String(x.id) === String(activityId));
    if (a) {
      const z = timeInZones(streams, s.hrMax);
      const flat = (a.total_elevation_gain || 0) / (a.distance / 1000) <= 15;
      lines.push('', `## Session selected in the UI (second-by-second analysis)`);
      lines.push(`${a.name}, ${a.start_date_local.slice(0, 10)}: ${km(a.distance)} km, ${durStr(a.moving_time)}, ${paceStr(a.average_speed)}/km, HR ${Math.round(a.average_heartrate || 0)}.`);
      lines.push(`${flat ? `Cardiac drift (Pa:HR decoupling): ${decoupling(streams) ?? 'n/a'}%. ` : ''}Time in zones: ${z ? z.map((x) => `Z${x.zone} ${x.pct}%`).join(', ') : 'n/a'}.`);
    }
  }
  return lines.join('\n');
}
