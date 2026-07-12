/**
 * Compiled bounds for the RepricingPolicy aggregate's rule pipeline.
 *
 * These are seller-facing AUTHORING limits (how large/aggressive a policy a
 * seller may author), not the m110 `definePolicy` platform-policy machinery
 * -- see bounded-contexts/pricing/README.md's "Core Aggregates" note on why
 * RepricingPolicy is a seller-owned domain aggregate with its own bounds,
 * distinct in kind from m110's operational/platform-tier policy values.
 *
 * There is no seller-tier policy-resolution machinery in Pricing yet to
 * source these from (that lands, if ever needed, as its own slice). Until
 * then these are documented compiled defaults -- a single, obviously-named
 * seam. If a future slice needs these to vary per seller tier, replace every
 * reference below with the resolved value at its one call site in
 * domain/domain.ts -- no other file should hard-code these numbers.
 */

/** First-match-wins rule pipeline length cap (design doc: "Rule-count cap (~20)"). */
export const REPRICING_POLICY_RULE_CAP = 20;

/** Longest an anchor fallback chain may be before it stops meaningfully narrowing the search. */
export const REPRICING_POLICY_ANCHOR_CHAIN_CAP = 5;

/** Comp-percentile anchors must reference a percentile strictly between these bounds. */
export const REPRICING_POLICY_COMP_PERCENTILE_MIN = 1;
export const REPRICING_POLICY_COMP_PERCENTILE_MAX = 99;

/** Seller-authored percentage fields (offset, ceiling, tolerance, margin) are bounded to this magnitude. */
export const REPRICING_POLICY_PERCENT_MAGNITUDE_CAP = 1000;

/** Per-evaluation max-move is a fraction of the anchor; it cannot exceed the anchor itself. */
export const REPRICING_POLICY_MAX_MOVE_PERCENT_CAP = 100;

/** Daily change-budget bounds (the epic's "budgets/kill switches" guardrail). */
export const REPRICING_POLICY_MIN_CHANGES_PER_DAY = 1;
export const REPRICING_POLICY_MAX_CHANGES_PER_DAY_CAP = 500;
