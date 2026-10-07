import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue, JsonObject } from "@chase-sets/primitives/json";
import { compareMoney } from "../../../support/runtime-support/common";
import { fundingRule } from "../domain/domain";

export type WalletFundingLimits = Readonly<{
  minimumAmount: string;
  maximumAmount: string;
  rollingThirtyDayMaximumAmount: string;
  rollingWindowDays: 30;
  allowedCurrencies: readonly "usd"[];
  allowedMethods: readonly "card"[];
}>;
export const defaultWalletFundingLimits: WalletFundingLimits = {
  minimumAmount: "5.00",
  maximumAmount: "500.00",
  rollingThirtyDayMaximumAmount: "2000.00",
  rollingWindowDays: 30,
  allowedCurrencies: ["usd"],
  allowedMethods: ["card"],
};
function isObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function decodeWalletFundingLimits(value: JsonValue): WalletFundingLimits {
  fundingRule(isObject(value), "funding_limits_invalid");
  fundingRule(
    Object.keys(value).sort().join(",") === Object.keys(defaultWalletFundingLimits).sort().join(","),
    "funding_limits_invalid",
  );
  const amount = (key: string): string => {
    const raw = value[key];
    fundingRule(
      typeof raw === "string" && /^(0|[1-9]\d{0,7})\.\d{2}$/.test(raw) && compareMoney(raw, "0.00") > 0,
      "funding_limits_invalid",
    );
    return raw;
  };
  const minimumAmount = amount("minimumAmount");
  const maximumAmount = amount("maximumAmount");
  const rollingThirtyDayMaximumAmount = amount("rollingThirtyDayMaximumAmount");
  fundingRule(value.rollingWindowDays === 30, "funding_limits_invalid");
  fundingRule(
    compareMoney(minimumAmount, maximumAmount) <= 0 && compareMoney(maximumAmount, rollingThirtyDayMaximumAmount) <= 0,
    "funding_limits_invalid",
  );
  fundingRule(
    Array.isArray(value.allowedCurrencies) &&
      value.allowedCurrencies.length <= 1 &&
      value.allowedCurrencies.every((v) => v === "usd"),
    "funding_limits_invalid",
  );
  fundingRule(
    Array.isArray(value.allowedMethods) &&
      value.allowedMethods.length <= 1 &&
      value.allowedMethods.every((v) => v === "card"),
    "funding_limits_invalid",
  );
  return {
    minimumAmount,
    maximumAmount,
    rollingThirtyDayMaximumAmount,
    rollingWindowDays: value.rollingWindowDays,
    allowedCurrencies: value.allowedCurrencies.length ? ["usd"] : [],
    allowedMethods: value.allowedMethods.length ? ["card"] : [],
  };
}
export const walletFundingLimitsPolicy = definePolicy({
  policyKey: "payments.wallet-funding-limits",
  contextName: "payments",
  schemaSummary:
    "payments.wallet-funding-limits/v1: closed positive decimal limits; rollingWindowDays: 30; allowedCurrencies: usd[]; allowedMethods: card[]",
  defaultValue: defaultWalletFundingLimits,
  decodeValue: decodeWalletFundingLimits,
});
