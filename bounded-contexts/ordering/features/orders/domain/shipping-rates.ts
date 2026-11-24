import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import { isCanonicalMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import { assert } from "./common";

export type ShippingRates = Readonly<{
  letterAmount: string;
  standardParcelAmount: string;
  expeditedParcelAmount: string;
  priorityParcelAmount: string;
  parcelIncludedOunces: number;
  parcelAdditionalOunceAmount: string;
}>;

export const defaultShippingRates: ShippingRates = {
  letterAmount: "1.49",
  standardParcelAmount: "4.99",
  expeditedParcelAmount: "7.49",
  priorityParcelAmount: "9.99",
  parcelIncludedOunces: 4,
  parcelAdditionalOunceAmount: "0.32",
};

export const SHIPPING_RATE_MINIMUM_AMOUNT = "0.00";
export const SHIPPING_RATE_MAXIMUM_AMOUNT = "100.00";
export const PARCEL_INCLUDED_OUNCES_MINIMUM = 0;
export const PARCEL_INCLUDED_OUNCES_MAXIMUM = 1000;

const shippingRateKeys = Object.keys(defaultShippingRates).sort().join(",");

export function decodeShippingRates(value: unknown): ShippingRates {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Shipping Rates must be an object of the six rates.",
  );
  assert(
    Object.keys(value).sort().join(",") === shippingRateKeys,
    "Shipping Rates must carry exactly the six rates and nothing else.",
  );
  const rates = value as Readonly<Record<keyof ShippingRates, unknown>>;
  const amount = (key: Exclude<keyof ShippingRates, "parcelIncludedOunces">): string => {
    const raw = rates[key];
    assert(
      typeof raw === "string" &&
        isCanonicalMoneyAmount(raw) &&
        moneyToCents(raw) >= moneyToCents(SHIPPING_RATE_MINIMUM_AMOUNT) &&
        moneyToCents(raw) <= moneyToCents(SHIPPING_RATE_MAXIMUM_AMOUNT),
      `Shipping Rates ${key} must be a two-decimal amount from ${SHIPPING_RATE_MINIMUM_AMOUNT} to ${SHIPPING_RATE_MAXIMUM_AMOUNT}.`,
    );
    return raw;
  };
  const parcelIncludedOunces = rates.parcelIncludedOunces;
  assert(
    typeof parcelIncludedOunces === "number" &&
      Number.isInteger(parcelIncludedOunces) &&
      parcelIncludedOunces >= PARCEL_INCLUDED_OUNCES_MINIMUM &&
      parcelIncludedOunces <= PARCEL_INCLUDED_OUNCES_MAXIMUM,
    `Shipping Rates parcelIncludedOunces must be a whole number from ${PARCEL_INCLUDED_OUNCES_MINIMUM} to ${PARCEL_INCLUDED_OUNCES_MAXIMUM}.`,
  );

  return {
    letterAmount: amount("letterAmount"),
    standardParcelAmount: amount("standardParcelAmount"),
    expeditedParcelAmount: amount("expeditedParcelAmount"),
    priorityParcelAmount: amount("priorityParcelAmount"),
    parcelIncludedOunces,
    parcelAdditionalOunceAmount: amount("parcelAdditionalOunceAmount"),
  };
}

export const shippingRatesPolicy = definePolicy({
  policyKey: "ordering.shipping-rates",
  contextName: "ordering",
  schemaSummary: `{ letterAmount, standardParcelAmount, expeditedParcelAmount, priorityParcelAmount, parcelAdditionalOunceAmount: two-decimal amount ${SHIPPING_RATE_MINIMUM_AMOUNT}-${SHIPPING_RATE_MAXIMUM_AMOUNT}, parcelIncludedOunces: integer ${PARCEL_INCLUDED_OUNCES_MINIMUM}-${PARCEL_INCLUDED_OUNCES_MAXIMUM} }`,
  defaultValue: defaultShippingRates,
  decodeValue: decodeShippingRates,
});
