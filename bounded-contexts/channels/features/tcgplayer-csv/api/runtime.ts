import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext, ExpectedStreamVersion, StoredEvent } from "@chase-sets/event-core/storage";
import type { ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import type { OutboundSyncServices } from "../../outbound-sync/domain/contracts";
import type { ChannelCompositionProfileRegistry } from "../../listing-composition/domain/contracts";
import type { ChannelListingCompositionServices } from "../../listing-composition/api/runtime";
import { readChannelListingProviderProductReferences } from "../../listing-composition/read-model/queries";
import { composeTcgplayerReservation, type ComposedTcgplayerReservation } from "../domain/composition";
import { parseTcgplayerFullExport } from "../domain/csv";
import {
  ChannelSyncRunError,
  type ChannelExportSchemaPin,
  type ChannelInventorySnapshot,
  type ChannelSyncRun,
  type ChannelSyncRunEvent,
  type ChannelSyncRunMember,
  type ManualClaimLeasePolicySnapshot,
  type TcgplayerExportIngestLimits,
  type TcgplayerExportParseResult,
  type TcgplayerImportSummary,
} from "../domain/contracts";
import { channelSyncRunEventCodec } from "../domain/codec";
import {
  applicationMatchesSnapshot,
  applicationMatchesImportSummary,
  decideChannelSyncRunTransition,
  deriveClaimedOperationOutcomes,
  isChannelSyncRunTerminalState,
} from "../domain/lifecycle";
import {
  assertBoundedText,
  assertClosedRecord,
  assertManualClaimLeasePolicySnapshot,
  assertSafeInteger,
  assertTcgplayerImportSummary,
  assertTimezoneInstant,
} from "../domain/validation";
import {
  readLatestSnapshotRows,
  readRun,
  readSnapshotRowsById,
  readTcgplayerConditionMappingInputs,
} from "../read-model/queries";
import {
  buildTcgplayerCsvProjectionHandlers,
  projectChannelSyncRunComposed,
  projectChannelSyncRunTransitioned,
} from "../read-model/projection";

export type TcgplayerCsvRuntimeDependencies = Readonly<{
  db: PgTransactionalPool;
  eventStore: EventStore;
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
  claimRun(input: RunFenceInput, context: EventStoreContext): Promise<ChannelSyncRun>;
  releaseRun(input: RunFenceInput, context: EventStoreContext): Promise<ChannelSyncRun>;
  recordUploadAttempt(
    input: RunFenceInput & Readonly<{ uploadAttemptedAt: string; fileName: string }>,
    context: EventStoreContext,
  ): Promise<ChannelSyncRun>;
  recordValidationCancellation(input: RunFenceInput, context: EventStoreContext): Promise<ChannelSyncRun>;
  verifyRun(
    input: RunFenceInput & Readonly<{ verificationSnapshotId: string; importSummary: TcgplayerImportSummary }>,
    context: EventStoreContext,
  ): Promise<ChannelSyncRun>;
  supersedeRun(input: RunFenceInput, context: EventStoreContext): Promise<ChannelSyncRun>;
  observeNewerBasis(input: RunFenceInput, context: EventStoreContext): Promise<ChannelSyncRun>;
  settleReservationLeaseExpiry(input: RunFenceInput): Promise<ChannelSyncRun>;
  readLatestSnapshotRows(
    input: Readonly<{ connectionId: string; surface: "live" | "staged" }>,
  ): ReturnType<typeof readLatestSnapshotRows>;
  readRun(runId: string): ReturnType<typeof readRun>;
  projectors: readonly ProjectionHandlerSet[];
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
  const projectors = [
    createProjectionHandlerSet({
      projectionName: "tcgplayer-csv-projection",
      handlers: buildTcgplayerCsvProjectionHandlers(dependencies.db),
      streamPrefixes: ["channels.tcgplayer-sync-run-"],
    }),
  ];
  const ingestTcgplayerExportSnapshot = async (
    input: IngestTcgplayerExportSnapshotInput,
  ): Promise<TcgplayerExportParseResult & Readonly<{ snapshot?: ChannelInventorySnapshot }>> => {
    assertClosedRecord(
      input,
      ["snapshotId", "connectionId", "surface", "csv", "limits", "ingestedAt", "capturedAt", "capturedAtSource"],
      "ingest snapshot input",
    );
    assertBoundedText(input.snapshotId, "snapshotId");
    assertBoundedText(input.connectionId, "connectionId");
    if (input.surface !== "live" && input.surface !== "staged") throw new Error("Snapshot surface is invalid.");
    if (typeof input.csv !== "string") throw new Error("Snapshot csv is invalid.");
    assertTimezoneInstant(input.ingestedAt, "ingestedAt");
    assertTimezoneInstant(input.capturedAt, "capturedAt");
    if (input.capturedAtSource !== "operator-declared" && input.capturedAtSource !== "ingest") {
      throw new Error("capturedAtSource is invalid.");
    }
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
      const generationRow = generationResult.rows[0];
      if (!generationRow) throw new Error("Snapshot generation query returned no row.");
      const snapshotGeneration = Number(generationRow.next_generation);
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
      const conditionMappings = await readTcgplayerConditionMappingInputs(lockClient, {
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
        conditionMappings,
        profile,
        maxRowsPerBatch: input.resolvedPolicy.maxRowsPerBatch,
      });
      await recordMappingCandidates(dependencies.listingComposition, input.connectionId, composition.members, context);
      const sequence = await readNextRunSequence(lockClient, input.connectionId);
      const initialRun: ChannelSyncRun = {
        runId: input.runId,
        revision: 0,
        sequence,
        connectionId: input.connectionId,
        providerKey: "tcgplayer",
        reservationId: reservation.reservationId,
        claimant: reservation.claimant,
        leaseExpiresAt: reservation.leaseExpiresAt,
        manualClaimLeasePolicySnapshot: input.manualClaimLeasePolicySnapshot,
        state: "composed",
        basisSnapshotId: basis.snapshot.snapshotId,
        basisSnapshotGeneration: basis.snapshot.snapshotGeneration,
        verificationSnapshotId: null,
        verificationSnapshotGeneration: null,
        uploadAttemptedAt: null,
        uploadFileName: null,
        importSummary: null,
        createdAt: input.composedAt,
        updatedAt: input.composedAt,
        membershipCompleteness: { kind: "complete", total: composition.members.length },
        members: composition.members,
      };
      const event: ChannelSyncRunEvent = {
        type: "channels.tcgplayer-sync-run.composed",
        data: { run: initialRun, csvHeader: pin.header },
      };
      const stored = await appendRunEvent(dependencies.eventStore, input.runId, "no_stream", event, context);
      await withTransaction(lockClient, (db) => projectChannelSyncRunComposed(db, event.data, stored.streamVersion));
      const run = await readRun(lockClient, input.runId);
      if (!run) throw new Error("Projected Channel Sync Run was not readable.");
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
    context: EventStoreContext,
    options: Readonly<{
      verificationSnapshotId?: string;
      verificationMatched?: boolean;
      uploadAttemptedAt?: string;
      uploadFileName?: string;
      importSummary?: TcgplayerImportSummary;
    }> = {},
  ): Promise<ChannelSyncRun> => {
    assertRunFence(input);
    const current = await readRun(dependencies.db, input.runId);
    if (!current) throw new ChannelSyncRunError("unknown-run");
    if (current.revision !== input.expectedRevision) throw new ChannelSyncRunError("stale-fence");
    if (
      trigger === "report-upload-attempted" &&
      options.uploadAttemptedAt !== undefined &&
      Date.parse(options.uploadAttemptedAt) > Date.parse(current.leaseExpiresAt)
    ) {
      throw new ChannelSyncRunError("stale-fence", "Upload attempt occurred after the claimed lease expired.");
    }
    const nextState = decideChannelSyncRunTransition(current.state, trigger, options);
    const verificationSnapshotGeneration = options.verificationSnapshotId
      ? await readSnapshotGeneration(dependencies.db, options.verificationSnapshotId)
      : null;
    const event: ChannelSyncRunEvent = {
      type: "channels.tcgplayer-sync-run.transitioned",
      data: {
        runId: current.runId,
        reservationId: current.reservationId,
        expectedRevision: current.revision,
        fromState: current.state,
        toState: nextState,
        verificationSnapshotId: options.verificationSnapshotId ?? null,
        verificationSnapshotGeneration,
        uploadAttemptedAt: options.uploadAttemptedAt ?? null,
        uploadFileName: options.uploadFileName ?? null,
        importSummary: options.importSummary ?? null,
      },
    };
    if (isChannelSyncRunTerminalState(nextState)) {
      const settledRun: ChannelSyncRun = {
        ...current,
        state: nextState,
        verificationSnapshotId: options.verificationSnapshotId ?? current.verificationSnapshotId,
        verificationSnapshotGeneration: verificationSnapshotGeneration ?? current.verificationSnapshotGeneration,
        uploadAttemptedAt: options.uploadAttemptedAt ?? current.uploadAttemptedAt,
        uploadFileName: options.uploadFileName ?? current.uploadFileName,
        importSummary: options.importSummary ?? current.importSummary,
      };
      await reportTerminalRun(dependencies, settledRun, event.data, context);
      const committed = await readRun(dependencies.db, input.runId);
      if (!committed) throw new ChannelSyncRunError("unknown-run");
      return committed;
    }
    const stored = await appendRunEvent(dependencies.eventStore, current.runId, current.revision + 1, event, context);
    await withPgTransaction(dependencies.db, (db) =>
      projectChannelSyncRunTransitioned(db, event.data, stored.streamVersion, stored.recordedAt),
    );
    const run = await readRun(dependencies.db, input.runId);
    if (!run) throw new ChannelSyncRunError("unknown-run");
    return run;
  };

  return {
    ingestTcgplayerExportSnapshot,
    composeTcgplayerSyncRun,
    claimRun: (input, context) => {
      assertClosedRecord(input, ["runId", "expectedRevision"], "claim run input");
      return transition(input, "claim", context);
    },
    releaseRun: (input, context) => {
      assertClosedRecord(input, ["runId", "expectedRevision"], "release run input");
      return transition(input, "release", context);
    },
    recordUploadAttempt: (input, context) => {
      assertClosedRecord(input, ["runId", "expectedRevision", "uploadAttemptedAt", "fileName"], "upload attempt input");
      assertTimezoneInstant(input.uploadAttemptedAt, "uploadAttemptedAt");
      assertBoundedText(input.fileName, "upload fileName", 256);
      return transition(input, "report-upload-attempted", context, {
        uploadAttemptedAt: input.uploadAttemptedAt,
        uploadFileName: input.fileName,
      });
    },
    recordValidationCancellation: (input, context) => {
      assertClosedRecord(input, ["runId", "expectedRevision"], "validation cancellation input");
      return transition(input, "report-validation-cancelled", context);
    },
    verifyRun: async (input, context) => {
      assertRunFence(input);
      assertClosedRecord(
        input,
        ["runId", "expectedRevision", "verificationSnapshotId", "importSummary"],
        "verify run input",
      );
      assertBoundedText(input.verificationSnapshotId, "verificationSnapshotId");
      assertTcgplayerImportSummary(input.importSummary);
      const run = await readRun(dependencies.db, input.runId);
      if (!run) throw new ChannelSyncRunError("unknown-run");
      const verification = await readSnapshotById(dependencies.db, input.verificationSnapshotId);
      if (
        !verification ||
        verification.snapshot.surface !== "staged" ||
        verification.snapshot.connectionId !== run.connectionId
      ) {
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
      return transition(input, "verify", context, {
        verificationSnapshotId: input.verificationSnapshotId,
        verificationMatched: matched,
        importSummary: input.importSummary,
      });
    },
    supersedeRun: (input, context) => {
      assertClosedRecord(input, ["runId", "expectedRevision"], "supersede run input");
      return transition(input, "supersede", context);
    },
    observeNewerBasis: (input, context) => {
      assertClosedRecord(input, ["runId", "expectedRevision"], "newer basis input");
      return transition(input, "observe-newer-basis", context);
    },
    settleReservationLeaseExpiry: async (input) => {
      assertClosedRecord(input, ["runId", "expectedRevision"], "lease expiry input");
      assertRunFence(input);
      const run = await readRun(dependencies.db, input.runId);
      if (!run) throw new ChannelSyncRunError("unknown-run");
      if (run.revision !== input.expectedRevision) throw new ChannelSyncRunError("stale-fence");
      if (isChannelSyncRunTerminalState(run.state)) throw new ChannelSyncRunError("terminal");
      const terminalState: "application-unknown" | "abandoned" =
        run.state === "awaiting-verification" ? "application-unknown" : "abandoned";
      const settled = { ...run, state: terminalState };
      await dependencies.outboundSync.reportClaimedOperationOutcomes({
        reservationId: run.reservationId,
        claimant: run.claimant,
        outcomes: deriveClaimedOperationOutcomes(settled),
        runSettlement: {
          runId: run.runId,
          expectedRunRevision: run.revision,
          fromState: run.state,
          toState: terminalState,
          verificationSnapshotId: null,
          verificationSnapshotGeneration: null,
          uploadAttemptedAt: null,
          uploadFileName: null,
          importSummary: null,
          context: null,
        },
      });
      const result = await readRun(dependencies.db, run.runId);
      if (!result) throw new ChannelSyncRunError("unknown-run");
      return result;
    },
    readLatestSnapshotRows: (input) => readLatestSnapshotRows(dependencies.db, input),
    readRun: (runId) => readRun(dependencies.db, runId),
    projectors,
  };
}

function validateComposeInput(input: ComposeTcgplayerSyncRunInput): void {
  assertClosedRecord(
    input,
    ["runId", "connectionId", "claimant", "leaseMs", "manualClaimLeasePolicySnapshot", "resolvedPolicy", "composedAt"],
    "compose run input",
  );
  assertBoundedText(input.runId, "runId");
  assertBoundedText(input.connectionId, "connectionId");
  assertClosedRecord(input.claimant, ["claimantKind", "claimantId"], "claimant");
  if (input.claimant.claimantKind !== "connector" && input.claimant.claimantKind !== "manual") {
    throw new Error("Claimant kind is invalid.");
  }
  assertBoundedText(input.claimant.claimantId, "claimantId");
  assertClosedRecord(input.resolvedPolicy, ["maxRowsPerBatch"], "resolved batch policy");
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

function assertRunFence(input: RunFenceInput): void {
  assertBoundedText(input.runId, "runId");
  assertSafeInteger(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER, "expectedRevision");
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
       AND verification_snapshot_generation IS NOT NULL
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

async function readNextRunSequence(db: PgQueryable, connectionId: string): Promise<number> {
  const sequenceResult = await db.query<{ next_sequence: string | number }>(
    "SELECT coalesce(max(sequence),0)+1 AS next_sequence FROM channel_sync_runs WHERE connection_id=$1",
    [connectionId],
  );
  const sequenceRow = sequenceResult.rows[0];
  if (!sequenceRow) throw new Error("Run sequence query returned no row.");
  const sequence = Number(sequenceRow.next_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Run sequence is invalid.");
  return sequence;
}

async function appendRunEvent(
  eventStore: EventStore,
  runId: string,
  expectedVersion: ExpectedStreamVersion,
  event: ChannelSyncRunEvent,
  context: EventStoreContext,
): Promise<StoredEvent> {
  const stored = await eventStore.appendToStream({
    streamId: `channels.tcgplayer-sync-run-${runId}`,
    wakeSourceContextName: "channels",
    expectedVersion,
    context,
    events: [channelSyncRunEventCodec.encode(event)],
  });
  const committed = stored[0];
  if (!committed || stored.length !== 1) throw new Error("Channel Sync Run event append returned no receipt.");
  return committed;
}

async function withTransaction(db: PgQueryable, action: (transaction: PgQueryable) => Promise<void>): Promise<void> {
  await db.query("BEGIN");
  try {
    await action(db);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function recordMappingCandidates(
  service: Pick<ChannelListingCompositionServices, "recordChannelMappingCandidates">,
  connectionId: string,
  members: readonly ChannelSyncRunMember[],
  context: EventStoreContext,
): Promise<void> {
  const candidates = [];
  const discovered = new Set<string>();
  for (const member of members) {
    if (member.memberKind !== "refused" || !member.mappingDimension || !member.mappingSourceKey) continue;
    const identity = `${member.mappingDimension}\u0000${member.mappingSourceKey}`;
    if (discovered.has(identity)) continue;
    discovered.add(identity);
    candidates.push({
      dimension: member.mappingDimension,
      sourceKey: member.mappingSourceKey,
      proposedTargetKey: null,
      confidenceTier: "low" as const,
      evidence: { listingId: member.listingId, derivedFrom: "tcgplayer-staged-export" },
    });
  }
  if (candidates.length > 0) {
    await service.recordChannelMappingCandidates(
      { connectionId, provenance: "export-discovered", candidates },
      context,
    );
  }
}

async function reportTerminalRun(
  dependencies: TcgplayerCsvRuntimeDependencies,
  run: ChannelSyncRun,
  transition: Extract<ChannelSyncRunEvent, { type: "channels.tcgplayer-sync-run.transitioned" }>["data"],
  context: EventStoreContext,
): Promise<void> {
  await dependencies.outboundSync.reportClaimedOperationOutcomes({
    reservationId: run.reservationId,
    claimant: run.claimant,
    outcomes: deriveClaimedOperationOutcomes(run),
    runSettlement: {
      runId: transition.runId,
      expectedRunRevision: transition.expectedRevision,
      fromState: transition.fromState as "composed" | "claimed" | "awaiting-verification",
      toState: transition.toState as Exclude<ChannelSyncRun["state"], "composed" | "claimed" | "awaiting-verification">,
      verificationSnapshotId: transition.verificationSnapshotId,
      verificationSnapshotGeneration: transition.verificationSnapshotGeneration,
      uploadAttemptedAt: transition.uploadAttemptedAt,
      uploadFileName: transition.uploadFileName,
      importSummary: transition.importSummary,
      context,
    },
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
