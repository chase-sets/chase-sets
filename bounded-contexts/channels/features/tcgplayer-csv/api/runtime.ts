import { createHash } from "node:crypto";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import type { OutboundSyncServices } from "../../outbound-sync/domain/contracts";
import type { ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import type { ChannelCompositionProfileRegistry } from "../../listing-composition/domain/contracts";
import type { ChannelListingCompositionServices } from "../../listing-composition/api/runtime";
import { readChannelListingProviderProductReferences } from "../../listing-composition/read-model/queries";
import { composeTcgplayerReservation, type ComposedTcgplayerReservation } from "../domain/composition";
import { parseTcgplayerFullExport } from "../domain/csv";
import {
  ChannelSyncRunError,
  channelSyncRunTerminalStates,
  type ChannelExportSchemaPin,
  type ChannelInventorySnapshot,
  type ChannelSyncRun,
  type ChannelSyncRunMember,
  type ManualClaimLeasePolicySnapshot,
  type TcgplayerExportIngestLimits,
  type TcgplayerExportParseResult,
  type TcgplayerImportSummary,
} from "../domain/contracts";
import {
  applicationMatchesSnapshot,
  applicationMatchesImportSummary,
  decideChannelSyncRunTransition,
  deriveClaimedOperationOutcomes,
} from "../domain/lifecycle";
import { assertManualClaimLeasePolicySnapshot, assertTimezoneInstant } from "../domain/validation";
import { readLatestSnapshotRows, readRun, readSnapshotRowsById } from "../read-model/queries";

export type TcgplayerCsvRuntimeDependencies = Readonly<{
  db: PgTransactionalPool;
  outboundSync: Pick<OutboundSyncServices, "reserveClaimedOutboundOperations" | "reportClaimedOperationOutcomes">;
  listingComposition: Pick<ChannelListingCompositionServices, "recordChannelMappingCandidates">;
  providerRegistry: ChannelProviderRegistry;
  compositionProfiles: ChannelCompositionProfileRegistry;
}>;

export interface TcgplayerCsvServices {
  ingestTcgplayerExportSnapshot(
    input: IngestTcgplayerExportSnapshotInput,
  ): Promise<TcgplayerExportParseResult & Readonly<{ snapshot?: ChannelInventorySnapshot }>>;
  composeTcgplayerSyncRun(
    input: ComposeTcgplayerSyncRunInput,
    context: EventStoreContext,
  ): Promise<Readonly<{ run: ChannelSyncRun; composition: ComposedTcgplayerReservation }> | null>;
  claimRun(input: RunFenceInput): Promise<ChannelSyncRun>;
  releaseRun(input: RunFenceInput): Promise<ChannelSyncRun>;
  recordUploadAttempt(
    input: RunFenceInput & Readonly<{ uploadAttemptedAt: string; fileName: string }>,
  ): Promise<ChannelSyncRun>;
  recordValidationCancellation(input: RunFenceInput): Promise<ChannelSyncRun>;
  verifyRun(
    input: RunFenceInput & Readonly<{ verificationSnapshotId: string; importSummary: TcgplayerImportSummary }>,
  ): Promise<ChannelSyncRun>;
  supersedeRun(input: RunFenceInput): Promise<ChannelSyncRun>;
  observeNewerBasis(input: RunFenceInput): Promise<ChannelSyncRun>;
  settleReservationLeaseExpiry(input: RunFenceInput): Promise<ChannelSyncRun>;
  readLatestSnapshotRows(
    input: Readonly<{ connectionId: string; surface: "live" | "staged" }>,
  ): ReturnType<typeof readLatestSnapshotRows>;
  readRun(runId: string): ReturnType<typeof readRun>;
}

export type IngestTcgplayerExportSnapshotInput = Readonly<{
  snapshotId: string;
  connectionId: string;
  surface: "live" | "staged";
  csv: string;
  limits: TcgplayerExportIngestLimits;
  ingestedAt: string;
  capturedAt: string;
  capturedAtSource: "operator-declared" | "ingest";
}>;

export type ComposeTcgplayerSyncRunInput = Readonly<{
  runId: string;
  connectionId: string;
  claimant: Readonly<{ claimantKind: "connector" | "manual"; claimantId: string }>;
  leaseMs: number;
  manualClaimLeasePolicySnapshot: ManualClaimLeasePolicySnapshot | null;
  resolvedPolicy: Readonly<{ maxRowsPerBatch: number }>;
  composedAt: string;
}>;

export type RunFenceInput = Readonly<{ runId: string; expectedRevision: number }>;

export function createTcgplayerCsvRuntime(dependencies: TcgplayerCsvRuntimeDependencies): TcgplayerCsvServices {
  const ingestTcgplayerExportSnapshot = async (
    input: IngestTcgplayerExportSnapshotInput,
  ): Promise<TcgplayerExportParseResult & Readonly<{ snapshot?: ChannelInventorySnapshot }>> => {
    assertTimezoneInstant(input.ingestedAt, "ingestedAt");
    assertTimezoneInstant(input.capturedAt, "capturedAt");
    const existingPin = input.surface === "staged" ? await readSchemaPin(dependencies.db, input.connectionId) : null;
    const parsed = parseTcgplayerFullExport(
      { csv: input.csv, surface: input.surface, pinnedSchema: existingPin },
      input.limits,
    );
    if (parsed.kind === "refused") return parsed;
    const snapshot = await withPgTransaction(dependencies.db, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `tcgplayer-snapshot:${input.connectionId}:${input.surface}`,
      ]);
      const currentPin = input.surface === "staged" ? await readSchemaPin(db, input.connectionId, true) : null;
      if (currentPin && !sameHeader(currentPin.header, parsed.header))
        throw new Error("TCGplayer staged header drifted after parsing.");
      const generationResult = await db.query<{ next_generation: string | number }>(
        "SELECT coalesce(max(snapshot_generation),0)+1 AS next_generation FROM channel_inventory_snapshots WHERE connection_id=$1 AND surface=$2",
        [input.connectionId, input.surface],
      );
      const snapshotGeneration = Number(generationResult.rows[0]!.next_generation);
      if (input.surface === "staged" && !currentPin) {
        await db.query(
          `INSERT INTO channel_export_schema_pins
           (connection_id,provider_key,surface,header,condition_column,pinned_from_snapshot_id,pinned_at)
           VALUES ($1,'tcgplayer','staged',$2::jsonb,$3,$4,$5)`,
          [
            input.connectionId,
            JSON.stringify(parsed.header),
            parsed.conditionColumn,
            input.snapshotId,
            input.ingestedAt,
          ],
        );
      }
      await db.query(
        `INSERT INTO channel_inventory_snapshots
         (snapshot_id,snapshot_generation,connection_id,provider_key,surface,parsed_row_count,completeness,ingested_at,captured_at,captured_at_source)
         VALUES ($1,$2,$3,'tcgplayer',$4,$5,'unverified',$6,$7,$8)`,
        [
          input.snapshotId,
          snapshotGeneration,
          input.connectionId,
          input.surface,
          parsed.parsedRowCount,
          input.ingestedAt,
          input.capturedAt,
          input.capturedAtSource,
        ],
      );
      await db.query(
        `INSERT INTO channel_inventory_snapshot_rows
         (snapshot_id,snapshot_generation,connection_id,provider_key,surface,external_key,condition_text,total_quantity,
          pending_quantity_delta,price_amount_text,price_amount_minor,currency,reference_columns,row_number,ingested_at,captured_at,captured_at_source)
         SELECT $1,$2,$3,'tcgplayer',$4,row.external_key,row.condition_text,row.total_quantity,
                row.pending_quantity_delta,row.price_amount_text,row.price_amount_minor,'USD',row.reference_columns,
                row.row_number,$6,$7,$8
         FROM jsonb_to_recordset($5::jsonb) AS row(
           external_key text,condition_text text,total_quantity integer,pending_quantity_delta integer,
           price_amount_text text,price_amount_minor bigint,reference_columns jsonb,row_number integer
         )`,
        [
          input.snapshotId,
          snapshotGeneration,
          input.connectionId,
          input.surface,
          JSON.stringify(
            parsed.rows.map((row) => ({
              external_key: row.externalKey,
              condition_text: row.conditionText,
              total_quantity: row.totalQuantity,
              pending_quantity_delta: row.pendingQuantityDelta,
              price_amount_text: row.priceAmountText,
              price_amount_minor: row.priceAmountMinor,
              reference_columns: row.referenceColumns,
              row_number: row.rowNumber,
            })),
          ),
          input.ingestedAt,
          input.capturedAt,
          input.capturedAtSource,
        ],
      );
      return {
        snapshotId: input.snapshotId,
        snapshotGeneration,
        connectionId: input.connectionId,
        providerKey: "tcgplayer" as const,
        surface: input.surface,
        parsedRowCount: parsed.parsedRowCount,
        completeness: "unverified" as const,
        ingestedAt: input.ingestedAt,
        capturedAt: input.capturedAt,
        capturedAtSource: input.capturedAtSource,
      };
    });
    return { ...parsed, snapshot };
  };

  const composeTcgplayerSyncRun = async (
    input: ComposeTcgplayerSyncRunInput,
    context: EventStoreContext,
  ): Promise<Readonly<{ run: ChannelSyncRun; composition: ComposedTcgplayerReservation }> | null> => {
    validateComposeInput(input);
    const lockClient = await dependencies.db.connect();
    let lockHeld = false;
    try {
      await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        `tcgplayer-run:${input.connectionId}`,
      ]);
      lockHeld = true;
      const outstanding = await lockClient.query(
        "SELECT 1 FROM channel_sync_runs WHERE connection_id=$1 AND state IN ('composed','claimed','awaiting-verification') LIMIT 1",
        [input.connectionId],
      );
      if (outstanding.rows.length > 0) throw new ChannelSyncRunError("run-outstanding");
      const basis = await readLatestSnapshotRows(lockClient, { connectionId: input.connectionId, surface: "staged" });
      if (!basis) throw new ChannelSyncRunError("staged-basis-unavailable");
      if (basis.membershipCompleteness.kind !== "complete") {
        throw new ChannelSyncRunError("staged-basis-unavailable", "Staged basis membership is incomplete.");
      }
      await assertFreshBasis(lockClient, input.connectionId, basis.snapshot.snapshotGeneration);
      const identity = {
        providerKey: "tcgplayer",
        environment: await readEnvironment(lockClient, input.connectionId),
      } as const;
      const provider = dependencies.providerRegistry.get(identity);
      if (!provider || provider.publication?.execution !== "claimed")
        throw new Error("TCGplayer claimed provider is not registered.");
      const profile = dependencies.compositionProfiles.get(identity);
      if (!profile) throw new Error("TCGplayer composition profile is not registered.");
      const reservation = await dependencies.outboundSync.reserveClaimedOutboundOperations({
        registry: dependencies.providerRegistry,
        connectionId: input.connectionId,
        claimant: input.claimant,
        maxOperations: input.resolvedPolicy.maxRowsPerBatch,
        leaseMs: input.leaseMs,
      });
      if (!reservation) return null;
      const references = await readChannelListingProviderProductReferences(lockClient, {
        connectionId: input.connectionId,
        channelListingIds: reservation.operations.map((operation) => operation.channelListingId),
      });
      const pin = await readSchemaPin(lockClient, input.connectionId);
      if (!pin) throw new ChannelSyncRunError("staged-basis-unavailable", "Staged schema is not pinned.");
      const composition = composeTcgplayerReservation({
        runId: input.runId,
        reservation,
        basisSnapshotId: basis.snapshot.snapshotId,
        basisSnapshotGeneration: basis.snapshot.snapshotGeneration,
        basisRows: basis.rows,
        header: pin.header,
        references,
        profile,
        maxRowsPerBatch: input.resolvedPolicy.maxRowsPerBatch,
      });
      await recordMappingCandidates(dependencies.listingComposition, input.connectionId, composition.members, context);
      await persistRun(lockClient, input, reservation, basis.snapshot, pin.header, composition.members);
      const run = await readRun(lockClient, input.runId);
      if (!run) throw new Error("Persisted Channel Sync Run was not readable.");
      return { run, composition };
    } finally {
      if (lockHeld)
        await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          `tcgplayer-run:${input.connectionId}`,
        ]);
      lockClient.release();
    }
  };

  const transition = async (
    input: RunFenceInput,
    trigger: Parameters<typeof decideChannelSyncRunTransition>[1],
    options: Readonly<{
      verificationSnapshotId?: string;
      verificationMatched?: boolean;
      uploadAttemptedAt?: string;
      uploadFileName?: string;
      importSummary?: TcgplayerImportSummary;
    }> = {},
  ): Promise<ChannelSyncRun> => {
    const current = await readRun(dependencies.db, input.runId);
    if (!current) throw new ChannelSyncRunError("unknown-run");
    if (current.revision !== input.expectedRevision) throw new ChannelSyncRunError("stale-fence");
    const nextState = decideChannelSyncRunTransition(current.state, trigger, options);
    const result = await dependencies.db.query(
      `UPDATE channel_sync_runs SET state=$3,revision=revision+1,updated_at=clock_timestamp(),
       upload_attempted_at=coalesce($4::timestamptz,upload_attempted_at),
       verification_snapshot_id=coalesce($5,verification_snapshot_id),
       verification_snapshot_generation=coalesce($6,verification_snapshot_generation),
       upload_file_name=coalesce($8,upload_file_name),
       import_summary=coalesce($9::jsonb,import_summary)
       WHERE run_id=$1 AND revision=$2 AND state=$7`,
      [
        input.runId,
        input.expectedRevision,
        nextState,
        options.uploadAttemptedAt ?? null,
        options.verificationSnapshotId ?? null,
        options.verificationSnapshotId
          ? await readSnapshotGeneration(dependencies.db, options.verificationSnapshotId)
          : null,
        current.state,
        options.uploadFileName ?? null,
        options.importSummary === undefined ? null : JSON.stringify(options.importSummary),
      ],
    );
    if (result.rowCount !== 1) throw new ChannelSyncRunError("stale-fence");
    const run = await readRun(dependencies.db, input.runId);
    if (!run) throw new ChannelSyncRunError("unknown-run");
    if (channelSyncRunTerminalStates.includes(run.state as never)) await reportTerminalRun(dependencies, run);
    return run;
  };

  return {
    ingestTcgplayerExportSnapshot,
    composeTcgplayerSyncRun,
    claimRun: (input) => transition(input, "claim"),
    releaseRun: (input) => transition(input, "release"),
    recordUploadAttempt: (input) => {
      assertTimezoneInstant(input.uploadAttemptedAt, "uploadAttemptedAt");
      if (input.fileName.length === 0 || input.fileName.length > 256) throw new Error("Upload fileName is invalid.");
      return transition(input, "report-upload-attempted", {
        uploadAttemptedAt: input.uploadAttemptedAt,
        uploadFileName: input.fileName,
      });
    },
    recordValidationCancellation: (input) => transition(input, "report-validation-cancelled"),
    verifyRun: async (input) => {
      const run = await readRun(dependencies.db, input.runId);
      if (!run) throw new ChannelSyncRunError("unknown-run");
      const verification = await readSnapshotById(dependencies.db, input.verificationSnapshotId);
      if (!verification || verification.snapshot.surface !== "staged") {
        throw new ChannelSyncRunError("staged-basis-unavailable");
      }
      if (verification.membershipCompleteness.kind !== "complete") {
        throw new ChannelSyncRunError("staged-basis-unavailable", "Verification snapshot membership is incomplete.");
      }
      const matched =
        applicationMatchesSnapshot(run, {
          snapshotGeneration: verification.snapshot.snapshotGeneration,
          rows: verification.rows,
        }) && applicationMatchesImportSummary(run, input.importSummary);
      return transition(input, "verify", {
        verificationSnapshotId: input.verificationSnapshotId,
        verificationMatched: matched,
        importSummary: input.importSummary,
      });
    },
    supersedeRun: (input) => transition(input, "supersede"),
    observeNewerBasis: (input) => transition(input, "observe-newer-basis"),
    settleReservationLeaseExpiry: async (input) => {
      const run = await readRun(dependencies.db, input.runId);
      if (!run) throw new ChannelSyncRunError("unknown-run");
      if (run.revision !== input.expectedRevision) throw new ChannelSyncRunError("stale-fence");
      if (channelSyncRunTerminalStates.includes(run.state as never)) throw new ChannelSyncRunError("terminal");
      const terminalState = run.state === "awaiting-verification" ? "application-unknown" : "abandoned";
      const settled = { ...run, state: terminalState };
      await dependencies.outboundSync.reportClaimedOperationOutcomes({
        reservationId: run.reservationId,
        claimant: run.claimant,
        outcomes: deriveClaimedOperationOutcomes(settled),
        runSettlement: { runId: run.runId, expectedRunRevision: run.revision },
      });
      const result = await readRun(dependencies.db, run.runId);
      if (!result) throw new ChannelSyncRunError("unknown-run");
      return result;
    },
    readLatestSnapshotRows: (input) => readLatestSnapshotRows(dependencies.db, input),
    readRun: (runId) => readRun(dependencies.db, runId),
  };
}

function validateComposeInput(input: ComposeTcgplayerSyncRunInput): void {
  assertTimezoneInstant(input.composedAt, "composedAt");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0)
    throw new Error("leaseMs must be a positive safe integer.");
  if (
    !Number.isSafeInteger(input.resolvedPolicy.maxRowsPerBatch) ||
    input.resolvedPolicy.maxRowsPerBatch < 1 ||
    input.resolvedPolicy.maxRowsPerBatch > 1_000_000
  )
    throw new Error("Resolved batch policy is invalid.");
  if (input.claimant.claimantKind === "manual") {
    assertManualClaimLeasePolicySnapshot(input.manualClaimLeasePolicySnapshot);
    if (input.leaseMs !== input.manualClaimLeasePolicySnapshot.value.leaseMs)
      throw new Error("Manual leaseMs does not match its policy snapshot.");
  } else if (input.manualClaimLeasePolicySnapshot !== null) {
    throw new Error("Connector runs cannot carry a manual lease policy snapshot.");
  }
}

async function readSchemaPin(
  db: PgQueryable,
  connectionId: string,
  lock = false,
): Promise<ChannelExportSchemaPin | null> {
  const result = await db.query<{
    connection_id: string;
    header: string[];
    condition_column: "present" | "absent";
    pinned_from_snapshot_id: string;
    pinned_at: string | Date;
  }>(
    `SELECT connection_id,header,condition_column,pinned_from_snapshot_id,pinned_at FROM channel_export_schema_pins WHERE connection_id=$1 AND provider_key='tcgplayer' AND surface='staged'${lock ? " FOR UPDATE" : ""}`,
    [connectionId],
  );
  const row = result.rows[0];
  return row
    ? {
        connectionId: row.connection_id,
        providerKey: "tcgplayer",
        surface: "staged",
        header: row.header,
        conditionColumn: row.condition_column,
        pinnedFromSnapshotId: row.pinned_from_snapshot_id,
        pinnedAt: row.pinned_at instanceof Date ? row.pinned_at.toISOString() : row.pinned_at,
      }
    : null;
}

async function assertFreshBasis(db: PgQueryable, connectionId: string, generation: number): Promise<void> {
  const result = await db.query<{ verification_snapshot_generation: string | number | null }>(
    `SELECT verification_snapshot_generation FROM channel_sync_runs
     WHERE connection_id=$1 AND state NOT IN ('composed','claimed','awaiting-verification')
     ORDER BY sequence DESC LIMIT 1`,
    [connectionId],
  );
  const fence = result.rows[0]?.verification_snapshot_generation;
  if (fence !== undefined && fence !== null && generation <= Number(fence))
    throw new ChannelSyncRunError("staged-basis-stale");
}

async function readEnvironment(db: PgQueryable, connectionId: string): Promise<"sandbox" | "production"> {
  const result = await db.query<{ environment: "sandbox" | "production" }>(
    "SELECT environment FROM channel_connections WHERE connection_id=$1 AND status='active'",
    [connectionId],
  );
  if (!result.rows[0]) throw new Error("Active Channel Connection is required.");
  return result.rows[0].environment;
}

async function persistRun(
  db: PgQueryable,
  input: ComposeTcgplayerSyncRunInput,
  reservation: ClaimedOperationReservation,
  basis: ChannelInventorySnapshot,
  header: readonly string[],
  members: readonly ChannelSyncRunMember[],
): Promise<void> {
  const sequenceResult = await db.query<{ next_sequence: string | number }>(
    "SELECT coalesce(max(sequence),0)+1 AS next_sequence FROM channel_sync_runs WHERE connection_id=$1",
    [input.connectionId],
  );
  const digest = createHash("sha256").update(JSON.stringify(members), "utf8").digest("hex");
  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO channel_sync_runs
       (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
        manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,verification_snapshot_id,
        verification_snapshot_generation,upload_attempted_at,upload_file_name,import_summary,csv_header,member_count,
        member_digest,created_at,updated_at)
       VALUES ($1,0,$2,$3,'tcgplayer',$4,$5,$6,$7,$8::jsonb,'composed',$9,$10,NULL,NULL,NULL,NULL,NULL,$11::jsonb,$12,$13,$14,$14)`,
      [
        input.runId,
        sequenceResult.rows[0]!.next_sequence,
        input.connectionId,
        reservation.reservationId,
        input.claimant.claimantKind,
        input.claimant.claimantId,
        reservation.leaseExpiresAt,
        input.manualClaimLeasePolicySnapshot === null ? null : JSON.stringify(input.manualClaimLeasePolicySnapshot),
        basis.snapshotId,
        basis.snapshotGeneration,
        JSON.stringify(header),
        members.length,
        digest,
        input.composedAt,
      ],
    );
    await insertMembers(db, input.runId, members);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function insertMembers(db: PgQueryable, runId: string, members: readonly ChannelSyncRunMember[]): Promise<void> {
  await db.query(
    `INSERT INTO channel_sync_run_rows
     (run_id,operation_id,ordinal,reservation_id,attempt_id,claim_generation,channel_listing_id,listing_id,
      desired_state_sequence,listing_revision,payload_digest,member_kind,external_key,condition_text,basis_snapshot_id,
      basis_snapshot_generation,basis_total_quantity,basis_price_amount_minor,target_quantity,target_price_amount_minor,
      csv_row_json,refusal_reason,mapping_dimension,mapping_source_key,provider_action)
     SELECT $1,row.operation_id,row.ordinal,row.reservation_id,row.attempt_id,row.claim_generation,row.channel_listing_id,
            row.listing_id,row.desired_state_sequence,row.listing_revision,row.payload_digest,row.member_kind,row.external_key,
            row.condition_text,row.basis_snapshot_id,row.basis_snapshot_generation,row.basis_total_quantity,
            row.basis_price_amount_minor,row.target_quantity,row.target_price_amount_minor,row.csv_row_json,
            row.refusal_reason,row.mapping_dimension,row.mapping_source_key,row.provider_action
     FROM jsonb_to_recordset($2::jsonb) AS row(
       operation_id text,ordinal integer,reservation_id text,attempt_id text,claim_generation bigint,
       channel_listing_id text,listing_id text,desired_state_sequence bigint,listing_revision bigint,payload_digest text,
       member_kind text,external_key text,condition_text text,basis_snapshot_id text,basis_snapshot_generation bigint,
       basis_total_quantity integer,basis_price_amount_minor bigint,target_quantity integer,target_price_amount_minor bigint,
       csv_row_json jsonb,refusal_reason text,mapping_dimension text,mapping_source_key text,provider_action text
     )`,
    [
      runId,
      JSON.stringify(
        members.map((member) => ({
          operation_id: member.operationId,
          ordinal: member.ordinal,
          reservation_id: member.reservationId,
          attempt_id: member.attemptId,
          claim_generation: member.claimGeneration,
          channel_listing_id: member.channelListingId,
          listing_id: member.listingId,
          desired_state_sequence: member.desiredStateSequence,
          listing_revision: member.listingRevision,
          payload_digest: member.payloadDigest,
          member_kind: member.memberKind,
          external_key: member.externalKey,
          condition_text: member.conditionText,
          basis_snapshot_id: member.basisSnapshotId,
          basis_snapshot_generation: member.basisSnapshotGeneration,
          basis_total_quantity: member.basisTotalQuantity,
          basis_price_amount_minor: member.basisPriceAmountMinor,
          target_quantity: member.targetQuantity,
          target_price_amount_minor: member.targetPriceAmountMinor,
          csv_row_json: member.csvRow,
          refusal_reason: member.refusalReason,
          mapping_dimension: member.mappingDimension,
          mapping_source_key: member.mappingSourceKey,
          provider_action: member.memberKind === "already-satisfied" ? member.providerAction : null,
        })),
      ),
    ],
  );
}

async function recordMappingCandidates(
  service: Pick<ChannelListingCompositionServices, "recordChannelMappingCandidates">,
  connectionId: string,
  members: readonly ChannelSyncRunMember[],
  context: EventStoreContext,
): Promise<void> {
  const candidates = members.flatMap((member) =>
    member.memberKind === "refused" && member.mappingDimension && member.mappingSourceKey
      ? [
          {
            dimension: member.mappingDimension,
            sourceKey: member.mappingSourceKey,
            proposedTargetKey: null,
            confidenceTier: "low" as const,
            evidence: { listingId: member.listingId, derivedFrom: "tcgplayer-staged-export" },
          },
        ]
      : [],
  );
  if (candidates.length > 0) {
    await service.recordChannelMappingCandidates(
      { connectionId, provenance: "export-discovered", candidates },
      context,
    );
  }
}

async function reportTerminalRun(dependencies: TcgplayerCsvRuntimeDependencies, run: ChannelSyncRun): Promise<void> {
  await dependencies.outboundSync.reportClaimedOperationOutcomes({
    reservationId: run.reservationId,
    claimant: run.claimant,
    outcomes: deriveClaimedOperationOutcomes(run),
  });
}

async function readSnapshotGeneration(db: PgQueryable, snapshotId: string): Promise<number> {
  const result = await db.query<{ snapshot_generation: string | number }>(
    "SELECT snapshot_generation FROM channel_inventory_snapshots WHERE snapshot_id=$1",
    [snapshotId],
  );
  if (!result.rows[0]) throw new ChannelSyncRunError("staged-basis-unavailable");
  return Number(result.rows[0].snapshot_generation);
}

async function readSnapshotById(
  db: PgQueryable,
  snapshotId: string,
): Promise<Awaited<ReturnType<typeof readLatestSnapshotRows>>> {
  return readSnapshotRowsById(db, snapshotId);
}

function sameHeader(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
