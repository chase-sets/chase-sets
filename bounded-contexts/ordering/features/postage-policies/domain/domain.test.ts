import { describe, expect, it } from "vitest";
import { decidePostagePolicy, evolvePostagePolicy, initialPostagePolicyState } from "./domain";

describe("ordering postage policies", () => {
  it("normalizes draft policies and records signature rules", () => {
    const events = decidePostagePolicy(initialPostagePolicyState, {
      type: "CreatePostagePolicy",
      policyId: "opp_test",
      label: "Default postage policy",
      createdByUserId: "usr_admin",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: null,
      payload: {
        policyVersion: "operator-postage-v1",
        maxLetterUnits: 8,
        maxLetterWeightOunces: 3.5,
        maxLetterThicknessInches: 0.25,
        maxLetterDeclaredValueAmount: 50,
        letterEnvelopeWeightOunces: 0.4,
        parcelPackagingWeightOunces: 2,
        parcelRequiredShippingOptions: ["expedited", "priority"],
        letterRequiredPhysicalFlags: ["raw-card"],
        parcelRequiredPhysicalFlags: ["slab"],
        signatureRequiredShippingOptions: ["priority"],
        signatureRequiredDeclaredValueAmount: 100,
        signatureRequiredPhysicalFlags: ["slab"],
        insuranceRequiredDeclaredValueAmount: 500,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      data: {
        payload: expect.objectContaining({
          policyVersion: "operator-postage-v1",
          signatureRequiredShippingOptions: ["priority"],
          signatureRequiredDeclaredValueAmount: 100,
          insuranceRequiredDeclaredValueAmount: 500,
        }),
      },
    });

    const state = events.reduce(evolvePostagePolicy, initialPostagePolicyState);
    expect(state.status).toBe("draft");
    expect(state.payload?.parcelRequiredPhysicalFlags).toEqual(["slab"]);
  });

  it("uses platform default value tiers when draft thresholds are omitted", () => {
    const events = decidePostagePolicy(initialPostagePolicyState, {
      type: "CreatePostagePolicy",
      policyId: "opp_default_tiers",
      label: "Default postage policy",
      createdByUserId: "usr_admin",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: null,
      payload: {
        policyVersion: "operator-postage-v1",
      },
    });

    expect(events[0]).toMatchObject({
      data: {
        payload: expect.objectContaining({
          signatureRequiredDeclaredValueAmount: 250,
          insuranceRequiredDeclaredValueAmount: 500,
        }),
      },
    });
  });

  it("rejects unsupported policy values", () => {
    expect(() =>
      decidePostagePolicy(initialPostagePolicyState, {
        type: "CreatePostagePolicy",
        policyId: "opp_test",
        label: "Bad policy",
        createdByUserId: "usr_admin",
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
        payload: {
          policyVersion: "bad-v1",
          parcelRequiredShippingOptions: ["overnight" as never],
        },
      }),
    ).toThrow("unsupported value");
  });
});
