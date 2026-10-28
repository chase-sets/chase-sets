import type { SellerSaleFact } from "../../seller-compliance-sales/read-model/queries";
import type { SellerComplianceCohortPolicyValue } from "./seller-compliance-cohort-policy";

export type CohortState = "outside" | "member";
export type DisclosureBand = "none" | "disclosure";

export type CohortEvaluation = Readonly<{
  state: CohortState;
  band: DisclosureBand;
  entryEffectiveAt: string | null;
  exitEffectiveAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  nextReevaluationAt: string | null;
  unclassifiableCount: number;
  qualifyingCount: number;
  qualifyingGrossCents: string;
}>;

export function addUtcMonths(instant: string, months: number): string {
  const anchor = new Date(instant);
  if (!Number.isFinite(anchor.getTime()) || !Number.isInteger(months))
    throw new Error("Invalid UTC month arithmetic input.");
  const day = anchor.getUTCDate();
  const targetMonth = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      targetMonth,
      Math.min(day, lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  ).toISOString();
}

function classify(
  sale: SellerSaleFact,
  policy: SellerComplianceCohortPolicyValue,
): "qualifying" | "unclassifiable" | "excluded" {
  if (
    sale.currencyCode !== policy.currencyCode ||
    sale.saleState !== "captured" ||
    sale.captureAnomalies.length > 0 ||
    sale.refundAnomalies.length > 0 ||
    sale.reconciliationMismatches.length > 0
  )
    return "excluded";
  const inputs = Array.isArray(sale.classificationInputs) ? sale.classificationInputs : [];
  const rules = policy.classificationRules ?? [];
  if (rules.length === 0) return "unclassifiable";
  const allClassified =
    inputs.length > 0 &&
    inputs.every((input) => {
      if (typeof input !== "object" || input === null) return false;
      const value = input as Record<string, unknown>;
      return rules.some(
        (rule) =>
          value[rule.source] === rule.value || value.productId === rule.value || value.catalogItemId === rule.value,
      );
    });
  if (!allClassified) return "unclassifiable";
  if (
    sale.refundedOrderTotalCents !== null &&
    sale.orderRefundCapCents !== null &&
    sale.refundedOrderTotalCents === sale.orderRefundCapCents
  )
    return "excluded";
  return "qualifying";
}

function gross(sale: SellerSaleFact): bigint | null {
  if (sale.sellerItemNetCents === null || sale.marketplaceSalesFeeCents === null) return null;
  return BigInt(sale.sellerItemNetCents) + BigInt(sale.marketplaceSalesFeeCents);
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
    if (sale.occurredAt < start || sale.occurredAt >= end) continue;
    if (classify(sale, policy) !== "qualifying") continue;
    const amount = gross(sale);
    if (amount === null) continue;
    qualifying.push(sale);
    total += amount;
  }
  return { start, end, qualifying, count: qualifying.length, gross: total };
}

function qualifies(candidate: Candidate, policy: SellerComplianceCohortPolicyValue): boolean {
  const inclusive = policy.comparisonIsInclusive ?? true;
  const countOk = inclusive
    ? candidate.count >= (policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER)
    : candidate.count > (policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER);
  const grossOk = inclusive
    ? candidate.gross >= threshold(policy.qualifyingGrossCents)
    : candidate.gross > threshold(policy.qualifyingGrossCents);
  return countOk && grossOk;
}

function thresholdEffectiveAt(
  candidate: Candidate,
  policy: SellerComplianceCohortPolicyValue,
  grossThreshold: bigint,
): string {
  let count = 0;
  let total = 0n;
  for (const sale of candidate.qualifying) {
    count += 1;
    total += gross(sale) ?? 0n;
    const inclusive = policy.comparisonIsInclusive ?? true;
    const countOk = inclusive
      ? count >= (policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER)
      : count > (policy.qualifyingTransactionCount ?? Number.MAX_SAFE_INTEGER);
    const grossOk = inclusive ? total >= grossThreshold : total > grossThreshold;
    if (countOk && grossOk) return sale.occurredAt;
  }
  return candidate.qualifying[candidate.qualifying.length - 1]?.occurredAt ?? candidate.start;
}

export function evaluateSellerComplianceCohort(
  input: Readonly<{
    sales: readonly SellerSaleFact[];
    policy: SellerComplianceCohortPolicyValue;
    evaluationAt: string;
    previous?: Readonly<{ state: CohortState; band: DisclosureBand; entryEffectiveAt: string | null }>;
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
    policy.classificationRules === null
  ) {
    return {
      state: "outside",
      band: "none",
      entryEffectiveAt: null,
      exitEffectiveAt: null,
      windowStart: null,
      windowEnd: null,
      nextReevaluationAt: null,
      unclassifiableCount: 0,
      qualifyingCount: 0,
      qualifyingGrossCents: "0",
    };
  }
  const at = Date.parse(evaluationAt);
  const windowMonths = policy.windowMonths;
  const lookbackMonths = policy.lookbackMonths;
  const floor = Date.parse(addUtcMonths(evaluationAt, -lookbackMonths));
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
  const bandWinner =
    winner !== null &&
    ((policy.comparisonIsInclusive ?? true)
      ? winner.gross >= threshold(policy.disclosureGrossCents)
      : winner.gross > threshold(policy.disclosureGrossCents));
  const unclassifiableCount = eligible.filter((sale) => classify(sale, policy) === "unclassifiable").length;
  const expiryCandidates = eligible
    .flatMap((sale) => [addUtcMonths(sale.occurredAt, windowMonths), addUtcMonths(sale.occurredAt, lookbackMonths)])
    .filter((instant) => Date.parse(instant) > at)
    .sort();
  let nextReevaluationAt: string | null = expiryCandidates[0] ?? null;
  if (winner === null) nextReevaluationAt = null;
  const previousMember = input.previous?.state === "member";
  const entryEffectiveAt =
    winner === null
      ? null
      : previousMember
        ? (input.previous?.entryEffectiveAt ??
          thresholdEffectiveAt(winner, policy, threshold(policy.qualifyingGrossCents)))
        : thresholdEffectiveAt(winner, policy, threshold(policy.qualifyingGrossCents));
  const exitEffectiveAt = previousMember && winner === null ? (expiryCandidates[0] ?? evaluationAt) : null;
  return {
    state: winner === null ? "outside" : "member",
    band: bandWinner ? "disclosure" : "none",
    entryEffectiveAt: winner === null ? null : entryEffectiveAt,
    exitEffectiveAt,
    windowStart: winner?.start ?? null,
    windowEnd: winner?.end ?? null,
    nextReevaluationAt,
    unclassifiableCount,
    qualifyingCount: winner?.count ?? 0,
    qualifyingGrossCents: (winner?.gross ?? 0n).toString(),
  };
}
