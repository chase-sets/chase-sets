import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { testContext } from "../../connections/tests/test-support";
import { createChannelListingCompositionRuntime } from "../../listing-composition/api/runtime";
import { createChannelCompositionProfileRegistry } from "../../listing-composition/domain/canonical";
import { createOutboundSyncRuntime } from "../../outbound-sync/api/runtime";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { createTcgplayerCsvRuntime } from "../api/runtime";
import { channelSyncRunEventCodec } from "../domain/codec";
import type { ChannelSyncRun } from "../domain/contracts";
import { deriveClaimedOperationOutcomes } from "../domain/lifecycle";
import { tcgplayerCompositionProfiles } from "../domain/profile";
import { createTcgplayerClaimedReservationRunSettlementPort } from "../integrations/outbound-sync-settlement";
import { canonicalManualClaimLeasePolicySnapshotDigest } from "../domain/validation";
import { projectChannelSyncRunComposed, projectChannelSyncRunTransitioned } from "../read-model/projection";
import { readRun } from "../read-model/queries";
import { tcgplayerCsvSchemaSql } from "../read-model/schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("tcgplayer-run-order-and-lease", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "tcgplayer_run_order");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("boots twice and admits only one non-terminal run per connection", async () => {
    await pools.channels.query(tcgplayerCsvSchemaSql);
    await seedSnapshot();
    await insertRun("run-1", "reservation-1", "manual");
    await expect(insertRun("run-2", "reservation-2", "connector")).rejects.toMatchObject({ code: "23505" });
    await pools.channels.query(
      "UPDATE channel_sync_runs SET state='abandoned',revision=revision+1 WHERE run_id='run-1'",
    );
    await expect(insertRun("run-2", "reservation-2", "connector")).resolves.toBeUndefined();
  });

  it("retains immutable listing identity and fences stale run writes", async () => {
    await seedSnapshot();
    await insertRun("run-1", "reservation-1", "manual");
    await insertMember("run-1", "reservation-1", "listing-immutable", 91);
    const first = await pools.channels.query<{ listing_id: string; desired_state_sequence: string }>(
      "SELECT listing_id,desired_state_sequence::text FROM channel_sync_run_rows WHERE run_id='run-1'",
    );
    expect(first.rows[0]).toEqual({ listing_id: "listing-immutable", desired_state_sequence: "91" });

    const winner = await pools.channels.query(
      "UPDATE channel_sync_runs SET state='claimed',revision=revision+1 WHERE run_id='run-1' AND revision=0 AND state='composed'",
    );
    const stale = await pools.channels.query(
      "UPDATE channel_sync_runs SET state='abandoned',revision=revision+1 WHERE run_id='run-1' AND revision=0 AND state='composed'",
    );
    expect(winner.rowCount).toBe(1);
    expect(stale.rowCount).toBe(0);
  });

  it("rejects manual runs without the captured lease policy snapshot and connector runs with one", async () => {
    await seedSnapshot();
    await expect(insertRun("run-manual", "reservation-manual", "manual", null)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insertRun("run-connector", "reservation-connector", "connector", { synthetic: true }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("replays run composition and transitions twice without duplicate writes", async () => {
    await seedSnapshot();
    const run = replayRun();
    const composed = { run, csvHeader: ["TCGplayer Id", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"] };
    const encoded = channelSyncRunEventCodec.encode({
      type: "channels.tcgplayer-sync-run.composed",
      data: composed,
    });
    const decoded = channelSyncRunEventCodec.decode({ eventType: encoded.eventType, payload: encoded.payload });
    if (decoded.type !== "channels.tcgplayer-sync-run.composed") throw new Error("Unexpected decoded event.");
    await projectChannelSyncRunComposed(pools.channels, decoded.data, 1);
    await projectChannelSyncRunComposed(pools.channels, decoded.data, 1);
    const transition = {
      runId: run.runId,
      reservationId: run.reservationId,
      expectedRevision: 0,
      fromState: "composed" as const,
      toState: "claimed" as const,
      verificationSnapshotId: null,
      verificationSnapshotGeneration: null,
      uploadAttemptedAt: null,
      uploadFileName: null,
      importSummary: null,
    };
    await projectChannelSyncRunTransitioned(pools.channels, transition, 2, "2026-09-09T00:01:00Z");
    await projectChannelSyncRunTransitioned(pools.channels, transition, 2, "2026-09-09T00:01:00Z");
    const replayed = await readRun(pools.channels, run.runId);
    expect(replayed).toMatchObject({
      state: "claimed",
      revision: 1,
      membershipCompleteness: { kind: "complete", total: 1 },
    });
    expect(replayed?.members).toEqual(run.members);
    const counts = await pools.channels.query<{ runs: string; members: string }>(
      "SELECT (SELECT count(*) FROM channel_sync_runs)::text AS runs,(SELECT count(*) FROM channel_sync_run_rows)::text AS members",
    );
    expect(counts.rows[0]).toEqual({ runs: "1", members: "1" });
  });

  it("discovers one canonical graded condition mapping through the production reservation boundary", async () => {
    const services = createOwnedRuntime();
    await seedProductionCompositionFacts([
      {
        listingId: "listing-graded",
        channelListingId: "channel-listing-graded",
        catalogItemId: "catalog-graded",
        externalKey: "product:90000011",
        gradedCard: gradedCard("PSA", "10"),
      },
    ]);
    await expect(
      services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
        snapshotId: "snapshot-graded-basis",
        connectionId: "connection-production",
        surface: "staged",
        csv: stagedCsv([
          ["90000011", "Near Mint", "2", "0", "0.2600"],
          ["90000011", "Lightly Played", "2", "0", "0.2600"],
        ]),
        limits: { maxRecords: 2 },
        ingestedAt: "2026-09-09T00:00:00Z",
        capturedAt: "2026-09-09T00:00:00Z",
        capturedAtSource: "operator-declared",
      }),
    ).resolves.toMatchObject({ kind: "parsed", parsedRowCount: 2 });
    await services.outboundSync.enqueueDesiredState(desiredState("listing-graded", "channel-listing-graded", 1, 1, 26));

    const result = await services.tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run-graded-discovery",
        connectionId: "connection-production",
        claimant: { claimantKind: "connector", claimantId: "connector-discovery" },
        leaseMs: 60_000,
        manualClaimLeasePolicySnapshot: null,
        resolvedPolicy: { maxRowsPerBatch: 500 },
        composedAt: "2026-09-09T00:01:00Z",
      },
      testContext,
    );

    expect(result?.composition.batch).toBeNull();
    expect(result?.composition.members).toEqual([
      expect.objectContaining({
        memberKind: "refused",
        refusalReason: "condition-identity-ambiguous",
        mappingDimension: "condition",
        mappingSourceKey: "graded-condition:PSA|10",
      }),
    ]);
    const recorded = await pools.channels.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM event_store_events
       WHERE event_type='channels.channel-publication-configuration.mapping-candidate-recorded'`,
    );
    expect(recorded.rows).toEqual([
      {
        payload: expect.objectContaining({
          connectionId: "connection-production",
          provenance: "export-discovered",
          candidates: [
            {
              dimension: "condition",
              sourceKey: "graded-condition:PSA|10",
              proposedTargetKey: null,
              confidenceTier: "low",
              evidence: { listingId: "listing-graded", derivedFrom: "tcgplayer-staged-export" },
            },
          ],
        }),
      },
    ]);
  });

  it("proves two-row application and cap mismatch behavior through the real database runtime", async () => {
    const services = createOwnedRuntime();
    await seedProductionCompositionFacts([
      {
        listingId: "listing-one",
        channelListingId: "channel-listing-one",
        catalogItemId: "catalog-one",
        externalKey: "product:90000101",
        gradedCard: null,
      },
      {
        listingId: "listing-two",
        channelListingId: "channel-listing-two",
        catalogItemId: "catalog-two",
        externalKey: "product:90000102",
        gradedCard: null,
      },
    ]);
    await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-application-basis",
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv([
        ["90000101", "Near Mint", "2", "0", "0.2500"],
        ["90000102", "Lightly Played", "4", "0", "0.2900"],
      ]),
      limits: { maxRecords: 2 },
      ingestedAt: "2026-09-09T01:00:00Z",
      capturedAt: "2026-09-09T01:00:00Z",
      capturedAtSource: "operator-declared",
    });
    await services.outboundSync.enqueueDesiredState(desiredState("listing-one", "channel-listing-one", 1, 1, 26));
    await services.outboundSync.enqueueDesiredState(desiredState("listing-two", "channel-listing-two", 1, 3, 30, 2));
    const composed = await services.tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run-application",
        connectionId: "connection-production",
        claimant: { claimantKind: "connector", claimantId: "connector-application" },
        leaseMs: 60_000,
        manualClaimLeasePolicySnapshot: null,
        resolvedPolicy: { maxRowsPerBatch: 500 },
        composedAt: "2026-09-09T01:01:00Z",
      },
      testContext,
    );
    expect(composed?.composition.batch?.rows).toHaveLength(2);
    const claimed = await services.tcgplayerCsv.claimRun(
      { runId: "run-application", expectedRevision: 0 },
      testContext,
    );
    const awaiting = await services.tcgplayerCsv.recordUploadAttempt(
      {
        runId: "run-application",
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T01:01:30Z",
        fileName: "run-application.csv",
      },
      testContext,
    );
    await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-application-proof",
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv([
        ["90000101", "Near Mint", "1", "0", "0.2600"],
        ["90000102", "Lightly Played", "3", "0", "0.3000"],
      ]),
      limits: { maxRecords: 2 },
      ingestedAt: "2026-09-09T01:02:00Z",
      capturedAt: "2026-09-09T01:02:00Z",
      capturedAtSource: "operator-declared",
    });
    await pools.channels.query(
      "UPDATE channel_inventory_snapshots SET parsed_row_count=3 WHERE snapshot_id='snapshot-application-proof'",
    );
    await expect(
      services.tcgplayerCsv.readLatestSnapshotRows({ connectionId: "connection-production", surface: "staged" }),
    ).resolves.toMatchObject({ membershipCompleteness: { kind: "bounded-incomplete" } });
    const beforeRefusal = await runWriteCounts("run-application");
    await expect(
      services.tcgplayerCsv.verifyRun(
        {
          runId: "run-application",
          expectedRevision: awaiting.revision,
          verificationSnapshotId: "snapshot-application-proof",
          importSummary: importSummary(2),
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "staged-basis-unavailable" });
    expect(await runWriteCounts("run-application")).toEqual(beforeRefusal);

    await pools.channels.query(
      "UPDATE channel_inventory_snapshots SET parsed_row_count=2 WHERE snapshot_id='snapshot-application-proof'",
    );
    await pools.channels.query(`CREATE FUNCTION reject_terminal_run_projection() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'applied' THEN RAISE EXCEPTION 'injected terminal projection failure'; END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await pools.channels.query(`CREATE TRIGGER reject_terminal_run_projection
      BEFORE UPDATE ON channel_sync_runs FOR EACH ROW EXECUTE FUNCTION reject_terminal_run_projection()`);
    await expect(
      services.tcgplayerCsv.verifyRun(
        {
          runId: "run-application",
          expectedRevision: awaiting.revision,
          verificationSnapshotId: "snapshot-application-proof",
          importSummary: importSummary(2),
        },
        testContext,
      ),
    ).rejects.toThrow("injected terminal projection failure");
    expect(await runWriteCounts("run-application")).toEqual(beforeRefusal);
    expect(
      await pools.channels.query(
        `SELECT status FROM channel_outbound_operations WHERE reservation_id=$1 ORDER BY operation_id`,
        [awaiting.reservationId],
      ),
    ).toMatchObject({ rows: [{ status: "in-flight" }, { status: "in-flight" }] });
    expect(
      await pools.channels.query("SELECT 1 FROM channel_outbound_reservation_settlements WHERE reservation_id=$1", [
        awaiting.reservationId,
      ]),
    ).toMatchObject({ rows: [] });
    await pools.channels.query("DROP TRIGGER reject_terminal_run_projection ON channel_sync_runs");
    await pools.channels.query("DROP FUNCTION reject_terminal_run_projection() ");
    const applied = await services.tcgplayerCsv.verifyRun(
      {
        runId: "run-application",
        expectedRevision: awaiting.revision,
        verificationSnapshotId: "snapshot-application-proof",
        importSummary: importSummary(2),
      },
      testContext,
    );
    expect(applied).toMatchObject({ state: "applied", verificationSnapshotGeneration: 2 });
    const operationStates = await pools.channels.query<{ status: string }>(
      "SELECT status FROM channel_outbound_operations ORDER BY operation_id",
    );
    expect(operationStates.rows).toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
    await expect(
      services.outboundSync.reportClaimedOperationOutcomes({
        reservationId: applied.reservationId,
        claimant: applied.claimant,
        outcomes: deriveClaimedOperationOutcomes(applied),
        runSettlement: {
          runId: applied.runId,
          expectedRunRevision: awaiting.revision,
          fromState: "awaiting-verification",
          toState: "applied",
          verificationSnapshotId: "snapshot-application-proof",
          verificationSnapshotGeneration: 2,
          uploadAttemptedAt: null,
          uploadFileName: null,
          importSummary: importSummary(2),
          context: testContext,
        },
      }),
    ).resolves.toBeUndefined();
    const committedOutcomes = deriveClaimedOperationOutcomes(applied);
    await expect(
      services.outboundSync.reportClaimedOperationOutcomes({
        reservationId: applied.reservationId,
        claimant: applied.claimant,
        outcomes: [{ ...committedOutcomes[0]!, desiredStateSequence: 99 }, ...committedOutcomes.slice(1)],
        runSettlement: {
          runId: applied.runId,
          expectedRunRevision: awaiting.revision,
          fromState: "awaiting-verification",
          toState: "applied",
          verificationSnapshotId: "snapshot-application-proof",
          verificationSnapshotGeneration: 2,
          uploadAttemptedAt: null,
          uploadFileName: null,
          importSummary: importSummary(2),
          context: testContext,
        },
      }),
    ).rejects.toMatchObject({ code: "reservation-membership-mismatch" });

    await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-day-after",
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv([
        ["90000101", "Near Mint", "1", "0", "0.2600"],
        ["90000102", "Lightly Played", "3", "0", "0.3000"],
      ]),
      limits: { maxRecords: 2 },
      ingestedAt: "2026-09-10T01:02:00Z",
      capturedAt: "2026-09-10T01:02:00Z",
      capturedAtSource: "operator-declared",
    });
    const beforeNoWork = await totalWriteCounts();
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        {
          runId: "run-no-work",
          connectionId: "connection-production",
          claimant: { claimantKind: "connector", claimantId: "connector-restart" },
          leaseMs: 60_000,
          manualClaimLeasePolicySnapshot: null,
          resolvedPolicy: { maxRowsPerBatch: 500 },
          composedAt: "2026-09-10T01:03:00Z",
        },
        testContext,
      ),
    ).resolves.toBeNull();
    expect(await totalWriteCounts()).toEqual(beforeNoWork);
  });

  it("retains the exact manual lease snapshot across restart and recomposes released work", async () => {
    const services = createOwnedRuntime();
    await seedProductionCompositionFacts([
      {
        listingId: "listing-restart",
        channelListingId: "channel-listing-restart",
        catalogItemId: "catalog-restart",
        externalKey: "product:90000201",
        gradedCard: null,
      },
    ]);
    await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-restart-basis",
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv([["90000201", "Near Mint", "2", "0", "0.2600"]]),
      limits: { maxRecords: 1 },
      ingestedAt: "2026-09-09T02:00:00Z",
      capturedAt: "2026-09-09T02:00:00Z",
      capturedAtSource: "operator-declared",
    });
    await services.outboundSync.enqueueDesiredState(
      desiredState("listing-restart", "channel-listing-restart", 1, 1, 27),
    );
    const manualClaimLeasePolicySnapshot = manualLeaseSnapshot(60_000);
    const composed = await services.tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run-restart-one",
        connectionId: "connection-production",
        claimant: { claimantKind: "manual", claimantId: "manual-restart" },
        leaseMs: 60_000,
        manualClaimLeasePolicySnapshot,
        resolvedPolicy: { maxRowsPerBatch: 500 },
        composedAt: "2026-09-09T02:01:00Z",
      },
      testContext,
    );
    expect(composed?.run.manualClaimLeasePolicySnapshot).toEqual(manualClaimLeasePolicySnapshot);
    const restarted = createOwnedRuntime();
    const beforeOutstanding = await totalWriteCounts();
    await expect(
      restarted.tcgplayerCsv.composeTcgplayerSyncRun(
        {
          runId: "run-restart-blocked",
          connectionId: "connection-production",
          claimant: { claimantKind: "connector", claimantId: "connector-restart" },
          leaseMs: 60_000,
          manualClaimLeasePolicySnapshot: null,
          resolvedPolicy: { maxRowsPerBatch: 500 },
          composedAt: "2026-09-09T02:02:00Z",
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "run-outstanding" });
    expect(await totalWriteCounts()).toEqual(beforeOutstanding);

    const claimed = await restarted.tcgplayerCsv.claimRun(
      { runId: "run-restart-one", expectedRevision: 0 },
      testContext,
    );
    const released = await restarted.tcgplayerCsv.releaseRun(
      { runId: "run-restart-one", expectedRevision: claimed.revision },
      testContext,
    );
    expect(released.state).toBe("abandoned");
    const dayAfter = await createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run-restart-two",
        connectionId: "connection-production",
        claimant: { claimantKind: "connector", claimantId: "connector-day-after" },
        leaseMs: 60_000,
        manualClaimLeasePolicySnapshot: null,
        resolvedPolicy: { maxRowsPerBatch: 500 },
        composedAt: "2026-09-10T02:00:00Z",
      },
      testContext,
    );
    expect(dayAfter?.composition.members).toEqual([
      expect.objectContaining({ listingId: "listing-restart", desiredStateSequence: 1 }),
    ]);
  });
});

function replayRun(): ChannelSyncRun {
  return {
    runId: "run-replay",
    revision: 0,
    sequence: 1,
    connectionId: "connection-1",
    providerKey: "tcgplayer",
    reservationId: "reservation-replay",
    claimant: { claimantKind: "connector", claimantId: "connector-replay" },
    leaseExpiresAt: "2026-09-09T00:30:00Z",
    manualClaimLeasePolicySnapshot: null,
    state: "composed",
    basisSnapshotId: "snapshot-1",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [
      {
        operationId: "operation-replay",
        attemptId: "attempt-replay",
        claimGeneration: 1,
        reservationId: "reservation-replay",
        channelListingId: "channel-listing-replay",
        listingId: "listing-replay",
        desiredStateSequence: 91,
        listingRevision: 7,
        payloadDigest: "b".repeat(64),
        ordinal: 0,
        memberKind: "already-satisfied",
        externalKey: "product:90000001",
        conditionText: null,
        basisSnapshotId: "snapshot-1",
        basisSnapshotGeneration: 1,
        basisTotalQuantity: 2,
        basisPriceAmountMinor: 26,
        targetQuantity: 2,
        targetPriceAmountMinor: 26,
        csvRow: null,
        refusalReason: null,
        mappingDimension: null,
        mappingSourceKey: null,
        providerAction: "not-attempted-already-satisfied",
      },
    ],
  };
}

async function seedSnapshot(): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_inventory_snapshots
     (snapshot_id,snapshot_generation,connection_id,provider_key,surface,parsed_row_count,completeness,ingested_at,captured_at,captured_at_source)
     VALUES ('snapshot-1',1,'connection-1','tcgplayer','staged',1,'unverified','2026-09-09T00:00:00Z','2026-09-09T00:00:00Z','operator-declared')`,
  );
}

async function insertRun(
  runId: string,
  reservationId: string,
  claimantKind: "manual" | "connector",
  snapshot: unknown = claimantKind === "manual" ? { synthetic: true } : null,
): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_sync_runs
     (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
      manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at,last_stream_version)
     VALUES ($1,0,(SELECT coalesce(max(sequence),0)+1 FROM channel_sync_runs),'connection-1','tcgplayer',$2,$3,'claimant-1',
      '2026-09-09T00:30:00Z',$4::jsonb,'composed','snapshot-1',1,'[]'::jsonb,1,$5,'2026-09-09T00:00:00Z','2026-09-09T00:00:00Z',1)`,
    [runId, reservationId, claimantKind, snapshot === null ? null : JSON.stringify(snapshot), "a".repeat(64)],
  );
}

async function insertMember(
  runId: string,
  reservationId: string,
  listingId: string,
  desiredStateSequence: number,
): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_sync_run_rows
     (run_id,operation_id,ordinal,reservation_id,attempt_id,claim_generation,channel_listing_id,listing_id,
      desired_state_sequence,listing_revision,payload_digest,member_kind,external_key,condition_text,basis_snapshot_id,
      basis_snapshot_generation,basis_total_quantity,basis_price_amount_minor,target_quantity,target_price_amount_minor,
      csv_row_json,refusal_reason,mapping_dimension,mapping_source_key,provider_action)
     VALUES ($1,'operation-1',0,$2,'attempt-1',1,'channel-listing-1',$3,$4,7,$5,'already-satisfied',
      'product:90000001',NULL,'snapshot-1',1,2,26,2,26,NULL,NULL,NULL,NULL,'not-attempted-already-satisfied')`,
    [runId, reservationId, listingId, desiredStateSequence, "b".repeat(64)],
  );
}

type ProductionListingFixture = Readonly<{
  listingId: string;
  channelListingId: string;
  catalogItemId: string;
  externalKey: string;
  gradedCard: ReturnType<typeof gradedCard> | null;
}>;

function createOwnedRuntime() {
  const eventStore = createPostgresEventStore({ pool: pools.channels });
  const compositionProfiles = createChannelCompositionProfileRegistry(tcgplayerCompositionProfiles);
  const listingComposition = createChannelListingCompositionRuntime({
    db: pools.channels,
    eventStore,
    transactionalEventStore: eventStore,
    profiles: compositionProfiles,
  });
  const outboundSync = createOutboundSyncRuntime(
    {
      db: pools.channels,
      recordOutcome: async () => "applied",
      claimedReservationRunSettlement: createTcgplayerClaimedReservationRunSettlementPort(eventStore),
    },
    { assertDelistDirective: () => undefined },
  );
  return {
    outboundSync,
    tcgplayerCsv: createTcgplayerCsvRuntime({
      db: pools.channels,
      eventStore,
      outboundSync,
      listingComposition,
      providerRegistry: channelProviderRegistry,
      compositionProfiles,
    }),
  };
}

async function seedProductionCompositionFacts(listings: readonly ProductionListingFixture[]): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_connections
     (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
     VALUES ('connection-production','account-production','tcgplayer','sandbox','active','2026-09-09T00:00:00Z',
       '2026-09-09T00:00:00Z','[]'::jsonb,'2026-09-09T00:00:00Z',1)`,
  );
  await pools.channels.query(
    `INSERT INTO channels_connection_facts
     (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES ('connection-production','account-production','tcgplayer','sandbox','active','2026-09-09T00:00:00Z',1)`,
  );
  for (const listing of listings) {
    await pools.channels.query(
      `INSERT INTO channels_listing_publication_facts
       (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
        selected_options,selected_option_key,listing_status,graded_card,updated_at,listing_stream_version)
       VALUES ($1,'account-production',$2,$3,'0.26','USD',10,'[]'::jsonb,'','active',$4::jsonb,
        '2026-09-09T00:00:00Z',1)`,
      [
        listing.listingId,
        `inventory-${listing.listingId}`,
        listing.catalogItemId,
        listing.gradedCard === null ? null : JSON.stringify(listing.gradedCard),
      ],
    );
    await pools.channels.query(
      `INSERT INTO channels_channel_listing_links
       (connection_id,listing_id,channel_listing_id,publish_state,blocking_reason_codes,operation_bindings,updated_at,last_stream_version)
       VALUES ('connection-production',$1,$2,'pending','[]'::jsonb,'{}'::jsonb,'2026-09-09T00:00:00Z',1)`,
      [listing.listingId, listing.channelListingId],
    );
    await pools.channels.query(
      `INSERT INTO channels_external_catalog_item_reference_facts
       (provider_key,external_key,catalog_item_id,link_state,updated_at,reference_stream_version)
       VALUES ('tcgplayer',$1,$2,'linked','2026-09-09T00:00:00Z',1)`,
      [listing.externalKey, listing.catalogItemId],
    );
  }
}

function gradedCard(gradingCompany: string, grade: string) {
  return {
    gradingCompany,
    grade,
    certificationNumber: null,
    population: null,
    conditionDescriptors: [],
  };
}

function desiredState(
  listingId: string,
  channelListingId: string,
  desiredStateSequence: number,
  quantity: number,
  priceAmountMinor: number,
  globalPosition: number = 1,
) {
  return {
    connectionId: "connection-production",
    channelListingId,
    listingId,
    operationKind: "update" as const,
    listingRevision: 1,
    desiredStateSequence,
    desiredStateHash: desiredStateSequence.toString(16).padStart(64, "0"),
    payload: {
      kind: "draft" as const,
      draft: {
        channelListingId,
        listingRevision: 1,
        title: "chase-sets:snapshot-preserved:tcgplayer",
        description: "chase-sets:snapshot-preserved:tcgplayer",
        categoryKey: "chase-sets:snapshot-preserved:tcgplayer",
        conditionKey: "chase-sets:snapshot-preserved:tcgplayer",
        price: { amountMinor: priceAmountMinor, currency: "USD" },
        quantity,
        attributes: [],
      },
    },
    envelope: {
      sourceEventId: `event-${listingId}-${desiredStateSequence}`,
      sourceStreamId: `channels.channel-listing-${channelListingId}`,
      sourceStreamVersion: desiredStateSequence,
      sourceGlobalPosition: parseGlobalPosition(String(globalPosition)),
      sourceOccurredAt: "2026-09-09T00:00:00Z",
    },
  };
}

function stagedCsv(rows: readonly (readonly string[])[]): string {
  return [
    "TCGplayer Id,Condition,Total Quantity,Add to Quantity,TCG Marketplace Price",
    ...rows.map((row) => row.join(",")),
  ].join("\r\n");
}

function importSummary(numberOfProducts: number) {
  return {
    fileName: "run-application.csv",
    dateImportedText: "9/9/2026 1:02 AM",
    numberOfProducts,
    recordedAt: "2026-09-09T01:02:30Z",
  };
}

function manualLeaseSnapshot(leaseMs: number) {
  const tuple = {
    policyKey: "channels.tcgplayer-manual-claim-lease" as const,
    value: { leaseMs },
    source: "fallback" as const,
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: "2026-09-09T02:00:30Z",
  };
  return { ...tuple, digest: canonicalManualClaimLeasePolicySnapshotDigest(tuple) };
}

async function runWriteCounts(runId: string): Promise<Readonly<{ events: string; revision: string }>> {
  const result = await pools.channels.query<{ events: string; revision: string }>(
    `SELECT
       (SELECT count(*)::text FROM event_store_events WHERE stream_id=$1) AS events,
       (SELECT revision::text FROM channel_sync_runs WHERE run_id=$2) AS revision`,
    [`channels.tcgplayer-sync-run-${runId}`, runId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Run write counts were unavailable.");
  return row;
}

async function totalWriteCounts(): Promise<
  Readonly<{ events: string; runs: string; operations: string; settlements: string }>
> {
  const result = await pools.channels.query<{
    events: string;
    runs: string;
    operations: string;
    settlements: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM event_store_events) AS events,
       (SELECT count(*)::text FROM channel_sync_runs) AS runs,
       (SELECT count(*)::text FROM channel_outbound_operations) AS operations,
       (SELECT count(*)::text FROM channel_outbound_reservation_settlements) AS settlements`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Total write counts were unavailable.");
  return row;
}
