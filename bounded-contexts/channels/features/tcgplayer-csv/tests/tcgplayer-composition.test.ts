import { describe, expect, it } from "vitest";
import type { ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import type { ChannelInventorySnapshotRow } from "../domain/contracts";
import { composeTcgplayerReservation, planStagedImportBatches } from "../domain/composition";
import { tcgplayerCompositionProfiles } from "../domain/profile";
import { parseTcgplayerFullExport } from "../domain/csv";

const digest = "a".repeat(64);
const tcgplayerProfile = tcgplayerCompositionProfiles[0];
if (!tcgplayerProfile) throw new Error("TCGplayer composition profile fixture is unavailable.");
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
      conditionMappings: [],
      profile: tcgplayerProfile,
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

  it("rejects the Live-basis substitution mutant at the pure composition boundary", () => {
    expect(() =>
      composeTcgplayerReservation({
        runId: "run-synthetic",
        reservation: { ...reservation, operations: [reservation.operations[0]!] },
        basisSnapshotId: "snapshot-staged",
        basisSnapshotGeneration: 7,
        basisRows: [{ ...basis("product:90000001", 5, 26), surface: "live" }],
        header: ["TCGplayer Id", "Title", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
        references: [
          reference("channel-listing-composed", {
            kind: "linked",
            providerKey: "tcgplayer",
            externalKey: "product:90000001",
          }),
        ],
        conditionMappings: [],
        profile: tcgplayerProfile,
        maxRowsPerBatch: 500,
      }),
    ).toThrow("exact Staged snapshot");
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
      profile: tcgplayerProfile,
      conditionMappings: [],
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
      conditionMappings: [],
    };
    const cases = [
      {
        profile: tcgplayerProfile,
        catalogItemReference: { kind: "unlinked" as const },
        productReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "sku:90000001" },
        reason: "provider-catalog-item-reference-unlinked",
      },
      {
        profile: tcgplayerProfile,
        catalogItemReference: { kind: "ambiguous" as const, candidateCount: 2 },
        productReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "sku:90000001" },
        reason: "provider-catalog-item-reference-ambiguous",
      },
      {
        profile: { ...tcgplayerProfile, requiresProviderProductReference: true },
        catalogItemReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "product:90000001" },
        productReference: { kind: "unlinked" as const },
        reason: "provider-product-reference-unlinked",
      },
      {
        profile: { ...tcgplayerProfile, requiresProviderProductReference: true },
        catalogItemReference: { kind: "linked" as const, providerKey: "tcgplayer", externalKey: "product:90000001" },
        productReference: { kind: "ambiguous" as const, candidateCount: 2 },
        reason: "provider-product-reference-ambiguous",
      },
      {
        profile: tcgplayerProfile,
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
        conditionMappings: [],
        profile: tcgplayerProfile,
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
      conditionMappings: [],
      profile: tcgplayerProfile,
      maxRowsPerBatch: 500,
    });
    if (!composed.batch) throw new Error("Synthetic composition did not create a batch.");
    expect(parseTcgplayerFullExport({ csv: composed.batch.csv, surface: "staged" }, { maxRecords: 1 })).toMatchObject({
      kind: "parsed",
      rows: [{ externalKey: "product:90000001", totalQuantity: 4, pendingQuantityDelta: -1, priceAmountMinor: 27 }],
    });
  });

  it("emits one genuine condition candidate or uses its accepted provider target", () => {
    const one = { ...reservation, operations: [reservation.operations[0]!] };
    const input = {
      runId: "run-condition-mapping",
      reservation: one,
      basisSnapshotId: "snapshot-staged",
      basisSnapshotGeneration: 7,
      basisRows: [basis("product:90000001", 4, 26, "Near Mint"), basis("product:90000001", 4, 26, "Lightly Played")],
      header: ["TCGplayer Id", "Condition", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
      references: [
        reference("channel-listing-composed", {
          kind: "linked" as const,
          providerKey: "tcgplayer",
          externalKey: "product:90000001",
        }),
      ],
      profile: tcgplayerProfile,
      maxRowsPerBatch: 500,
    };
    const discovered = composeTcgplayerReservation({
      ...input,
      conditionMappings: [
        {
          channelListingId: "channel-listing-composed",
          dimension: "condition",
          sourceKey: "graded-condition:PSA|10",
          targetKey: null,
        },
      ],
    });
    expect(discovered.batch).toBeNull();
    expect(discovered.members).toEqual([
      expect.objectContaining({
        memberKind: "refused",
        refusalReason: "condition-identity-ambiguous",
        mappingDimension: "condition",
        mappingSourceKey: "graded-condition:PSA|10",
      }),
    ]);

    const accepted = composeTcgplayerReservation({
      ...input,
      conditionMappings: [
        {
          channelListingId: "channel-listing-composed",
          dimension: "condition",
          sourceKey: "graded-condition:PSA|10",
          targetKey: "Near Mint",
        },
      ],
    });
    expect(accepted.members[0]).toMatchObject({ memberKind: "composed", conditionText: "Near Mint" });
  });

  it("owns an omitted target only as one local refusal with no CSV row or invented mapping candidate", () => {
    const omitted = composeTcgplayerReservation({
      runId: "run-omitted-target",
      reservation: { ...reservation, operations: [reservation.operations[0]!] },
      basisSnapshotId: "snapshot-staged",
      basisSnapshotGeneration: 7,
      basisRows: [],
      header: ["TCGplayer Id", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
      references: [
        reference("channel-listing-composed", {
          kind: "linked",
          providerKey: "tcgplayer",
          externalKey: "product:90000001",
        }),
      ],
      conditionMappings: [],
      profile: tcgplayerProfile,
      maxRowsPerBatch: 500,
    });
    expect(omitted.batch).toBeNull();
    expect(omitted.members).toEqual([
      expect.objectContaining({
        memberKind: "refused",
        refusalReason: "staged-basis-row-absent",
        csvRow: null,
        mappingDimension: null,
        mappingSourceKey: null,
      }),
    ]);
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

function basis(
  externalKey: string,
  quantity: number,
  price: number,
  conditionText: string | null = null,
): ChannelInventorySnapshotRow {
  return {
    snapshotId: "snapshot-staged",
    snapshotGeneration: 7,
    connectionId: "connection-synthetic",
    providerKey: "tcgplayer",
    surface: "staged",
    externalKey,
    conditionText,
    totalQuantity: quantity,
    pendingQuantityDelta: 0,
    priceAmountText: `${Math.floor(price / 100)}.${String(price % 100).padStart(2, "0")}00`,
    priceAmountMinor: price,
    currency: "USD",
    referenceColumns: {
      "TCGplayer Id": externalKey.slice("product:".length),
      ...(conditionText === null ? {} : { Condition: conditionText }),
      Title: "synthetic-title",
      "Total Quantity": String(quantity),
    },
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
