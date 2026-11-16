import { createHash } from "node:crypto";

export type Material = null | boolean | number | string | Material[] | { [key: string]: Material };
export type SetupItem = { [key: string]: Material };
export const policyTypes = ["fulfillment", "payment", "return"] as const;
export type PolicyType = (typeof policyTypes)[number];

export class EbaySetupError extends Error {
  constructor(
    public readonly code: "incomplete" | "invalid-selection" | "generation-conflict" | "credential-not-current",
  ) {
    super(code);
  }
}

type Parser = (value: unknown) => Material;
const invalid = (): never => {
  throw new EbaySetupError("incomplete");
};
const text: Parser = (value) =>
  typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value) ? value : invalid();
const boolean: Parser = (value) => (typeof value === "boolean" ? value : invalid());
const number: Parser = (value) => (typeof value === "number" && Number.isFinite(value) ? value : invalid());
const array =
  (parse: Parser): Parser =>
  (value) =>
    Array.isArray(value) && value.length <= 1000 ? value.map(parse) : invalid();
function object(fields: Record<string, Parser>, required: readonly string[] = []): (value: unknown) => SetupItem {
  return (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    if (required.some((key) => !Object.hasOwn(value, key))) return invalid();
    const result: SetupItem = {};
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(fields, key)) return invalid();
      result[key] = fields[key](item);
    }
    return result;
  };
}
const duration = object({ value: number, unit: text }, ["value", "unit"]);
const money = object({ value: text, currency: text }, ["value", "currency"]);
const category = object({ name: text, default: boolean }, ["name"]);
const returnTerms = {
  returnsAccepted: boolean,
  returnPeriod: duration,
  refundMethod: text,
  returnMethod: text,
  returnShippingCostPayer: text,
};
const policyFields: Record<PolicyType, Record<string, Parser>> = {
  fulfillment: {
    fulfillmentPolicyId: text,
    handlingTime: duration,
    globalShipping: boolean,
    pickupDropOff: boolean,
    freightShipping: boolean,
    shippingOptions: array(
      object({
        optionType: text,
        costType: text,
        shippingDiscountProfileId: text,
        shippingPromotionOffered: boolean,
        shippingServices: array(
          object({
            sortOrder: number,
            shippingCarrierCode: text,
            shippingServiceCode: text,
            shippingCost: money,
            additionalShippingCost: money,
            freeShipping: boolean,
            buyerResponsibleForShipping: boolean,
            buyerResponsibleForPickup: boolean,
          }),
        ),
      }),
    ),
  },
  payment: {
    paymentPolicyId: text,
    immediatePay: boolean,
    paymentMethods: array(
      object({
        paymentMethodType: text,
        recipientAccountReference: object({ referenceId: text, referenceType: text }),
      }),
    ),
  },
  return: { returnPolicyId: text, ...returnTerms, internationalOverride: object(returnTerms) },
};

// Closed captured item shapes: all admitted fields are material; none are discarded.
export function parsePolicyItem(type: PolicyType, value: unknown): SetupItem {
  const result = object(
    { name: text, description: text, marketplaceId: text, categoryTypes: array(category), ...policyFields[type] },
    ["name", "marketplaceId", `${type}PolicyId`],
  )(value);
  if (result.marketplaceId !== "EBAY_US" || !result.name || !result[`${type}PolicyId`]) return invalid();
  return result;
}
const address = object({
  addressLine1: text,
  addressLine2: text,
  city: text,
  stateOrProvince: text,
  postalCode: text,
  country: text,
});
const interval = object({ open: text, close: text }, ["open", "close"]);
export function parseLocationItem(value: unknown): SetupItem {
  const result = object(
    {
      merchantLocationKey: text,
      name: text,
      merchantLocationStatus: text,
      locationTypes: array(text),
      location: object({ address, geoCoordinates: object({ latitude: number, longitude: number }), locationId: text }),
      locationInstructions: text,
      locationWebUrl: text,
      phone: text,
      operatingHours: array(object({ dayOfWeekEnum: text, intervals: array(interval) })),
      specialHours: array(object({ date: text, intervals: array(interval) })),
    },
    ["merchantLocationKey", "location", "merchantLocationStatus", "locationTypes"],
  )(value);
  if (!result.merchantLocationKey) return invalid();
  return result;
}

export function canonicalSetupJson(value: Material): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSetupJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSetupJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function materialFingerprint(item: SetupItem): string {
  return `v1:${createHash("sha256").update(canonicalSetupJson(item), "utf8").digest("hex")}`;
}
