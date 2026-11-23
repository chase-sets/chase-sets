import { describe, expect, it } from "vitest";
import { buildCreatePolicyDocumentCommand } from "@chase-sets/platform-policy/commands";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE,
  authenticityFeePolicy,
  decodeAuthenticityFeePolicyValue,
} from "./policy";

describe("authenticity fee policy definition", () => {
  it("declares a policy key scoped to commercial-terms", () => {
    expect(authenticityFeePolicy.policyKey).toBe("commercial-terms.authenticity-fee");
    expect(authenticityFeePolicy.contextName).toBe("commercial-terms");
  });

  it("decodes its own launch default (definePolicy fails fast if this doesn't round-trip)", () => {
    expect(authenticityFeePolicy.defaultValue).toEqual(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE);
  });

  it("round-trips a valid policy value through JSON", () => {
    const encoded = JSON.parse(JSON.stringify(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE));
    expect(decodeAuthenticityFeePolicyValue(encoded)).toEqual(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE);
  });

  it("keeps the category key on the launch value and states its one value in the schema summary", () => {
    expect(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE.bands.map((band) => band.category)).toEqual(["any"]);
    expect(authenticityFeePolicy.schemaSummary).toContain('category: "any"');
  });

  it("rejects a policy with no bands", () => {
    expect(() => decodeAuthenticityFeePolicyValue({ optInThresholdAmount: "100.00", bands: [] })).toThrow(
      "at least one band",
    );
  });

  it("rejects a negative opt-in threshold", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "-1.00",
        bands: AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE.bands,
      }),
    ).toThrow("must be a valid decimal");
  });

  it("rejects a band percentage outside 0-10000 bps", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          {
            minOrderValueAmount: "0.00",
            category: "any",
            flatAmount: "8.00",
            percentageBps: 10_001,
            capAmount: "50.00",
          },
        ],
      }),
    ).toThrow("cannot exceed 10000 basis points");
  });

  it("rejects an unknown band category", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          {
            minOrderValueAmount: "0.00",
            category: "slabbed",
            flatAmount: "8.00",
            percentageBps: 200,
            capAmount: "50.00",
          },
        ],
      }),
    ).toThrow('category must be "any"');
  });

  it("rejects a band with no category", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [{ minOrderValueAmount: "0.00", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" }],
      }),
    ).toThrow('category must be "any"');
  });

  it("rejects a zero cap amount", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "0.00" },
        ],
      }),
    ).toThrow("greater than zero");
  });

  it("rejects two bands at one minimum order value", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
          { minOrderValueAmount: "0.00", category: "any", flatAmount: "10.00", percentageBps: 150, capAmount: "40.00" },
        ],
      }),
    ).toThrow("must not repeat a minimum order value");
  });

  it("accepts bands at different minimum order values", () => {
    const decoded = decodeAuthenticityFeePolicyValue({
      optInThresholdAmount: "100.00",
      bands: [
        { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
        {
          minOrderValueAmount: "1000.00",
          category: "any",
          flatAmount: "15.00",
          percentageBps: 150,
          capAmount: "75.00",
        },
      ],
    });
    expect(decoded.bands.map((band) => band.minOrderValueAmount)).toEqual(["0.00", "1000.00"]);
  });
});

// Document values as the policy store holds them: JSON written while a band could still be stored
// with a "raw" or "graded" category.
const storedAnyBand = {
  minOrderValueAmount: "0.00",
  category: "any",
  flatAmount: "8.00",
  percentageBps: 200,
  capAmount: "50.00",
};
const storedValueWithRetiredBands: JsonValue = JSON.parse(
  JSON.stringify({
    optInThresholdAmount: "100.00",
    bands: [
      { minOrderValueAmount: "0.00", category: "raw", flatAmount: "5.00", percentageBps: 100, capAmount: "25.00" },
      storedAnyBand,
      {
        minOrderValueAmount: "1000.00",
        category: "graded",
        flatAmount: "15.00",
        percentageBps: 150,
        capAmount: "75.00",
      },
    ],
  }),
);
const storedValueWithOnlyRetiredBands: JsonValue = JSON.parse(
  JSON.stringify({
    optInThresholdAmount: "100.00",
    bands: [
      { minOrderValueAmount: "0.00", category: "graded", flatAmount: "15.00", percentageBps: 150, capAmount: "75.00" },
    ],
  }),
);

describe("authenticity fee policy stored documents", () => {
  it("decodes a stored document without its raw and graded bands", () => {
    expect(decodeAuthenticityFeePolicyValue(storedValueWithRetiredBands)).toEqual({
      optInThresholdAmount: "100.00",
      bands: [storedAnyBand],
    });
  });

  it("decodes a stored document left with no band to an empty band list", () => {
    expect(decodeAuthenticityFeePolicyValue(storedValueWithOnlyRetiredBands)).toEqual({
      optInThresholdAmount: "100.00",
      bands: [],
    });
  });

  // A build that predates the removal validates every band, so a value it would refuse is refused here too.
  it("rejects a raw or graded band with a malformed field", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          { minOrderValueAmount: "abc", category: "raw", flatAmount: "5.00", percentageBps: 100, capAmount: "25.00" },
          storedAnyBand,
        ],
      }),
    ).toThrow("Authenticity fee band minimum order value");
  });

  it("rejects two raw bands at one minimum order value", () => {
    const rawBand = {
      minOrderValueAmount: "0.00",
      category: "raw",
      flatAmount: "5.00",
      percentageBps: 100,
      capAmount: "25.00",
    };
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [rawBand, { ...rawBand, flatAmount: "6.00" }, storedAnyBand],
      }),
    ).toThrow("Authenticity fee policy bands must not repeat a minimum order value.");
  });

  it("decodes through the policy definition the resolver reads stored documents with", () => {
    expect(authenticityFeePolicy.decodeValue(storedValueWithRetiredBands).bands).toEqual([storedAnyBand]);
  });

  it("stores a console-submitted value unchanged and reads it back as its any band alone", () => {
    const command = buildCreatePolicyDocumentCommand<unknown>(authenticityFeePolicy, {
      documentId: "pol_authenticity_fee",
      value: storedValueWithRetiredBands,
      status: "active",
      effectiveFrom: "2026-05-03T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });

    expect(command.value).toStrictEqual(storedValueWithRetiredBands);
    expect(authenticityFeePolicy.decodeValue(command.value)).toEqual({
      optInThresholdAmount: "100.00",
      bands: [storedAnyBand],
    });
  });
});
