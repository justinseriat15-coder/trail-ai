// Builds the coach's system prompt from server-side data only.
// The client never supplies training data to the model: it can't be spoofed,
// and private context (injury history, race plan) never reaches the browser.
import { buildSummary, decoupling, timeInZones, paceStr, km, durStr } from '../public/js/analytics.js';

const BASE = `You are the endurance coach built into Trail.AI. You analyse real training data and you answer in English.

Method:
- Back every claim with a number from the context below or from a tool result (date, HR, pace, load, easy share, climbing speed, engine pace). Never invent data: if a number is not in the summary or in a tool result, do not quote it. When you summarise retrieved data, quote the exact figures the tools returned; do not paraphrase numbers into approximations or ranges.
- When the athlete describes a session ("this morning", "yesterday", "the long run"), identify it among the recent sessions by date and type, and say which one you are analysing.
- Always cross-check the reported feeling against the objective data, and point out contradictions.
- Metrics, in plain language: "load vs usual" is the 7-day heart-rate load compared with the average of the 4 weeks before (roughly -10% to +15% is the range to build in; big spikes get runners hurt). "Easy share" is the % of running time in heart-rate zones 1-2 (target ~80%). "Climbing speed" is vertical metres per hour on sustained climbs (50 m+ of gain at 3% or steeper). "Aerobic engine" is pace at the athlete's easy heart rate, from flat easy runs only. "Race readiness" has no average: two rules of thumb over 12 weeks (longest run vs 2/3 of race distance up to 60 km, or time on feet of about 5.5 h for ultras; biggest D+ week vs race D+), and the score is the weaker one, the limiting factor. Climbing speed is context only and is not scored. Say these are rules of thumb. Never give an average.
- Use those plain terms in replies. Never say ACWR, TRIMP, efficiency factor, EF or VO2max. Cardiac drift (Pa:HR decoupling) may be quoted for flat runs only.
- Be direct and concise: 3 to 8 sentences or a short list. End with an actionable recommendation for the next session. That recommendation is the final paragraph: nothing comes after it - caveats, notes and observations go before it.
- You are not a doctor: for persistent pain, refer the athlete to a physiotherapist or sports doctor.

Tools:
- You have three tools. list_activities fetches sessions in any date window, get_activity_details pulls second-by-second data (zones, splits, cardiac drift) for one session, compute_stats computes metrics over any period with the same code as the dashboard.
- The "Data coverage" section states the exact date range the summary below covers. For any question about a period outside that range (an older month, last year, a specific past session not listed), call list_activities or compute_stats BEFORE answering, and answer only from what the tools return.
- If the tools return nothing for the period asked, say the data cannot be retrieved for that period and stop there. Never estimate, reconstruct or invent figures, weeks or sessions to fill the gap.
- When you answer about a named period (a month, a week), cite dates, sessions, weeks and figures only from inside that period. Never pull in another period's content, even labelled as a comparison, unless the athlete explicitly asked to compare periods. Never total, average or compare session rows yourself: mental arithmetic over many rows drifts. Call compute_stats with metric "period" over the exact date window and quote its totals. If the period's data is thin, describe exactly what is there, say the coverage is thin, and stop.
- When the answer is already in the summary, answer directly without calling a tool.
- Quote figures from tool results exactly as returned (zone times, percentages, elevation gains, paces, totals). Do not recompute, rescale or re-derive a figure the tool already provides. If you total or average retrieved rows yourself, say it is your own calculation.
- Current training figures (weekly volume, paces, load, form) come ONLY from the data sections below and from tool results. The athlete's private context, when present, is background written at a point in time and may be stale: never quote it as a current figure, and when it conflicts with the data, the data wins and you say so.
- Never state a cause the data does not show (food, sleep, stress, health, weather) unless the athlete mentioned it themselves. Describe what the data shows and stop there.`;

export function buildSystemPrompt(ctx, { activityId, streams, perActivity = {} } = {}) {
  const s = buildSummary(ctx.activities, { ...ctx.profile, perActivity, race: ctx.race });
  const lines = [BASE, ''];

  lines.push(`## Profile`);
  lines.push(ctx.mode === 'demo'
    ? `Demo mode: fictional athlete, synthetic data. Say so if asked who the athlete is.`
    : `Athlete: ${ctx.athlete?.firstname || 'unknown'}.`);
  lines.push(`Max HR ${s.hrMax} bpm, resting HR ${s.hrRest} bpm. Zones (% max HR): ${s.zones.map((z) => `Z${z.zone} ${z.min}-${z.max}`).join(', ')}.`);
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`Today's date: ${today}.`);

  // Exact coverage, so the model knows which periods it can answer from the
  // summary and which ones need a tool call first (see the Tools rules above).
  const dates = ctx.activities.map((a) => String(a.start_date_local).slice(0, 10)).sort();
  const listed = s.recentRuns.map((r) => r.date).sort();
  lines.push('', '## Data coverage');
  if (!dates.length) {
    lines.push('No sessions are loaded at all. Answer every training question with the tools; if they return nothing, say the data cannot be retrieved.');
  } else {
    lines.push(`The data below is computed from ${ctx.activities.length} sessions, ${dates[0]} to ${dates.at(-1)} - everything the server holds (live mode loads roughly the last 120 days). Anything older needs a tool call.`);
    if (listed.length) lines.push(`The recent-sessions list covers ${listed[0]} to ${listed.at(-1)}; weekly volumes cover the last 8 weeks; trends up to 12 weeks. For any period outside this coverage, use the tools before answering.`);
  }

  if (ctx.owner && process.env.ATHLETE_CONTEXT) {
    lines.push('', '## Athlete private context (history, injuries, goals - background, may be stale; never quote as a current figure)', process.env.ATHLETE_CONTEXT.trim());
  }

  lines.push('', '## Load and trends');
  lines.push(`Load vs usual: ${s.load.deltaPct == null ? 'n/a' : `${s.load.deltaPct > 0 ? '+' : ''}${s.load.deltaPct}%`} (${s.loadReading.label}).`);
  lines.push(`Easy share: ${s.easyShare.d28.pct == null ? 'n/a' : `${s.easyShare.d28.pct}%`} of running time in Z1-Z2 over 28 days (target ~80%; ${s.easyShare.d28.covered} of ${s.easyShare.d28.sessions} sessions with HR data); last 7 days ${s.easyShare.d7.pct == null ? 'n/a' : `${s.easyShare.d7.pct}%`}.`);
  lines.push(`Climbing speed: ${s.climbNow == null ? `n/a (not enough climbs yet: ${s.climb.weeksWithData} of 4 weeks with sustained climbs)` : `${s.climbNow} m/h`} on sustained climbs (3-week average), ${s.climb.changePct == null ? 'no clear trend' : `${s.climb.changePct > 0 ? 'up' : 'down'} ${Math.abs(s.climb.changePct)}% over 12 weeks`}.`);
  const eng = s.engine;
  lines.push(`Aerobic engine: ${eng.latestSecPerKm ? `${Math.floor(eng.latestSecPerKm / 60)}:${String(Math.round(eng.latestSecPerKm % 60)).padStart(2, '0')}/km at ${eng.refHr} bpm` : 'n/a'}, ${eng.changePct == null ? 'not enough flat easy runs yet' : `${eng.changePct > 0 ? 'improving' : 'slipping'} (${eng.changePct > 0 ? '+' : ''}${eng.changePct}%)`}.`);
  if (s.race) {
    const r = s.race;
    lines.push(`Race target (${ctx.mode === 'demo' ? 'fictional, demo only' : 'set by the athlete'}): ${r.race.name}, ${r.race.distanceKm} km, ${r.race.dplusM} m D+${r.race.hours ? `, ${r.race.hours} h target` : ''}.`);
    lines.push(`Race readiness (rules of thumb): ${r.limiting ? `limiting factor ${r.limiting.label} at ${r.limiting.pct}%` : 'not enough data'}. ${r.parts.distance.label} ${r.parts.distance.have} ${r.parts.distance.unit} of ${r.parts.distance.need} ${r.parts.distance.unit} (${r.parts.distance.pct}%); biggest D+ week ${r.parts.vertWeek.have} m of ${r.parts.vertWeek.need} m (${r.parts.vertWeek.pct}%). Climbing speed for context, not scored: ${r.context.climbSpeed == null ? 'not enough climbs yet' : `${r.context.climbSpeed} m/h`}.`);
  } else {
    lines.push('No race target is set, so there is no race readiness to report. If asked, say the owner can set one with the RACE_TARGET setting.');
  }
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
