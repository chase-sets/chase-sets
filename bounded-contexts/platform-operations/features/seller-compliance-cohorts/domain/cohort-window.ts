import type { SellerSaleFact } from "../../seller-compliance-sales/read-model/queries";
import {
  addUtcMonths as addUtcMonthsFromSales,
  isLookbackAnchorEligible,
} from "../../seller-compliance-sales/read-model/queries";
import type {
  SellerComplianceCohortPolicyValue,
  SellerComplianceClassificationRule,
} from "./seller-compliance-cohort-policy";

export type CohortState = "outside" | "member";
export type DisclosureBand = "none" | "disclosure";
export type CohortEvaluation = Readonly<{
  state: CohortState;
  band: DisclosureBand;
  entryEffectiveAt: string | null;
  /** Effective instant of the band transition this evaluation produces; null when the band does not change. */
  bandEffectiveAt: string | null;
  exitEffectiveAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  nextReevaluationAt: string | null;
  unclassifiableCount: number;
  qualifyingCount: number;
  qualifyingGrossCents: string;
}>;
export const addUtcMonths = addUtcMonthsFromSales;
type Classification = "qualifying" | "unclassifiable" | "excluded";

function fullRefund(sale: SellerSaleFact): boolean {
  return (
    sale.refundedOrderTotalCents !== null &&
    sale.orderRefundCapCents !== null &&
    sale.refundedOrderTotalCents === sale.orderRefundCapCents
  );
}
function matchesRule(value: Record<string, unknown>, rule: SellerComplianceClassificationRule): boolean {
  if (rule.source === "productId" || rule.source === "catalogItemId") return value[rule.source] === rule.value;
  if (rule.source === "selectedOptionId") {
    const options = value.selectedOptions;
    return (
      Array.isArray(options) &&
      options.some((option) => {
        if (typeof option === "string") return option === rule.value;
        if (typeof option !== "object" || option === null) return false;
        const item = option as Record<string, unknown>;
        return item.optionId === rule.value || item.id === rule.value || item.value === rule.value;
      })
    );
  }
  const graded = value.gradedCard;
  if (graded === null || graded === undefined || graded === false) return false;
  if (rule.value === "graded" || rule.value === "true") return true;
  return typeof graded === "string"
    ? graded === rule.value
    : typeof graded === "object" &&
        graded !== null &&
        (graded as Record<string, unknown>).gradingCompany === rule.value;
}
function classify(sale: SellerSaleFact, policy: SellerComplianceCohortPolicyValue): Classification {
  if (
    sale.currencyCode !== policy.currencyCode ||
    sale.saleState !== "captured" ||
    sale.captureAnomalies.length > 0 ||
    sale.refundAnomalies.length > 0 ||
    sale.reconciliationMismatches.length > 0
  )
    return "excluded";
  const isFullyRefunded = fullRefund(sale);
  if (isFullyRefunded && policy.refundTreatment === "exclude-refunded") return "excluded";
  if (
    sale.cancelledAt !== null &&
    (policy.postCaptureCancellationTreatment === "exclude-cancelled" ||
      (isFullyRefunded && policy.postCaptureCancellationTreatment === "exclude-if-fully-refunded"))
  )
    return "excluded";
  const inputs = Array.isArray(sale.classificationInputs) ? sale.classificationInputs : [];
  const rules = policy.classificationRules ?? [];
  if (rules.length === 0)
    return policy.unclassifiableTreatment === "count-unclassifiable" ? "qualifying" : "unclassifiable";
  const lineResults = inputs.map(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      rules.some((rule) => matchesRule(input as Record<string, unknown>, rule)),
  );
  if (lineResults.length === 0 || lineResults.some((matched) => !matched)) {
    if (policy.mixedLineTreatment === "count-mixed" && lineResults.some(Boolean)) return "qualifying";
    return policy.unclassifiableTreatment === "count-unclassifiable" ? "qualifying" : "unclassifiable";
  }
  return "qualifying";
}
function gross(sale: SellerSaleFact, policy: SellerComplianceCohortPolicyValue): bigint | null {
  if (sale.sellerItemNetCents === null || sale.marketplaceSalesFeeCents === null) return null;
  const itemGross = BigInt(sale.sellerItemNetCents) + BigInt(sale.marketplaceSalesFeeCents);
  return policy.qualifyingGrossBasis === "item-gross-plus-shipping" && sale.shippingChargeCents !== null
    ? itemGross + BigInt(sale.shippingChargeCents)
    : itemGross;
}
function threshold(value: string | null): bigint {
  return value === null ? 0n : BigInt(value);
}
type Candidate = Readonly<{
  start: string;
  end: string;
  qualifying: readonly SellerSaleFact[];
  count: number;
  gross: bigint;
}>;
/** `amounts[i]` is the qualifying gross of `sales[i]`, or null when that sale does not qualify. */
function candidateAt(
  start: string,
  sales: readonly SellerSaleFact[],
  amounts: readonly (bigint | null)[],
  policy: SellerComplianceCohortPolicyValue,
): Candidate {
  const end = addUtcMonths(start, policy.windowMonths ?? 1);
  const qualifying: SellerSaleFact[] = [];
  let total = 0n;
  for (const [index, sale] of sales.entries()) {
    const amount = amounts[index] ?? null;
    if (sale.occurredAt < start || sale.occurredAt >= end || amount === null) continue;
    qualifying.push(sale);
    total += amount;
  }
  return { start, end, qualifying, count: qualifying.length, gross: total };
}
function qualifies(
  candidate: Candidate,
  policy: SellerComplianceCohortPolicyValue,
  grossThreshold = threshold(policy.qualifyingGrossCents),
): boolean {
  const inclusive = policy.comparisonIsInclusive ?? true;
  const countThreshold = policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER;
  return (
    (inclusive ? candidate.count >= countThreshold : candidate.count > countThreshold) &&
    (inclusive ? candidate.gross >= grossThreshold : candidate.gross > grossThreshold)
  );
}
function thresholdEffectiveAt(
  candidate: Candidate,
  policy: SellerComplianceCohortPolicyValue,
  grossThreshold: bigint,
): string | null {
  let count = 0;
  let total = 0n;
  for (const sale of candidate.qualifying) {
    count += 1;
    total += gross(sale, policy) ?? 0n;
    const inclusive = policy.comparisonIsInclusive ?? true;
    if (
      (inclusive
        ? count >= (policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER)
        : count > (policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER)) &&
      (inclusive ? total >= grossThreshold : total > grossThreshold)
    )
      return sale.occurredAt;
  }
  return null;
}
/**
 * No span of `months` calendar months exceeds 31 days each, so a sale older than that can never be admissible and
 * skips the calendar check; every other sale is decided by the shared #7144 lookback rule.
 */
function withinCalendarHorizon(occurred: number, at: number, months: number): boolean {
  return at - occurred <= months * 31 * 86_400_000;
}
/** Canonical ISO-8601 UTC instants order chronologically by code unit; ids break ties. */
function bySaleKey(a: SellerSaleFact, b: SellerSaleFact): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.paymentId.localeCompare(b.paymentId) || a.orderId.localeCompare(b.orderId);
}
/** `includeSalesAt` counts a sale occurring exactly at the instant, which dates a sale-caused change at that sale. */
function evaluateAt(
  sales: readonly SellerSaleFact[],
  policy: SellerComplianceCohortPolicyValue,
  evaluationAt: string,
  includeSalesAt = false,
) {
  const at = Date.parse(evaluationAt);
  const lookbackMonths = policy.lookbackMonths ?? 60;
  const eligible = sales
    .filter((sale) => {
      const occurred = Date.parse(sale.occurredAt);
      return (
        (includeSalesAt ? occurred <= at : occurred < at) &&
        withinCalendarHorizon(occurred, at, lookbackMonths) &&
        isLookbackAnchorEligible(sale.occurredAt, lookbackMonths, evaluationAt)
      );
    })
    .sort(bySaleKey);
  const amounts = eligible.map((sale) => (classify(sale, policy) === "qualifying" ? gross(sale, policy) : null));
  let winner: Candidate | null = null;
  for (const sale of eligible) {
    const candidate = candidateAt(sale.occurredAt, eligible, amounts, policy);
    if (qualifies(candidate, policy)) {
      winner = candidate;
      break;
    }
  }
  return {
    at,
    eligible,
    winner,
    bandWinner: winner !== null && qualifies(winner, policy, threshold(policy.disclosureGrossCents)),
  };
}

function isConfigured(policy: SellerComplianceCohortPolicyValue): boolean {
  return (
    policy.activated &&
    policy.currencyCode !== null &&
    policy.windowMonths !== null &&
    policy.lookbackMonths !== null &&
    policy.qualifyingTransactionCount !== null &&
    policy.qualifyingGrossCents !== null &&
    policy.classificationRules !== null &&
    policy.saleUnit !== null &&
    policy.qualifyingGrossBasis !== null &&
    policy.refundTreatment !== null &&
    policy.postCaptureCancellationTreatment !== null &&
    policy.mixedLineTreatment !== null &&
    policy.unclassifiableTreatment !== null
  );
}

/** A policy in force from `effectiveFrom` until the next segment or the evaluated revision. */
export type CohortPolicySegment = Readonly<{ effectiveFrom: string; policy: SellerComplianceCohortPolicyValue }>;

export type CohortEvaluationInput = Readonly<{
  sales: readonly SellerSaleFact[];
  policy: SellerComplianceCohortPolicyValue;
  evaluationAt: string;
  previous?: Readonly<{
    state: CohortState;
    band: DisclosureBand;
    entryEffectiveAt: string | null;
    exitEffectiveAt?: string | null;
    /** Effective instant of the seller's latest recorded transition; every new transition lies strictly after it. */
    transitionEffectiveAt?: string | null;
  }>;
  /** The instant from which `policy` is in force, when it differs from the policy that produced `previous`. */
  revisionEffectiveAt?: string;
  /** The policies in force before `revisionEffectiveAt`, each from its own effective instant. */
  priorPolicies?: readonly CohortPolicySegment[];
}>;

function policyTimeline(input: CohortEvaluationInput) {
  const revisionAt = input.revisionEffectiveAt === undefined ? null : Date.parse(input.revisionEffectiveAt);
  const prior = [...(input.priorPolicies ?? [])].sort(
    (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
  );
  return (instant: string): SellerComplianceCohortPolicyValue => {
    const at = Date.parse(instant);
    if (revisionAt === null || at >= revisionAt) return input.policy;
    // The earliest known policy also governs older history, as it does for a first admission.
    const segment = prior.filter((candidate) => Date.parse(candidate.effectiveFrom) <= at).at(-1) ?? prior[0];
    if (segment === undefined || !isConfigured(segment.policy))
      throw new Error(
        "The policy in force before the revision is unavailable, so the transition's cause cannot be determined.",
      );
    return segment.policy;
  };
}

/**
 * The earliest instant strictly after `lower` and no later than the evaluation instant at which `holds` is true,
 * judging each instant under the policy then in force. Membership and band are step functions of time that change
 * only at a sale instant, an anchor's lookback expiry, or a policy boundary, so those instants plus `lower + 1 ms`
 * (a correction already in effect) are a complete candidate set. A sale never removes membership and an expiry
 * never grants it, so `change` narrows the set for a membership loss or gain; a band change keeps every instant.
 * A change found at the revision boundary is caused by the revision; one found before it happened under the old
 * policy, whatever revision is evaluated later.
 */
function firstInstant(
  input: CohortEvaluationInput,
  lower: string | null,
  change: "membership-loss" | "membership-gain" | "band",
  holds: (state: Readonly<{ member: boolean; band: DisclosureBand }>) => boolean,
): string | null {
  if (lower === null)
    throw new Error("The seller's latest transition instant is unavailable, so the transition cannot be dated.");
  const lowerAt = Date.parse(lower);
  const upperAt = Date.parse(input.evaluationAt);
  if (Number.isNaN(lowerAt) || Number.isNaN(upperAt)) return null;
  const policyAt = policyTimeline(input);
  const policies = [input.policy, ...(input.priorPolicies ?? []).map((segment) => segment.policy)];
  // A sale no longer admissible just after `lower` stays inadmissible at every later candidate instant.
  const firstCandidate = new Date(lowerAt + 1).toISOString();
  const sales = input.sales.filter((sale) => {
    const occurred = Date.parse(sale.occurredAt);
    return (
      occurred < upperAt &&
      policies.some(
        (candidate) =>
          withinCalendarHorizon(occurred, lowerAt + 1, candidate.lookbackMonths ?? 60) &&
          isLookbackAnchorEligible(sale.occurredAt, candidate.lookbackMonths ?? 60, firstCandidate),
      )
    );
  });
  const instants = new Set<number>([lowerAt + 1, upperAt]);
  if (input.revisionEffectiveAt !== undefined) instants.add(Date.parse(input.revisionEffectiveAt));
  for (const segment of input.priorPolicies ?? []) instants.add(Date.parse(segment.effectiveFrom));
  for (const sale of sales) {
    if (change !== "membership-loss") instants.add(Date.parse(sale.occurredAt));
    if (change !== "membership-gain")
      for (const candidate of policies)
        instants.add(Date.parse(addUtcMonths(sale.occurredAt, candidate.lookbackMonths ?? 60)) + 1);
  }
  const ordered = [...instants].filter((at) => at > lowerAt && at <= upperAt).sort((a, b) => a - b);
  for (const at of ordered) {
    const instant = new Date(at).toISOString();
    const state = evaluateAt(sales, policyAt(instant), instant, at !== upperAt);
    if (holds({ member: state.winner !== null, band: state.bandWinner ? "disclosure" : "none" })) return instant;
  }
  return null;
}

function required(instant: string | null, transition: string): string {
  if (instant === null) throw new Error(`The ${transition} has no effective instant after the latest transition.`);
  return instant;
}

export function evaluateSellerComplianceCohort(unordered: CohortEvaluationInput): CohortEvaluation {
  // Ordered once by the (occurred_at, payment_id, order_id) key, so the verdict is independent of input order.
  const input = { ...unordered, sales: [...unordered.sales].sort(bySaleKey) };
  const { sales, policy, evaluationAt } = input;
  if (!isConfigured(policy))
    return {
      state: "outside",
      band: "none",
      entryEffectiveAt: null,
      bandEffectiveAt: null,
      exitEffectiveAt: null,
      windowStart: null,
      windowEnd: null,
      nextReevaluationAt: null,
      unclassifiableCount: 0,
      qualifyingCount: 0,
      qualifyingGrossCents: "0",
    };
  const result = evaluateAt(sales, policy, evaluationAt);
  const winner = result.winner;
  const band: DisclosureBand = result.bandWinner ? "disclosure" : "none";
  const previous = input.previous;
  const windowMonths = policy.windowMonths as number;
  const lookbackMonths = policy.lookbackMonths as number;
  const expiries =
    winner === null
      ? []
      : result.eligible
          .flatMap((sale) => [
            addUtcMonths(sale.occurredAt, windowMonths),
            new Date(Date.parse(addUtcMonths(sale.occurredAt, lookbackMonths)) + 1).toISOString(),
          ])
          .filter((instant) => Date.parse(instant) > Date.parse(evaluationAt))
          .sort();
  // Every transition lies strictly after the latest recorded one; without the ledger instant the row's own applies.
  const since = (fallback: string | null | undefined) => previous?.transitionEffectiveAt ?? fallback ?? null;
  let entryEffectiveAt: string | null = null;
  let bandEffectiveAt: string | null = null;
  let exitEffectiveAt: string | null = null;
  if (previous?.state === "member" && winner === null) {
    exitEffectiveAt = firstInstant(input, since(previous.entryEffectiveAt), "membership-loss", (at) => !at.member);
    if (exitEffectiveAt === null) {
      throw new Error("A member without a qualifying window must have an exit effective instant.");
    }
  } else if (previous?.state === "member" && winner !== null) {
    entryEffectiveAt =
      previous.entryEffectiveAt ?? thresholdEffectiveAt(winner, policy, threshold(policy.qualifyingGrossCents));
    // A band change keeps the same-winning-window predicate; a loss is dated where that predicate stops holding.
    if (band !== previous.band)
      bandEffectiveAt = required(
        firstInstant(
          input,
          since(previous.band === "none" ? previous.entryEffectiveAt : null),
          "band",
          (at) => at.band === band,
        ),
        "band change",
      );
  } else if (winner !== null) {
    const lastExit = since(previous?.exitEffectiveAt);
    if (lastExit === null) {
      // First admission, including history admitted by an activating revision, dates at the qualifying sales.
      entryEffectiveAt = thresholdEffectiveAt(winner, policy, threshold(policy.qualifyingGrossCents));
      bandEffectiveAt =
        band === "disclosure" ? thresholdEffectiveAt(winner, policy, threshold(policy.disclosureGrossCents)) : null;
    } else {
      // Re-entry: window sums keep pre-exit sales, but only instants after the exit are candidates.
      entryEffectiveAt = required(
        firstInstant(input, lastExit, "membership-gain", (at) => at.member),
        "re-entry",
      );
      if (band === "disclosure")
        bandEffectiveAt = required(
          firstInstant(
            input,
            new Date(Date.parse(entryEffectiveAt) - 1).toISOString(),
            "band",
            (at) => at.band === "disclosure",
          ),
          "re-entry band",
        );
    }
  } else {
    exitEffectiveAt = previous?.exitEffectiveAt ?? null;
  }
  return {
    state: winner === null ? "outside" : "member",
    band,
    entryEffectiveAt,
    bandEffectiveAt,
    exitEffectiveAt,
    windowStart: winner?.start ?? null,
    windowEnd: winner?.end ?? null,
    nextReevaluationAt: winner === null ? null : (expiries[0] ?? null),
    unclassifiableCount: result.eligible.filter((sale) => classify(sale, policy) === "unclassifiable").length,
    qualifyingCount: winner?.count ?? 0,
    qualifyingGrossCents: (winner?.gross ?? 0n).toString(),
  };
}
