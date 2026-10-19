import type { ChannelSyncRun } from "../domain/contracts";
import type { ClaimedReservationRunSettlement } from "../../outbound-sync/domain/contracts";

export function readbackRun(): ChannelSyncRun {
  return {
    runId: "run-synthetic-readback",
    revision: 2,
    sequence: 1,
    connectionId: "connection-synthetic",
    providerKey: "tcgplayer",
    reservationId: "reservation-synthetic",
    claimant: { claimantKind: "connector", claimantId: "connector-synthetic" },
    leaseExpiresAt: "2099-01-01T00:30:00Z",
    manualClaimLeasePolicySnapshot: null,
    state: "awaiting-verification",
    basisSnapshotId: "snapshot-synthetic",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: "2026-10-01T00:10:00Z",
    uploadFileName: "synthetic.csv",
    importSummary: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:10:00Z",
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [
      {
        operationId: "operation-synthetic",
        attemptId: "attempt-synthetic",
        claimGeneration: 1,
        reservationId: "reservation-synthetic",
        channelListingId: "channel-listing-synthetic",
        listingId: "listing-synthetic",
        desiredStateSequence: 1,
        listingRevision: 1,
        payloadDigest: "a".repeat(64),
        ordinal: 0,
        memberKind: "composed",
        externalKey: "product:90000001",
        conditionText: null,
        basisSnapshotId: "snapshot-synthetic",
        basisSnapshotGeneration: 1,
        basisTotalQuantity: 1,
        basisPriceAmountMinor: 100,
        targetQuantity: 2,
        targetPriceAmountMinor: 100,
        csvRow: { "TCGplayer Id": "90000001", "Add to Quantity": "1", "TCG Marketplace Price": "1.00" },
        refusalReason: null,
        mappingDimension: null,
        mappingSourceKey: null,
      },
    ],
  };
}

export function readbackSettlement(): ClaimedReservationRunSettlement {
  const run = readbackRun();
  return {
    runId: run.runId,
    expectedRunRevision: run.revision,
    fromState: "awaiting-verification",
    toState: "applied",
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    context: null,
    stagedReadback: { kind: "applied", counts: { preRows: 1, postRows: 1, members: 1 } },
  };
}

export const readbackSummary = {
  fileName: "synthetic.csv",
  dateImportedText: "synthetic date",
  numberOfProducts: 1,
  recordedAt: "2026-10-01T00:11:00Z",
};
