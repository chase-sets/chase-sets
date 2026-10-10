import { describe, expect, it } from "vitest";
import {
  decodeStagedImportDispatchPolicy,
  decodeStagedImportDispatchPolicyResponse,
} from "../../connector-feed/domain/staged-import-dispatch-policy";

export function syntheticFloorResponse() {
  return {
    schemaVersion: 1,
    policyKey: "channels.tcgplayer-staged-import-dispatch",
    unit: "seconds",
    applicability: "founder-staged-import-all-provider-requests",
    connectionId: "connection-1",
    pairingId: "pairing-1",
    reservationId: "reservation-1",
    requestNonce: "a".repeat(32),
    policy: {
      source: "policy",
      documentId: "synthetic-policy",
      effectiveFrom: "2026-10-09T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-10-09T00:00:00.000Z",
      value: { minimumRequestStartIntervalSeconds: 60 },
      revision: "b".repeat(64),
    },
  };
}

describe("staged-import floor closed policy", () => {
  it("accepts exactly safe integer 60..600 seconds", () => {
    for (const value of [60, 61, 600])
      expect(decodeStagedImportDispatchPolicy({ minimumRequestStartIntervalSeconds: value })).toEqual({
        minimumRequestStartIntervalSeconds: value,
      });
    for (const value of [
      null,
      {},
      60,
      { minimumRequestStartIntervalSeconds: 59 },
      { minimumRequestStartIntervalSeconds: 601 },
      { minimumRequestStartIntervalSeconds: 60.1 },
      { minimumRequestStartIntervalSeconds: "60" },
      { minimumRequestStartIntervalSeconds: 60, extra: true },
    ])
      expect(() => decodeStagedImportDispatchPolicy(value)).toThrow("staged-import-policy-unavailable");
  });
  it("recursively closes provenance and rejects fallback, wrong units, windows and null bindings", () => {
    expect(decodeStagedImportDispatchPolicyResponse(syntheticFloorResponse())).toEqual(syntheticFloorResponse());
    const invalid: unknown[] = [
      { ...syntheticFloorResponse(), extra: true },
      { ...syntheticFloorResponse(), schemaVersion: 2 },
      { ...syntheticFloorResponse(), unit: "milliseconds" },
      { ...syntheticFloorResponse(), connectionId: null },
      { ...syntheticFloorResponse(), requestNonce: "a".repeat(31) },
      ...[
        { source: "fallback" },
        { documentId: null },
        { revision: "" },
        { effectiveFrom: "2026-10-09" },
        { resolvedAt: "2026-10-08T00:00:00Z" },
        { effectiveUntil: "2026-10-09T00:00:00Z" },
        { value: { minimumRequestStartIntervalSeconds: 60, nested: {} } },
        { extra: true },
      ].map((patch) => ({ ...syntheticFloorResponse(), policy: { ...syntheticFloorResponse().policy, ...patch } })),
    ];
    for (const value of invalid)
      expect(() => decodeStagedImportDispatchPolicyResponse(value)).toThrow("staged-import-policy-unavailable");
  });
});
