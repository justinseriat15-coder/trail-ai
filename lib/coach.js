// Builds the coach's system prompt from server-side data only.
// The client never supplies training data to the model: it can't be spoofed,
// and private context (injury history, race plan) never reaches the browser.
import { buildSummary, decoupling, timeInZones, paceStr, km, durStr, efficiencyFactor } from '../public/js/analytics.js';

const BASE = `You are the endurance coach built into Trail.AI. You analyse real training data and you answer in English.

Method:
- Back every claim with a number from the context below (date, HR, pace, EF, ACWR, decoupling). Never invent data.
- When the athlete describes a session ("this morning", "yesterday", "the long run"), identify it among the recent sessions by date and type, and say which one you are analysing.
- Always cross-check the reported feeling against the objective data, and point out contradictions.
- Metrics: EF (efficiency factor) = speed in m/min ÷ average HR, only comparable between flat easy runs ≥ 20 min. ACWR = 7-day load ÷ 28-day weekly average (Banister TRIMP); 0.8-1.3 = optimal zone, > 1.5 = elevated risk. Pa:HR decoupling < 5% = good aerobic endurance for that duration.
- Be direct and concise: 3 to 8 sentences or a short list. End with an actionable recommendation for the next session.
- You are not a doctor: for persistent pain, refer the athlete to a physiotherapist or sports doctor.`;

export function buildSystemPrompt(ctx, { activityId, streams } = {}) {
  const s = buildSummary(ctx.activities, ctx.profile);
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
  lines.push(`Current ACWR: ${s.acwr?.ratio ?? 'n/a'} (${s.acwrStatus.label}), acute load ${s.acwr?.acute}, chronic ${s.acwr?.chronic}.`);
  lines.push(`EF change over the period (last third vs first third): ${s.efChangePct ?? 'n/a'}%.`);
  lines.push(`Max consecutive running days in 14 d: ${s.consecutiveRunDays14d}.`);
  lines.push(`Weekly volume (last 8 weeks, the last one is in progress): ${s.weeks.map((w) => `${w.week}: ${w.km} km/${w.dplus} m gain/${w.count} sessions`).join(' | ')}.`);

  lines.push('', '## Recent sessions (most recent first)');
  for (const r of s.recentRuns) {
    lines.push(`- ${r.date} | ${r.name} (${r.type}) | ${r.km} km | ${r.duration} | ${r.pace}/km | HR ${r.hr ?? 'n/a'} (max ${r.hrMax ?? 'n/a'}) | gain ${r.dplus} m | EF ${r.ef ?? 'n/a'} | TRIMP ${r.trimp ?? 'n/a'} | id ${r.id}`);
  }

  if (activityId && streams) {
    const a = ctx.activities.find((x) => String(x.id) === String(activityId));
    if (a) {
      const z = timeInZones(streams, s.hrMax);
      lines.push('', `## Session selected in the UI (second-by-second analysis)`);
      lines.push(`${a.name}, ${a.start_date_local.slice(0, 10)}: ${km(a.distance)} km, ${durStr(a.moving_time)}, ${paceStr(a.average_speed)}/km, HR ${Math.round(a.average_heartrate || 0)}, EF ${efficiencyFactor(a)?.toFixed(3) ?? 'n/a'}.`);
      lines.push(`Pa:HR decoupling: ${decoupling(streams) ?? 'n/a'}%. Time in zones: ${z ? z.map((x) => `Z${x.zone} ${x.pct}%`).join(', ') : 'n/a'}.`);
    }
  }
  return lines.join('\n');
}
