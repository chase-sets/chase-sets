import { createHash } from "node:crypto";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MarketplaceChannelInboundClampCapability } from "../../../support/request-support/marketplace-channel-inbound-clamp";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ChannelConnectionServices, PublicChannelConnection } from "../../connections/domain/contracts";
import type { TcgplayerCsvServices } from "../../tcgplayer-csv/api/runtime";
import { planStagedImportBatches } from "../../tcgplayer-csv/domain/composition";
import type {
  ChannelSyncRun,
  StagedImportBatch,
  TcgplayerExportParseResult,
  TcgplayerImportSummary,
} from "../../tcgplayer-csv/domain/contracts";
import { tcgplayerStagedImportPolicy } from "../../tcgplayer-csv/domain/policy";
import {
  ManualSyncError,
  manualSyncIngestContract,
  resolveManualSyncActions,
  type FounderExportIngestProbe,
  type ManualSyncPanel,
} from "../domain/contracts";
import { founderExportIngestProbe, inspectTcgplayerExportBytes } from "../domain/ingest";
import { freezeManualClaimLeasePolicySnapshot, tcgplayerManualClaimLeasePolicy } from "../domain/policy";

export type ManualSyncRuntimeDependencies = Readonly<{
  db: PgTransactionalPool;
  connections: ChannelConnectionServices;
  tcgplayerCsv: TcgplayerCsvServices;
  policies: Pick<PolicyRuntime, "resolvePolicy">;
  marketplaceClamp: MarketplaceChannelInboundClampCapability;
  now?: () => string;
}>;

export type ManualSyncIngestInput = Readonly<{
  accountId: string;
  connectionId: string;
  surface: "live" | "staged";
  fileName: string;
  bytes: Uint8Array;
  capturedAt: string;
  capturedAtSource: "operator-declared" | "ingest";
}>;

export interface ManualSyncServices {
  readPanel(input: Readonly<{ accountId: string; connectionId: string }>): Promise<ManualSyncPanel | null>;
  compose(
    input: Readonly<{ accountId: string; connectionId: string }>,
    context: EventStoreContext,
  ): Promise<ManualSyncPanel>;
  claimAndDownload(
    input: Readonly<{ accountId: string; connectionId: string; runId: string; expectedRevision: number }>,
    context: EventStoreContext,
  ): Promise<Readonly<{ run: ChannelSyncRun; batch: StagedImportBatch; fileName: string }>>;
  retryClamp(
    input: Readonly<{ accountId: string; connectionId: string; runId: string; expectedRevision: number }>,
    context: EventStoreContext,
  ): Promise<ManualSyncPanel>;
  release(
    input: Readonly<{ accountId: string; connectionId: string; runId: string; expectedRevision: number }>,
    context: EventStoreContext,
  ): Promise<ChannelSyncRun>;
  recordUploadAttempt(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      runId: string;
      expectedRevision: number;
      uploadAttemptedAt: string;
      fileName: string;
    }>,
    context: EventStoreContext,
  ): Promise<ChannelSyncRun>;
  recordValidationCancellation(
    input: Readonly<{ accountId: string; connectionId: string; runId: string; expectedRevision: number }>,
    context: EventStoreContext,
  ): Promise<ChannelSyncRun>;
  ingest(
    input: ManualSyncIngestInput,
  ): Promise<Readonly<{ result: TcgplayerExportParseResult; probe: FounderExportIngestProbe }>>;
  verify(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      runId: string;
      expectedRevision: number;
      verificationSnapshotId: string;
      importSummary: TcgplayerImportSummary;
    }>,
    context: EventStoreContext,
  ): Promise<ChannelSyncRun>;
}

export function createManualSyncRuntime(dependencies: ManualSyncRuntimeDependencies): ManualSyncServices {
  const now = dependencies.now ?? (() => new Date().toISOString());

  async function authorize(input: Readonly<{ accountId: string; connectionId: string }>) {
    const connection = await dependencies.connections.getConnection(input);
    if (!connection) throw new ManualSyncError("connection-not-found");
    if (connection.providerKey !== "tcgplayer" || connection.status !== "active") {
      throw new ManualSyncError("manual-sync-unavailable");
    }
    return connection;
  }

  async function authorizeRun(input: Readonly<{ accountId: string; connectionId: string; runId: string }>) {
    const connection = await authorize(input);
    const run = await dependencies.tcgplayerCsv.readRun(input.runId);
    if (!run || run.connectionId !== input.connectionId) throw new ManualSyncError("invalid-action");
    return { connection, run };
  }

  async function readPanel(input: Readonly<{ accountId: string; connectionId: string }>) {
    const connection = await dependencies.connections.getConnection(input);
    if (!connection) return null;
    const run = await readLatestRun(dependencies.db, dependencies.tcgplayerCsv, input.connectionId);
    return buildPanel(dependencies.db, connection, run, now());
  }

  return {
    readPanel,
    compose: async (input, context) => {
      const connection = await authorize(input);
      const resolvedAt = now();
      const [leaseResolution, batchResolution] = await Promise.all([
        dependencies.policies.resolvePolicy(tcgplayerManualClaimLeasePolicy, { at: resolvedAt }),
        dependencies.policies.resolvePolicy(tcgplayerStagedImportPolicy, { at: resolvedAt }),
      ]);
      const leaseSnapshot = freezeManualClaimLeasePolicySnapshot(leaseResolution);
      const composed = await dependencies.tcgplayerCsv.composeTcgplayerSyncRun(
        {
          runId: createId("csr"),
          connectionId: input.connectionId,
          claimant: { claimantKind: "manual", claimantId: context.audit.performedByUserId },
          leaseMs: leaseSnapshot.value.leaseMs,
          manualClaimLeasePolicySnapshot: leaseSnapshot,
          resolvedPolicy: batchResolution.value,
          composedAt: resolvedAt,
        },
        context,
      );
      if (!composed) throw new ManualSyncError("invalid-action", "No claimed publication work is available.");
      return buildPanel(dependencies.db, connection, composed.run, now());
    },
    claimAndDownload: async (input, context) => {
      const { run } = await authorizeRun(input);
      assertManualRunAction(run, input.expectedRevision, "composed");
      await engageRunClamp(dependencies, input, run, context);
      const header = await readRunHeader(dependencies.db, run.runId);
      const batch = planStagedImportBatches({
        runId: run.runId,
        reservationId: run.reservationId,
        header,
        members: run.members,
      })[0];
      if (!batch) throw new ManualSyncError("invalid-action", "The run has no composed Staged rows.");
      const claimed = await dependencies.tcgplayerCsv.claimRun(
        { runId: run.runId, expectedRevision: input.expectedRevision },
        context,
      );
      return { run: claimed, batch, fileName: `tcgplayer-staged-${run.runId}.csv` };
    },
    retryClamp: async (input, context) => {
      const { connection, run } = await authorizeRun(input);
      assertManualRunAction(run, input.expectedRevision, "composed");
      await engageRunClamp(dependencies, input, run, context);
      return buildPanel(dependencies.db, connection, run, now());
    },
    release: async (input, context) => {
      const { run } = await authorizeRun(input);
      assertManualRunAction(run, input.expectedRevision, "claimed");
      if (run.uploadAttemptedAt !== null) throw new ManualSyncError("invalid-action");
      const clamp = requireClamp(dependencies.marketplaceClamp);
      const released = await dependencies.tcgplayerCsv.releaseRun(
        { runId: input.runId, expectedRevision: input.expectedRevision },
        context,
      );
      const recovery = await clamp.recover(clampInput(input, run), context);
      await recordClampRecoveryStatus(dependencies.db, input, released.revision, run.members.length, recovery);
      if (recovery.kind === "recovery") throw new ManualSyncError("inbound-clamp-recovery");
      return released;
    },
    recordUploadAttempt: async (input, context) => {
      const { run } = await authorizeRun(input);
      assertManualRunAction(run, input.expectedRevision, "claimed");
      return dependencies.tcgplayerCsv.recordUploadAttempt(
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          uploadAttemptedAt: input.uploadAttemptedAt,
          fileName: input.fileName,
        },
        context,
      );
    },
    recordValidationCancellation: async (input, context) => {
      const { run } = await authorizeRun(input);
      assertManualRunAction(run, input.expectedRevision, "claimed");
      if (run.uploadAttemptedAt !== null) throw new ManualSyncError("invalid-action");
      const clamp = requireClamp(dependencies.marketplaceClamp);
      const cancelled = await dependencies.tcgplayerCsv.recordValidationCancellation(
        { runId: input.runId, expectedRevision: input.expectedRevision },
        context,
      );
      const recovery = await clamp.recover(clampInput(input, run), context);
      await recordClampRecoveryStatus(dependencies.db, input, cancelled.revision, run.members.length, recovery);
      if (recovery.kind === "recovery") throw new ManualSyncError("inbound-clamp-recovery");
      return cancelled;
    },
    ingest: async (input) => {
      await authorize(input);
      const inspected = inspectTcgplayerExportBytes(input.bytes);
      const observedAt = now();
      const probe =
        input.surface === "live"
          ? founderExportIngestProbe(inspected, { fileName: input.fileName, observedAt })
          : {
              fileName: input.fileName,
              byteSize: inspected.byteSize,
              logicalRows: inspected.logicalRows,
              headerSha256: createHash("sha256").update(inspected.headerText, "utf8").digest("hex"),
              observedAt,
            };
      const ingested = await dependencies.tcgplayerCsv.ingestTcgplayerExportSnapshot({
        snapshotId: createId("cis"),
        connectionId: input.connectionId,
        surface: input.surface,
        csv: inspected.csv,
        limits: { maxRecords: manualSyncIngestContract.maxRecords },
        ingestedAt: observedAt,
        capturedAt: input.capturedAt,
        capturedAtSource: input.capturedAtSource,
      });
      return { result: ingested, probe };
    },
    verify: async (input, context) => {
      const { run } = await authorizeRun(input);
      assertManualRunAction(run, input.expectedRevision, "awaiting-verification");
      return dependencies.tcgplayerCsv.verifyRun(
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          verificationSnapshotId: input.verificationSnapshotId,
          importSummary: input.importSummary,
        },
        context,
      );
    },
  };
}

function requireClamp(capability: MarketplaceChannelInboundClampCapability) {
  if (capability.kind !== "available") throw new ManualSyncError("inbound-clamp-recovery");
  return capability.port;
}

function clampInput(input: Readonly<{ accountId: string; connectionId: string; runId: string }>, run: ChannelSyncRun) {
  return {
    accountId: input.accountId,
    connectionId: input.connectionId,
    runId: input.runId,
    listingIds: run.members.map((member) => member.listingId),
  };
}

async function readLatestRun(
  db: PgQueryable,
  tcgplayerCsv: TcgplayerCsvServices,
  connectionId: string,
): Promise<ChannelSyncRun | null> {
  const result = await db.query<{ run_id: string }>(
    "SELECT run_id FROM channel_sync_runs WHERE connection_id=$1 ORDER BY sequence DESC LIMIT 1",
    [connectionId],
  );
  return result.rows[0] ? tcgplayerCsv.readRun(result.rows[0].run_id) : null;
}

async function buildPanel(
  db: PgQueryable,
  connection: PublicChannelConnection,
  run: ChannelSyncRun | null,
  currentAt: string,
): Promise<ManualSyncPanel> {
  const attentionReason = run ? await readAttentionReason(db, run) : null;
  const available = connection.providerKey === "tcgplayer" && connection.status === "active";
  return {
    connection,
    inboundCoverage: { state: "dark", reason: "no-inbound-authority" },
    run,
    actions: available ? resolveManualSyncActions(run, attentionReason) : [],
    leaseCountdownMs: run ? Math.max(0, Date.parse(run.leaseExpiresAt) - Date.parse(currentAt)) : null,
    requestedListingCount: run?.members.length ?? 0,
    composedListingCount: run?.members.filter((member) => member.memberKind === "composed").length ?? 0,
    attentionReason,
  };
}

async function engageRunClamp(
  dependencies: ManualSyncRuntimeDependencies,
  input: Readonly<{ accountId: string; connectionId: string; runId: string }>,
  run: ChannelSyncRun,
  context: EventStoreContext,
) {
  if (run.membershipCompleteness.kind !== "complete") throw new ManualSyncError("invalid-action");
  const listingIds = run.members.map((member) => member.listingId);
  if (listingIds.length < 1 || new Set(listingIds).size !== listingIds.length) {
    throw new ManualSyncError("invalid-action", "Channel Sync Run listing membership is not exact and unique.");
  }
  const clamp = requireClamp(dependencies.marketplaceClamp);
  const result = await clamp.engage(
    { accountId: input.accountId, connectionId: input.connectionId, runId: input.runId, listingIds },
    context,
  );
  await recordClampStatus(dependencies.db, input, run.revision, result);
  if (result.kind !== "engaged") throw new ManualSyncError("inbound-clamp-recovery");
}

async function readAttentionReason(db: PgQueryable, run: ChannelSyncRun) {
  const result = await db.query<{ state: string }>(
    "SELECT state FROM channels_manual_sync_clamp_status WHERE run_id=$1",
    [run.runId],
  );
  if (result.rows[0]?.state === "recovery") return "recovery" as const;
  if (run.state === "application-unknown") return "unknown" as const;
  if (run.state === "composed") return "ready" as const;
  return null;
}

async function readRunHeader(db: PgQueryable, runId: string): Promise<readonly string[]> {
  const result = await db.query<{ csv_header: unknown }>("SELECT csv_header FROM channel_sync_runs WHERE run_id=$1", [
    runId,
  ]);
  const header = result.rows[0]?.csv_header;
  if (!Array.isArray(header) || header.length === 0 || !header.every((column) => typeof column === "string")) {
    throw new ManualSyncError("invalid-action", "Channel Sync Run CSV header is unavailable.");
  }
  return header;
}

async function recordClampStatus(
  db: PgQueryable,
  input: Readonly<{ accountId: string; connectionId: string; runId: string }>,
  runRevision: number,
  clamp: Readonly<{ kind: "engaged" | "recovery"; requestedListingCount: number; affectedListingCount: number }>,
) {
  await db.query(
    `INSERT INTO channels_manual_sync_clamp_status
     (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (run_id) DO UPDATE SET
       state=EXCLUDED.state,
       requested_listing_count=EXCLUDED.requested_listing_count,
       affected_listing_count=EXCLUDED.affected_listing_count,
       updated_at=EXCLUDED.updated_at,
       run_revision=EXCLUDED.run_revision
     WHERE channels_manual_sync_clamp_status.connection_id=EXCLUDED.connection_id
       AND channels_manual_sync_clamp_status.account_id=EXCLUDED.account_id
       AND channels_manual_sync_clamp_status.run_revision <= EXCLUDED.run_revision`,
    [
      input.runId,
      input.connectionId,
      input.accountId,
      runRevision,
      clamp.kind,
      clamp.requestedListingCount,
      clamp.affectedListingCount,
    ],
  );
}

async function recordClampRecoveryStatus(
  db: PgQueryable,
  input: Readonly<{ accountId: string; connectionId: string; runId: string }>,
  runRevision: number,
  requestedListingCount: number,
  recovery: Readonly<{
    kind: "released" | "recovery";
    examinedListingCount: number;
    releasedListingCount: number;
    retainedListingCount: number;
    recoveryListingCount: number;
  }>,
) {
  await db.query(
    `UPDATE channels_manual_sync_clamp_status
        SET state=$4,run_revision=$5,requested_listing_count=$6,
            affected_listing_count=$7,updated_at=now()
      WHERE run_id=$1 AND connection_id=$2 AND account_id=$3 AND run_revision <= $5`,
    [
      input.runId,
      input.connectionId,
      input.accountId,
      recovery.kind,
      runRevision,
      requestedListingCount,
      recovery.examinedListingCount,
    ],
  );
}

function assertManualRunAction(run: ChannelSyncRun, expectedRevision: number, state: ChannelSyncRun["state"]) {
  if (
    run.claimant.claimantKind !== "manual" ||
    run.revision !== expectedRevision ||
    run.state !== state ||
    run.membershipCompleteness.kind !== "complete"
  ) {
    throw new ManualSyncError("invalid-action");
  }
}
