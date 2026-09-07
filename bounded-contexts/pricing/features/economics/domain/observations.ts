import type { ResolvedEconomicsPolicy } from "./policy";
import { requireCurrency, requirePositiveInteger, requireRfc3339Instant } from "./contracts";

const DAY_MILLISECONDS = 86_400_000;

export type AcquisitionOccurrence =
  | Readonly<{ kind: "occurred"; occurredAt: string; source: "seller-supplied" | "import-supplied" }>
  | Readonly<{ kind: "unknown" }>;

export type AcquisitionLotObservation = Readonly<{
  accountId: string;
  inventoryItemId: string;
  lotId: string;
  quantity: number;
  occurrence: AcquisitionOccurrence;
}>;

export type SaleObservation = Readonly<{
  accountId: string;
  inventoryItemId: string | null;
  saleId: string;
  quantity: number;
  soldAt: string;
  currency: string;
  excluded: boolean;
}>;

export type WeightedCycleSample = Readonly<{
  sampleId: string;
  days: number;
  quantity: number;
  oldestObservationAt: string;
}>;

export type CycleStatistic = Readonly<{
  value: number;
  sampleCount: number;
  samples: readonly WeightedCycleSample[];
  excludedDurationCount: number;
  observedAt: string;
  policyRevision: string;
}>;

export type CapitalCycleObservations = Readonly<{
  observedHold: CycleStatistic | null;
  observedTurnaround: CycleStatistic | null;
  diagnostics: Readonly<{
    holdCandidateCount: number;
    holdExcludedDurationCount: number;
    turnaroundCandidateCount: number;
    turnaroundExcludedDurationCount: number;
  }>;
}>;

type MutableQuantity<T> = T & { remaining: number };

export function observeCapitalCycle(
  input: Readonly<{
    accountId: string;
    currency: string;
    effectiveAt: string;
    acquisitions: readonly AcquisitionLotObservation[];
    sales: readonly SaleObservation[];
    policy: ResolvedEconomicsPolicy;
  }>,
): CapitalCycleObservations {
  const effectiveAt = requireRfc3339Instant(input.effectiveAt, "effectiveAt");
  const currency = requireCurrency(input.currency, "currency");
  const effectiveMillis = Date.parse(effectiveAt);
  const windowStart = effectiveMillis - input.policy.value.observationWindowDays * DAY_MILLISECONDS;
  const acquisitions = eligibleAcquisitions(input.acquisitions, input.accountId, windowStart, effectiveMillis);
  const sales = eligibleSales(input.sales, input.accountId, currency, windowStart, effectiveMillis);

  const holdSamples = allocateObservedHold(acquisitions, sales);
  const turnaroundSamples = allocateObservedTurnaround(acquisitions, sales);
  const hold = statistic(
    holdSamples,
    input.policy.value.minimumHoldSamples,
    input.policy.value.maximumObservationDurationDays,
    input.policy.policyRevision,
  );
  const turnaround = statistic(
    turnaroundSamples,
    input.policy.value.minimumTurnaroundSamples,
    input.policy.value.maximumObservationDurationDays,
    input.policy.policyRevision,
  );
  return {
    observedHold: hold.value,
    observedTurnaround: turnaround.value,
    diagnostics: {
      holdCandidateCount: hold.candidateCount,
      holdExcludedDurationCount: hold.excludedDurationCount,
      turnaroundCandidateCount: turnaround.candidateCount,
      turnaroundExcludedDurationCount: turnaround.excludedDurationCount,
    },
  };
}

function eligibleAcquisitions(
  rows: readonly AcquisitionLotObservation[],
  accountId: string,
  windowStart: number,
  effectiveAt: number,
): readonly MutableQuantity<AcquisitionLotObservation & { acquiredAt: string }>[] {
  return rows
    .filter((row) => row.accountId === accountId)
    .map((row) => {
      requireIdentity(row.lotId, "Acquisition lotId");
      requireIdentity(row.inventoryItemId, `Acquisition ${row.lotId} inventoryItemId`);
      requirePositiveInteger(row.quantity, `Acquisition ${row.lotId} quantity`, Number.MAX_SAFE_INTEGER);
      assertAcquisitionOccurrence(row.occurrence, row.lotId);
      if (row.occurrence.kind === "unknown") return null;
      const acquiredAt = requireRfc3339Instant(row.occurrence.occurredAt, `Acquisition ${row.lotId} occurredAt`);
      return { ...row, acquiredAt, remaining: row.quantity };
    })
    .filter((row) => row !== null)
    .filter((row) => Date.parse(row.acquiredAt) >= windowStart && Date.parse(row.acquiredAt) <= effectiveAt)
    .sort((left, right) => compareInstantIdentity(left.acquiredAt, left.lotId, right.acquiredAt, right.lotId));
}

function eligibleSales(
  rows: readonly SaleObservation[],
  accountId: string,
  currency: string,
  windowStart: number,
  effectiveAt: number,
): readonly MutableQuantity<SaleObservation>[] {
  return rows
    .filter((row) => row.accountId === accountId)
    .map((row) => {
      requireIdentity(row.saleId, "Sale saleId");
      if (row.inventoryItemId !== null) requireIdentity(row.inventoryItemId, `Sale ${row.saleId} inventoryItemId`);
      requirePositiveInteger(row.quantity, `Sale ${row.saleId} quantity`, Number.MAX_SAFE_INTEGER);
      requireRfc3339Instant(row.soldAt, `Sale ${row.saleId} soldAt`);
      requireCurrency(row.currency, `Sale ${row.saleId} currency`);
      if (typeof row.excluded !== "boolean") throw new Error(`Sale ${row.saleId} excluded must be boolean.`);
      return { ...row, remaining: row.quantity };
    })
    .filter((row) => row.currency === currency && !row.excluded)
    .filter((row) => Date.parse(row.soldAt) >= windowStart && Date.parse(row.soldAt) <= effectiveAt)
    .sort((left, right) => compareInstantIdentity(left.soldAt, left.saleId, right.soldAt, right.saleId));
}

function allocateObservedHold(
  acquisitions: readonly MutableQuantity<AcquisitionLotObservation & { acquiredAt: string }>[],
  sales: readonly MutableQuantity<SaleObservation>[],
): WeightedCycleSample[] {
  const lotsByItem = new Map<string, MutableQuantity<AcquisitionLotObservation & { acquiredAt: string }>[]>();
  for (const acquisition of acquisitions) {
    const existing = lotsByItem.get(acquisition.inventoryItemId) ?? [];
    existing.push({ ...acquisition });
    lotsByItem.set(acquisition.inventoryItemId, existing);
  }
  const result: WeightedCycleSample[] = [];
  for (const originalSale of sales) {
    if (originalSale.inventoryItemId === null) continue;
    let saleRemaining = originalSale.remaining;
    const lots = lotsByItem.get(originalSale.inventoryItemId) ?? [];
    for (const lot of lots) {
      if (saleRemaining === 0 || Date.parse(lot.acquiredAt) > Date.parse(originalSale.soldAt)) break;
      if (lot.remaining === 0) continue;
      const quantity = Math.min(lot.remaining, saleRemaining);
      result.push({
        sampleId: `hold:${lot.lotId}:${originalSale.saleId}`,
        days: elapsedDays(lot.acquiredAt, originalSale.soldAt),
        quantity,
        oldestObservationAt: earlier(lot.acquiredAt, originalSale.soldAt),
      });
      lot.remaining -= quantity;
      saleRemaining -= quantity;
    }
  }
  return result;
}

function allocateObservedTurnaround(
  acquisitions: readonly MutableQuantity<AcquisitionLotObservation & { acquiredAt: string }>[],
  sales: readonly MutableQuantity<SaleObservation>[],
): WeightedCycleSample[] {
  const mutableSales = sales.map((sale) => ({ ...sale }));
  const result: WeightedCycleSample[] = [];
  for (const acquisition of acquisitions) {
    let acquisitionRemaining = acquisition.remaining;
    for (const sale of mutableSales) {
      if (acquisitionRemaining === 0 || Date.parse(sale.soldAt) > Date.parse(acquisition.acquiredAt)) break;
      if (sale.remaining === 0) continue;
      const quantity = Math.min(sale.remaining, acquisitionRemaining);
      result.push({
        sampleId: `turnaround:${sale.saleId}:${acquisition.lotId}`,
        days: elapsedDays(sale.soldAt, acquisition.acquiredAt),
        quantity,
        oldestObservationAt: earlier(sale.soldAt, acquisition.acquiredAt),
      });
      sale.remaining -= quantity;
      acquisitionRemaining -= quantity;
    }
  }
  return result;
}

function statistic(
  samples: readonly WeightedCycleSample[],
  minimumSamples: number,
  maximumDurationDays: number,
  policyRevision: string,
): Readonly<{
  value: CycleStatistic | null;
  candidateCount: number;
  excludedDurationCount: number;
}> {
  const accepted = samples.filter((sample) => sample.days <= maximumDurationDays);
  const candidateCount = samples.reduce((total, sample) => total + sample.quantity, 0);
  const excludedDurationCount = samples
    .filter((sample) => sample.days > maximumDurationDays)
    .reduce((total, sample) => total + sample.quantity, 0);
  const sampleCount = accepted.reduce((total, sample) => total + sample.quantity, 0);
  if (sampleCount < minimumSamples) return { value: null, candidateCount, excludedDurationCount };
  const sorted = [...accepted].sort(
    (left, right) => left.days - right.days || left.sampleId.localeCompare(right.sampleId),
  );
  const lowerPosition = Math.floor((sampleCount - 1) / 2);
  const upperPosition = Math.floor(sampleCount / 2);
  const value = (weightedValueAt(sorted, lowerPosition) + weightedValueAt(sorted, upperPosition)) / 2;
  return {
    candidateCount,
    excludedDurationCount,
    value: {
      value,
      sampleCount,
      samples: sorted,
      excludedDurationCount,
      observedAt: sorted.reduce(
        (oldest, sample) => earlier(oldest, sample.oldestObservationAt),
        sorted[0]!.oldestObservationAt,
      ),
      policyRevision,
    },
  };
}

function weightedValueAt(samples: readonly WeightedCycleSample[], zeroBasedPosition: number): number {
  let traversed = 0;
  for (const sample of samples) {
    traversed += sample.quantity;
    if (zeroBasedPosition < traversed) return sample.days;
  }
  throw new Error("Weighted median position exceeds its samples.");
}

function elapsedDays(earlierAt: string, laterAt: string): number {
  return (Date.parse(laterAt) - Date.parse(earlierAt)) / DAY_MILLISECONDS;
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function compareInstantIdentity(leftAt: string, leftId: string, rightAt: string, rightId: string): number {
  return Date.parse(leftAt) - Date.parse(rightAt) || leftId.localeCompare(rightId);
}

function assertAcquisitionOccurrence(occurrence: AcquisitionOccurrence, lotId: string): void {
  if (typeof occurrence !== "object" || occurrence === null || Array.isArray(occurrence)) {
    throw new Error(`Acquisition ${lotId} occurrence must be an object.`);
  }
  const keys = Object.keys(occurrence).sort();
  if (occurrence.kind === "unknown") {
    if (keys.length !== 1 || keys[0] !== "kind") {
      throw new Error(`Acquisition ${lotId} unknown occurrence is not closed.`);
    }
    return;
  }
  if (occurrence.kind !== "occurred") throw new Error(`Acquisition ${lotId} occurrence kind is unknown.`);
  if (keys.join("\u0000") !== ["kind", "occurredAt", "source"].join("\u0000")) {
    throw new Error(`Acquisition ${lotId} occurred occurrence is not closed.`);
  }
  requireRfc3339Instant(occurrence.occurredAt, `Acquisition ${lotId} occurredAt`);
  if (occurrence.source !== "seller-supplied" && occurrence.source !== "import-supplied") {
    throw new Error(`Acquisition ${lotId} occurrence source is unknown.`);
  }
}

function requireIdentity(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be non-empty and already trimmed.`);
  }
}
