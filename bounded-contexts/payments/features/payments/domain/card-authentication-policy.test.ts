import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import { cardAuthenticationPolicy, decodeCardAuthenticationPolicy } from "./card-authentication-policy";

describe("Card Authentication Policy", () => {
  it("declares the Payments key and the two amounts in force before the policy existed", () => {
    expect(cardAuthenticationPolicy.policyKey).toBe("payments.card-authentication");
    expect(cardAuthenticationPolicy.contextName).toBe("payments");
    expect(cardAuthenticationPolicy.defaultValue).toEqual({
      highPaymentAmount: "250.00",
      highSellerExposureAmount: "250.00",
    });
    expect(cardAuthenticationPolicy.decodeValue).toBe(decodeCardAuthenticationPolicy);
  });

  it("decodes two independent positive two-decimal amounts", () => {
    expect(
      decodeCardAuthenticationPolicy({ highPaymentAmount: "0.01", highSellerExposureAmount: "99999999.99" }),
    ).toEqual({ highPaymentAmount: "0.01", highSellerExposureAmount: "99999999.99" });
    expect(decodeCardAuthenticationPolicy({ highSellerExposureAmount: "400.00", highPaymentAmount: "100.00" })).toEqual(
      {
        highPaymentAmount: "100.00",
        highSellerExposureAmount: "400.00",
      },
    );
  });

  const valid = { highPaymentAmount: "250.00", highSellerExposureAmount: "250.00" };
  const rejected: readonly Readonly<{ name: string; value: JsonValue }>[] = [
    { name: "a missing highPaymentAmount", value: { highSellerExposureAmount: "250.00" } },
    { name: "a missing highSellerExposureAmount", value: { highPaymentAmount: "250.00" } },
    { name: "an unknown key", value: { ...valid, thresholdAmount: "250.00" } },
    { name: "one amount under another name", value: { highPaymentAmount: "250.00", amount: "250.00" } },
    { name: "a zero highPaymentAmount", value: { ...valid, highPaymentAmount: "0.00" } },
    { name: "a zero highSellerExposureAmount", value: { ...valid, highSellerExposureAmount: "0.00" } },
    { name: "a negative highPaymentAmount", value: { ...valid, highPaymentAmount: "-250.00" } },
    { name: "a negative highSellerExposureAmount", value: { ...valid, highSellerExposureAmount: "-0.01" } },
    { name: "an amount with no decimals", value: { ...valid, highPaymentAmount: "250" } },
    { name: "an amount with one decimal", value: { ...valid, highSellerExposureAmount: "250.0" } },
    { name: "an amount with three decimals", value: { ...valid, highPaymentAmount: "250.000" } },
    { name: "a leading zero", value: { ...valid, highPaymentAmount: "0250.00" } },
    { name: "a numeric amount", value: { ...valid, highSellerExposureAmount: 250 } },
    { name: "a null amount", value: { ...valid, highPaymentAmount: null } },
    { name: "an array", value: ["250.00", "250.00"] },
    { name: "null", value: null },
    { name: "a bare amount", value: "250.00" },
  ];

  it.each(rejected)("rejects $name", ({ value }) => {
    expect(() => decodeCardAuthenticationPolicy(value)).toThrow("card_authentication_policy_invalid");
  });
});
