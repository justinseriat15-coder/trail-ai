// Grounding eval set: ~15 questions built from the demo dataset's ACTUAL
// coverage, so the set stays valid as time moves on. Each question declares
// the tool behaviour a grounded agent shows:
//   tools: []            -> must answer from the preloaded summary, no tool call
//   tools: [...names]    -> must call at least one of these before answering
// Every question is also checked for numeric grounding: each number in the
// reply must appear in the system prompt, the question itself, or a tool
// result (see tests/eval-grounding.test.js for the exact rule and its limits).
import { demoActivities } from '../public/js/demo-data.js';

const DAY = 86400_000;
const monthName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shift = (iso, days) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);

export function buildGroundingQuestions(activities = demoActivities()) {
  const dates = activities.map((a) => String(a.start_date_local).slice(0, 10)).sort();
  const newest = dates.at(-1);
  const oldest = dates[0];

  // Anchors, all derived from the real dataset:
  const recentLong = activities.find((a) => (a.sport_type || a.type) === 'TrailRun');           // in the recent list
  const oldSession = activities.at(-2);                                                          // near the coverage edge, not in the recent list
  const inDataMonth = monthName(shift(newest, -70));                                             // ~10 weeks back: in data, outside the recent list
  const olderInDataMonth = monthName(shift(newest, -84));                                        // for comparisons
  const beyondMonth = monthName(shift(oldest, -40));                                             // before the dataset starts
  const lastYearMonth = monthName(shift(newest, -370));                                          // same month, last year
  const beyondDate = shift(oldest, -14);                                                         // a specific date with no session

  const keyOf = (label) => {
    const d = new Date(`1 ${label} 12:00 UTC`);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  return [
    // --- Answerable from the preloaded summary: no tool call expected ---
    // In-coverage questions: the preloaded summary suffices, so no tool call is
    // required - but pulling fresh detail is equally grounded, so retrieval is
    // optional (allowNone) and only the listed tools are admissible.
    { q: 'Am I ready for my race? What is holding me back?', tools: ['compute_stats'], allowNone: true },
    { q: 'How does my training load compare to usual?', tools: ['compute_stats'], allowNone: true },
    { q: 'What was my longest run in the last two weeks?', tools: ['get_activity_details', 'compute_stats'], allowNone: true },
    // In the recent list, but pulling its second-by-second detail is equally grounded - retrieval optional.
    { q: `How was my long run on ${recentLong ? String(recentLong.start_date_local).slice(0, 10) : 'Sunday'}?`, tools: ['get_activity_details'], allowNone: true },
    { q: 'What should I do tomorrow?', tools: ['compute_stats', 'list_activities'], allowNone: true },

    // --- In the data but outside the preloaded window: retrieval required ---
    { q: `What did my training look like in ${inDataMonth}?`, tools: ['list_activities', 'compute_stats'], period: keyOf(inDataMonth) },
    { q: `How many sessions did I do in ${inDataMonth}?`, tools: ['list_activities', 'compute_stats'] },
    { q: `Compare my weekly volume this month with ${olderInDataMonth}.`, tools: ['list_activities', 'compute_stats'] },
    { q: 'How has my climbing speed changed over the last 12 weeks?', tools: ['compute_stats', 'list_activities'] },
    { q: 'How much time did I spend in each heart-rate zone during my last threshold session?', tools: ['get_activity_details'] },
    ...(oldSession ? [{ q: `Analyse my session "${oldSession.name}" from ${String(oldSession.start_date_local).slice(0, 10)} second by second.`, tools: ['get_activity_details', 'list_activities'] }] : []),

    // --- Outside the dataset entirely: must fetch, find nothing, and say so ---
    { q: `What did my training look like in ${beyondMonth}?`, tools: ['list_activities', 'compute_stats'] },
    // No period marker here: a correct 'no data' answer legitimately cites the coverage boundary (e.g. 'history starts 2026-07').
    { q: `How many kilometres did I run in ${lastYearMonth}?`, tools: ['list_activities', 'compute_stats'] },
    { q: `Find my run from ${beyondDate} and tell me about it.`, tools: ['list_activities', 'get_activity_details'] },
    { q: `Compare my climbing in ${inDataMonth} with ${beyondMonth}.`, tools: ['list_activities', 'compute_stats'] },
  ];
}

export const GROUNDING_QUESTIONS = buildGroundingQuestions();
