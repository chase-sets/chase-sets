import type { PublicChannelConnection } from "../../connections/domain/contracts";
import {
  tcgplayerRowRefusalReasons,
  type ChannelExportSurface,
  type ChannelSyncRun,
  type TcgplayerRowRefusalReason,
} from "../../tcgplayer-csv/domain/contracts";
import { isChannelSyncRunTerminalState } from "../../tcgplayer-csv/domain/lifecycle";

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
  "retry-clamp",
  "record-upload-attempt",
  "record-validation-cancellation",
  "release",
  "ingest-live",
  "ingest-staged",
  "verify",
] as const;
export type ManualSyncActionId = (typeof manualSyncActionIds)[number];

export type ManualSyncVerificationCandidate = Readonly<{
  snapshotId: string;
  snapshotGeneration: number;
  parsedRowCount: number;
  capturedAt: string;
  ingestedAt: string;
}>;

export type ManualSyncPanel = Readonly<{
  connection: PublicChannelConnection;
  inboundCoverage: ChannelInboundCoverage;
  run: ChannelSyncRun | null;
  actions: readonly ManualSyncActionId[];
  leaseCountdownMs: number | null;
  requestedListingCount: number;
  composedListingCount: number;
  attentionReason: "ready" | "unknown" | "recovery" | null;
  verificationCandidate: ManualSyncVerificationCandidate | null;
}>;

export type FounderExportIngestProbe = Readonly<{
  fileName: string;
  byteSize: number;
  logicalRows: number;
  headerSha256: string;
  observedAt: string;
}>;

export type ManualSyncIngestReceipt = Readonly<{
  surface: ChannelExportSurface;
  probe: FounderExportIngestProbe;
  outcome:
    | Readonly<{ kind: "ingested"; snapshotId: string; snapshotGeneration: number; parsedRowCount: number }>
    | Readonly<{ kind: "refused"; reason: TcgplayerRowRefusalReason }>;
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

export function resolveManualSyncActions(
  run: ChannelSyncRun | null,
  attentionReason: ManualSyncPanel["attentionReason"] = null,
): readonly ManualSyncActionId[] {
  if (!run || isChannelSyncRunTerminalState(run.state)) return ["ingest-live", "ingest-staged", "compose"];
  if (run.claimant.claimantKind !== "manual") return [];
  if (attentionReason === "recovery") return run.state === "composed" ? ["retry-clamp"] : [];
  switch (run.state) {
    case "composed":
      return ["download"];
    case "claimed":
      return ["record-upload-attempt", "record-validation-cancellation", "release"];
    case "awaiting-verification":
      return ["ingest-staged", "verify"];
  }
}

export function decodeManualSyncIngestReceipt(value: unknown): ManualSyncIngestReceipt | null {
  if (!isRecord(value)) return null;
  const { surface, probe, outcome } = value;
  if (surface !== "live" && surface !== "staged") return null;
  if (
    !isRecord(probe) ||
    !isRecord(outcome) ||
    typeof probe.fileName !== "string" ||
    !isCount(probe.byteSize) ||
    !isCount(probe.logicalRows) ||
    typeof probe.headerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(probe.headerSha256) ||
    typeof probe.observedAt !== "string"
  ) {
    return null;
  }
  const bounded: Pick<ManualSyncIngestReceipt, "surface" | "probe"> = {
    surface,
    probe: {
      fileName: probe.fileName,
      byteSize: probe.byteSize,
      logicalRows: probe.logicalRows,
      headerSha256: probe.headerSha256,
      observedAt: probe.observedAt,
    },
  };
  if (
    outcome.kind === "ingested" &&
    typeof outcome.snapshotId === "string" &&
    isCount(outcome.snapshotGeneration) &&
    isCount(outcome.parsedRowCount)
  ) {
    return {
      ...bounded,
      outcome: {
        kind: "ingested",
        snapshotId: outcome.snapshotId,
        snapshotGeneration: outcome.snapshotGeneration,
        parsedRowCount: outcome.parsedRowCount,
      },
    };
  }
  const reason = tcgplayerRowRefusalReasons.find((candidate) => candidate === outcome.reason);
  return outcome.kind === "refused" && reason ? { ...bounded, outcome: { kind: "refused", reason } } : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
