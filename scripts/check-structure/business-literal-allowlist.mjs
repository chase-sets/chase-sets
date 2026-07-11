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
//      milestone and was never a platform-policy candidate -- fraud/velocity
//      heuristics and risk-summary reporting windows, which are m107 trust &
//      safety territory, not m110's Tier 1-3 money/deadline/rate-limit list.
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
    file: "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-projection.ts",
    reason:
      "Chargeback/listing/review/buyer-spend velocity-flag thresholds and windows are m107 trust-and-safety fraud-detection heuristics, not part of the m110 audit's Tier 1-3 findings ledger (epic #4294). Tracked as a future migration candidate under trust & safety hardening, not this milestone.",
    owner: "settlement",
    ref: "#4293",
  },
  {
    file: "bounded-contexts/platform-operations/features/risk-alerts/read-model/projection.ts",
    reason:
      "Companion velocity-counter windows for the settlement account-risk-source projection above; same m107 trust-and-safety scope, same out-of-Tier-ledger disposition.",
    owner: "platform-operations",
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
