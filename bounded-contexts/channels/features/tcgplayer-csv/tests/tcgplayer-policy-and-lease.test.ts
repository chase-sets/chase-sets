import { describe, expect, it } from "vitest";
import { tcgplayerStagedImportPolicy } from "../domain/policy";
import {
  assertManualClaimLeasePolicySnapshot,
  assertTcgplayerImportSummary,
  canonicalManualClaimLeasePolicySnapshotDigest,
} from "../domain/validation";

describe("tcgplayer-batch-cap-and-split", () => {
  it("keeps the ruled 500-row fallback distinct from decoder capacity", () => {
    expect(tcgplayerStagedImportPolicy.defaultValue).toEqual({ maxRowsPerBatch: 500 });
    expect(tcgplayerStagedImportPolicy.decodeValue({ maxRowsPerBatch: 1_000_000 })).toEqual({
      maxRowsPerBatch: 1_000_000,
    });
    expect(() => tcgplayerStagedImportPolicy.decodeValue({ maxRowsPerBatch: 1_000_001 })).toThrow();
    expect(() => tcgplayerStagedImportPolicy.decodeValue({ maxRowsPerBatch: 500, providerCapacity: 500 })).toThrow();
  });
});

describe("ManualClaimLeasePolicySnapshot", () => {
  it("accepts the exact fallback tuple and rejects digest or window changes", () => {
    const tuple = {
      policyKey: "channels.tcgplayer-manual-claim-lease" as const,
      value: { leaseMs: 1_800_000 },
      source: "fallback" as const,
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-09-09T00:00:00Z",
    };
    const snapshot = { ...tuple, digest: canonicalManualClaimLeasePolicySnapshotDigest(tuple) };
    expect(() => assertManualClaimLeasePolicySnapshot(snapshot)).not.toThrow();
    expect(() => assertManualClaimLeasePolicySnapshot({ ...snapshot, digest: "0".repeat(64) })).toThrow("digest");
    expect(() => assertManualClaimLeasePolicySnapshot({ ...snapshot, documentId: "policy-1" })).toThrow("Fallback");
  });
});

describe("TcgplayerImportSummary", () => {
  it("is recursively closed and timezone-bounded", () => {
    const summary = {
      fileName: "synthetic.csv",
      dateImportedText: "9/9/2026 12:15 PM",
      numberOfProducts: 2,
      recordedAt: "2026-09-09T17:15:00Z",
    };
    expect(() => assertTcgplayerImportSummary(summary)).not.toThrow();
    expect(() => assertTcgplayerImportSummary({ ...summary, extra: true })).toThrow("exactly");
    expect(() => assertTcgplayerImportSummary({ ...summary, recordedAt: "2026-09-09" })).toThrow("timezone");
    expect(() => assertTcgplayerImportSummary({ ...summary, numberOfProducts: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "safe integer",
    );
  });
});
