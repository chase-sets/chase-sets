// Reviewed exceptions for scripts/check-structure/business-literal-guard.mjs.
//
// The hardcoded-values audit's debt sweep confirmed zero remaining
// *duplicated* business literals in the milestone's money/deadline/rate-limit
// findings: every clearance window, payout bound, processing/authenticity
// fee, support deadline, rate limit, and listing-gate threshold the audit
// named now resolves through `infrastructure/platform-policy/define-policy.ts`
// (see docs/architecture/platform-policy-conventions.md). This allowlist
// therefore does NOT grandfather any of those values back in.
//
// Every entry below is a *reviewed, out-of-scope* exception the guard would
// otherwise flag, in one of three shapes:
//
//   1. An operational (non-business) window or comparison that predates this
//      milestone and was never a platform-policy candidate -- a single
//      reporting query's own FILTER-clause window, not a value duplicated
//      across functions. (The m107 fraud/velocity heuristic thresholds that
//      used to live in this bucket were migrated onto `definePolicy` by
//      the settlement and platform-operations trust-and-safety policies --
//      see `bounded-contexts/settlement/features/wallets/domain/fraud-velocity-policy.ts`
//      and `bounded-contexts/platform-operations/features/risk-alerts/domain/risk-alert-threshold-policy.ts`.)
//   2. A page-size / result-count constant that only coincidentally matches
//      the curated `_LIMIT` suffix.
//   3. A pre-existing business-shaped threshold outside the audit's Tier
//      ledger, tracked here as a named future-migration candidate rather than
//      silently ignored.
//
// Entry shape: { file, pattern?, reason, owner, ref }.
//   - `file` is repo-root-relative.
//   - `pattern`, when present, must appear in the matched violation snippet;
//     omit it only to suppress an entire file (use sparingly -- prefer a
//     snippet pattern so unrelated new literals in the same file still fail).
//   - `reason` must explain why the literal is NOT a duplicated business
//     value needing platform-policy, not just "pre-existing".
//   - `ref` points at the issue/PR that reviewed the exception.
//
// The guard ratchets: when an entry's file gets a platform-policy migration
// slice, delete the entry in the same PR.
export const businessLiteralAllowlist = [
  {
    file: "bounded-contexts/settlement/features/payouts/read-model/queries.ts",
    pattern: "INTERVAL '7 days'",
    reason:
      "Payout risk-summary lookback window (getAccountPayoutRiskSummary): a single reporting query's FILTER clauses, not a value duplicated across functions -- the historical bug pattern this guard exists to catch.",
    owner: "settlement",
    ref: "#4293",
  },
  {
    file: "bounded-contexts/discovery/features/search/domain/relevance-evaluation.ts",
    pattern: "RELEVANCE_RESULT_LIMIT",
    reason:
      "Search-relevance result-count cap, not a money/deadline/rate business value -- a page-size-shaped constant that only coincidentally matches the curated _LIMIT suffix.",
    owner: "discovery",
    ref: "#4293",
  },
  {
    file: "bounded-contexts/marketplace/features/reports/api/runtime.ts",
    pattern: "LISTING_REPORT_AUTO_UNLIST_THRESHOLD",
    reason:
      "Report-count auto-unlist threshold predates and is outside the m110 audit's Tier 1-3 findings ledger (epic #4294 only tiered the $250 listing-gate + 3-review minimum). Named here as a future migration candidate rather than silently ignored.",
    owner: "marketplace",
    ref: "#4293",
  },
];
