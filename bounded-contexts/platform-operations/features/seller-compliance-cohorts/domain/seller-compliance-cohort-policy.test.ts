import { describe, expect, it } from "vitest";
import { MONEY_AMOUNT_MAX_CENTS } from "@chase-sets/primitives/money";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  decodeSellerComplianceCohortPolicyValue as decode,
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE as defaults,
} from "./seller-compliance-cohort-policy";

const configured = {
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 200,
  qualifyingGrossCents: "500000",
  disclosureGrossCents: "2000000",
  windowMonths: 12,
  lookbackMonths: 24,
  comparisonIsInclusive: true,
  saleUnit: "captured-order",
  qualifyingGrossBasis: "item-gross",
  refundTreatment: "exclude-refunded",
  postCaptureCancellationTreatment: "exclude-cancelled",
  mixedLineTreatment: "exclude-mixed",
  unclassifiableTreatment: "exclude-unclassifiable",
  classificationRules: [{ source: "productId", value: "new-or-unused" }],
};

describe("seller compliance cohort policy", () => {
  it("inert-gate: leaves every unresolved interpretation null and rejects each null on activation", () => {
    expect(decode(defaults as JsonValue)).toEqual(defaults);
    expect(decode({ activated: false })).toEqual(defaults);
    expect(decode(configured)).toEqual(configured);
    for (const field of Object.keys(configured).filter((key) => key !== "activated")) {
      expect(() => decode({ ...configured, [field]: null }), field).toThrow("every interpretive field");
      const missing = { ...configured } as Record<string, JsonValue>;
      delete missing[field];
      expect(() => decode(missing), field).toThrow("every interpretive field");
      expect(
        decode({ ...defaults, [field]: configured[field as keyof typeof configured] } as JsonValue).activated,
      ).toBe(false);
    }
  });

  it("positive-twin: exact integer bounds and their +/-1 neighbors", () => {
    for (const [key, min, max] of [
      ["qualifyingTransactionCount", 1, 1_000_000],
      ["windowMonths", 1, 24],
      ["lookbackMonths", 1, 60],
    ] as const) {
      for (const value of [min, min + 1, max - 1, max])
        expect(decode({ ...defaults, [key]: value })[key], `${key}=${value}`).toBe(value);
      for (const value of [min - 1, max + 1, 1.5, true, "1"])
        expect(() => decode({ ...defaults, [key]: value }), `${key}=${value}`).toThrow();
    }
    expect(decode({ ...configured, lookbackMonths: 12 }).lookbackMonths).toBe(12);
    expect(() => decode({ ...configured, lookbackMonths: 11 })).toThrow("at least windowMonths");
    expect(decode({ ...configured, lookbackMonths: 13 }).lookbackMonths).toBe(13);
  });

  it("exact-threshold: validates cents at zero, maximum and their +/-1 twins", () => {
    for (const key of ["qualifyingGrossCents", "disclosureGrossCents"] as const) {
      for (const value of ["0", "1", (MONEY_AMOUNT_MAX_CENTS - 1n).toString(), MONEY_AMOUNT_MAX_CENTS.toString()])
        expect(decode({ ...defaults, [key]: value })[key]).toBe(value);
      for (const value of ["-1", (MONEY_AMOUNT_MAX_CENTS + 1n).toString(), "1.2", 1.2, true, ""])
        expect(() => decode({ ...defaults, [key]: value })).toThrow();
      expect(decode({ ...defaults, [key]: 500000 })[key]).toBe("500000");
    }
    for (const delta of [0, 1])
      expect(decode({ ...configured, disclosureGrossCents: String(500000 + delta) }).disclosureGrossCents).toBe(
        String(500000 + delta),
      );
    expect(() => decode({ ...configured, disclosureGrossCents: "499999" })).toThrow("at least qualifyingGrossCents");
  });

  it("treatment-matrix: decodes every supported choice and rejects cross-field choices", () => {
    const treatments = {
      saleUnit: ["captured-order"],
      qualifyingGrossBasis: ["item-gross", "item-gross-plus-shipping"],
      refundTreatment: ["exclude-refunded", "count-refunded"],
      postCaptureCancellationTreatment: ["exclude-cancelled", "exclude-if-fully-refunded", "count-cancelled"],
      mixedLineTreatment: ["exclude-mixed", "count-mixed"],
      unclassifiableTreatment: ["exclude-unclassifiable", "count-unclassifiable"],
    };
    for (const [field, values] of Object.entries(treatments)) {
      for (const value of values)
        expect(decode({ ...configured, [field]: value })[field as keyof typeof configured]).toEqual(value);
      for (const invalid of ["unsupported", false, 1, [], {}])
        expect(() => decode({ ...configured, [field]: invalid })).toThrow();
    }
  });

  it("recursively validates classification rules and scalar types", () => {
    for (const source of ["productId", "catalogItemId", "selectedOptionId", "gradedCard"])
      expect(
        decode({ ...configured, classificationRules: [{ source, value: "new-or-unused" }] }).classificationRules,
      ).toEqual([{ source, value: "new-or-unused" }]);
    for (const rules of [
      [],
      [null],
      [[]],
      [{ source: "unknown", value: "new" }],
      [{ source: "productId", value: "" }],
      [{ source: "productId", value: 1 }],
    ])
      expect(() => decode({ ...configured, classificationRules: rules })).toThrow();
    for (const raw of [null, [], true, 1, "value", {}]) expect(() => decode(raw)).toThrow();
    for (const currencyCode of ["usd", "US", "USDD", 123])
      expect(() => decode({ ...configured, currencyCode })).toThrow();
    for (const comparisonIsInclusive of [false, true])
      expect(decode({ ...configured, comparisonIsInclusive }).comparisonIsInclusive).toBe(comparisonIsInclusive);
    expect(() => decode({ ...configured, comparisonIsInclusive: "true" })).toThrow();
  });
});
