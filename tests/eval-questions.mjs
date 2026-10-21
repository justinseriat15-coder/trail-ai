// Eval set: questions paired with the tool behaviour a correct agent shows.
// The mock-free harness (tests/eval.test.js) runs these against the real API
// only when ANTHROPIC_API_KEY is set (npm run eval); the unit suite checks the
// set is well-formed. 'fetch' = at least one tool call; 'direct' = no tool call.
export const EVAL_QUESTIONS = [
  { q: 'How was my run on Sunday?', expect: 'direct' },
  { q: 'Am I overreaching right now?', expect: 'direct' },
  { q: 'What was my longest run in the last two weeks?', expect: 'direct' },
  { q: 'Analyse my long run from 18 October second by second.', expect: 'fetch' },
  { q: 'Compare my volume this month with 12 weeks ago.', expect: 'fetch' },
  { q: 'What did my training look like in the first half of July?', expect: 'fetch' },
  { q: 'How has my climbing speed changed over the last 12 weeks?', expect: 'fetch' },
  { q: 'How much time did I spend in each heart-rate zone during my last threshold session?', expect: 'fetch' },
  { q: 'Am I ready for my race? What is holding me back?', expect: 'direct' },
  { q: 'What should I do tomorrow?', expect: 'direct' },
  { q: 'How many sessions did I do in September, and what was the total distance?', expect: 'fetch' },
];
