import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { compareMoney, PaymentsDomainError } from "../../../support/runtime-support/common";

/**
 * The two amounts at or above which a card payment steps up to 3-D Secure.
 * They are separate rules over separate quantities: `highPaymentAmount` is
 * compared with the amount charged to the card, `highSellerExposureAmount`
 * with the largest single seller payout inside the Payment.
 */
export type CardAuthenticationPolicyValue = Readonly<{
  highPaymentAmount: string;
  highSellerExposureAmount: string;
}>;

const defaultCardAuthenticationPolicyValue: CardAuthenticationPolicyValue = {
  highPaymentAmount: "250.00",
  highSellerExposureAmount: "250.00",
};

function invalid(): never {
  throw new PaymentsDomainError("card_authentication_policy_invalid", "card_authentication_policy_invalid");
}

function isObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeCardAuthenticationPolicy(value: JsonValue): CardAuthenticationPolicyValue {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !== Object.keys(defaultCardAuthenticationPolicyValue).sort().join(",")
  ) {
    return invalid();
  }
  const amount = (key: keyof CardAuthenticationPolicyValue): string => {
    const raw = value[key];
    if (typeof raw !== "string" || !/^(0|[1-9]\d{0,7})\.\d{2}$/.test(raw) || compareMoney(raw, "0.00") <= 0) {
      return invalid();
    }
    return raw;
  };
  return {
    highPaymentAmount: amount("highPaymentAmount"),
    highSellerExposureAmount: amount("highSellerExposureAmount"),
  };
}

export const cardAuthenticationPolicy = definePolicy({
  policyKey: "payments.card-authentication",
  contextName: "payments",
  schemaSummary:
    "payments.card-authentication/v1: closed; highPaymentAmount and highSellerExposureAmount are positive two-decimal amounts",
  defaultValue: defaultCardAuthenticationPolicyValue,
  decodeValue: decodeCardAuthenticationPolicy,
});
