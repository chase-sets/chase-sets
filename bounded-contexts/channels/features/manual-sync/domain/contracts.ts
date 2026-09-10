import type { PublicChannelConnection } from "../../connections/domain/contracts";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";

export const channelInboundCoverageStates = ["live", "dark"] as const;
export type ChannelInboundCoverageState = (typeof channelInboundCoverageStates)[number];

export const channelInboundDarkReasons = [
  "provider-has-no-inbound",
  "no-inbound-authority",
  "inbound-authority-revoked",
  "inbound-authority-failing",
] as const;
export type ChannelInboundDarkReason = (typeof channelInboundDarkReasons)[number];

export type ChannelInboundCoverage =
  | Readonly<{ state: "live"; reason: null }>
  | Readonly<{ state: "dark"; reason: ChannelInboundDarkReason }>;

export const manualSyncActionIds = [
  "compose",
  "download",
  "record-upload-attempt",
  "record-validation-cancellation",
  "release",
  "ingest-live",
  "ingest-staged",
  "verify",
] as const;
export type ManualSyncActionId = (typeof manualSyncActionIds)[number];

export type ManualSyncPanel = Readonly<{
  connection: PublicChannelConnection;
  inboundCoverage: ChannelInboundCoverage;
  run: ChannelSyncRun | null;
  actions: readonly ManualSyncActionId[];
  leaseCountdownMs: number | null;
  requestedListingCount: number;
  composedListingCount: number;
  attentionReason: "ready" | "unknown" | "recovery" | null;
}>;

export type FounderExportIngestProbe = Readonly<{
  fileName: string;
  byteSize: number;
  logicalRows: number;
  headerSha256: string;
  observedAt: string;
}>;

export const manualSyncIngestContract = Object.freeze({
  contract: "channels.manual-sync-ingest/v1",
  maxBytes: 33_554_432,
  maxRecords: 100_000,
  configuredBounds: Object.freeze({
    bytes: Object.freeze([1_048_576, 134_217_728]),
    rows: Object.freeze([1, 1_000_000]),
  }),
  multipartMaxBytes: 35_651_584,
  founderProbeMaxBytes: 16_777_216,
  founderProbeMultipartMaxBytes: 18_874_368,
} as const);

export class ManualSyncError extends Error {
  public constructor(
    public readonly code:
      | "connection-not-found"
      | "manual-sync-unavailable"
      | "invalid-input"
      | "invalid-action"
      | "inbound-clamp-recovery"
      | "export-too-large"
      | "export-record-limit-exceeded",
    message: string = code,
  ) {
    super(message);
    this.name = "ManualSyncError";
  }
}

export function resolveManualSyncActions(run: ChannelSyncRun | null): readonly ManualSyncActionId[] {
  if (!run) return ["ingest-live", "ingest-staged", "compose"];
  if (run.claimant.claimantKind !== "manual") return [];
  switch (run.state) {
    case "composed":
      return ["download"];
    case "claimed":
      return ["record-upload-attempt", "record-validation-cancellation", "release"];
    case "awaiting-verification":
      return ["ingest-staged", "verify"];
    case "applied":
    case "validation-rejected":
    case "application-unknown":
    case "superseded":
    case "stale-basis":
    case "abandoned":
      return [];
  }
}
