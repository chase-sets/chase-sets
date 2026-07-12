import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import { centsToMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  CommercialTermsDomainError,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  applyFeeFormula,
  normalizeLabel,
  normalizeMoneyAmount,
  normalizePercentageBps,
} from "../../../support/runtime-support/common";

export type MarketplaceSalesFeeSchedulePolicyValue = Readonly<{
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string;
  shippingAllowancePercentageBps: number;
}>;

export const MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY = "commercial-terms.marketplace-sales-fee-schedule";

/** The single published seller-side fee schedule and compiled fallback. */
export const MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE: MarketplaceSalesFeeSchedulePolicyValue = {
  label: "Standard seller terms",
  marketplaceSalesFeePercentageBps: 500,
  marketplaceSalesFeeFixedAmount: "0.00",
  marketplaceSalesFeeCapAmount: "25.00",
  shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
};

export function decodeMarketplaceSalesFeeSchedulePolicyValue(raw: JsonValue): MarketplaceSalesFeeSchedulePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommercialTermsDomainError("Marketplace sales fee schedule policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    label: normalizeLabel(String(record.label ?? ""), "Marketplace sales fee schedule label"),
    marketplaceSalesFeePercentageBps: normalizePercentageBps(
      Number(record.marketplaceSalesFeePercentageBps),
      "Marketplace sales fee percentage",
    ),
    marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(String(record.marketplaceSalesFeeFixedAmount ?? ""), {
      fieldName: "Marketplace sales fee fixed amount",
      allowZero: true,
    }),
    marketplaceSalesFeeCapAmount: normalizeMoneyAmount(String(record.marketplaceSalesFeeCapAmount ?? ""), {
      fieldName: "Marketplace sales fee cap amount",
      allowZero: false,
    }),
    shippingAllowancePercentageBps: normalizePercentageBps(
      Number(record.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS),
      "Shipping allowance percentage",
    ),
  };
}

export const marketplaceSalesFeeSchedulePolicy: PolicyDefinition<MarketplaceSalesFeeSchedulePolicyValue> = definePolicy(
  {
    policyKey: MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY,
    contextName: "commercial-terms",
    schemaSummary:
      "{ label, marketplaceSalesFeePercentageBps, marketplaceSalesFeeFixedAmount, marketplaceSalesFeeCapAmount, shippingAllowancePercentageBps }",
    defaultValue: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
    decodeValue: decodeMarketplaceSalesFeeSchedulePolicyValue,
  },
);

export function quoteMarketplaceSalesFee(
  basisAmount: string,
  schedule: Pick<
    MarketplaceSalesFeeSchedulePolicyValue,
    "marketplaceSalesFeePercentageBps" | "marketplaceSalesFeeFixedAmount" | "marketplaceSalesFeeCapAmount"
  >,
): string {
  const uncapped = applyFeeFormula(basisAmount, {
    percentageBps: schedule.marketplaceSalesFeePercentageBps,
    fixedAmount: schedule.marketplaceSalesFeeFixedAmount,
  });
  return centsToMoneyAmount(
    moneyToCents(uncapped) < moneyToCents(schedule.marketplaceSalesFeeCapAmount)
      ? moneyToCents(uncapped)
      : moneyToCents(schedule.marketplaceSalesFeeCapAmount),
  );
}
