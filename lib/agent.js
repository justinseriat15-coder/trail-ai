// The coach agent: one model call that decides for itself whether to fetch data.
// Hybrid by design: the cached summary in the system prompt covers the common
// questions; the three tools below cover everything beyond it. No router, no
// forced tool use. The loop is capped at MAX_CALLS model calls per question and
// the last call is always made without tools, so it must end in a written answer.
//
// The Anthropic client is injected so tests can run the whole loop with a mock.
import {
  buildSummary, acwrSeries, efTrend, efChange, weeklyVolume, timeInZones, decoupling,
  efficiencyFactor, trimp, paceStr, km, durStr,
} from '../public/js/analytics.js';
import { fetchActivitiesCached, fetchActivityDetail } from './strava.js';
import { loadStreams } from './data.js';

const MAX_CALLS = 8;
const STRAVA_BUDGET = 6; // live Strava calls per question (demo never calls Strava)

export const TOOLS = [
  {
    name: 'list_activities',
    description:
      'List the athlete\'s sessions in a date window, newest first. Use this for anything outside the recent sessions in the summary: older history, a specific month, a comparison with another period. Dates are YYYY-MM-DD, inclusive. Omit both for the last ~120 days. type filters by sport (e.g. "Run", "TrailRun", "Ride"); omit it for all sports.',
    input_schema: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'Start of window, YYYY-MM-DD, inclusive.' },
        before: { type: 'string', description: 'End of window, YYYY-MM-DD, inclusive.' },
        type: { type: 'string', description: 'Sport type filter, e.g. Run, TrailRun, Ride.' },
      },
    },
  },
  {
    name: 'get_activity_details',
    description:
      'Second-by-second analysis of one session by id: time in heart-rate zones, pace and HR per kilometre (splits), laps, and Pa:HR decoupling. Use it when the athlete asks about a specific session in depth, or names one the summary lists.',
    input_schema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'The activity id (the summary lists ids for recent sessions).' } },
      required: ['id'],
    },
  },
  {
    name: 'compute_stats',
    description:
      'Compute a metric deterministically over a lookback window, with the same functions the dashboard uses. Prefer this over estimating from raw sessions. metric: "summary" (load, trends, streaks), "acwr" (daily ratio series), "ef_trend" (efficiency factor points and change), "weekly_volume" (distance and gain per week). days is the lookback window (default 56).',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['summary', 'acwr', 'ef_trend', 'weekly_volume'] },
        days: { type: 'number', description: 'Lookback window in days. Default 56.' },
      },
      required: ['metric'],
    },
  },
];

// Visible-step label, built ONLY from the tool_use block (name + inputs) so the
// chat shows what the agent actually did, never what the model claimed it did.
export function stepLabel(tu, ctx) {
  if (tu.name === 'list_activities') {
    const range = tu.input?.after || tu.input?.before
      ? ` (${tu.input.after || '…'} → ${tu.input.before || 'today'})`
      : ' (last 120 days)';
    return `Fetching activities${range}${tu.input?.type ? `, ${tu.input.type} only` : ''}…`;
  }
  if (tu.name === 'get_activity_details') {
    const a = ctx.activities.find((x) => String(x.id) === String(tu.input?.id));
    const what = a ? `"${a.name}" (${String(a.start_date_local).slice(0, 10)})` : `session ${tu.input?.id}`;
    return `Analysing ${what} second by second…`;
  }
  if (tu.name === 'compute_stats') {
    const names = { summary: 'training summary', acwr: 'ACWR series', ef_trend: 'efficiency trend', weekly_volume: 'weekly volume' };
    return `Computing ${names[tu.input?.metric] || tu.input?.metric} over ${tu.input?.days || 56} days…`;
  }
  return `${tu.name}…`;
}

const trimActivity = (a, hrMax, hrRest) => ({
  id: a.id,
  date: String(a.start_date_local).slice(0, 10),
  name: a.name,
  type: a.sport_type || a.type,
  km: +km(a.distance),
  min: Math.round(a.moving_time / 60),
  pace: paceStr(a.average_speed),
  hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
  gain: Math.round(a.total_elevation_gain || 0),
  ef: efficiencyFactor(a) ? +efficiencyFactor(a).toFixed(3) : null,
  trimp: trimp(a, hrMax, hrRest) ? Math.round(trimp(a, hrMax, hrRest)) : null,
});

const outOfData = () => ({ activities: [], note: 'No sessions in this window. The athlete may simply not have trained then, or the data does not go back that far.' });

async function toolListActivities(ctx, input, budget) {
  let list;
  if (ctx.mode === 'demo') {
    list = ctx.activities;
  } else {
    if (budget.left <= 0) return { error: 'Live data budget reached for this question; answer from the data already retrieved.' };
    budget.left--;
    list = await fetchActivitiesCached(ctx.session, { after: input?.after, before: input?.before, type: input?.type });
  }
  const after = input?.after, before = input?.before, type = input?.type;
  const filtered = list
    .filter((a) => (!after || String(a.start_date_local).slice(0, 10) >= after)
      && (!before || String(a.start_date_local).slice(0, 10) <= before)
      && (!type || a.type === type || a.sport_type === type));
  if (!filtered.length) return outOfData();
  const { hrMax, hrRest } = ctx.profile;
  const out = filtered.slice(0, 30).map((a) => trimActivity(a, hrMax, hrRest));
  return { count: filtered.length, activities: out, note: filtered.length > 30 ? 'Showing the 30 most recent of the window.' : undefined };
}

async function toolActivityDetails(ctx, input, budget) {
  const id = input?.id;
  const a = ctx.activities.find((x) => String(x.id) === String(id));
  if (!a && ctx.mode === 'demo') return { error: `No session with id ${id}. Use an id from the recent sessions or from list_activities.` };
  if (ctx.mode !== 'demo' && budget.left <= 0) return { error: 'Live data budget reached for this question; answer from the data already retrieved.' };
  if (ctx.mode !== 'demo') budget.left--;
  const streams = await loadStreams(ctx, id); // demo: synthetic; live: Strava (1 call)
  let detail = { splits: [], laps: [] };
  if (ctx.mode !== 'demo') {
    if (budget.left <= 0) return { error: 'Live data budget reached for this question; answer from the data already retrieved.' };
    budget.left--;
    detail = await fetchActivityDetail(ctx.session, id); // splits + laps (1 call)
  }
  const { hrMax, hrRest } = ctx.profile;
  return {
    id: a?.id ?? id,
    name: a?.name ?? detail.name,
    date: a ? String(a.start_date_local).slice(0, 10) : undefined,
    km: a ? +km(a.distance) : undefined,
    duration: a ? durStr(a.moving_time) : undefined,
    pace: a ? paceStr(a.average_speed) : undefined,
    hrAvg: a?.average_heartrate ? Math.round(a.average_heartrate) : null,
    ef: a && efficiencyFactor(a) ? +efficiencyFactor(a).toFixed(3) : null,
    decouplingPct: decoupling(streams),
    zones: timeInZones(streams, hrMax),
    splits: detail.splits,
    laps: detail.laps,
    trimp: a && trimp(a, hrMax, hrRest) ? Math.round(trimp(a, hrMax, hrRest)) : null,
  };
}

function toolComputeStats(ctx, input) {
  const days = Math.min(Math.max(Number(input?.days) || 56, 7), 370);
  const { hrMax, hrRest } = ctx.profile;
  switch (input?.metric) {
    case 'summary': {
      const s = buildSummary(ctx.activities, { hrMax, hrRest });
      return {
        acwr: s.acwr, acwrStatus: s.acwrStatus, efChangePct: s.efChangePct,
        weeks: s.weeks, consecutiveRunDays14d: s.consecutiveRunDays14d,
      };
    }
    case 'acwr':
      return { days, series: acwrSeries(ctx.activities, hrMax, hrRest, days) };
    case 'ef_trend': {
      const trend = efTrend(ctx.activities, hrMax);
      return { changePct: efChange(trend), points: trend };
    }
    case 'weekly_volume':
      return { weeks: weeklyVolume(ctx.activities, Math.max(1, Math.round(days / 7))) };
    default:
      return { error: `Unknown metric "${input?.metric}". Use summary, acwr, ef_trend or weekly_volume.` };
  }
}

export async function executeTool(ctx, name, input, budget) {
  if (name === 'list_activities') return toolListActivities(ctx, input, budget);
  if (name === 'get_activity_details') return toolActivityDetails(ctx, input, budget);
  if (name === 'compute_stats') return toolComputeStats(ctx, input);
  return { error: `Unknown tool ${name}` };
}

// The loop. onStep(label) fires as each tool call starts; the client shows it.
// Tool results go back in one user message, with a second cache breakpoint on the
// latest one so fetched data stays cached within the conversation.
export async function runCoachAgent({ client, model, system, messages, ctx, onStep }) {
  const msgs = messages.map(({ role, content }) => ({ role, content }));
  const budget = { left: STRAVA_BUDGET };
  const steps = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let call = 1; call <= MAX_CALLS; call++) {
    const last = call === MAX_CALLS;
    const req = {
      model,
      max_tokens: 700,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: msgs,
    };
    if (!last) req.tools = TOOLS; // final call: no tools, so the model must answer
    const resp = await client.messages.create(req);
    if (resp.usage) {
      usage.input_tokens += resp.usage.input_tokens || 0;
      usage.output_tokens += resp.usage.output_tokens || 0;
      usage.cache_read_input_tokens += resp.usage.cache_read_input_tokens || 0;
    }
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
    if (last || resp.stop_reason !== 'tool_use' || !toolUses.length) {
      return { reply: text, steps, usage, calls: call };
    }
    msgs.push({ role: 'assistant', content: resp.content }); // verbatim: keeps thinking blocks valid
    const results = [];
    for (const tu of toolUses) {
      const label = stepLabel(tu, ctx);
      steps.push({ tool: tu.name, input: tu.input, label });
      onStep?.(label);
      const out = await executeTool(ctx, tu.name, tu.input, budget).catch((e) => ({ error: e.message }));
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    results[results.length - 1].cache_control = { type: 'ephemeral' };
    msgs.push({ role: 'user', content: results });
  }
}
