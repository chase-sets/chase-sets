import type { MoneyAmount, SignedMoneyAmount } from "@chase-sets/primitives/money";
import type { Economics, EconomicsFact, FactSource } from "../../../economics/domain/contracts";
import { toEconomicsForPricingGoal, type EconomicsForPricingGoal } from "../../../economics/domain/resolution";

export type GoalFeeTerms = Readonly<{
  platformFeeRelativeBps: number;
  platformFeeFixedPerUnitAmount: string;
  platformFeeCapPerUnitAmount: string | null;
  sellerHandlingRelativeBps: number;
  sellerHandlingFixedPerUnitAmount: string;
  sellerHandlingCapPerUnitAmount: string | null;
}>;

const effectiveAt = "2026-10-10T12:00:00Z";
const source: FactSource = { kind: "pricing-observation", policyRevision: "sha256:synthetic-policy", sampleCount: 5 };
const fact = <Value>(value: Value): EconomicsFact<Value> => ({
  sourceValue: value,
  source,
  effectiveValue: value,
  override: null,
  observedAt: effectiveAt,
});
const diagnostics = {
  observedHoldDays: 10,
  capitalCycleDays: 38,
  hurdleStatus: "derived",
  hurdleReason: null,
  inventoryWatermark: "synthetic-inventory-watermark",
  pricingWatermark: "synthetic-pricing-watermark",
  generatedAt: effectiveAt,
  inventoryObservedAt: effectiveAt,
  pricingObservedAt: effectiveAt,
  generatedAgeSeconds: 0,
  inventorySourceAgeSeconds: 0,
  pricingSourceAgeSeconds: 0,
} as const;

/** Resolved Economics as a goal receives it: through the real adapter, so the currency stays lower case. */
export function resolvedGoalEconomics(
  terms: GoalFeeTerms,
  dailyReturnHurdle: number,
  currency = "usd",
): EconomicsForPricingGoal {
  const money = (amount: string) => ({ amount: amount as MoneyAmount, currency });
  const economics: Economics = {
    accountId: "synthetic-seller-account",
    channel: { kind: "native-marketplace" },
    currency,
    effectiveAt,
    revision: "sha256:synthetic-economics",
    facts: {
      platformFeeRelativeBps: fact(terms.platformFeeRelativeBps),
      platformFeeFixedPerUnitAmount: fact(money(terms.platformFeeFixedPerUnitAmount)),
      platformFeeCapPerUnitAmount: fact(
        terms.platformFeeCapPerUnitAmount === null ? null : money(terms.platformFeeCapPerUnitAmount),
      ),
      sellerHandlingRelativeBps: fact(terms.sellerHandlingRelativeBps),
      sellerHandlingFixedPerUnitAmount: fact(money(terms.sellerHandlingFixedPerUnitAmount)),
      sellerHandlingCapPerUnitAmount: fact(
        terms.sellerHandlingCapPerUnitAmount === null ? null : money(terms.sellerHandlingCapPerUnitAmount),
      ),
      shippingAllowanceBps: fact(0),
      costBasisShareOfMarketBps: fact(7_000),
      costBasisCoverageBps: fact(10_000),
      costBasisDiscountPerUnitAmount: fact({ amount: "0.00" as SignedMoneyAmount, currency }),
      turnaroundDays: fact(28),
      dailyReturnHurdle: fact(dailyReturnHurdle),
    },
    diagnostics,
  };
  return toEconomicsForPricingGoal({ kind: "resolved", economics });
}

/** Unavailable Economics carries a currency and a hurdle but no fee value. */
export function unavailableGoalEconomics(currency = "usd"): EconomicsForPricingGoal {
  return toEconomicsForPricingGoal({
    kind: "unavailable",
    reason: "provider-unavailable",
    accountId: "synthetic-seller-account",
    channel: { kind: "native-marketplace" },
    currency,
    effectiveAt,
    revision: "sha256:synthetic-economics",
    facts: {
      costBasisShareOfMarketBps: fact(7_000),
      costBasisCoverageBps: fact(10_000),
      costBasisDiscountPerUnitAmount: fact({ amount: "0.00" as SignedMoneyAmount, currency }),
      turnaroundDays: fact(28),
      dailyReturnHurdle: fact(0.005),
    },
    diagnostics,
  });
}
