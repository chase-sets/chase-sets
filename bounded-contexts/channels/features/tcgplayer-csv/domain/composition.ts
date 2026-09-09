import type { ClaimedOperationReservation, ClaimedOutboundOperation } from "../../outbound-sync/domain/contracts";
import type {
  ChannelCompositionProfile,
  ChannelListingDelistDirective,
  ChannelReferenceRead,
  ChannelReferenceResolution,
} from "../../listing-composition/domain/contracts";
import { formatTcgplayerMinorUnits, serializeCsv } from "./csv";
import type {
  ChannelInventorySnapshotRow,
  ChannelSyncRunMember,
  ChannelSyncRunRefusedMember,
  StagedImportBatch,
  TcgplayerLocalRefusalReason,
} from "./contracts";

export type ComposeTcgplayerReservationInput = Readonly<{
  runId: string;
  reservation: ClaimedOperationReservation;
  basisSnapshotId: string;
  basisSnapshotGeneration: number;
  basisRows: readonly ChannelInventorySnapshotRow[];
  header: readonly string[];
  references: readonly ChannelReferenceRead[];
  profile: ChannelCompositionProfile;
  maxRowsPerBatch: number;
}>;

export type ComposedTcgplayerReservation = Readonly<{
  members: readonly ChannelSyncRunMember[];
  batch: StagedImportBatch | null;
}>;

type RunMemberCommon = Pick<
  ChannelSyncRunRefusedMember,
  | "operationId"
  | "attemptId"
  | "claimGeneration"
  | "reservationId"
  | "channelListingId"
  | "listingId"
  | "desiredStateSequence"
  | "listingRevision"
  | "payloadDigest"
  | "ordinal"
>;

export function composeTcgplayerReservation(input: ComposeTcgplayerReservationInput): ComposedTcgplayerReservation {
  if (!Number.isSafeInteger(input.maxRowsPerBatch) || input.maxRowsPerBatch < 1 || input.maxRowsPerBatch > 1_000_000) {
    throw new Error("maxRowsPerBatch is invalid.");
  }
  if (input.reservation.operations.length > input.maxRowsPerBatch) {
    throw new Error("Reservation exceeds the policy-served batch cap.");
  }
  if (input.profile.identity.providerKey !== "tcgplayer") throw new Error("TCGplayer composition profile is required.");
  if (
    input.reservation.connectionId.length === 0 ||
    input.reservation.providerIdentity.providerKey !== "tcgplayer" ||
    input.reservation.providerIdentity.environment !== input.profile.identity.environment
  ) {
    throw new Error("Reservation identity does not match the TCGplayer composition profile.");
  }
  if (
    input.basisRows.some(
      (row) =>
        row.connectionId !== input.reservation.connectionId ||
        row.providerKey !== "tcgplayer" ||
        row.surface !== "staged" ||
        row.snapshotId !== input.basisSnapshotId ||
        row.snapshotGeneration !== input.basisSnapshotGeneration,
    )
  ) {
    throw new Error("Every composition basis row must belong to the exact Staged snapshot.");
  }
  const references = new Map(input.references.map((reference) => [reference.channelListingId, reference]));
  const members = input.reservation.operations.map((operation, ordinal) =>
    composeOperation(input, operation, ordinal, references.get(operation.channelListingId)),
  );
  const rows = members.flatMap((member) => (member.memberKind === "composed" ? [member.csvRow] : []));
  return {
    members,
    batch:
      rows.length === 0
        ? null
        : {
            runId: input.runId,
            reservationId: input.reservation.reservationId,
            header: input.header,
            rows,
            csv: serializeCsv(input.header, rows),
          },
  };
}

export function planStagedImportBatches(
  input: Readonly<{
    runId: string;
    reservationId: string;
    header: readonly string[];
    members: readonly ChannelSyncRunMember[];
  }>,
): readonly StagedImportBatch[] {
  const rows = input.members.flatMap((member) => (member.memberKind === "composed" ? [member.csvRow] : []));
  return rows.length === 0
    ? []
    : [
        {
          runId: input.runId,
          reservationId: input.reservationId,
          header: input.header,
          rows,
          csv: serializeCsv(input.header, rows),
        },
      ];
}

export function tcgplayerExternalListingId(externalKey: string, conditionText: string | null): string {
  const condition = conditionText ?? "";
  return `tcgplayer:${externalKey.length}:${externalKey}:${condition.length}:${condition}`;
}

function composeOperation(
  input: ComposeTcgplayerReservationInput,
  operation: ClaimedOutboundOperation,
  ordinal: number,
  reference: ChannelReferenceRead | undefined,
): ChannelSyncRunMember {
  const common = {
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    claimGeneration: operation.claimGeneration,
    reservationId: input.reservation.reservationId,
    channelListingId: operation.channelListingId,
    listingId: operation.listingId,
    desiredStateSequence: operation.desiredStateSequence,
    listingRevision: operation.listingRevision,
    payloadDigest: operation.payloadDigest,
    ordinal,
  };
  if (!reference) return refused(common, "provider-catalog-item-reference-unlinked");
  const referenceRefusal = validateReferences(input.profile, reference);
  if (referenceRefusal) return refused(common, referenceRefusal);
  const catalogReference = reference.catalogItemReference;
  if (catalogReference.kind !== "linked") return refused(common, catalogReferenceRefusal(catalogReference));
  if (catalogReference.providerKey !== "tcgplayer" || !/^product:[1-9]\d*$/.test(catalogReference.externalKey)) {
    return refused(common, "provider-reference-wrong-family", catalogReference.externalKey);
  }
  const candidates = input.basisRows.filter((row) => row.externalKey === catalogReference.externalKey);
  if (candidates.length === 0) return refused(common, "staged-basis-row-absent", catalogReference.externalKey);
  const target = readTarget(operation);
  if (target.kind === "refused") return refused(common, target.reason, catalogReference.externalKey);
  const basis = chooseBasisRow(candidates, target.conditionKey, input.profile.snapshotPreservedPlaceholder);
  if (!basis) return refused(common, "condition-identity-ambiguous", catalogReference.externalKey);
  if (basis.pendingQuantityDelta !== 0) {
    return refusedFromBasis(common, "staged-pending-delta-unknown", basis);
  }
  if (basis.priceAmountMinor === null) return refusedFromBasis(common, "price-unresolvable", basis);
  if (!Number.isSafeInteger(target.priceAmountMinor) || target.priceAmountMinor < 0) {
    return refusedFromBasis(common, "price-not-cents-exact", basis);
  }
  if (target.currency !== "USD") return refusedFromBasis(common, "currency-not-usd", basis);
  const details = {
    ...common,
    externalKey: basis.externalKey,
    conditionText: basis.conditionText,
    basisSnapshotId: basis.snapshotId,
    basisSnapshotGeneration: basis.snapshotGeneration,
    basisTotalQuantity: basis.totalQuantity,
    basisPriceAmountMinor: basis.priceAmountMinor,
    targetQuantity: target.quantity,
    targetPriceAmountMinor: target.priceAmountMinor,
    refusalReason: null,
    mappingDimension: null,
    mappingSourceKey: null,
  } as const;
  if (basis.totalQuantity === target.quantity && basis.priceAmountMinor === target.priceAmountMinor) {
    return {
      ...details,
      memberKind: "already-satisfied",
      csvRow: null,
      providerAction: "not-attempted-already-satisfied",
    };
  }
  const csvRow: Record<string, string> = { ...basis.referenceColumns };
  csvRow["Add to Quantity"] = String(target.quantity - basis.totalQuantity);
  csvRow["TCG Marketplace Price"] = formatTcgplayerMinorUnits(target.priceAmountMinor);
  if (Object.values(csvRow).includes(input.profile.snapshotPreservedPlaceholder)) {
    throw new Error("Snapshot-preserved placeholders cannot be serialized.");
  }
  return { ...details, memberKind: "composed", csvRow };
}

function validateReferences(
  profile: ChannelCompositionProfile,
  reference: ChannelReferenceRead | undefined,
): TcgplayerLocalRefusalReason | null {
  if (!reference) return "provider-catalog-item-reference-unlinked";
  if (profile.requiresProviderCatalogItemReference && reference.catalogItemReference.kind !== "linked") {
    return catalogReferenceRefusal(reference.catalogItemReference);
  }
  if (profile.requiresProviderProductReference && reference.productReference.kind !== "linked") {
    return reference.productReference.kind === "ambiguous"
      ? "provider-product-reference-ambiguous"
      : "provider-product-reference-unlinked";
  }
  return null;
}

function catalogReferenceRefusal(reference: ChannelReferenceResolution): TcgplayerLocalRefusalReason {
  return reference.kind === "ambiguous"
    ? "provider-catalog-item-reference-ambiguous"
    : "provider-catalog-item-reference-unlinked";
}

function readTarget(operation: ClaimedOutboundOperation):
  | Readonly<{
      kind: "target";
      quantity: number;
      priceAmountMinor: number;
      currency: string;
      conditionKey: string | null;
    }>
  | Readonly<{ kind: "refused"; reason: "price-unresolvable" }> {
  if (operation.payload.kind === "draft") {
    return {
      kind: "target",
      quantity: operation.payload.draft.quantity,
      priceAmountMinor: operation.payload.draft.price.amountMinor,
      currency: operation.payload.draft.price.currency,
      conditionKey: operation.payload.draft.conditionKey,
    };
  }
  if (!isDelistDirective(operation.payload.delist)) return { kind: "refused", reason: "price-unresolvable" };
  return {
    kind: "target",
    quantity: 0,
    priceAmountMinor: operation.payload.delist.lastPublishedPrice.amountMinor,
    currency: operation.payload.delist.lastPublishedPrice.currency,
    conditionKey: null,
  };
}

function isDelistDirective(value: unknown): value is ChannelListingDelistDirective {
  if (!isRecord(value) || !isRecord(value.lastPublishedPrice)) return false;
  return (
    typeof value.channelListingId === "string" &&
    Number.isSafeInteger(value.listingRevision) &&
    Number.isSafeInteger(value.lastPublishedQuantity) &&
    Number.isSafeInteger(value.lastPublishedPrice.amountMinor) &&
    typeof value.lastPublishedPrice.currency === "string" &&
    Array.isArray(value.delistReasons)
  );
}

function chooseBasisRow(
  candidates: readonly ChannelInventorySnapshotRow[],
  conditionKey: string | null,
  placeholder: string,
): ChannelInventorySnapshotRow | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  if (conditionKey && conditionKey !== placeholder) {
    const matches = candidates.filter((row) => row.conditionText === conditionKey);
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

function refused(
  common: RunMemberCommon,
  refusalReason: TcgplayerLocalRefusalReason,
  externalKey: string | null = null,
): ChannelSyncRunRefusedMember {
  return {
    ...common,
    memberKind: "refused",
    externalKey,
    conditionText: null,
    basisSnapshotId: null,
    basisSnapshotGeneration: null,
    basisTotalQuantity: null,
    basisPriceAmountMinor: null,
    targetQuantity: null,
    targetPriceAmountMinor: null,
    csvRow: null,
    refusalReason,
    mappingDimension: null,
    mappingSourceKey: null,
  };
}

function refusedFromBasis(
  common: RunMemberCommon,
  refusalReason: TcgplayerLocalRefusalReason,
  basis: ChannelInventorySnapshotRow,
): ChannelSyncRunRefusedMember {
  return {
    ...refused(common, refusalReason, basis.externalKey),
    conditionText: basis.conditionText,
    basisSnapshotId: basis.snapshotId,
    basisSnapshotGeneration: basis.snapshotGeneration,
    basisTotalQuantity: basis.totalQuantity,
    basisPriceAmountMinor: basis.priceAmountMinor,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
