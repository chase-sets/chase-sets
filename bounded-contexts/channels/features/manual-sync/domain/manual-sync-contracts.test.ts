import { describe, expect, it } from "vitest";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import type { ChannelSyncRun, ChannelSyncRunState } from "../../tcgplayer-csv/domain/contracts";
import { resolveManualSyncActions } from "./contracts";
import { founderExportIngestProbe, inspectTcgplayerExportBytes } from "./ingest";
import { decodeTcgplayerManualClaimLeasePolicyValue, freezeManualClaimLeasePolicySnapshot } from "./policy";

describe("manual-sync-panel-state-action-matrix", () => {
  it("exposes only the registered manual actions in every run state", () => {
    expect(resolveManualSyncActions(null)).toEqual(["ingest-live", "ingest-staged", "compose"]);
    const expected: Record<ChannelSyncRunState, readonly string[]> = {
      composed: ["download"],
      claimed: ["record-upload-attempt", "record-validation-cancellation", "release"],
      "awaiting-verification": ["ingest-staged", "verify"],
      applied: [],
      "validation-rejected": [],
      "application-unknown": [],
      superseded: [],
      "stale-basis": [],
      abandoned: [],
    };
    for (const [state, actions] of Object.entries(expected)) {
      expect(resolveManualSyncActions(run(state as ChannelSyncRunState))).toEqual(actions);
    }
    expect(
      resolveManualSyncActions({ ...run("composed"), claimant: { claimantKind: "connector", claimantId: "worker" } }),
    ).toEqual([]);
  });
});

describe("manual-sync-claim-policy", () => {
  it.each([60_000, 1_800_000, 7_200_000])("accepts inclusive lease value %i", (leaseMs) => {
    expect(decodeTcgplayerManualClaimLeasePolicyValue({ leaseMs })).toEqual({ leaseMs });
  });

  it.each([59_999, 7_200_001, 60_000.5, null, { leaseMs: 60_000, extra: true }])(
    "rejects malformed or out-of-range value %j",
    (value) => expect(() => decodeTcgplayerManualClaimLeasePolicyValue(value as never)).toThrow(),
  );

  it("freezes the complete fallback tuple and a lowercase canonical digest", () => {
    const resolution: ResolvedPolicy<{ leaseMs: number }> = {
      policyKey: "channels.tcgplayer-manual-claim-lease",
      value: { leaseMs: 1_800_000 },
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-09-10T12:00:00.000Z",
    };
    const snapshot = freezeManualClaimLeasePolicySnapshot(resolution);
    expect(snapshot).toMatchObject(resolution);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("manual-sync-export-ingest-bounds-and-completeness", () => {
  it("counts a quoted newline as one logical row and produces a body-free founder probe", () => {
    const inspected = inspectTcgplayerExportBytes(
      new TextEncoder().encode('TCGplayer Id,Product Name\r\n1,"one\ncard"\r\n2,two\r\n'),
    );
    expect(inspected.logicalRows).toBe(2);
    expect(inspected.headerText).toBe("TCGplayer Id,Product Name");
    expect(founderExportIngestProbe(inspected, { fileName: "live.csv", observedAt: "2026-09-10T12:00:00Z" })).toEqual(
      expect.objectContaining({ fileName: "live.csv", logicalRows: 2, byteSize: 48 }),
    );
  });

  it("refuses logical record 100001 before the producer parser is called", () => {
    const csv = `id\n${"1\n".repeat(100_001)}`;
    expect(() => inspectTcgplayerExportBytes(new TextEncoder().encode(csv))).toThrowError(
      expect.objectContaining({ code: "export-record-limit-exceeded" }),
    );
  });
});

function run(state: ChannelSyncRunState): ChannelSyncRun {
  return {
    runId: "run-manual",
    revision: 1,
    sequence: 1,
    connectionId: "connection-tcgplayer",
    providerKey: "tcgplayer",
    reservationId: "reservation-manual",
    claimant: { claimantKind: "manual", claimantId: "seller" },
    leaseExpiresAt: "2026-09-10T12:30:00Z",
    manualClaimLeasePolicySnapshot: null,
    state,
    basisSnapshotId: "snapshot-basis",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
    membershipCompleteness: { kind: "complete", total: 0 },
    members: [],
  };
}
