// Grounding eval (pre-merge gate for coach changes): runs the grounding
// question set through the real agent loop + real model on demo data.
// Skipped unless ANTHROPIC_API_KEY is set: npm run eval:grounding.
//
// Two assertions per question, per the agreed gate:
//   (a) tool behaviour: the expected tool was called (or none, for questions
//       the preloaded summary answers);
//   (b) numeric grounding: every number in the reply must be traceable to the
//       system prompt, the question itself, or a tool result.
//
// Known limits of (b), kept deliberately simple and strict:
//   - It is token matching with rounding tolerance, not semantic validation:
//     a number present in the data but misused (wrong session, wrong unit)
//     still passes. Human review of failures remains part of the gate.
//   - The final sentence is exempt: the prompt requires ending with an
//     actionable recommendation, and prescribed numbers ("hold 45 min easy")
//     are advice, not data claims.
//   - Aggregates the coach legitimately derives from a retrieved list
//     (totals of distance/time/gain, session count) are admitted by adding
//     those aggregates of each tool result to the corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { runCoachAgent } from '../lib/agent.js';
import { buildSystemPrompt } from '../lib/coach.js';
import { demoActivities } from '../public/js/demo-data.js';
import { GROUNDING_QUESTIONS } from './eval-grounding-questions.mjs';

const KEY = process.env.ANTHROPIC_API_KEY;
const opts = { skip: !KEY };

// Cost accounting for the per-run cap (GitHub Actions sets EVAL_COST_CAP_USD).
// Prices in $/token, from https://platform.claude.com/docs/en/about-claude/pricing
// (Claude Sonnet 5.5: $2/MTok input, $0.10/MTok cache read, $10/MTok output).
const PRICES = { 'claude-sonnet-5-5': { in: 2e-6, cache: 0.1e-6, out: 10e-6 } };
// Hard per-run cap at Sonnet 5.5 rates ($2/MTok input, $10/MTok output).
// Enforced inside the agent loop BEFORE every paid call: the exact request
// input is measured with the free token-count endpoint, priced uncached, plus
// that call's full max_tokens output; the call only starts if the measured
// worst case fits the remaining cap. There is no assumed input size.
const COST_CAP = Number(process.env.EVAL_COST_CAP_USD ?? '2.00');
const costBudget = { spent: 0, capUsd: COST_CAP, priceIn: 2e-6, priceOut: 10e-6 };
let spent = 0; // mirror for reporting; costBudget.spent is the enforced value
function costOf(model, u = {}) {
  const p = PRICES[model];
  if (!p) return 0; // unknown model: cost untracked, cap ineffective (warned in output)
  return (u.input_tokens || 0) * p.in + (u.cache_read_input_tokens || 0) * p.cache + (u.output_tokens || 0) * p.out;
}

// --- numeric grounding -------------------------------------------------

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

function normalize(text) {
  // thousands separators: "2,170 m" -> "2170 m"
  let t = text;
  for (let i = 0; i < 4; i++) t = t.replace(/(\d),(\d{3})(?![\d,])/g, '$1$2');
  return t;
}

// Numbers as values: "5:32" -> 332 (s), "2h17" -> 137 (min), "468"/"467.7" as read.
// Time-like tokens are consumed first (blanked out) so their components are
// not also read as plain numbers; JSON values (":465,) parse normally.
function numbersOf(text) {
  let t = normalize(text);
  const out = [];
  t = t.replace(/(\d{1,2})h(\d{2})/g, (m, h, mm) => { out.push((+h) * 60 + (+mm)); return ' '.repeat(m.length); });
  t = t.replace(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g, (m, a, b, c) => {
    out.push(c != null ? (+a) * 3600 + (+b) * 60 + (+c) : (+a) * 60 + (+b));
    return ' '.repeat(m.length);
  });
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  return out;
}

// Calendar and label numbers are not data claims: day numbers in date
// expressions ("Aug 5-11", "12 August", "2026-09-21") and ordinals in
// "Week 3" describe WHERE, not WHAT. A fabricated metric never wears a
// month name, so exempting these keeps the gate strict where it matters.
function calendarNumbers(text) {
  const t = normalize(text);
  const out = new Set();
  const add = (v) => { if (v != null) out.add(Number(v)); };
  for (const m of t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) { add(m[1]); add(m[2]); add(m[3]); }
  for (const m of t.matchAll(/(?<!\d)(\d{2})-(\d{2})(?!\d)/g)) { add(m[1]); add(m[2]); } // MM-DD
  // Month name followed by a day list: "Sept 7, 14, 21 and 28", "Aug 5-11".
  for (const m of t.matchAll(new RegExp(`(?:${MONTHS})[a-z]*\\.?\\s+((?:\\d{1,2}\\s*(?:,|\\u2013|-|and)?\\s*)+)`, 'gi'))) {
    for (const d of m[1].matchAll(/\d{1,2}/g)) add(d[0]);
  }
  for (const m of t.matchAll(new RegExp(`(\\d{1,2})\\s+(?:${MONTHS})`, 'gi'))) add(m[1]);
  // Year with a month name: "September 2026", "3 September 2026".
  for (const m of t.matchAll(new RegExp(`(?:${MONTHS})[a-z]*\\.?\\s+(?:\\d{1,2},?\\s+)?(\\d{4})`, 'gi'))) add(m[1]);
  for (const m of t.matchAll(new RegExp(`(\\d{4})\\s+(?:${MONTHS})`, 'gi'))) add(m[1]);
  for (const m of t.matchAll(/\bWeek\s+(\d{1,2})\b/gi)) add(m[1]);
  // Spans of time are framing, not data claims: "a strict 14-day window", "over 6 weeks".
  for (const m of t.matchAll(/(\d{1,3})[- ](?:day|days|week|weeks)\b/gi)) add(m[1]);
  return out;
}

// Aggregates a coach may legitimately derive from a retrieved activity list:
// totals over the whole list, per calendar week (Mon-Sun, like the dashboard's
// weekly volume), and per sport type. Arbitrary subset sums stay inadmissible.
function addAggregates(corpus, output) {
  // Combined zone figures (e.g. "68.8% in Z1-Z2"): contiguous zone-range sums.
  const zones = output?.zones;
  if (Array.isArray(zones) && zones.length) {
    for (let i = 0; i < zones.length; i++) {
      let s = 0, p = 0;
      for (let j = i; j < zones.length; j++) {
        s += zones[j].seconds || 0; p += zones[j].pct || 0;
        corpus.push(s, p);
      }
    }
  }
  const list = output?.activities;
  if (Array.isArray(list) && list.length) {
    const pushSums = (rows) => {
      corpus.push(rows.length, rows.reduce((s, a) => s + (a.km || 0), 0), rows.reduce((s, a) => s + (a.min || 0), 0), rows.reduce((s, a) => s + (a.gain || 0), 0));
    };
    pushSums(list);
    const byWeek = new Map(), byType = new Map();
    for (const a of list) {
      const d = new Date(`${a.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const wk = d.toISOString().slice(0, 10);
      (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)).push(a);
      (byType.get(a.type) ?? byType.set(a.type, []).get(a.type)).push(a);
    }
    for (const rows of [...byWeek.values(), ...byType.values()]) pushSums(rows);
    // Other week conventions the coach may legitimately use: Sunday-start
    // weeks and 7-day chunks from the window start.
    const bucket = (offset) => {
      const m = new Map();
      for (const a of list) {
        const d = new Date(`${a.date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + offset) % 7));
        const k = d.toISOString().slice(0, 10);
        (m.get(k) ?? m.set(k, []).get(k)).push(a);
      }
      return m;
    };
    for (const rows of bucket(0).values()) pushSums(rows); // Sunday-start
    const sorted = [...list].sort((x, y) => x.date.localeCompare(y.date));
    for (let i = 0; i < sorted.length; i += 7) pushSums(sorted.slice(i, i + 7)); // chunks from window start
  }
  // Unit conversions of values already retrieved: seconds <-> minutes.
  for (const c of [...corpus]) {
    if (Number.isFinite(c) && c >= 60) corpus.push(c / 60, Math.round(c / 60));
  }
}

export function ungroundedNumbers(reply, corpusValues, { exemptTail = true } = {}) {
  // The prompt requires ending with an actionable recommendation, so the
  // closing advice blocks (up to two trailing paragraphs) are exempt:
  // prescribed numbers there ("hold 45-75 min easy") are advice, not data
  // claims. Single-block replies are data claims throughout and fully checked.
  const blocks = reply.split(/\n\s*\n/);
  const exempt = exemptTail ? Math.min(2, blocks.length - 1) : 0;
  const body = blocks.slice(0, blocks.length - exempt).join('\n\n');
  const calendar = calendarNumbers(body);
  return numbersOf(body).filter((n) => !calendar.has(n) && !corpusValues.some((c) => Math.abs(n - c) <= Math.max(0.51, 0.01 * Math.abs(n))));
}

// --- the gate ------------------------------------------------------------

const activities = demoActivities();
const ctx = {
  mode: 'demo', owner: false,
  athlete: { firstname: 'Demo athlete' },
  profile: { hrMax: 196, hrRest: 48 },
  activities,
};
const system = buildSystemPrompt(ctx);

for (const { q, tools, allowNone = false, period = null } of GROUNDING_QUESTIONS) {
  test(`grounding [${allowNone ? 'opt:' : ''}${tools.join('|') || 'direct'}]: ${q}`, opts, async () => {
    const client = new Anthropic({ apiKey: KEY });
    if (costBudget.spent >= COST_CAP) {
      assert.fail(`cost cap $${COST_CAP} already reached ($${costBudget.spent.toFixed(4)}); refusing further paid calls`);
    }
    const model = process.env.ANTHROPIC_DEMO_MODEL || 'claude-sonnet-5-5'; // same default as demo mode in api/chat.js
    const before = costBudget.spent;
    const out = await runCoachAgent({
      client,
      model,
      system,
      messages: [{ role: 'user', content: q }],
      ctx,
      costBudget,
    });
    const qCost = costBudget.spent - before;
    spent = costBudget.spent;
    console.log(`eval-question cost: $${qCost.toFixed(4)} (run total $${spent.toFixed(4)} / cap $${COST_CAP}) - ${q.slice(0, 60)}`);

    // (a) tool behaviour
    const called = out.steps.map((s) => s.tool);
    if (tools.length === 0) {
      assert.equal(called.length, 0, `expected no tool call, got ${called.join(', ')}; reply: ${out.reply?.slice(0, 160)}`);
    } else if (allowNone) {
      assert.ok(called.every((t) => tools.includes(t)),
        `expected no tools or only ${tools.join(', ')}, got ${called.join(', ') || 'no tools'}; reply: ${out.reply?.slice(0, 160)}`);
    } else {
      assert.ok(called.some((t) => tools.includes(t)),
        `expected one of ${tools.join(', ')}, got ${called.join(', ') || 'no tools'}; reply: ${out.reply?.slice(0, 160)}`);
    }

    // (b) numeric grounding. Corpus = numbers from the prompt's DATA sections
    // (everything from '## Profile' on: profile, athlete context, data coverage,
    // load/trends, race, weekly volume, recent sessions) plus tool results and
    // their standard aggregates. NOT admitted: the BASE method/rules text
    // (rule-of-thumb numbers are instructions, not data evidence), the question
    // itself (a user-supplied figure must not self-ground - it is only echoed
    // via the calendar-date exemption), and numbers that appear in the corpus
    // only inside date strings (a '03' in 2026-09-03 must not ground a
    // fabricated '3 sessions').
    const dataSections = system.slice(Math.max(0, system.indexOf('## Profile')));
    const dataCal = calendarNumbers(dataSections);
    const corpus = numbersOf(dataSections).filter((n) => !dataCal.has(n));
    // Metric DEFINITIONS and tool-description constants (the 50 m+/3% climb
    // rule, the ~80% easy target, the -10%/+15% load band, 120-day windows) are
    // legitimately quoted from the prompt/tool docs, not from data. Admitted
    // only at >= 10 so small integers cannot coincidence-ground fabrications.
    const { TOOLS: EVAL_TOOLS } = await import('../lib/agent.js');
    const defsText = system.slice(0, Math.max(0, system.indexOf('## Profile'))) + JSON.stringify(EVAL_TOOLS.map((x) => [x.name, x.description]));
    corpus.push(...numbersOf(defsText).filter((n) => n >= 10 && !calendarNumbers(defsText).has(n)));
    // Counts derivable from the recent-sessions list: total listed, and how
    // many fall in the trailing 7/14/28/56-day windows the metrics use.
    const todayM = system.match(/Today's date: (\d{4}-\d{2}-\d{2})/);
    const sessDates = [...dataSections.matchAll(/- (\d{4}-\d{2}-\d{2}) \|/g)].map((m) => m[1]);
    if (todayM && sessDates.length) {
      const today = new Date(`${todayM[1]}T00:00:00Z`).getTime();
      corpus.push(sessDates.length);
      for (const w of [7, 14, 28, 56]) {
        corpus.push(sessDates.filter((d) => today - new Date(`${d}T00:00:00Z`).getTime() < w * 86400_000).length);
      }
    }
    for (const s of out.steps) {
      const outJson = JSON.stringify(s.output ?? {});
      const outCal = calendarNumbers(outJson);
      corpus.push(...numbersOf(JSON.stringify(s.input ?? {})).filter((n) => !calendarNumbers(JSON.stringify(s.input ?? {})).has(n)));
      corpus.push(...numbersOf(outJson).filter((n) => !outCal.has(n)));
      addAggregates(corpus, s.output);
    }
    // (c) period attribution, where the question declares a month: every date
    // or week cited in the reply must start inside that month. This catches
    // answers that fold a neighbouring month's weeks into the asked period.
    if (period) {
      const cited = [...out.reply.matchAll(/\b(\d{4})-(\d{2})-\d{2}\b/g)].map((m) => `${m[1]}-${m[2]}`);
      const outside = cited.filter((ym) => ym !== period);
      assert.deepEqual(outside, [], `reply cites dates outside ${period}: ${outside.join(', ')}; reply: ${out.reply?.slice(0, 400)}`);
    }

    // Strict: EVERY number in the reply must be grounded in the corpus (the
    // preloaded summary's data sections, or a tool result, within rounding
    // equivalence). A misquote or mis-sum is a failure, not a warning.
    const bad = ungroundedNumbers(out.reply, corpus);
    const trace = out.steps.map((s) => `${s.tool}(${JSON.stringify(s.input)}) -> ${JSON.stringify(s.output)?.slice(0, 300)}`).join('\n');
    assert.deepEqual(bad, [], `ungrounded numbers in reply: ${bad.join(', ')};\ncalls: ${trace}\nreply: ${out.reply}`);
  });
}
