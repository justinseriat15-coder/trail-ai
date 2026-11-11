// Checked-in paid-call budget for the eval gate. The workflow's
// EVAL_COST_CAP_USD is a hard ceiling; this file can only TIGHTEN it for a
// scoped phase. 2026-11-11: the owner set a EUR 1 rest-of-work budget
// (CI + the final production validation share it); 0.80 USD here reserves
// room for the production question inside that cap. Restore to null when the
// phase ends. Set null to defer entirely to the workflow ceiling.
export const EVAL_BUDGET_CAP_USD = 0.80;
