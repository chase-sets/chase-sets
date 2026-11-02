import type { SellerSaleFact } from "../../seller-compliance-sales/read-model/queries";
import { addUtcMonths as addUtcMonthsFromSales } from "../../seller-compliance-sales/read-model/queries";
import type { PolicyHistoryRecord } from "@chase-sets/platform-policy/policy-history-reader";
import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type {
  SellerComplianceCohortPolicyValue,
  SellerComplianceClassificationRule,
} from "./seller-compliance-cohort-policy";

export type CohortState = "outside" | "member";
export type DisclosureBand = "none" | "disclosure";
export type CohortPolicyIdentity = Pick<PolicyHistoryRecord, "policyKey" | "documentId" | "eventId" | "streamVersion">;
export type CohortEvaluation = Readonly<{
  effectiveAt: IsoUtcTimestamp | null;
  observedAt: IsoUtcTimestamp;
  policyIdentity: CohortPolicyIdentity | null;
  state: CohortState;
  band: DisclosureBand;
  entryEffectiveAt: IsoUtcTimestamp | null;
  /** Effective instant of the band transition this evaluation produces; null when the band does not change. */
  bandEffectiveAt: IsoUtcTimestamp | null;
  exitEffectiveAt: IsoUtcTimestamp | null;
  windowStart: IsoUtcTimestamp | null;
  windowEnd: IsoUtcTimestamp | null;
  nextReevaluationAt: IsoUtcTimestamp | null;
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
  if (rules.length === 0) return "unclassifiable";
  const lineResults = inputs.map(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      rules.some((rule) => matchesRule(input as Record<string, unknown>, rule)),
  );
  if (lineResults.length === 0 || lineResults.some((matched) => !matched)) {
    if (policy.mixedLineTreatment === "count-mixed" && lineResults.some(Boolean)) return "qualifying";
    return "unclassifiable";
  }
  return "qualifying";
}
function gross(sale: SellerSaleFact, policy: SellerComplianceCohortPolicyValue): bigint | null {
  if (sale.sellerItemNetCents === null || sale.marketplaceSalesFeeCents === null) return null;
  const itemGross = BigInt(sale.sellerItemNetCents) + BigInt(sale.marketplaceSalesFeeCents);
  if (policy.qualifyingGrossBasis === "item-gross-plus-shipping")
    return sale.shippingChargeCents === null ? null : itemGross + BigInt(sale.shippingChargeCents);
  return itemGross;
}
function qualifyingAmount(sale: SellerSaleFact, policy: SellerComplianceCohortPolicyValue): bigint | null {
  const classification = classify(sale, policy);
  return classification === "qualifying" ||
    (classification === "unclassifiable" && policy.unclassifiableTreatment === "count-unclassifiable")
    ? gross(sale, policy)
    : null;
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

type StartRun = Readonly<{ first: number; last: number; lookbackOffset: number; count: number; gross: bigint }>;
const DAY_MS = 86_400_000;
const iso = (at: number) => new Date(at).toISOString();
const shifted = (at: number, months: number) => Date.parse(addUtcMonths(iso(at), months));

/**
 * Month addition is affine within each unclamped month prefix and each clamped
 * UTC day, but jumps backwards between clamped days. Intersect W/L pieces;
 * never binary-search across a clamp or invert a calendar addition.
 */
function calendarPieces(first: number, last: number, months: readonly number[]): readonly number[] {
  const date = new Date(first);
  const boundaries = new Set<number>([first, last + 1]);
  for (let month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); month <= last; ) {
    const d = new Date(month);
    const year = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    boundaries.add(month);
    for (const shift of months) {
      const targetDays = new Date(Date.UTC(year, m + shift + 1, 0)).getUTCDate();
      for (let day = targetDays + 1; day <= days; day++) boundaries.add(Date.UTC(year, m, day));
    }
    month = Date.UTC(year, m + 1, 1);
  }
  return [...boundaries].filter((at) => at >= first && at <= last + 1).sort((a, b) => a - b);
}

function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Constant-composition qualifying runs also retain their right ends for exact forward expiry. */
function qualifyingRuns(sales: readonly SellerSaleFact[], policy: SellerComplianceCohortPolicyValue): StartRun[] {
  const qualifying = sales.flatMap((sale) => {
    const amount = qualifyingAmount(sale, policy);
    return amount === null ? [] : [{ at: Date.parse(sale.occurredAt), amount }];
  });
  if (qualifying.length === 0) return [];
  const times = qualifying.map((sale) => sale.at);
  const sums = [0n];
  for (const sale of qualifying) sums.push(sums.at(-1)! + sale.amount);
  const w = policy.windowMonths!;
  const l = policy.lookbackMonths!;
  const first = times[0]! - (w * 32 + 3) * DAY_MS;
  const last = times.at(-1)!;
  const pieces = calendarPieces(first, last, [w, l]);
  const runs: StartRun[] = [];
  for (let index = 0; index < pieces.length - 1; index++) {
    const left = pieces[index]!;
    const right = pieces[index + 1]! - 1;
    const windowOffset = shifted(left, w) - left;
    const lookbackOffset = shifted(left, l) - left;
    // The five candidate families: sale instants, W-piece rightmost ms,
    // earliest containing starts per sale/tie, L-piece eligible starts (at
    // evaluation), and qualifying-run right ends at sale/W/L-piece limits.
    const cuts = new Set<number>([left, right + 1]);
    for (const time of times) {
      if (time + 1 > left && time + 1 <= right) cuts.add(time + 1);
      const enters = time - windowOffset + 1;
      if (enters > left && enters <= right) cuts.add(enters);
    }
    const ordered = [...cuts].sort((a, b) => a - b);
    for (let cut = 0; cut < ordered.length - 1; cut++) {
      const start = ordered[cut]!;
      const from = lowerBound(times, start);
      const to = lowerBound(times, start + windowOffset);
      const run = {
        first: start,
        last: ordered[cut + 1]! - 1,
        lookbackOffset,
        count: to - from,
        gross: sums[to]! - sums[from]!,
      };
      if (qualifies(run, policy)) runs.push(run);
    }
  }
  return runs;
}
function qualifies(
  candidate: Pick<Candidate, "count" | "gross">,
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
/** Canonical ISO-8601 UTC instants order chronologically by code unit; ids break ties. */
function bySaleKey(a: SellerSaleFact, b: SellerSaleFact): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.paymentId.localeCompare(b.paymentId) || a.orderId.localeCompare(b.orderId);
}
function evaluateAt(sales: readonly SellerSaleFact[], policy: SellerComplianceCohortPolicyValue, evaluationAt: string) {
  const at = Date.parse(evaluationAt);
  const eligible = sales
    .filter((sale) => {
      const occurred = Date.parse(sale.occurredAt);
      return occurred < at && at - occurred <= ((policy.lookbackMonths ?? 60) * 31 + 3) * DAY_MS;
    })
    .sort(bySaleKey);
  const amounts = eligible.map((sale) => qualifyingAmount(sale, policy));
  const runs = qualifyingRuns(eligible, policy);
  let winner: Candidate | null = null;
  for (const run of runs) {
    const start = Math.max(run.first, at - run.lookbackOffset);
    if (start <= run.last && start < at) {
      winner = candidateAt(iso(start), eligible, amounts, policy);
      break;
    }
  }
  const bandWinner = winner !== null && qualifies(winner, policy, threshold(policy.disclosureGrossCents));
  // Runs are ordered by start, not expiry: clamp pieces can expire out of
  // order. A later run matters only beyond the coverage already retained.
  let through = at;
  let next: number | null = null;
  for (const run of runs) {
    const expiry = run.last + run.lookbackOffset + 1;
    if (expiry <= through) continue;
    if (through > at && qualifies(run, policy, threshold(policy.disclosureGrossCents)) !== bandWinner) {
      next = through;
      break;
    }
    through = expiry;
  }
  if (next === null && through > at) next = through;
  return {
    at,
    eligible,
    winner,
    bandWinner,
    next,
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
    policy.disclosureGrossCents !== null &&
    policy.comparisonIsInclusive !== null &&
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
export type CohortPolicySegment = Readonly<{
  effectiveFrom: string;
  /** null is an inert policy interval (inactive or uncovered history). */
  policy: SellerComplianceCohortPolicyValue | null;
}>;

export type CohortEvaluationInput = Readonly<{
  sales: readonly SellerSaleFact[];
  policy: SellerComplianceCohortPolicyValue;
  evaluationAt: string;
  observedAt: string;
  policyIdentity: CohortPolicyIdentity | null;
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
  return (instant: string): SellerComplianceCohortPolicyValue | null | undefined => {
    const at = Date.parse(instant);
    if (revisionAt === null || at >= revisionAt) return input.policy;
    const segment = prior.filter((candidate) => Date.parse(candidate.effectiveFrom) <= at).at(-1);
    if (segment === undefined) return undefined;
    return segment.policy;
  };
}

/** Walk causal boundaries, recomputing forward run expiry under the policy then in force. */
function firstInstant(
  input: CohortEvaluationInput,
  lower: string | null,
  holds: (state: Readonly<{ member: boolean; band: DisclosureBand }>) => boolean,
): string | null {
  if (lower === null)
    throw new Error("The seller's latest transition instant is unavailable, so the transition cannot be dated.");
  const lowerAt = Date.parse(lower);
  const upperAt = Date.parse(input.evaluationAt);
  if (Number.isNaN(lowerAt) || Number.isNaN(upperAt)) return null;
  const policyAt = policyTimeline(input);
  const boundaries = [
    upperAt,
    ...input.sales.map((sale) => Date.parse(sale.occurredAt) + 1),
    ...(input.priorPolicies ?? []).map((segment) => Date.parse(segment.effectiveFrom)),
    ...(input.revisionEffectiveAt === undefined ? [] : [Date.parse(input.revisionEffectiveAt)]),
  ].sort((a, b) => a - b);
  for (let at = lowerAt + 1; at <= upperAt; ) {
    const instant = iso(at);
    const activePolicy = policyAt(instant);
    const state =
      activePolicy === undefined
        ? null
        : activePolicy === null || !isConfigured(activePolicy)
          ? { winner: null, bandWinner: false, next: null }
          : evaluateAt(input.sales, activePolicy, instant);
    // Uncovered history is not evidence of a transition. An explicitly inert
    // segment is outside; policyTimeline keeps unavailable history distinct.
    if (state !== null && holds({ member: state.winner !== null, band: state.bandWinner ? "disclosure" : "none" })) {
      const saleCaused = input.sales.some((sale) => Date.parse(sale.occurredAt) + 1 === at);
      const policyBoundary =
        input.revisionEffectiveAt === instant ||
        input.priorPolicies?.some((segment) => segment.effectiveFrom === instant);
      return iso(saleCaused && !policyBoundary && at - 1 > lowerAt ? at - 1 : at);
    }
    const nextBoundary = boundaries.find((boundary) => boundary > at) ?? Infinity;
    at = Math.min(nextBoundary, state?.next ?? Infinity);
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
  const observedAt = parseIsoUtcTimestamp(input.observedAt);
  const dated = (value: string | null): IsoUtcTimestamp | null => (value === null ? null : parseIsoUtcTimestamp(value));
  const metadata = { observedAt, policyIdentity: input.policyIdentity };
  if (!isConfigured(policy)) {
    const previous = input.previous;
    const exit =
      previous?.state === "member"
        ? required(
            firstInstant(input, previous.transitionEffectiveAt ?? previous.entryEffectiveAt, (at) => !at.member),
            "inert-policy exit",
          )
        : (previous?.exitEffectiveAt ?? null);
    return {
      ...metadata,
      effectiveAt: dated(exit),
      state: "outside",
      band: "none",
      entryEffectiveAt: null,
      bandEffectiveAt: null,
      exitEffectiveAt: dated(exit),
      windowStart: null,
      windowEnd: null,
      nextReevaluationAt: null,
      unclassifiableCount: 0,
      qualifyingCount: 0,
      qualifyingGrossCents: "0",
    };
  }
  const result = evaluateAt(sales, policy, evaluationAt);
  const winner = result.winner;
  const band: DisclosureBand = result.bandWinner ? "disclosure" : "none";
  const previous = input.previous;
  // Every transition lies strictly after the latest recorded one; without the ledger instant the row's own applies.
  const since = (fallback: string | null | undefined) => previous?.transitionEffectiveAt ?? fallback ?? null;
  let entryEffectiveAt: string | null = null;
  let bandEffectiveAt: string | null = null;
  let exitEffectiveAt: string | null = null;
  if (previous?.state === "member" && winner === null) {
    exitEffectiveAt = firstInstant(input, since(previous.entryEffectiveAt), (at) => !at.member);
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
        firstInstant(input, lastExit, (at) => at.member),
        "re-entry",
      );
      if (band === "disclosure")
        bandEffectiveAt = required(
          firstInstant(
            input,
            new Date(Date.parse(entryEffectiveAt) - 1).toISOString(),
            (at) => at.band === "disclosure",
          ),
          "re-entry band",
        );
    }
  } else {
    exitEffectiveAt = previous?.exitEffectiveAt ?? null;
  }
  return {
    ...metadata,
    effectiveAt: dated(exitEffectiveAt ?? bandEffectiveAt ?? entryEffectiveAt),
    state: winner === null ? "outside" : "member",
    band,
    entryEffectiveAt: dated(entryEffectiveAt),
    bandEffectiveAt: dated(bandEffectiveAt),
    exitEffectiveAt: dated(exitEffectiveAt),
    windowStart: dated(winner?.start ?? null),
    windowEnd: dated(winner?.end ?? null),
    nextReevaluationAt:
      winner === null
        ? null
        : dated(
            [
              ...(result.next === null ? [] : [iso(result.next)]),
              ...result.eligible
                .map((sale) => addUtcMonths(sale.occurredAt, policy.windowMonths!))
                .filter((instant) => instant > evaluationAt),
            ].sort()[0] ?? null,
          ),
    unclassifiableCount: result.eligible.filter((sale) => classify(sale, policy) === "unclassifiable").length,
    qualifyingCount: winner?.count ?? 0,
    qualifyingGrossCents: (winner?.gross ?? 0n).toString(),
  };
}
