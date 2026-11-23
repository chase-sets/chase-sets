import { describe, expect, it } from "vitest";
import {
  decidePostagePolicy,
  evolvePostagePolicy,
  initialPostagePolicyState,
  type OrderingPostagePolicyPayload,
  type PostagePolicyEvent,
} from "./domain";

const flagLists = [
  "letterRequiredPhysicalFlags",
  "parcelRequiredPhysicalFlags",
  "signatureRequiredPhysicalFlags",
] as const;
const productKinds = ["raw-card", "slab", "sealed"] as const;
const kindInEachFlagList = flagLists.flatMap((flagList) => productKinds.map((kind) => ({ flagList, kind })));

// A policy stored while product kinds were Physical Flags.
const storedPayloadThatNamesKinds = {
  policyVersion: "default-postage-policy-v2",
  maxLetterUnits: 8,
  maxLetterWeightOunces: 3.5,
  maxLetterThicknessInches: 0.25,
  maxLetterDeclaredValueAmount: 50,
  letterEnvelopeWeightOunces: 0.4,
  parcelPackagingWeightOunces: 2,
  parcelRequiredShippingOptions: ["expedited", "priority"],
  letterRequiredPhysicalFlags: ["raw-card"],
  parcelRequiredPhysicalFlags: ["slab", "sealed", "rigid", "metal", "jumbo", "irregular"],
  signatureRequiredShippingOptions: ["priority"],
  signatureRequiredDeclaredValueAmount: 250,
  signatureRequiredPhysicalFlags: ["slab"],
  insuranceRequiredDeclaredValueAmount: 500,
} as unknown as OrderingPostagePolicyPayload;

const storedCreatedEventThatNamesKinds: PostagePolicyEvent = {
  type: "ordering.postage-policy.created",
  data: {
    policyId: "opp_stored",
    label: "Stored postage policy",
    status: "draft",
    payload: storedPayloadThatNamesKinds,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    createdByUserId: "usr_admin",
  },
};

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
        letterRequiredPhysicalFlags: ["bendable"],
        parcelRequiredPhysicalFlags: ["rigid"],
        signatureRequiredShippingOptions: ["priority"],
        signatureRequiredDeclaredValueAmount: 100,
        signatureRequiredPhysicalFlags: ["rigid"],
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
    expect(state.payload?.letterRequiredPhysicalFlags).toEqual(["bendable"]);
    expect(state.payload?.parcelRequiredPhysicalFlags).toEqual(["rigid"]);
    expect(state.payload?.signatureRequiredPhysicalFlags).toEqual(["rigid"]);
  });

  it("accepts every physical property in each flag list", () => {
    const properties = ["rigid", "bendable", "metal", "jumbo", "irregular"] as const;
    const [created] = decidePostagePolicy(initialPostagePolicyState, {
      type: "CreatePostagePolicy",
      policyId: "opp_properties",
      label: "Every property",
      createdByUserId: "usr_admin",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: null,
      payload: {
        policyVersion: "operator-postage-v1",
        letterRequiredPhysicalFlags: properties,
        parcelRequiredPhysicalFlags: properties,
        signatureRequiredPhysicalFlags: properties,
      },
    });

    expect(created?.data).toMatchObject({
      payload: {
        letterRequiredPhysicalFlags: properties,
        parcelRequiredPhysicalFlags: properties,
        signatureRequiredPhysicalFlags: properties,
      },
    });
  });

  it.each(kindInEachFlagList)("rejects the $kind kind in $flagList when a policy is created", ({ flagList, kind }) => {
    expect(() =>
      decidePostagePolicy(initialPostagePolicyState, {
        type: "CreatePostagePolicy",
        policyId: "opp_kind",
        label: "Kind policy",
        createdByUserId: "usr_admin",
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
        payload: { policyVersion: "kind-v1", [flagList]: ["bendable", kind] },
      }),
    ).toThrow("physical flag includes an unsupported value.");
  });

  it.each(kindInEachFlagList)("rejects the $kind kind in $flagList when a policy is revised", ({ flagList, kind }) => {
    const state = evolvePostagePolicy(initialPostagePolicyState, storedCreatedEventThatNamesKinds);

    expect(() =>
      decidePostagePolicy(state, {
        type: "RevisePostagePolicy",
        label: "Kind policy",
        revisedByUserId: "usr_admin",
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
        payload: { policyVersion: "kind-v2", [flagList]: [kind] },
      }),
    ).toThrow("physical flag includes an unsupported value.");
  });

  it("folds a stream whose stored events name a kind to their payload, then to its revision", () => {
    const stored = evolvePostagePolicy(initialPostagePolicyState, storedCreatedEventThatNamesKinds);

    expect(stored.payload).toBe(storedPayloadThatNamesKinds);
    expect(stored.payload?.letterRequiredPhysicalFlags).toEqual(["raw-card"]);
    expect(stored.payload?.parcelRequiredPhysicalFlags).toEqual([
      "slab",
      "sealed",
      "rigid",
      "metal",
      "jumbo",
      "irregular",
    ]);
    expect(stored.payload?.signatureRequiredPhysicalFlags).toEqual(["slab"]);

    const storedRevision: PostagePolicyEvent = {
      type: "ordering.postage-policy.revised",
      data: {
        policyId: "opp_stored",
        label: "Stored postage policy",
        payload: { ...storedPayloadThatNamesKinds, policyVersion: "stored-revision" },
        effectiveFrom: "2026-02-01T00:00:00.000Z",
        effectiveUntil: null,
        revisedByUserId: "usr_admin",
      },
    };
    const revised = [
      storedCreatedEventThatNamesKinds,
      {
        type: "ordering.postage-policy.activated",
        data: { policyId: "opp_stored", activatedByUserId: "usr_admin", activationReason: "Reviewed" },
      } satisfies PostagePolicyEvent,
      storedRevision,
    ].reduce(evolvePostagePolicy, initialPostagePolicyState);

    expect(revised.status).toBe("active");
    expect(revised.payload).toBe(storedRevision.data.payload);
    expect(revised.payload?.letterRequiredPhysicalFlags).toEqual(["raw-card"]);

    const [replacement] = decidePostagePolicy(revised, {
      type: "RevisePostagePolicy",
      label: "Stored postage policy",
      revisedByUserId: "usr_admin",
      effectiveFrom: "2026-02-01T00:00:00.000Z",
      effectiveUntil: null,
      payload: { policyVersion: "properties-v1", letterRequiredPhysicalFlags: ["bendable"] },
    });
    expect(evolvePostagePolicy(revised, replacement!).payload?.letterRequiredPhysicalFlags).toEqual(["bendable"]);
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
