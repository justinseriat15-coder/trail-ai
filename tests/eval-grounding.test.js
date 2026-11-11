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
  const patterns = [
    new RegExp(`(?:${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:\\s*[\\u2013-]\\s*(\\d{1,2}))?`, 'gi'),
    new RegExp(`(\\d{1,2})\\s+(?:${MONTHS})`, 'gi'),
    /(\d{4})-(\d{2})-(\d{2})/g,
    /\bWeek\s+(\d{1,2})\b/gi,
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      for (const g of m.slice(1)) if (g != null) out.add(Number(g));
    }
  }
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

for (const { q, tools, allowNone = false } of GROUNDING_QUESTIONS) {
  test(`grounding [${allowNone ? 'opt:' : ''}${tools.join('|') || 'direct'}]: ${q}`, opts, async () => {
    const client = new Anthropic({ apiKey: KEY });
    const out = await runCoachAgent({
      client,
      model: process.env.ANTHROPIC_DEMO_MODEL || 'claude-haiku-4-5-20251001',
      system,
      messages: [{ role: 'user', content: q }],
      ctx,
    });

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

    // (b) numeric grounding: corpus = system prompt + question + tool inputs/outputs
    const corpus = [...numbersOf(system), ...numbersOf(q)];
    for (const s of out.steps) {
      corpus.push(...numbersOf(JSON.stringify(s.input ?? {})));
      corpus.push(...numbersOf(JSON.stringify(s.output ?? {})));
      addAggregates(corpus, s.output);
    }
    const bad = ungroundedNumbers(out.reply, corpus);
    const trace = out.steps.map((s) => `${s.tool}(${JSON.stringify(s.input)}) -> ${JSON.stringify(s.output)?.slice(0, 300)}`).join('\n');
    assert.deepEqual(bad, [], `ungrounded numbers in reply: ${bad.join(', ')};\ncalls: ${trace}\nreply: ${out.reply}`);
  });
}
