import type { DomainEvent } from "@chase-sets/event-core";
import type { ClaimedOperationClaimant } from "../../outbound-sync/domain/contracts";

export const channelExportSurfaces = ["live", "staged"] as const;
export type ChannelExportSurface = (typeof channelExportSurfaces)[number];

export const channelExportCompletenessStates = ["unverified"] as const;
export type ChannelExportCompleteness = (typeof channelExportCompletenessStates)[number];

export const tcgplayerRowRefusalReasons = [
  "invalid-input",
  "header-mismatch",
  "header-missing-required-column",
  "header-duplicate-column",
  "row-width-mismatch",
  "unterminated-quoted-field",
  "empty-export",
  "duplicate-row-identity",
  "invalid-integer",
  "record-limit-exceeded",
] as const;
export type TcgplayerRowRefusalReason = (typeof tcgplayerRowRefusalReasons)[number];

export type TcgplayerExportIngestLimits = Readonly<{ maxRecords: number }>;

export type ChannelExportSchemaDescriptor = Readonly<{
  providerKey: "tcgplayer";
  surface: ChannelExportSurface;
  pinState: "fixed" | "connection-write-once";
  requiredColumns: readonly string[];
  fixedHeader?: readonly string[];
  derivation: Readonly<{
    sourceKind: "operator-capture";
    sourceRef: string;
    sourceVersion: "Seller Portal v313357";
    capturedAt: string;
  }>;
}>;

export type ChannelExportSchemaPin = Readonly<{
  connectionId: string;
  providerKey: "tcgplayer";
  surface: ChannelExportSurface;
  header: readonly string[];
  conditionColumn: "present" | "absent";
  pinnedFromSnapshotId: string;
  pinnedAt: string;
}>;

export type TcgplayerParsedExportRow = Readonly<{
  externalKey: string;
  conditionText: string | null;
  totalQuantity: number;
  pendingQuantityDelta: number;
  priceAmountText: string;
  priceAmountMinor: number | null;
  referenceColumns: Readonly<Record<string, string>>;
  rowNumber: number;
}>;

export type ParsedTcgplayerExport = Readonly<{
  kind: "parsed";
  surface: ChannelExportSurface;
  header: readonly string[];
  conditionColumn: "present" | "absent";
  parsedRowCount: number;
  completeness: "unverified";
  rows: readonly TcgplayerParsedExportRow[];
}>;

export type TcgplayerExportParseResult =
  | ParsedTcgplayerExport
  | Readonly<{ kind: "refused"; reason: TcgplayerRowRefusalReason }>;

export type ChannelInventorySnapshot = Readonly<{
  snapshotId: string;
  snapshotGeneration: number;
  connectionId: string;
  providerKey: "tcgplayer";
  surface: ChannelExportSurface;
  parsedRowCount: number;
  completeness: "unverified";
  ingestedAt: string;
  capturedAt: string;
  capturedAtSource: "operator-declared" | "ingest";
}>;

export type ChannelInventorySnapshotRow = TcgplayerParsedExportRow &
  Readonly<{
    snapshotId: string;
    snapshotGeneration: number;
    connectionId: string;
    providerKey: "tcgplayer";
    surface: ChannelExportSurface;
    currency: "USD";
    ingestedAt: string;
    capturedAt: string;
    capturedAtSource: "operator-declared" | "ingest";
  }>;

export const tcgplayerLocalRefusalReasons = [
  "provider-catalog-item-reference-unlinked",
  "provider-catalog-item-reference-ambiguous",
  "provider-product-reference-unlinked",
  "provider-product-reference-ambiguous",
  "provider-reference-wrong-family",
  "staged-basis-row-absent",
  "staged-pending-delta-unknown",
  "price-unresolvable",
  "price-not-cents-exact",
  "currency-not-usd",
  "condition-identity-ambiguous",
] as const;
export type TcgplayerLocalRefusalReason = (typeof tcgplayerLocalRefusalReasons)[number];

export const channelSyncRunMemberKinds = ["composed", "already-satisfied", "refused"] as const;
export type ChannelSyncRunMemberKind = (typeof channelSyncRunMemberKinds)[number];

export type TcgplayerComposedCsvRow = Readonly<Record<string, string>>;

type ChannelSyncRunMemberCommon = Readonly<{
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  reservationId: string;
  channelListingId: string;
  listingId: string;
  desiredStateSequence: number;
  listingRevision: number;
  payloadDigest: string;
  ordinal: number;
}>;

export type ChannelSyncRunComposedMember = ChannelSyncRunMemberCommon &
  Readonly<{
    memberKind: "composed";
    externalKey: string;
    conditionText: string | null;
    basisSnapshotId: string;
    basisSnapshotGeneration: number;
    basisTotalQuantity: number;
    basisPriceAmountMinor: number;
    targetQuantity: number;
    targetPriceAmountMinor: number;
    csvRow: TcgplayerComposedCsvRow;
    refusalReason: null;
    mappingDimension: null;
    mappingSourceKey: null;
  }>;

export type ChannelSyncRunAlreadySatisfiedMember = ChannelSyncRunMemberCommon &
  Readonly<{
    memberKind: "already-satisfied";
    externalKey: string;
    conditionText: string | null;
    basisSnapshotId: string;
    basisSnapshotGeneration: number;
    basisTotalQuantity: number;
    basisPriceAmountMinor: number;
    targetQuantity: number;
    targetPriceAmountMinor: number;
    csvRow: null;
    refusalReason: null;
    mappingDimension: null;
    mappingSourceKey: null;
    providerAction: "not-attempted-already-satisfied";
  }>;

export type ChannelSyncRunRefusedMember = ChannelSyncRunMemberCommon &
  Readonly<{
    memberKind: "refused";
    externalKey: string | null;
    conditionText: string | null;
    basisSnapshotId: string | null;
    basisSnapshotGeneration: number | null;
    basisTotalQuantity: number | null;
    basisPriceAmountMinor: number | null;
    targetQuantity: number | null;
    targetPriceAmountMinor: number | null;
    csvRow: null;
    refusalReason: TcgplayerLocalRefusalReason;
    mappingDimension: "category" | "condition" | "attribute" | null;
    mappingSourceKey: string | null;
  }>;

export type ChannelSyncRunMember =
  | ChannelSyncRunComposedMember
  | ChannelSyncRunAlreadySatisfiedMember
  | ChannelSyncRunRefusedMember;

export const channelSyncRunStates = [
  "composed",
  "claimed",
  "awaiting-verification",
  "applied",
  "validation-rejected",
  "application-unknown",
  "superseded",
  "stale-basis",
  "abandoned",
] as const;
export type ChannelSyncRunState = (typeof channelSyncRunStates)[number];

export const channelSyncRunTriggers = [
  "compose",
  "claim",
  "release",
  "report-upload-attempted",
  "report-validation-cancelled",
  "verify",
  "supersede",
  "observe-newer-basis",
  "reservation-lease-expired",
] as const;
export type ChannelSyncRunTrigger = (typeof channelSyncRunTriggers)[number];

export const channelSyncRunTerminalStates = channelSyncRunStates.slice(3) as readonly Exclude<
  ChannelSyncRunState,
  "composed" | "claimed" | "awaiting-verification"
>[];

export type ManualClaimLeasePolicySnapshot = Readonly<{
  policyKey: "channels.tcgplayer-manual-claim-lease";
  value: Readonly<{ leaseMs: number }>;
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  resolvedAt: string;
  digest: string;
}>;

export type ChannelSyncRun = Readonly<{
  runId: string;
  revision: number;
  sequence: number;
  connectionId: string;
  providerKey: "tcgplayer";
  reservationId: string;
  claimant: ClaimedOperationClaimant;
  leaseExpiresAt: string;
  manualClaimLeasePolicySnapshot: ManualClaimLeasePolicySnapshot | null;
  state: ChannelSyncRunState;
  basisSnapshotId: string;
  basisSnapshotGeneration: number;
  verificationSnapshotId: string | null;
  verificationSnapshotGeneration: number | null;
  uploadAttemptedAt: string | null;
  uploadFileName: string | null;
  importSummary: TcgplayerImportSummary | null;
  createdAt: string;
  updatedAt: string;
  membershipCompleteness:
    | Readonly<{ kind: "complete"; total: number }>
    | Readonly<{ kind: "bounded-incomplete"; reason: "member-count-or-digest-mismatch" }>;
  members: readonly ChannelSyncRunMember[];
}>;

export type ChannelSyncRunComposedEvent = DomainEvent<
  "channels.tcgplayer-sync-run.composed",
  Readonly<{ run: ChannelSyncRun; csvHeader: readonly string[] }>
>;

export type ChannelSyncRunTransitionedEvent = DomainEvent<
  "channels.tcgplayer-sync-run.transitioned",
  Readonly<{
    runId: string;
    reservationId: string;
    expectedRevision: number;
    fromState: ChannelSyncRunState;
    toState: ChannelSyncRunState;
    verificationSnapshotId: string | null;
    verificationSnapshotGeneration: number | null;
    uploadAttemptedAt: string | null;
    uploadFileName: string | null;
    importSummary: TcgplayerImportSummary | null;
  }>
>;

export type ChannelSyncRunEvent = ChannelSyncRunComposedEvent | ChannelSyncRunTransitionedEvent;

export type TcgplayerImportSummary = Readonly<{
  fileName: string;
  dateImportedText: string;
  numberOfProducts: number;
  recordedAt: string;
}>;

export type StagedImportBatch = Readonly<{
  runId: string;
  reservationId: string;
  header: readonly string[];
  rows: readonly TcgplayerComposedCsvRow[];
  csv: string;
}>;

export type ChannelSyncRunRefusal =
  | "invalid-input"
  | "staged-basis-unavailable"
  | "staged-basis-stale"
  | "run-outstanding"
  | "unknown-run"
  | "no-attempt-outstanding"
  | "stale-fence"
  | "terminal"
  | "illegal-transition";

export class ChannelSyncRunError extends Error {
  public constructor(
    public readonly code: ChannelSyncRunRefusal,
    message: string = code,
  ) {
    super(message);
    this.name = "ChannelSyncRunError";
  }
}
