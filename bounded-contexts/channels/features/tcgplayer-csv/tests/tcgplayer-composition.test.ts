import { describe, expect, it } from "vitest";
import type { ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import type { ChannelInventorySnapshotRow } from "../domain/contracts";
import { composeTcgplayerReservation, planStagedImportBatches } from "../domain/composition";
import { tcgplayerCompositionProfiles } from "../domain/profile";
import { parseTcgplayerFullExport } from "../domain/csv";

const digest = "a".repeat(64);
const reservation: ClaimedOperationReservation = {
  reservationId: "reservation-synthetic",
  connectionId: "connection-synthetic",
  providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
  claimant: { claimantKind: "manual", claimantId: "claimant-synthetic" },
  reservedAt: "2026-09-09T00:00:00Z",
  leaseExpiresAt: "2026-09-09T00:30:00Z",
  operations: [
    operation("operation-composed", "listing-composed", "channel-listing-composed", 11, 5, 3, 27),
    operation("operation-refused", "listing-refused", "channel-listing-refused", 12, 5, 1, 20),
    operation("operation-noop", "listing-noop", "channel-listing-noop", 13, 5, 2, 26),
  ],
};

describe("tcgplayer-member-outcomes-and-field-provenance", () => {
  it("partitions reservation membership exactly and computes deltas only from Staged", () => {
    const composed = composeTcgplayerReservation({
      runId: "run-synthetic",
      reservation,
      basisSnapshotId: "snapshot-staged",
      basisSnapshotGeneration: 7,
      basisRows: [basis("product:90000001", 4, 26), basis("product:90000003", 2, 26)],
      header: ["TCGplayer Id", "Title", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
      references: [
        reference("channel-listing-composed", {
          kind: "linked",
          providerKey: "tcgplayer",
          externalKey: "product:90000001",
        }),
        reference("channel-listing-refused", { kind: "unlinked" }),
        reference("channel-listing-noop", {
          kind: "linked",
          providerKey: "tcgplayer",
          externalKey: "product:90000003",
        }),
      ],
      profile: tcgplayerCompositionProfiles[0]!,
      maxRowsPerBatch: 500,
    });

    expect(composed.members).toHaveLength(3);
    expect(
      composed.members.map((member) => [member.memberKind, member.listingId, member.desiredStateSequence]),
    ).toEqual([
      ["composed", "listing-composed", 11],
      ["refused", "listing-refused", 12],
      ["already-satisfied", "listing-noop", 13],
    ]);
    expect(composed.members[0]).toMatchObject({
      memberKind: "composed",
      basisTotalQuantity: 4,
      targetQuantity: 3,
      csvRow: {
        "TCGplayer Id": "90000001",
        Title: "synthetic-title",
        "Add to Quantity": "-1",
        "TCG Marketplace Price": "0.27",
      },
    });
    expect(composed.members[1]).toMatchObject({
      memberKind: "refused",
      refusalReason: "provider-catalog-item-reference-unlinked",
    });
    expect(composed.members[2]).toMatchObject({
      memberKind: "already-satisfied",
      providerAction: "not-attempted-already-satisfied",
    });
    expect(composed.batch?.rows).toHaveLength(1);
    expect(composed.batch?.csv).not.toContain("chase-sets:snapshot-preserved");
  });

  it("keeps productReference and catalogItemReference families distinct", () => {
    const one = { ...reservation, operations: [reservation.operations[0]!] };
    const base = {
      runId: "run-synthetic",
      reservation: one,
      basisSnapshotId: "snapshot-staged",
      basisSnapshotGeneration: 7,
      basisRows: [basis("product:90000001", 4, 26)],
      header: ["TCGplayer Id", "Title", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
      profile: tcgplayerCompositionProfiles[0]!,
      maxRowsPerBatch: 500,
    };
    const catalogLinked = composeTcgplayerReservation({
      ...base,
      references: [
        {
          ...reference("channel-listing-composed", {
            kind: "linked",
            providerKey: "tcgplayer",
            externalKey: "product:90000001",
          }),
          productReference: { kind: "unlinked" },
        },
      ],
    });
    expect(catalogLinked.members[0]?.memberKind).toBe("composed");

    const productLinked = composeTcgplayerReservation({
      ...base,
      references: [
        {
          channelListingId: "channel-listing-composed",
          productReference: { kind: "linked", providerKey: "tcgplayer", externalKey: "sku:90000001" },
          catalogItemReference: { kind: "unlinked" },
        },
      ],
    });
    expect(productLinked.members[0]).toMatchObject({
      memberKind: "refused",
      refusalReason: "provider-catalog-item-reference-unlinked",
    });
  });

  it("keeps all four producer absence reasons and wrong-family identity distinct", () => {
    const one = { ...reservation, operations: [reservation.operations[0]!] };
    const base = {
      runId: "run-synthetic",
      reservation: one,
      basisSnapshotId: "snapshot-staged",
      basisSnapshotGeneration: 7,
      basisRows: [basis("product:90000001", 4, 26)],
      header: ["TCGplayer Id", "Title", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
      maxRowsPerBatch: 500,
    };
    const cases = [
      {
        profile: tcgplayerCompositionProfiles[0]!,
        catalogItemReference: { kind: "unlinked" as const },
        productReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "sku:90000001" },
        reason: "provider-catalog-item-reference-unlinked",
      },
      {
        profile: tcgplayerCompositionProfiles[0]!,
        catalogItemReference: { kind: "ambiguous" as const, candidateCount: 2 },
        productReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "sku:90000001" },
        reason: "provider-catalog-item-reference-ambiguous",
      },
      {
        profile: { ...tcgplayerCompositionProfiles[0]!, requiresProviderProductReference: true },
        catalogItemReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "product:90000001" },
        productReference: { kind: "unlinked" as const },
        reason: "provider-product-reference-unlinked",
      },
      {
        profile: { ...tcgplayerCompositionProfiles[0]!, requiresProviderProductReference: true },
        catalogItemReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "product:90000001" },
        productReference: { kind: "ambiguous" as const, candidateCount: 2 },
        reason: "provider-product-reference-ambiguous",
      },
      {
        profile: tcgplayerCompositionProfiles[0]!,
        catalogItemReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "sku:90000001" },
        productReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "product:90000001" },
        reason: "provider-reference-wrong-family",
      },
    ];
    expect(
      cases.map(
        (candidate) =>
          composeTcgplayerReservation({
            ...base,
            profile: candidate.profile,
            references: [
              {
                channelListingId: "channel-listing-composed",
                catalogItemReference: candidate.catalogItemReference,
                productReference: candidate.productReference,
              },
            ],
          }).members[0]?.refusalReason,
      ),
    ).toEqual(cases.map((candidate) => candidate.reason));
  });

  it("returns zero or one batch and refuses over-cap reservation residue", () => {
    expect(planStagedImportBatches({ runId: "r", reservationId: "q", header: [], members: [] })).toEqual([]);
    expect(() =>
      composeTcgplayerReservation({
        runId: "run-synthetic",
        reservation,
        basisSnapshotId: "snapshot-staged",
        basisSnapshotGeneration: 7,
        basisRows: [],
        header: [],
        references: [],
        profile: tcgplayerCompositionProfiles[0]!,
        maxRowsPerBatch: 2,
      }),
    ).toThrow("policy-served batch cap");
  });

  it("round-trips the synthetic composed CSV as an internal inverse", () => {
    const composed = composeTcgplayerReservation({
      runId: "run-synthetic",
      reservation: { ...reservation, operations: [reservation.operations[0]!] },
      basisSnapshotId: "snapshot-staged",
      basisSnapshotGeneration: 7,
      basisRows: [basis("product:90000001", 4, 26)],
      header: ["TCGplayer Id", "Title", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
      references: [
        reference("channel-listing-composed", {
          kind: "linked",
          providerKey: "tcgplayer",
          externalKey: "product:90000001",
        }),
      ],
      profile: tcgplayerCompositionProfiles[0]!,
      maxRowsPerBatch: 500,
    });
    expect(
      parseTcgplayerFullExport({ csv: composed.batch!.csv, surface: "staged" }, { maxRecords: 1 }),
    ).toMatchObject({
      kind: "parsed",
      rows: [{ externalKey: "product:90000001", totalQuantity: 4, pendingQuantityDelta: -1, priceAmountMinor: 27 }],
    });
  });
});

function operation(
  operationId: string,
  listingId: string,
  channelListingId: string,
  desiredStateSequence: number,
  liveQuantity: number,
  targetQuantity: number,
  targetPrice: number,
) {
  return {
    operationId,
    attemptId: `attempt-${operationId}`,
    claimGeneration: 1,
    connectionId: "connection-synthetic",
    providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" as const },
    channelListingId,
    listingId,
    operationKind: "update" as const,
    listingRevision: liveQuantity,
    desiredStateSequence,
    payload: {
      kind: "draft" as const,
      draft: {
        channelListingId,
        listingRevision: liveQuantity,
        title: "chase-sets:snapshot-preserved:tcgplayer",
        description: "chase-sets:snapshot-preserved:tcgplayer",
        categoryKey: "chase-sets:snapshot-preserved:tcgplayer",
        conditionKey: "chase-sets:snapshot-preserved:tcgplayer",
        price: { amountMinor: targetPrice, currency: "USD" },
        quantity: targetQuantity,
        attributes: [],
      },
    },
    payloadDigest: digest,
    sourceOccurredAt: "2026-09-09T00:00:00Z",
    enqueuedAt: "2026-09-09T00:00:01Z",
  };
}

function basis(externalKey: string, quantity: number, price: number): ChannelInventorySnapshotRow {
  return {
    snapshotId: "snapshot-staged",
    snapshotGeneration: 7,
    connectionId: "connection-synthetic",
    providerKey: "tcgplayer",
    surface: "staged",
    externalKey,
    conditionText: null,
    totalQuantity: quantity,
    pendingQuantityDelta: 0,
    priceAmountText: `${Math.floor(price / 100)}.${String(price % 100).padStart(2, "0")}00`,
    priceAmountMinor: price,
    currency: "USD",
    referenceColumns: { "TCGplayer Id": externalKey.slice("product:".length), Title: "synthetic-title" },
    rowNumber: 2,
    ingestedAt: "2026-09-09T00:00:00Z",
    capturedAt: "2026-09-09T00:00:00Z",
    capturedAtSource: "operator-declared",
  };
}

function reference(
  channelListingId: string,
  catalogItemReference: { kind: "linked"; providerKey: string; externalKey: string } | { kind: "unlinked" },
) {
  return { channelListingId, catalogItemReference, productReference: { kind: "unlinked" as const } };
}
