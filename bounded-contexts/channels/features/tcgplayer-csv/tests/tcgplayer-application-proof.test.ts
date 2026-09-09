import { describe, expect, it } from "vitest";
import type { ChannelSyncRun } from "../domain/contracts";
import { parseTcgplayerFullExport } from "../domain/csv";
import {
  applicationMatchesImportSummary,
  applicationMatchesSnapshot,
  deriveClaimedOperationOutcomes,
} from "../domain/lifecycle";

const run: ChannelSyncRun = {
  runId: "run-synthetic",
  revision: 3,
  sequence: 1,
  connectionId: "connection-synthetic",
  providerKey: "tcgplayer",
  reservationId: "reservation-synthetic",
  claimant: { claimantKind: "connector", claimantId: "claimant-synthetic" },
  leaseExpiresAt: "2026-09-09T00:30:00Z",
  manualClaimLeasePolicySnapshot: null,
  state: "awaiting-verification",
  basisSnapshotId: "snapshot-basis",
  basisSnapshotGeneration: 1,
  verificationSnapshotId: null,
  verificationSnapshotGeneration: null,
  uploadAttemptedAt: "2026-09-09T00:10:00Z",
  uploadFileName: "run-synthetic.csv",
  importSummary: null,
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:10:00Z",
  membershipCompleteness: { kind: "complete", total: 3 },
  members: [
    {
      operationId: "operation-composed",
      attemptId: "attempt-composed",
      claimGeneration: 4,
      reservationId: "reservation-synthetic",
      channelListingId: "channel-listing-composed",
      listingId: "listing-composed",
      desiredStateSequence: 41,
      listingRevision: 7,
      payloadDigest: "a".repeat(64),
      ordinal: 0,
      memberKind: "composed",
      externalKey: "product:90000001",
      conditionText: "Near Mint",
      basisSnapshotId: "snapshot-basis",
      basisSnapshotGeneration: 1,
      basisTotalQuantity: 2,
      basisPriceAmountMinor: 25,
      targetQuantity: 1,
      targetPriceAmountMinor: 26,
      csvRow: { "TCGplayer Id": "90000001", "Add to Quantity": "-1", "TCG Marketplace Price": "0.26" },
      refusalReason: null,
      mappingDimension: null,
      mappingSourceKey: null,
    },
    {
      operationId: "operation-refused",
      attemptId: "attempt-refused",
      claimGeneration: 5,
      reservationId: "reservation-synthetic",
      channelListingId: "channel-listing-refused",
      listingId: "listing-refused",
      desiredStateSequence: 42,
      listingRevision: 7,
      payloadDigest: "b".repeat(64),
      ordinal: 1,
      memberKind: "refused",
      externalKey: null,
      conditionText: null,
      basisSnapshotId: null,
      basisSnapshotGeneration: null,
      basisTotalQuantity: null,
      basisPriceAmountMinor: null,
      targetQuantity: null,
      targetPriceAmountMinor: null,
      csvRow: null,
      refusalReason: "provider-catalog-item-reference-unlinked",
      mappingDimension: null,
      mappingSourceKey: null,
    },
    {
      operationId: "operation-noop",
      attemptId: "attempt-noop",
      claimGeneration: 6,
      reservationId: "reservation-synthetic",
      channelListingId: "channel-listing-noop",
      listingId: "listing-noop",
      desiredStateSequence: 43,
      listingRevision: 7,
      payloadDigest: "c".repeat(64),
      ordinal: 2,
      memberKind: "already-satisfied",
      externalKey: "product:90000002",
      conditionText: null,
      basisSnapshotId: "snapshot-basis",
      basisSnapshotGeneration: 1,
      basisTotalQuantity: 3,
      basisPriceAmountMinor: 30,
      targetQuantity: 3,
      targetPriceAmountMinor: 30,
      csvRow: null,
      refusalReason: null,
      mappingDimension: null,
      mappingSourceKey: null,
      providerAction: "not-attempted-already-satisfied",
    },
  ],
};
const firstComposedMember = run.members[0];
if (!firstComposedMember || firstComposedMember.memberKind !== "composed") {
  throw new Error("Synthetic composed member fixture is unavailable.");
}

describe("tcgplayer-application-proof", () => {
  it("proves a synthetic two-row application only from an independently parsed newer Staged export", () => {
    const second = {
      ...firstComposedMember,
      operationId: "operation-composed-two",
      attemptId: "attempt-composed-two",
      channelListingId: "channel-listing-composed-two",
      listingId: "listing-composed-two",
      desiredStateSequence: 44,
      ordinal: 1,
      externalKey: "product:90000002",
      conditionText: "Lightly Played",
      targetQuantity: 3,
      targetPriceAmountMinor: 30,
    };
    const twoRowRun: ChannelSyncRun = {
      ...run,
      membershipCompleteness: { kind: "complete", total: 2 },
      members: [firstComposedMember, second],
    };
    const parsed = parseTcgplayerFullExport(
      {
        surface: "staged",
        csv: [
          "TCGplayer Id,Condition,Total Quantity,Add to Quantity,TCG Marketplace Price",
          "90000001,Near Mint,1,0,0.2600",
          "90000002,Lightly Played,3,0,0.3000",
        ].join("\r\n"),
      },
      { maxRecords: 2 },
    );
    if (parsed.kind !== "parsed") throw new Error("Synthetic verification export did not parse.");
    expect(
      applicationMatchesSnapshot(twoRowRun, {
        snapshotGeneration: 2,
        rows: parsed.rows,
      }),
    ).toBe(true);
    expect(parsed.rows[0]).toMatchObject({ priceAmountText: "0.2600", priceAmountMinor: 26 });
  });

  it("uses only a newer snapshot's quantity and minor-unit aggregate", () => {
    const rows = [
      {
        externalKey: "product:90000001",
        conditionText: "Near Mint",
        totalQuantity: 1,
        priceAmountMinor: 26,
        priceAmountText: "0.2600",
      },
    ];
    const row = rows[0];
    if (!row) throw new Error("Synthetic verification row is unavailable.");
    expect(applicationMatchesSnapshot(run, { snapshotGeneration: 2, rows })).toBe(true);
    expect(applicationMatchesSnapshot(run, { snapshotGeneration: 1, rows })).toBe(false);
    expect(applicationMatchesSnapshot(run, { snapshotGeneration: 2, rows: [{ ...row, priceAmountMinor: null }] })).toBe(
      false,
    );
    expect(applicationMatchesSnapshot(run, { snapshotGeneration: 2, rows: [{ ...row, totalQuantity: 2 }] })).toBe(
      false,
    );
    expect(applicationMatchesSnapshot(run, { snapshotGeneration: 2, rows: [] })).toBe(false);
    expect(applicationMatchesSnapshot(run, { snapshotGeneration: 2, rows: [row, row] })).toBe(false);
  });

  it("settles the mixed immutable partition without copying run state to every member", () => {
    const outcomes = deriveClaimedOperationOutcomes({ ...run, state: "applied" });
    expect(
      outcomes.map((outcome) => [outcome.operationId, outcome.desiredStateSequence, outcome.outcome.kind]),
    ).toEqual([
      ["operation-composed", 41, "applied"],
      ["operation-refused", 42, "rejected"],
      ["operation-noop", 43, "applied"],
    ]);
  });

  it("uses import summary fields only as mismatch tripwires", () => {
    const summary = {
      fileName: "run-synthetic.csv",
      dateImportedText: "9/9/2026 12:15 PM",
      numberOfProducts: 1,
      recordedAt: "2026-09-09T17:15:00Z",
    };
    expect(applicationMatchesImportSummary(run, summary)).toBe(true);
    expect(applicationMatchesImportSummary(run, { ...summary, fileName: "other.csv" })).toBe(false);
    expect(applicationMatchesImportSummary(run, { ...summary, numberOfProducts: 2 })).toBe(false);
  });
});
