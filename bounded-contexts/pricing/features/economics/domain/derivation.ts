import { moneyToCents, signedMoneyToCents } from "@chase-sets/primitives/money";
import {
  requirePositiveInteger,
  requireRfc3339Instant,
  type DefaultReason,
  type EconomicsFact,
  type Money,
  type SignedMoney,
} from "./contracts";
import type { CapitalCycleObservations, CycleStatistic } from "./observations";
import type { ResolvedEconomicsPolicy } from "./policy";
import { canonicalSha256 } from "./revision";

export type InventoryCostLot = Readonly<{
  accountId: string;
  inventoryItemId: string;
  lotId: string;
  quantity: number;
  acquisitionCostPerUnit: Money | null;
  observedAt: string;
  revision: string;
}>;

export type CostBasisFacts = Readonly<{
  share: EconomicsFact<number>;
  coverage: EconomicsFact<number>;
  discount: EconomicsFact<SignedMoney>;
  coveredQuantity: number;
  selectedQuantity: number;
  coveredCostMinor: bigint;
  inventoryWatermark: string;
}>;

export function deriveCostBasisFacts(
  input: Readonly<{
    accountId: string;
    inventoryItemId: string;
    marketUnitPrice: Money;
    quantity: number;
    effectiveAt: string;
    inventoryWatermark: string;
    lots: readonly InventoryCostLot[];
    policy: ResolvedEconomicsPolicy;
  }>,
): CostBasisFacts {
  const quantity = requirePositiveInteger(input.quantity, "quantity", Number.MAX_SAFE_INTEGER);
  if (input.inventoryWatermark.length === 0 || input.inventoryWatermark.trim() !== input.inventoryWatermark) {
    throw new Error("inventoryWatermark must be non-empty and already trimmed.");
  }
  const effectiveMillis = Date.parse(requireRfc3339Instant(input.effectiveAt, "effectiveAt"));
  const eligible = input.lots
    .filter((lot) => lot.accountId === input.accountId && lot.inventoryItemId === input.inventoryItemId)
    .map((lot) => {
      requirePositiveInteger(lot.quantity, `Cost lot ${lot.lotId} quantity`, Number.MAX_SAFE_INTEGER);
      requireRfc3339Instant(lot.observedAt, `Cost lot ${lot.lotId} observedAt`);
      if (lot.lotId.length === 0 || lot.lotId.trim() !== lot.lotId) throw new Error("Cost lot identity is required.");
      if (lot.revision.length === 0 || lot.revision.trim() !== lot.revision) {
        throw new Error(`Cost lot ${lot.lotId} revision is required.`);
      }
      if (lot.acquisitionCostPerUnit !== null) moneyToCents(lot.acquisitionCostPerUnit.amount);
      return lot;
    })
    .filter((lot) => Date.parse(lot.observedAt) <= effectiveMillis)
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.lotId.localeCompare(right.lotId),
    );

  let remaining = quantity;
  let selectedQuantity = 0;
  let coveredQuantity = 0;
  let coveredCostCents = 0n;
  const material: Array<Readonly<{ lotId: string; quantity: number; cost: string | null; revision: string }>> = [];
  let oldestObservedAt: string | null = null;
  for (const lot of eligible) {
    if (remaining === 0) break;
    const selected = Math.min(remaining, lot.quantity);
    remaining -= selected;
    selectedQuantity += selected;
    oldestObservedAt =
      oldestObservedAt === null || Date.parse(lot.observedAt) < Date.parse(oldestObservedAt)
        ? lot.observedAt
        : oldestObservedAt;
    const cost = lot.acquisitionCostPerUnit;
    const currencyMatches = cost !== null && cost.currency === input.marketUnitPrice.currency;
    material.push({
      lotId: lot.lotId,
      quantity: selected,
      cost: currencyMatches ? cost.amount : null,
      revision: lot.revision,
    });
    if (!currencyMatches) continue;
    coveredQuantity += selected;
    coveredCostCents += moneyToCents(cost.amount) * BigInt(selected);
  }

  const coverageBps = Number((BigInt(coveredQuantity) * 10_000n + BigInt(quantity) / 2n) / BigInt(quantity));
  const marketUnitCents = moneyToCents(input.marketUnitPrice.amount);
  const marketCoveredCents = marketUnitCents * BigInt(coveredQuantity);
  const observedShareBps =
    marketCoveredCents > 0n
      ? Number((coveredCostCents * 10_000n + marketCoveredCents / 2n) / marketCoveredCents)
      : null;
  const shareIsUsable =
    coverageBps >= input.policy.value.minimumCostBasisCoverageBps &&
    observedShareBps !== null &&
    observedShareBps >= 0 &&
    observedShareBps <= 10_000;
  const inventoryRevision = canonicalSha256({ inventoryWatermark: input.inventoryWatermark, material });
  const inventoryObservedAt = oldestObservedAt ?? input.policy.observedAt;
  const actualOrDefaultShare = shareIsUsable ? observedShareBps : input.policy.value.defaultCostBasisShareOfMarketBps;
  const shareSource = shareIsUsable
    ? ({ kind: "inventory-observation", revision: inventoryRevision } as const)
    : ({
        kind: "policy-default",
        policyRevision: input.policy.policyRevision,
        reason: "cost-basis-unavailable",
      } as const);

  return {
    share: {
      sourceValue: actualOrDefaultShare,
      source: shareSource,
      effectiveValue: actualOrDefaultShare,
      override: null,
      observedAt: shareIsUsable ? inventoryObservedAt : input.policy.observedAt,
    },
    coverage: {
      sourceValue: coverageBps,
      source: { kind: "inventory-observation", revision: inventoryRevision },
      effectiveValue: coverageBps,
      override: null,
      observedAt: inventoryObservedAt,
    },
    discount: {
      sourceValue: {
        amount: input.policy.value.costBasisDiscountPerUnitAmount,
        currency: input.marketUnitPrice.currency,
      },
      source: { kind: "policy-owned", policyRevision: input.policy.policyRevision },
      effectiveValue: {
        amount: input.policy.value.costBasisDiscountPerUnitAmount,
        currency: input.marketUnitPrice.currency,
      },
      override: null,
      observedAt: input.policy.observedAt,
    },
    coveredQuantity,
    selectedQuantity,
    coveredCostMinor: coveredCostCents,
    inventoryWatermark: input.inventoryWatermark,
  };
}

export type CycleFacts = Readonly<{
  turnaround: EconomicsFact<number>;
  dailyReturnHurdle: EconomicsFact<number>;
  diagnostics: Readonly<{
    observedHoldDays: number | null;
    capitalCycleDays: number | null;
    hurdleStatus: "derived" | "defaulted";
    hurdleReason: DefaultReason | null;
  }>;
}>;

export function deriveCycleFacts(
  input: Readonly<{
    marketUnitPrice: Money;
    quantity: number;
    netProceedsAmount: Money;
    costBasisShareOfMarketBps: number;
    costBasisDiscountPerUnitAmount: SignedMoney;
    observations: CapitalCycleObservations;
    policy: ResolvedEconomicsPolicy;
    upstreamFailure?: "provider-unavailable" | "terms-unavailable" | "cost-basis-unavailable";
  }>,
): CycleFacts {
  const quantity = requirePositiveInteger(input.quantity, "quantity", Number.MAX_SAFE_INTEGER);
  assertCurrency(input.netProceedsAmount, input.marketUnitPrice.currency, "netProceedsAmount");
  assertCurrency(
    input.costBasisDiscountPerUnitAmount,
    input.marketUnitPrice.currency,
    "costBasisDiscountPerUnitAmount",
  );
  const turnaround = observedOrDefaultTurnaround(input.observations.observedTurnaround, input.policy);
  const hold = input.observations.observedHold;
  const observedHoldDays = hold?.value ?? null;
  const observedTurnaroundDays = input.observations.observedTurnaround?.value ?? null;
  const capitalCycleDays =
    observedHoldDays === null || observedTurnaroundDays === null ? null : observedHoldDays + observedTurnaroundDays;

  const defaultResult = (reason: DefaultReason): CycleFacts => ({
    turnaround,
    dailyReturnHurdle: {
      sourceValue: input.policy.value.defaultDailyReturnHurdle,
      source: { kind: "policy-default", policyRevision: input.policy.policyRevision, reason },
      effectiveValue: input.policy.value.defaultDailyReturnHurdle,
      override: null,
      observedAt: input.policy.observedAt,
    },
    diagnostics: { observedHoldDays, capitalCycleDays, hurdleStatus: "defaulted", hurdleReason: reason },
  });

  if (input.upstreamFailure) return defaultResult(input.upstreamFailure);
  if (hold === null || input.observations.observedTurnaround === null) {
    return defaultResult("insufficient-observed-history");
  }
  const netCents = moneyToCents(input.netProceedsAmount.amount);
  if (netCents <= 0n) return defaultResult("non-positive-net-proceeds");
  const unitCostCents =
    (Number(moneyToCents(input.marketUnitPrice.amount)) * input.costBasisShareOfMarketBps) / 10_000 -
    Number(signedMoneyToCents(input.costBasisDiscountPerUnitAmount.amount));
  const effectiveCostCents = quantity * unitCostCents;
  if (!Number.isFinite(effectiveCostCents) || effectiveCostCents <= 0) return defaultResult("non-positive-cost");
  if (capitalCycleDays === null || !Number.isFinite(capitalCycleDays) || capitalCycleDays <= 0) {
    return defaultResult("non-positive-cycle");
  }
  const hurdle = Math.log(Number(netCents) / effectiveCostCents) / capitalCycleDays;
  if (!Number.isFinite(hurdle)) return defaultResult("non-positive-cycle");
  const observedAt = oldest(hold.observedAt, input.observations.observedTurnaround.observedAt);
  return {
    turnaround,
    dailyReturnHurdle: {
      sourceValue: hurdle,
      source: {
        kind: "pricing-observation",
        policyRevision: input.policy.policyRevision,
        sampleCount: hold.sampleCount + input.observations.observedTurnaround.sampleCount,
      },
      effectiveValue: hurdle,
      override: null,
      observedAt,
    },
    diagnostics: { observedHoldDays, capitalCycleDays, hurdleStatus: "derived", hurdleReason: null },
  };
}

function observedOrDefaultTurnaround(
  observation: CycleStatistic | null,
  policy: ResolvedEconomicsPolicy,
): EconomicsFact<number> {
  return observation
    ? {
        sourceValue: observation.value,
        source: {
          kind: "pricing-observation",
          policyRevision: observation.policyRevision,
          sampleCount: observation.sampleCount,
        },
        effectiveValue: observation.value,
        override: null,
        observedAt: observation.observedAt,
      }
    : {
        sourceValue: policy.value.defaultTurnaroundDays,
        source: {
          kind: "policy-default",
          policyRevision: policy.policyRevision,
          reason: "insufficient-observed-history",
        },
        effectiveValue: policy.value.defaultTurnaroundDays,
        override: null,
        observedAt: policy.observedAt,
      };
}

function assertCurrency(value: Money | SignedMoney, expected: string, name: string): void {
  if (value.currency !== expected) throw new Error(`${name} currency must match ${expected}.`);
}

function oldest(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
