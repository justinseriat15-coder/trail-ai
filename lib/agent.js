// The coach agent: one model call that decides for itself whether to fetch data.
// Hybrid by design: the cached summary in the system prompt covers the common
// questions; the three tools below cover everything beyond it. No router, no
// forced tool use. The loop is capped at MAX_CALLS model calls per question and
// the last call is always made without tools, so it must end in a written answer.
//
// The Anthropic client is injected so tests can run the whole loop with a mock.
import {
  buildSummary, weeklyVolume, timeInZones, decoupling,
  paceStr, km, durStr,
} from '../public/js/analytics.js';
import { fetchActivitiesCached, fetchActivityDetail } from './strava.js';
import { loadStreams } from './data.js';

const MAX_CALLS = 8;
const STRAVA_BUDGET = 6; // live Strava calls per question (demo never calls Strava)
// claude-sonnet-5-5 thinks by default and thinking tokens count against
// max_tokens. 700 (the old budget) is starved by thinking alone on harder
// questions: the API returns stop_reason "max_tokens" with only thinking
// blocks and no text, which used to surface as an empty reply. Start with
// room for thinking plus a full answer; if a call still comes back truncated
// (stop_reason "max_tokens"), retry it with more headroom up to the cap.
const MAX_TOKENS = 4096;
const MAX_TOKENS_CAP = 8192;

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
      'Second-by-second analysis of one session by id: time in heart-rate zones, pace and HR per kilometre (splits), laps, and cardiac drift (Pa:HR decoupling, meaningful for flat runs only). Use it when the athlete asks about a specific session in depth, or names one the summary lists.',
    input_schema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'The activity id (the summary lists ids for recent sessions).' } },
      required: ['id'],
    },
  },
  {
    name: 'compute_stats',
    description:
      'Compute a metric deterministically, with the same functions the dashboard uses. Prefer this over estimating from raw sessions, and NEVER total or average a session list yourself - mental arithmetic over many rows drifts; use "period" for any total or average. metric: "summary" (load vs usual, easy share, climbing speed, aerobic engine, weekly volume), "climb_trend" (climbing-speed points and change), "engine_trend" (pace at easy heart rate, points and change), "weekly_volume" (time and elevation gain per week), "race_readiness" (limiting factor and the two checks against the target race, climbing speed as context), "period" (exact totals and averages over a date window: pass after/before YYYY-MM-DD, inclusive; use this for any "how much in <month>" question). days is the lookback window for the trend metrics (default 56).',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['summary', 'climb_trend', 'engine_trend', 'weekly_volume', 'race_readiness', 'period'] },
        after: { type: 'string', description: 'For metric "period": start of window, YYYY-MM-DD, inclusive.' },
        before: { type: 'string', description: 'For metric "period": end of window, YYYY-MM-DD, inclusive.' },
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
    if (tu.input?.metric === 'period') return `Computing totals for ${tu.input?.after || '...'} to ${tu.input?.before || 'today'}...`;
    const names = { summary: 'training summary', climb_trend: 'climbing-speed trend', engine_trend: 'aerobic-engine trend', weekly_volume: 'weekly volume', race_readiness: 'race readiness' };
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
    decouplingPct: decoupling(streams),
    zones: timeInZones(streams, hrMax),
    splits: detail.splits,
    laps: detail.laps,
  };
}

async function toolComputeStats(ctx, input, budget) {
  const days = Math.min(Math.max(Number(input?.days) || 56, 7), 370);
  const { hrMax, hrRest } = ctx.profile;
  const perActivity = ctx.insights?.perActivity || {};
  const summary = () => buildSummary(ctx.activities, { hrMax, hrRest, perActivity, race: ctx.race });
  if (input?.metric === 'period') {
    const after = /^\d{4}-\d{2}-\d{2}$/.test(input?.after || '') ? input.after : null;
    const before = /^\d{4}-\d{2}-\d{2}$/.test(input?.before || '') ? input.before : null;
    if (!after && !before) return { error: 'metric "period" needs after and/or before (YYYY-MM-DD, inclusive).' };
    let source = ctx.activities;
    if (ctx.mode !== 'demo') {
      // Live: the preload holds ~120 days; fetch the exact window so older
      // periods are computed from real data, not silently empty.
      if (budget && budget.left <= 0) return { error: 'Live data budget reached for this question; answer from the data already retrieved.' };
      if (budget) budget.left--;
      source = await fetchActivitiesCached(ctx.session, { after, before });
    }
    const rows = source.filter((x) => {
      const d = String(x.start_date_local).slice(0, 10);
      return (!after || d >= after) && (!before || d <= before);
    });
    if (!rows.length) return { after, before, count: 0, note: 'No sessions in this window. Say so; never estimate a total.' };
    const sum = (f) => rows.reduce((s, x) => s + (x[f] || 0), 0);
    const kmTotal = +(sum('distance') / 1000).toFixed(1);
    const gainTotal = Math.round(sum('total_elevation_gain'));
    const mins = Math.round(sum('moving_time') / 60);
    const withHr = rows.filter((x) => x.average_heartrate);
    return {
      after, before, count: rows.length, kmTotal, gainTotal,
      hoursTotal: +(mins / 60).toFixed(1),
      avgHr: withHr.length ? Math.round(withHr.reduce((s, x) => s + x.average_heartrate, 0) / withHr.length) : null,
      longestKm: +Math.max(0, ...rows.map((x) => x.distance / 1000)).toFixed(1),
      note: 'Exact totals computed over the sessions whose dates lie inside this window. Quote these; do not re-add them yourself.',
    };
  }
  switch (input?.metric) {
    case 'summary': {
      const s = summary();
      return {
        load: { deltaPct: s.load.deltaPct, label: s.loadReading.label },
        easyShare: s.easyShare,
        climbNowMph: s.climbNow,
        climbChangePct: s.climb.changePct,
        engine: { latestSecPerKm: s.engine.latestSecPerKm, refHr: s.engine.refHr, changePct: s.engine.changePct },
        weeks: s.weeks,
      };
    }
    case 'race_readiness': {
      const s = summary();
      if (!s.race) return { error: 'No race target is set, so there is no race readiness to compute. The owner can set one with the RACE_TARGET setting.' };
      return { race: s.race.race, limiting: s.race.limiting, parts: s.race.parts, context: s.race.context, sentence: s.race.sentence, note: 'Rules of thumb. No average by design: the weaker of the two checks is the score. Climbing speed is context only.' };
    }
    case 'climb_trend': {
      const s = summary();
      return { days, points: s.climb.points, changePct: s.climb.changePct };
    }
    case 'engine_trend': {
      const s = summary();
      return { days, points: s.engine.points, refHr: s.engine.refHr, changePct: s.engine.changePct };
    }
    case 'weekly_volume':
      return { weeks: weeklyVolume(ctx.activities, Math.max(1, Math.round(days / 7))) };
    default:
      return { error: `Unknown metric "${input?.metric}". Use summary, climb_trend, engine_trend, weekly_volume or race_readiness.` };
  }
}

export async function executeTool(ctx, name, input, budget) {
  if (name === 'list_activities') return toolListActivities(ctx, input, budget);
  if (name === 'get_activity_details') return toolActivityDetails(ctx, input, budget);
  if (name === 'compute_stats') return toolComputeStats(ctx, input, budget);
  return { error: `Unknown tool ${name}` };
}

// The loop. onStep(label) fires as each tool call starts; the client shows it.
// Tool results go back in one user message, with a second cache breakpoint on the
// latest one so fetched data stays cached within the conversation.
// Defaults chosen by A/B on the coach's five benchmark questions (2026-11-10,
// demo dataset, claude-sonnet-5-5): medium effort + thinking only between tool
// calls matched the answer quality of default thinking with zero up-front
// thinking tokens, so it is cheaper per question and far harder to starve.
// Some models reject the tuning knobs (Haiku: no effort, no thinking). Remember
// what a model rejected for the life of the process and drop that knob, so one
// code path serves thinking and non-thinking models.
const unsupported = new Map(); // model -> { effort?: bool, thinking?: bool }

export async function runCoachAgent({ client, model, system, messages, ctx, onStep, onText, costBudget = null, effort = 'medium', thinking = { type: 'between_tools' } }) {
  const msgs = messages.map(({ role, content }) => ({ role, content }));
  const budget = { left: STRAVA_BUDGET };
  const steps = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, thinking_tokens: 0 };
  let maxTokens = MAX_TOKENS;

  for (let call = 1; call <= MAX_CALLS; call++) {
    const last = call === MAX_CALLS;
    const req = {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: msgs,
    };
    if (!last) req.tools = TOOLS; // final call: no tools, so the model must answer
    const uns = unsupported.get(model) || {};
    if (effort && !uns.effort) req.output_config = { effort }; // medium: quality per credit on a thinking-by-default model
    if (thinking && !uns.thinking) req.thinking = thinking;
    if (costBudget) {
      // Hard pre-call cap (eval gate). The input is MEASURED with the free
      // token-count endpoint for this exact request (system + messages +
      // tools), priced at uncached rates, plus this call's full max_tokens
      // output. No paid call starts unless its measured worst case fits the
      // remaining cap - the stop lands BEFORE the expense, not after.
      const countReq = { model, system: req.system, messages: msgs };
      if (req.tools) countReq.tools = req.tools;
      const counted = await client.messages.countTokens(countReq);
      const inTok = counted?.input_tokens ?? 0;
      const worst = inTok * costBudget.priceIn + req.max_tokens * costBudget.priceOut;
      if (costBudget.spent + worst > costBudget.capUsd) {
        throw Object.assign(
          new Error(`EVAL_COST_CAP: spent $${costBudget.spent.toFixed(4)} + next call worst case $${worst.toFixed(4)} (${inTok} input tokens, max_tokens ${req.max_tokens}) exceeds cap $${costBudget.capUsd}`),
          { code: 'EVAL_COST_CAP' },
        );
      }
    }
    let resp;
    try {
      if (onText && typeof client.messages.stream === 'function') {
        // Streamed: text deltas flow to the chat as they are written.
        // Thinking blocks between tool calls are not text deltas, so only the
        // coach's actual words ever reach the bubble.
        const stream = client.messages.stream(req);
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') onText(event.delta.text);
        }
        resp = await stream.finalMessage();
      } else {
        resp = await client.messages.create(req);
      }
    } catch (e) {
      const msg = String(e?.error?.error?.message || e?.message || '');
      if (e?.status === 400 && /not support/i.test(msg) && /effort/i.test(msg)) {
        unsupported.set(model, { ...unsupported.get(model), effort: true });
        call--; continue; // retry without the effort knob
      }
      if (e?.status === 400 && /not supported/i.test(msg) && /thinking/i.test(msg)) {
        unsupported.set(model, { ...unsupported.get(model), thinking: true });
        call--; continue; // retry without the thinking knob
      }
      throw e;
    }
    if (resp.usage && costBudget) {
      // Actual billed usage at conservative rates (cache write 1.25x input,
      // cache read 0.1x input); thinking tokens bill as output already.
      const u = resp.usage;
      costBudget.spent += (u.input_tokens || 0) * costBudget.priceIn
        + (u.cache_creation_input_tokens || 0) * costBudget.priceIn * 1.25
        + (u.cache_read_input_tokens || 0) * costBudget.priceIn * 0.1
        + (u.output_tokens || 0) * costBudget.priceOut;
    }
    if (resp.usage) {
      usage.input_tokens += resp.usage.input_tokens || 0;
      usage.output_tokens += resp.usage.output_tokens || 0;
      usage.cache_read_input_tokens += resp.usage.cache_read_input_tokens || 0;
      usage.thinking_tokens += resp.usage.output_tokens_details?.thinking_tokens || 0;
    }
    if (resp.stop_reason === 'max_tokens') {
      // Thinking ate the whole budget (or a tool call was cut off mid-block).
      // A truncated turn can never be echoed back (thinking signatures, partial
      // tool inputs), so it is discarded and retried with more headroom.
      if (maxTokens < MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
        call--;
        continue;
      }
      throw new Error('The coach could not finish an answer within the token budget. Please try again.');
    }
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
    if (last || resp.stop_reason !== 'tool_use' || !toolUses.length) {
      // Never hand back an empty reply: the client stores what it is given, and
      // an empty assistant turn breaks every later message in the conversation.
      if (!text) throw new Error('The coach returned an empty reply. Please try again.');
      return { reply: text, steps, usage, calls: call };
    }
    msgs.push({ role: 'assistant', content: resp.content }); // verbatim: keeps thinking blocks valid
    const results = [];
    for (const tu of toolUses) {
      const label = stepLabel(tu, ctx);
      steps.push({ tool: tu.name, input: tu.input, label });
      onStep?.(label);
      const out = await executeTool(ctx, tu.name, tu.input, budget).catch((e) => ({ error: e.message }));
      // Keep the raw tool result on the step (server-side only; api/chat forwards
      // labels to the client, never outputs). The grounding eval checks every
      // number in the reply against these results plus the preloaded summary.
      steps[steps.length - 1].output = out;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    results[results.length - 1].cache_control = { type: 'ephemeral' };
    msgs.push({ role: 'user', content: results });
  }
}
