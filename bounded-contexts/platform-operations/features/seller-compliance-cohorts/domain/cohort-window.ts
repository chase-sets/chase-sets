import type { SellerSaleFact } from "../../seller-compliance-sales/read-model/queries";
import { addUtcMonths as addUtcMonthsFromSales } from "../../seller-compliance-sales/read-model/queries";
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
    isFullyRefunded &&
    (policy.postCaptureCancellationTreatment === "exclude-cancelled" ||
      policy.postCaptureCancellationTreatment === "exclude-if-fully-refunded")
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
function candidateAt(
  start: string,
  sales: readonly SellerSaleFact[],
  policy: SellerComplianceCohortPolicyValue,
): Candidate {
  const end = addUtcMonths(start, policy.windowMonths ?? 1);
  const qualifying: SellerSaleFact[] = [];
  let total = 0n;
  for (const sale of sales) {
    if (sale.occurredAt < start || sale.occurredAt >= end || classify(sale, policy) !== "qualifying") continue;
    const amount = gross(sale, policy);
    if (amount === null) continue;
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
function evaluateAt(sales: readonly SellerSaleFact[], policy: SellerComplianceCohortPolicyValue, evaluationAt: string) {
  const at = Date.parse(evaluationAt);
  const floor = Date.parse(addUtcMonths(evaluationAt, -(policy.lookbackMonths ?? 60)));
  const eligible = [...sales]
    .filter((sale) => Date.parse(sale.occurredAt) < at && Date.parse(sale.occurredAt) >= floor)
    .sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) ||
        a.paymentId.localeCompare(b.paymentId) ||
        a.orderId.localeCompare(b.orderId),
    );
  const candidates = eligible.map((sale) => candidateAt(sale.occurredAt, eligible, policy));
  const winner = candidates.find((candidate) => qualifies(candidate, policy)) ?? null;
  return {
    at,
    eligible,
    winner,
    bandWinner: winner !== null && qualifies(winner, policy, threshold(policy.disclosureGrossCents)),
  };
}

export function evaluateSellerComplianceCohort(
  input: Readonly<{
    sales: readonly SellerSaleFact[];
    policy: SellerComplianceCohortPolicyValue;
    evaluationAt: string;
    previous?: Readonly<{
      state: CohortState;
      band: DisclosureBand;
      entryEffectiveAt: string | null;
      exitEffectiveAt?: string | null;
    }>;
  }>,
): CohortEvaluation {
  const { sales, policy, evaluationAt } = input;
  if (
    !policy.activated ||
    policy.currencyCode === null ||
    policy.windowMonths === null ||
    policy.lookbackMonths === null ||
    policy.qualifyingTransactionCount === null ||
    policy.qualifyingGrossCents === null ||
    policy.classificationRules === null ||
    policy.saleUnit === null ||
    policy.qualifyingGrossBasis === null ||
    policy.refundTreatment === null ||
    policy.postCaptureCancellationTreatment === null ||
    policy.mixedLineTreatment === null ||
    policy.unclassifiableTreatment === null
  )
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
  const previousMember = input.previous?.state === "member";
  const windowMonths = policy.windowMonths as number;
  const lookbackMonths = policy.lookbackMonths as number;
  const expiries = result.eligible
    .flatMap((sale) => [addUtcMonths(sale.occurredAt, windowMonths), addUtcMonths(sale.occurredAt, lookbackMonths)])
    .filter((instant) => Date.parse(instant) > Date.parse(evaluationAt))
    .sort();
  let exitEffectiveAt: string | null = null;
  if (previousMember && winner === null) {
    const entry = input.previous?.entryEffectiveAt ?? "";
    const candidates = result.eligible
      .flatMap((sale) => [addUtcMonths(sale.occurredAt, windowMonths), addUtcMonths(sale.occurredAt, lookbackMonths)])
      .filter((instant) => Date.parse(instant) > Date.parse(entry) && Date.parse(instant) <= Date.parse(evaluationAt))
      .sort();
    for (const instant of candidates) {
      const at = evaluateAt(sales, policy, instant);
      if (!at.winner || !qualifies(at.winner, policy)) {
        exitEffectiveAt = instant;
        break;
      }
    }
    exitEffectiveAt ??= evaluationAt;
  }
  const entryEffectiveAt =
    winner === null
      ? null
      : previousMember
        ? (input.previous?.entryEffectiveAt ??
          thresholdEffectiveAt(winner, policy, threshold(policy.qualifyingGrossCents)))
        : thresholdEffectiveAt(winner, policy, threshold(policy.qualifyingGrossCents));
  const bandEffectiveAt =
    winner === null || !result.bandWinner
      ? null
      : thresholdEffectiveAt(winner, policy, threshold(policy.disclosureGrossCents));
  return {
    state: winner === null ? "outside" : "member",
    band: result.bandWinner ? "disclosure" : "none",
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
