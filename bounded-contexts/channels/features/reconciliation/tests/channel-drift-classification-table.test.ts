import { describe, expect, it } from "vitest";
import { classifyChannelDrift } from "../domain/classification";
import type { ChannelDriftObservationV1, ChannelSourceAuthority } from "../domain/contracts";

const complete: ChannelSourceAuthority = { kind: "complete", collectedCount: 1, authorityTotal: 1 };

function observation(override: Partial<ChannelDriftObservationV1> = {}): ChannelDriftObservationV1 {
  return {
    connectionId: "connection-1",
    channelListingId: "channel-listing-1",
    expectedRevision: 7,
    expectedPrice: { amountMinor: 1_500, currency: "USD" },
    expectedQuantity: 3,
    expectedMaterialFingerprint: "expected-fingerprint",
    lastAppliedRevision: 6,
    acceptedForeignEdit: null,
    observed: {
      present: true,
      revision: "7",
      price: { amountMinor: 1_500, currency: "USD" },
      quantity: 3,
      fingerprint: "expected-fingerprint",
    },
    sourceAuthority: complete,
    ...override,
  };
}

describe("channel-drift-classification-table", () => {
  it.each([
    ["exact expected state", observation(), "in-sync"],
    [
      "retained accepted edit",
      observation({
        observed: {
          present: true,
          revision: "foreign",
          price: { amountMinor: 1_600, currency: "USD" },
          quantity: 2,
          fingerprint: "observed-accepted",
        },
        acceptedForeignEdit: {
          observedFingerprint: "observed-accepted",
          expectedMaterialFingerprint: "expected-fingerprint",
          acceptedAtRunGeneration: 4,
        },
      }),
      "in-sync",
    ],
    [
      "expected moved after acceptance",
      observation({
        expectedMaterialFingerprint: "expected-moved",
        observed: {
          present: true,
          revision: "foreign",
          price: { amountMinor: 1_600, currency: "USD" },
          quantity: 2,
          fingerprint: "observed-accepted",
        },
        acceptedForeignEdit: {
          observedFingerprint: "observed-accepted",
          expectedMaterialFingerprint: "expected-fingerprint",
          acceptedAtRunGeneration: 4,
        },
      }),
      "foreign-edit",
    ],
    [
      "provider still reports last applied state",
      observation({
        expectedRevision: 7,
        lastAppliedRevision: 6,
        observed: {
          present: true,
          revision: "6",
          price: { amountMinor: 1_400, currency: "USD" },
          quantity: 4,
          fingerprint: "previously-applied",
        },
      }),
      "repairable",
    ],
    [
      "provider reports an unowned edit",
      observation({
        lastAppliedRevision: null,
        observed: {
          present: true,
          revision: "foreign",
          price: { amountMinor: 1_400, currency: "USD" },
          quantity: 4,
          fingerprint: "foreign",
        },
      }),
      "foreign-edit",
    ],
    ["complete source reports absence", observation({ observed: { present: false } }), "structural"],
    [
      "declared incomplete source",
      observation({ sourceAuthority: { kind: "declared-incomplete", reason: "page-total-mismatch" } }),
      "source-unavailable",
    ],
    [
      "claimed source absent by design",
      observation({
        observed: { present: false },
        sourceAuthority: { kind: "absent-by-design", reason: "claimed-snapshot-not-installed" },
      }),
      "source-unavailable",
    ],
  ] as const)("classifies %s without a fallthrough", (_label, input, expected) => {
    expect(classifyChannelDrift(input)).toBe(expected);
  });

  it("covers every authority, observation-presence, and last-applied nullability branch", () => {
    const authorities: readonly ChannelSourceAuthority[] = [
      complete,
      { kind: "declared-incomplete", reason: "count-mismatch" },
      { kind: "absent-by-design", reason: "reconciliation-capability-unregistered" },
    ];
    const observedStates: readonly ChannelDriftObservationV1["observed"][] = [
      { present: false },
      {
        present: true,
        revision: "6",
        price: { amountMinor: 1_400, currency: "USD" },
        quantity: 4,
        fingerprint: "previously-applied",
      },
    ];
    const results = new Set<string>();
    for (const sourceAuthority of authorities) {
      for (const observed of observedStates) {
        for (const lastAppliedRevision of [null, 6] as const) {
          const result = classifyChannelDrift(observation({ sourceAuthority, observed, lastAppliedRevision }));
          results.add(result);
          expect(result).toBe(
            sourceAuthority.kind !== "complete"
              ? "source-unavailable"
              : !observed.present
                ? "structural"
                : lastAppliedRevision === 6
                  ? "repairable"
                  : "foreign-edit",
          );
        }
      }
    }
    expect([...results].sort()).toEqual(["foreign-edit", "repairable", "source-unavailable", "structural"]);
  });
});

describe("channel-drift-provenance-discriminator", () => {
  it("distinguishes our unapplied desired move from a foreign edit", () => {
    const ours = observation({
      observed: {
        present: true,
        revision: "6",
        price: { amountMinor: 1_400, currency: "USD" },
        quantity: 4,
        fingerprint: "previously-applied",
      },
    });
    expect(classifyChannelDrift(ours)).toBe("repairable");
    expect(classifyChannelDrift({ ...ours, lastAppliedRevision: 5 })).toBe("foreign-edit");
  });
});
