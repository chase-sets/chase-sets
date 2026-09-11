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

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

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

  it("atomically rolls back reservation and composed event failures before restart, expiry, and a two-claimant race", async () => {
    const base = createOwnedRuntime("2026-09-09T03:00:00Z");
    await seedProductionCompositionFacts([
      {
        listingId: "listing-atomic",
        channelListingId: "channel-listing-atomic",
        catalogItemId: "catalog-atomic",
        externalKey: "product:90000010",
        gradedCard: null,
      },
    ]);
    await base.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-atomic-basis",
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv([["90000010", "Near Mint", "2", "0", "0.2600"]]),
      limits: { maxRecords: 1 },
      ingestedAt: "2026-09-09T03:00:00Z",
      capturedAt: "2026-09-09T03:00:00Z",
      capturedAtSource: "operator-declared",
    });
    await base.outboundSync.enqueueDesiredState(desiredState("listing-atomic", "channel-listing-atomic", 1, 1, 27));

    await installInitialCompositionFailure("event");
    await expect(
      base.tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-atomic-event-failure", "connector", "connector-atomic"),
        testContext,
      ),
    ).rejects.toThrow("Failed to append events in a caller-owned Postgres transaction.");
    await removeInitialCompositionFailure("event");
    expect(await initialCompositionState("run-atomic-event-failure")).toEqual({
      events: "0",
      runs: "0",
      pending: "1",
      inFlight: "0",
    });

    await installInitialCompositionFailure("projection");
    await expect(
      base.tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-atomic-projection-failure", "connector", "connector-atomic"),
        testContext,
      ),
    ).rejects.toThrow("injected composed projection failure");
    await removeInitialCompositionFailure("projection");
    expect(await initialCompositionState("run-atomic-projection-failure")).toEqual({
      events: "0",
      runs: "0",
      pending: "1",
      inFlight: "0",
    });

    const committed = await createOwnedRuntime("2026-09-09T03:00:00Z").tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-atomic-committed", "connector", "connector-atomic"),
      testContext,
    );
    expect(committed?.run).toMatchObject({ state: "composed", membershipCompleteness: { kind: "complete", total: 1 } });
    expect(await initialCompositionState("run-atomic-committed")).toEqual({
      events: "1",
      runs: "1",
      pending: "0",
      inFlight: "1",
    });

    const expired = createOwnedRuntime("2026-09-09T03:02:00Z");
    await expect(expired.outboundSync.recoverExpiredClaimedOperations()).resolves.toBe(1);
    expect(await readRun(pools.channels, "run-atomic-committed")).toMatchObject({ state: "abandoned" });
    expect(await pools.channels.query("SELECT status FROM channel_outbound_operations")).toMatchObject({
      rows: [{ status: "pending" }],
    });

    const claimantOne = createOwnedRuntime("2026-09-09T03:03:00Z");
    const claimantTwo = createOwnedRuntime("2026-09-09T03:03:00Z");
    const raced = await Promise.allSettled([
      claimantOne.tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-atomic-race-one", "manual", "manual-race"),
        testContext,
      ),
      claimantTwo.tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-atomic-race-two", "connector", "connector-race"),
        testContext,
      ),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(raced.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "run-outstanding" }),
    });
    expect(
      await pools.channels.query(
        "SELECT count(*)::text AS count FROM channel_sync_runs WHERE state IN ('composed','claimed','awaiting-verification')",
      ),
    ).toMatchObject({ rows: [{ count: "1" }] });
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

  it("refuses every ingest grammar arm with zero snapshot, row, or schema-pin persistence", async () => {
    const services = createOwnedRuntime();
    await seedProductionCompositionFacts([]);
    await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-ingest-pin",
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv([["90000020", "Near Mint", "2", "0", "0.2600"]]),
      limits: { maxRecords: 1 },
      ingestedAt: "2026-09-09T04:00:00Z",
      capturedAt: "2026-09-09T04:00:00Z",
      capturedAtSource: "operator-declared",
    });
    const pinnedCounts = await snapshotPersistenceCounts("connection-production");
    const header = "TCGplayer Id,Condition,Total Quantity,Add to Quantity,TCG Marketplace Price";
    const refusals = [
      ["invalid-input", `${header}\n90000021,Near Mint,1,0,1.00`, { maxRecords: 0 }],
      ["header-mismatch", `${header},Unknown\n90000021,Near Mint,1,0,1.00,x`, { maxRecords: 10 }],
      [
        "header-missing-required-column",
        "TCGplayer Id,Condition,Total Quantity,Add to Quantity\n1,Near Mint,1,0",
        { maxRecords: 10 },
      ],
      [
        "header-duplicate-column",
        "TCGplayer Id,TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n1,1,1,0,1.00",
        { maxRecords: 10 },
      ],
      ["row-width-mismatch", `${header}\n90000021,Near Mint,1,0`, { maxRecords: 10 }],
      ["unterminated-quoted-field", `${header}\n90000021,"Near Mint,1,0,1.00`, { maxRecords: 10 }],
      ["empty-export", header, { maxRecords: 10 }],
      [
        "duplicate-row-identity",
        `${header}\n90000021,Near Mint,1,0,1.00\n90000021,Near Mint,2,0,2.00`,
        { maxRecords: 10 },
      ],
      ["invalid-integer", `${header}\n90000021,Near Mint,1.5,0,1.00`, { maxRecords: 10 }],
      [
        "record-limit-exceeded",
        `${header}\n90000021,Near Mint,1,0,1.00\n90000022,Near Mint,1,0,1.00`,
        { maxRecords: 1 },
      ],
    ] as const;
    for (const [reason, csv, limits] of refusals) {
      await expect(
        services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
          snapshotId: `snapshot-refused-${reason}`,
          connectionId: "connection-production",
          surface: "staged",
          csv,
          limits,
          ingestedAt: "2026-09-09T04:01:00Z",
          capturedAt: "2026-09-09T04:01:00Z",
          capturedAtSource: "ingest",
        }),
      ).resolves.toEqual({ kind: "refused", reason });
      expect(await snapshotPersistenceCounts("connection-production")).toEqual(pinnedCounts);
    }

    await cloneConnection("connection-condition-absent");
    const conditionAbsentHeader = "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price";
    await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-condition-absent-pin",
      connectionId: "connection-condition-absent",
      surface: "staged",
      csv: `${conditionAbsentHeader}\n90000023,1,0,1.00`,
      limits: { maxRecords: 1 },
      ingestedAt: "2026-09-09T04:02:00Z",
      capturedAt: "2026-09-09T04:02:00Z",
      capturedAtSource: "ingest",
    });
    const absentCounts = await snapshotPersistenceCounts("connection-condition-absent");
    await expect(
      services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
        snapshotId: "snapshot-condition-absent-duplicate",
        connectionId: "connection-condition-absent",
        surface: "staged",
        csv: `${conditionAbsentHeader}\n90000024,1,0,1.00\n90000024,2,0,2.00`,
        limits: { maxRecords: 2 },
        ingestedAt: "2026-09-09T04:03:00Z",
        capturedAt: "2026-09-09T04:03:00Z",
        capturedAtSource: "ingest",
      }),
    ).resolves.toEqual({ kind: "refused", reason: "duplicate-row-identity" });
    expect(await snapshotPersistenceCounts("connection-condition-absent")).toEqual(absentCounts);
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

  it("drives missing, first, never-verified, equal, and newer Staged basis generations", async () => {
    const services = createOwnedRuntime();
    await seedProductionCompositionFacts([
      {
        listingId: "listing-freshness",
        channelListingId: "channel-listing-freshness",
        catalogItemId: "catalog-freshness",
        externalKey: "product:90000301",
        gradedCard: null,
      },
    ]);
    await services.outboundSync.enqueueDesiredState(
      desiredState("listing-freshness", "channel-listing-freshness", 1, 1, 27),
    );
    const beforeMissing = await totalWriteCounts();
    await expect(
      services.tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-basis-missing", "connector", "connector-basis"),
        testContext,
      ),
    ).rejects.toMatchObject({ code: "staged-basis-unavailable" });
    expect(await totalWriteCounts()).toEqual(beforeMissing);

    await ingestStaged(services, "snapshot-basis-first", [["90000301", "Near Mint", "2", "0", "0.2600"]], 5);
    const first = await services.tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-basis-first", "connector", "connector-basis"),
      testContext,
    );
    const firstClaimed = await services.tcgplayerCsv.claimRun(
      { runId: first!.run.runId, expectedRevision: first!.run.revision },
      testContext,
    );
    await services.tcgplayerCsv.recordValidationCancellation(
      { runId: firstClaimed.runId, expectedRevision: firstClaimed.revision },
      testContext,
    );

    await services.outboundSync.enqueueDesiredState(
      desiredState("listing-freshness", "channel-listing-freshness", 2, 1, 27, 2),
    );
    const blockedLane = await pools.channels.query<{ revision: string | number }>(
      `SELECT revision FROM channel_outbound_lanes
       WHERE connection_id='connection-production' AND channel_listing_id='channel-listing-freshness'`,
    );
    const blockedLaneRevision = blockedLane.rows[0]?.revision;
    if (blockedLaneRevision === undefined) throw new Error("Expected the validation-rejected lane to remain blocked.");
    await services.outboundSync.clearOutboundOperationLane({
      connectionId: "connection-production",
      channelListingId: "channel-listing-freshness",
      expectedRevision: Number(blockedLaneRevision),
    });
    const neverVerified = await createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-basis-never-verified", "connector", "connector-basis"),
      testContext,
    );
    expect(neverVerified?.run.basisSnapshotGeneration).toBe(1);
    const claimed = await services.tcgplayerCsv.claimRun(
      { runId: neverVerified!.run.runId, expectedRevision: neverVerified!.run.revision },
      testContext,
    );
    const awaiting = await services.tcgplayerCsv.recordUploadAttempt(
      {
        runId: claimed.runId,
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T05:01:00Z",
        fileName: "basis-freshness.csv",
      },
      testContext,
    );
    await ingestStaged(services, "snapshot-basis-verified", [["90000301", "Near Mint", "1", "0", "0.2700"]], 6);
    const verified = await services.tcgplayerCsv.verifyRun(
      {
        runId: awaiting.runId,
        expectedRevision: awaiting.revision,
        verificationSnapshotId: "snapshot-basis-verified",
        importSummary: {
          fileName: "basis-freshness.csv",
          dateImportedText: "9/9/2026 5:02 AM",
          numberOfProducts: 1,
          recordedAt: "2026-09-09T05:02:30Z",
        },
      },
      testContext,
    );
    expect(verified).toMatchObject({ state: "applied", verificationSnapshotGeneration: 2 });

    await services.outboundSync.enqueueDesiredState(
      desiredState("listing-freshness", "channel-listing-freshness", 3, 0, 27, 3),
    );
    const beforeStale = await totalWriteCounts();
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-basis-equal", "connector", "connector-basis"),
        testContext,
      ),
    ).rejects.toMatchObject({ code: "staged-basis-stale" });
    expect(await totalWriteCounts()).toEqual(beforeStale);
    await ingestStaged(services, "snapshot-basis-newer", [["90000301", "Near Mint", "1", "0", "0.2700"]], 7);
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-basis-newer", "connector", "connector-basis"),
        testContext,
      ),
    ).resolves.toMatchObject({ run: { basisSnapshotGeneration: 3 } });
  });

  it("splits repeated N+1 reservations into ordered N then one without in-flight residue", async () => {
    const services = createOwnedRuntime();
    const listings = [1, 2, 3].map((ordinal) => ({
      listingId: `listing-split-${ordinal}`,
      channelListingId: `channel-listing-split-${ordinal}`,
      catalogItemId: `catalog-split-${ordinal}`,
      externalKey: `product:9000040${ordinal}`,
      gradedCard: null,
    }));
    await seedProductionCompositionFacts(listings);
    await ingestStaged(
      services,
      "snapshot-split-basis",
      listings.map((_, index) => [`9000040${index + 1}`, "Near Mint", "2", "0", "0.2600"]),
      8,
    );
    for (const [index, listing] of listings.entries()) {
      await services.outboundSync.enqueueDesiredState(
        desiredState(listing.listingId, listing.channelListingId, 1, 1, 27, index + 1),
      );
    }
    const expectedOrder = await pools.channels.query<{ operation_id: string }>(
      "SELECT operation_id FROM channel_outbound_operations ORDER BY enqueued_at,operation_id",
    );
    const memberOrder: string[] = [];
    for (const [ordinal, expectedSize] of [2, 1].entries()) {
      const composed = await createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        {
          ...composeInput(`run-split-${ordinal + 1}`, "connector", "connector-split"),
          resolvedPolicy: { maxRowsPerBatch: 2 },
        },
        testContext,
      );
      expect(composed?.run.members).toHaveLength(expectedSize);
      memberOrder.push(...composed!.run.members.map((member) => member.operationId));
      const claimed = await services.tcgplayerCsv.claimRun(
        { runId: composed!.run.runId, expectedRevision: composed!.run.revision },
        testContext,
      );
      await services.tcgplayerCsv.recordValidationCancellation(
        { runId: claimed.runId, expectedRevision: claimed.revision },
        testContext,
      );
    }
    expect(memberOrder).toEqual(expectedOrder.rows.map((row) => row.operation_id));
    expect(
      await pools.channels.query(
        "SELECT status,count(*)::text AS count FROM channel_outbound_operations GROUP BY status ORDER BY status",
      ),
    ).toMatchObject({ rows: [{ status: "failed", count: "3" }] });
  });

  it("serializes two claimant families across three cap-sized sets and restarts", async () => {
    const initial = createOwnedRuntime();
    const listings = Array.from({ length: 6 }, (_, index) => ({
      listingId: `listing-race-${index + 1}`,
      channelListingId: `channel-listing-race-${index + 1}`,
      catalogItemId: `catalog-race-${index + 1}`,
      externalKey: `product:9000050${index + 1}`,
      gradedCard: null,
    }));
    await seedProductionCompositionFacts(listings);
    await ingestStaged(
      initial,
      "snapshot-race-basis",
      listings.map((_, index) => [`9000050${index + 1}`, "Near Mint", "2", "0", "0.2600"]),
      9,
    );
    for (const [index, listing] of listings.entries()) {
      await initial.outboundSync.enqueueDesiredState(
        desiredState(listing.listingId, listing.channelListingId, 1, 1, 27, index + 1),
      );
    }

    for (let batch = 1; batch <= 3; batch += 1) {
      const manual = createOwnedRuntime();
      const connector = createOwnedRuntime();
      const results = await Promise.allSettled([
        manual.tcgplayerCsv.composeTcgplayerSyncRun(
          {
            ...composeInput(`run-race-${batch}-manual`, "manual", `manual-${batch}`),
            resolvedPolicy: { maxRowsPerBatch: 2 },
          },
          testContext,
        ),
        connector.tcgplayerCsv.composeTcgplayerSyncRun(
          {
            ...composeInput(`run-race-${batch}-connector`, "connector", `connector-${batch}`),
            resolvedPolicy: { maxRowsPerBatch: 2 },
          },
          testContext,
        ),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const winner = fulfilled[0];
      if (!winner || winner.status !== "fulfilled" || winner.value === null) {
        throw new Error("Claimant race did not produce one composed run.");
      }
      expect(winner.value.run.members).toHaveLength(2);
      const claimed = await createOwnedRuntime().tcgplayerCsv.claimRun(
        { runId: winner.value.run.runId, expectedRevision: winner.value.run.revision },
        testContext,
      );
      await createOwnedRuntime().tcgplayerCsv.recordValidationCancellation(
        { runId: claimed.runId, expectedRevision: claimed.revision },
        testContext,
      );
    }
    expect(
      await pools.channels.query(
        `SELECT count(*)::text AS count FROM channel_sync_runs
         WHERE state IN ('composed','claimed','awaiting-verification')`,
      ),
    ).toMatchObject({ rows: [{ count: "0" }] });
    expect(await pools.channels.query("SELECT member_count FROM channel_sync_runs ORDER BY sequence")).toMatchObject({
      rows: [{ member_count: 2 }, { member_count: 2 }, { member_count: 2 }],
    });
  });

  it("settles claimed and upload-verify lease boundaries once through the genuine run port", async () => {
    const initial = createOwnedRuntime("2026-09-09T06:00:00Z");
    await seedProductionCompositionFacts([
      {
        listingId: "listing-expiry",
        channelListingId: "channel-listing-expiry",
        catalogItemId: "catalog-expiry",
        externalKey: "product:90000601",
        gradedCard: null,
      },
    ]);
    await ingestStaged(initial, "snapshot-expiry-basis", [["90000601", "Near Mint", "2", "0", "0.2600"]], 10);
    await initial.outboundSync.enqueueDesiredState(desiredState("listing-expiry", "channel-listing-expiry", 1, 1, 27));
    const manualRun = await initial.tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-expiry-claimed", "manual", "manual-expiry"),
      testContext,
    );
    await initial.tcgplayerCsv.claimRun(
      { runId: manualRun!.run.runId, expectedRevision: manualRun!.run.revision },
      testContext,
    );
    await expect(
      createOwnedRuntime("2026-09-09T06:02:00Z").outboundSync.recoverExpiredClaimedOperations(),
    ).resolves.toBe(1);
    expect(await readRun(pools.channels, "run-expiry-claimed")).toMatchObject({ state: "abandoned" });
    expect(await pools.channels.query("SELECT status FROM channel_outbound_operations")).toMatchObject({
      rows: [{ status: "pending" }],
    });

    const connector = createOwnedRuntime("2026-09-09T06:03:00Z");
    const uploadRun = await connector.tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-expiry-awaiting", "connector", "connector-expiry"),
      testContext,
    );
    const claimed = await connector.tcgplayerCsv.claimRun(
      { runId: uploadRun!.run.runId, expectedRevision: uploadRun!.run.revision },
      testContext,
    );
    await connector.tcgplayerCsv.recordUploadAttempt(
      {
        runId: claimed.runId,
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T06:03:30Z",
        fileName: "expiry-boundary.csv",
      },
      testContext,
    );
    await expect(
      createOwnedRuntime("2026-09-09T06:05:00Z").outboundSync.recoverExpiredClaimedOperations(),
    ).resolves.toBe(1);
    expect(await readRun(pools.channels, "run-expiry-awaiting")).toMatchObject({ state: "application-unknown" });
    expect(await pools.channels.query("SELECT status,terminal_reason FROM channel_outbound_operations")).toMatchObject({
      rows: [{ status: "failed", terminal_reason: "outcome-unknown" }],
    });
    const terminalCounts = await totalWriteCounts();
    await expect(
      createOwnedRuntime("2026-09-09T06:06:00Z").outboundSync.recoverExpiredClaimedOperations(),
    ).resolves.toBe(0);
    expect(await totalWriteCounts()).toEqual(terminalCounts);
    await initial.outboundSync.enqueueDesiredState(
      desiredState("listing-expiry", "channel-listing-expiry", 2, 0, 27, 2),
    );
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-expiry-no-redelivery", "connector", "connector-expiry"),
        testContext,
      ),
    ).resolves.toBeNull();
  });

  it("settles every member durably when an awaiting run reports a second upload attempt", async () => {
    const services = createOwnedRuntime("2026-09-09T08:00:00Z");
    const composed = await composeMixedMemberRun(services, "run-mixed-duplicate-upload", "connector-mixed-duplicate");
    const claimed = await services.tcgplayerCsv.claimRun(
      { runId: composed.run.runId, expectedRevision: composed.run.revision },
      testContext,
    );
    const awaiting = await services.tcgplayerCsv.recordUploadAttempt(
      {
        runId: claimed.runId,
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T08:00:20Z",
        fileName: "mixed-members.csv",
      },
      testContext,
    );
    const unknown = await services.tcgplayerCsv.recordUploadAttempt(
      {
        runId: awaiting.runId,
        expectedRevision: awaiting.revision,
        uploadAttemptedAt: "2026-09-09T08:00:40Z",
        fileName: "mixed-members.csv",
      },
      testContext,
    );

    expect(unknown.state).toBe("application-unknown");
    await expectMixedMemberDurableSettlement(unknown);
    const terminalCounts = await totalWriteCounts();
    await expect(
      createOwnedRuntime("2026-09-09T08:02:00Z").outboundSync.recoverExpiredClaimedOperations(),
    ).resolves.toBe(0);
    expect(await totalWriteCounts()).toEqual(terminalCounts);
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-mixed-duplicate-no-redelivery", "connector", "connector-mixed-duplicate"),
        testContext,
      ),
    ).resolves.toBeNull();
  });

  it("settles the mixed member partition through upload-to-verify expiry exactly once", async () => {
    const services = createOwnedRuntime("2026-09-09T09:00:00Z");
    const composed = await composeMixedMemberRun(services, "run-mixed-expiry", "connector-mixed-expiry");
    const claimed = await services.tcgplayerCsv.claimRun(
      { runId: composed.run.runId, expectedRevision: composed.run.revision },
      testContext,
    );
    await services.tcgplayerCsv.recordUploadAttempt(
      {
        runId: claimed.runId,
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T09:00:30Z",
        fileName: "mixed-members.csv",
      },
      testContext,
    );

    await expect(
      createOwnedRuntime("2026-09-09T09:02:00Z").outboundSync.recoverExpiredClaimedOperations(),
    ).resolves.toBe(3);
    const unknown = await readRun(pools.channels, composed.run.runId);
    if (!unknown) throw new Error("The expired mixed member run was unavailable.");
    await expectMixedMemberDurableSettlement(unknown);
    const terminalCounts = await totalWriteCounts();
    await expect(
      createOwnedRuntime("2026-09-09T09:03:00Z").outboundSync.recoverExpiredClaimedOperations(),
    ).resolves.toBe(0);
    expect(await totalWriteCounts()).toEqual(terminalCounts);
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-mixed-expiry-no-redelivery", "connector", "connector-mixed-expiry"),
        testContext,
      ),
    ).resolves.toBeNull();
  });

  it("settles a genuine composed, refused, and already-satisfied member partition by member proof", async () => {
    const services = createOwnedRuntime();
    const composed = await composeMixedMemberRun(services, "run-mixed-members", "connector-mixed");
    const claimed = await services.tcgplayerCsv.claimRun(
      { runId: composed.run.runId, expectedRevision: composed.run.revision },
      testContext,
    );
    const awaiting = await services.tcgplayerCsv.recordUploadAttempt(
      {
        runId: claimed.runId,
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T07:01:00Z",
        fileName: "mixed-members.csv",
      },
      testContext,
    );
    await ingestStaged(
      services,
      "snapshot-mixed-proof",
      [
        ["90000701", "Near Mint", "1", "0", "0.2700"],
        ["90000702", "Near Mint", "2", "0", "0.2600"],
        ["90000703", "Near Mint", "3", "0", "0.3000"],
      ],
      12,
    );
    const applied = await services.tcgplayerCsv.verifyRun(
      {
        runId: awaiting.runId,
        expectedRevision: awaiting.revision,
        verificationSnapshotId: "snapshot-mixed-proof",
        importSummary: {
          fileName: "mixed-members.csv",
          dateImportedText: "9/9/2026 7:02 AM",
          numberOfProducts: 1,
          recordedAt: "2026-09-09T07:02:30Z",
        },
      },
      testContext,
    );
    expect(applied.state).toBe("applied");
    expect(
      await pools.channels.query(
        "SELECT channel_listing_id,status FROM channel_outbound_operations ORDER BY channel_listing_id",
      ),
    ).toMatchObject({
      rows: [
        { channel_listing_id: "channel-listing-mixed-composed", status: "succeeded" },
        { channel_listing_id: "channel-listing-mixed-noop", status: "succeeded" },
        { channel_listing_id: "channel-listing-mixed-refused", status: "failed" },
      ],
    });
    const receipt = await pools.channels.query<{ outcomes: readonly { outcome: { kind: string } }[] }>(
      "SELECT outcomes FROM channel_outbound_reservation_settlements WHERE reservation_id=$1",
      [applied.reservationId],
    );
    expect(receipt.rows[0]?.outcomes.map((outcome) => outcome.outcome.kind).sort()).toEqual([
      "applied",
      "applied",
      "rejected",
    ]);
  });

  it("recomposes superseded and stale-basis work on the day after without mutating terminal audit", async () => {
    const services = createOwnedRuntime();
    await seedProductionCompositionFacts([
      {
        listingId: "listing-terminal-day-after",
        channelListingId: "channel-listing-terminal-day-after",
        catalogItemId: "catalog-terminal-day-after",
        externalKey: "product:90000811",
        gradedCard: null,
      },
    ]);
    await ingestStaged(services, "snapshot-terminal-basis", [["90000811", "Near Mint", "2", "0", "0.2600"]], 13);
    await services.outboundSync.enqueueDesiredState(
      desiredState("listing-terminal-day-after", "channel-listing-terminal-day-after", 1, 1, 27),
    );
    const supersededRun = await services.tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-terminal-superseded", "connector", "connector-terminal"),
      testContext,
    );
    const superseded = await services.tcgplayerCsv.supersedeRun(
      { runId: supersededRun!.run.runId, expectedRevision: supersededRun!.run.revision },
      testContext,
    );
    expect(superseded.state).toBe("superseded");
    const terminalCounts = await totalWriteCounts();
    await expect(
      services.tcgplayerCsv.supersedeRun(
        { runId: superseded.runId, expectedRevision: superseded.revision },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "terminal" });
    expect(await totalWriteCounts()).toEqual(terminalCounts);

    const staleRun = await createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
      composeInput("run-terminal-stale", "connector", "connector-terminal"),
      testContext,
    );
    await ingestStaged(services, "snapshot-terminal-newer-basis", [["90000811", "Near Mint", "2", "0", "0.2600"]], 14);
    const stale = await services.tcgplayerCsv.observeNewerBasis(
      { runId: staleRun!.run.runId, expectedRevision: staleRun!.run.revision },
      testContext,
    );
    expect(stale.state).toBe("stale-basis");
    await expect(
      createOwnedRuntime().tcgplayerCsv.composeTcgplayerSyncRun(
        composeInput("run-terminal-recomposed", "connector", "connector-terminal"),
        testContext,
      ),
    ).resolves.toMatchObject({ run: { basisSnapshotGeneration: 2, state: "composed" } });
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
  externalKey: string | null;
  gradedCard: ReturnType<typeof gradedCard> | null;
}>;

function createOwnedRuntime(now?: string) {
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
      ...(now ? { clock: { now: () => new Date(now) } } : {}),
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
      transactionalEventStore: eventStore,
      outboundSync,
      listingComposition,
      providerRegistry: channelProviderRegistry,
      compositionProfiles,
    }),
  };
}

function composeInput(runId: string, claimantKind: "connector" | "manual", claimantId: string) {
  return {
    runId,
    connectionId: "connection-production",
    claimant: { claimantKind, claimantId },
    leaseMs: 60_000,
    manualClaimLeasePolicySnapshot: claimantKind === "manual" ? manualLeaseSnapshot(60_000) : null,
    resolvedPolicy: { maxRowsPerBatch: 500 },
    composedAt: "2026-09-09T03:00:00Z",
  } as const;
}

async function ingestStaged(
  services: ReturnType<typeof createOwnedRuntime>,
  snapshotId: string,
  rows: readonly (readonly string[])[],
  minute: number,
): Promise<void> {
  await expect(
    services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId,
      connectionId: "connection-production",
      surface: "staged",
      csv: stagedCsv(rows),
      limits: { maxRecords: rows.length },
      ingestedAt: `2026-09-09T05:${String(minute).padStart(2, "0")}:00Z`,
      capturedAt: `2026-09-09T05:${String(minute).padStart(2, "0")}:00Z`,
      capturedAtSource: "operator-declared",
    }),
  ).resolves.toMatchObject({ kind: "parsed", parsedRowCount: rows.length });
}

async function composeMixedMemberRun(
  services: ReturnType<typeof createOwnedRuntime>,
  runId: string,
  claimantId: string,
) {
  await seedProductionCompositionFacts([
    {
      listingId: "listing-mixed-composed",
      channelListingId: "channel-listing-mixed-composed",
      catalogItemId: "catalog-mixed-composed",
      externalKey: "product:90000701",
      gradedCard: null,
    },
    {
      listingId: "listing-mixed-refused",
      channelListingId: "channel-listing-mixed-refused",
      catalogItemId: "catalog-mixed-refused",
      externalKey: null,
      gradedCard: null,
    },
    {
      listingId: "listing-mixed-noop",
      channelListingId: "channel-listing-mixed-noop",
      catalogItemId: "catalog-mixed-noop",
      externalKey: "product:90000703",
      gradedCard: null,
    },
  ]);
  await ingestStaged(
    services,
    "snapshot-mixed-basis",
    [
      ["90000701", "Near Mint", "2", "0", "0.2600"],
      ["90000702", "Near Mint", "2", "0", "0.2600"],
      ["90000703", "Near Mint", "3", "0", "0.3000"],
    ],
    11,
  );
  await services.outboundSync.enqueueDesiredState(
    desiredState("listing-mixed-composed", "channel-listing-mixed-composed", 1, 1, 27, 1),
  );
  await services.outboundSync.enqueueDesiredState(
    desiredState("listing-mixed-refused", "channel-listing-mixed-refused", 1, 1, 27, 2),
  );
  await services.outboundSync.enqueueDesiredState(
    desiredState("listing-mixed-noop", "channel-listing-mixed-noop", 1, 3, 30, 3),
  );
  const composed = await services.tcgplayerCsv.composeTcgplayerSyncRun(
    composeInput(runId, "connector", claimantId),
    testContext,
  );
  if (!composed) throw new Error("The mixed member run was not composed.");
  expect(composed.composition.batch?.rows).toHaveLength(1);
  expect(composed.run.members.map((member) => member.memberKind).sort()).toEqual([
    "already-satisfied",
    "composed",
    "refused",
  ]);
  return composed;
}

async function expectMixedMemberDurableSettlement(run: ChannelSyncRun): Promise<void> {
  expect(run).toMatchObject({
    state: "application-unknown",
    membershipCompleteness: { kind: "complete", total: 3 },
  });
  expect(run.members.find((member) => member.memberKind === "already-satisfied")).toMatchObject({
    providerAction: "not-attempted-already-satisfied",
  });
  const outcomes = deriveClaimedOperationOutcomes(run);
  const outcomesByMemberKind = run.members
    .map((member) => {
      const outcome = outcomes.find((candidate) => candidate.operationId === member.operationId)?.outcome;
      if (!outcome) throw new Error(`Outcome for '${member.operationId}' was unavailable.`);
      return {
        memberKind: member.memberKind,
        outcomeKind: outcome.kind,
        rejectionCode: outcome.kind === "rejected" ? outcome.code : null,
      };
    })
    .sort((left, right) => left.memberKind.localeCompare(right.memberKind));
  expect(outcomesByMemberKind).toEqual([
    { memberKind: "already-satisfied", outcomeKind: "applied", rejectionCode: null },
    { memberKind: "composed", outcomeKind: "outcome-unknown", rejectionCode: null },
    { memberKind: "refused", outcomeKind: "rejected", rejectionCode: "validation" },
  ]);
  const receipt = await pools.channels.query<{ outcomes: unknown; run_settlement: unknown }>(
    `SELECT outcomes,run_settlement FROM channel_outbound_reservation_settlements WHERE reservation_id=$1`,
    [run.reservationId],
  );
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.rows[0]).toMatchObject({
    outcomes,
    run_settlement: {
      runId: run.runId,
      fromState: "awaiting-verification",
      toState: "application-unknown",
    },
  });
  expect(
    await pools.channels.query(
      `SELECT channel_listing_id,status,terminal_reason,last_rejection_code
       FROM channel_outbound_operations WHERE reservation_id=$1 ORDER BY channel_listing_id`,
      [run.reservationId],
    ),
  ).toMatchObject({
    rows: [
      {
        channel_listing_id: "channel-listing-mixed-composed",
        status: "failed",
        terminal_reason: "outcome-unknown",
        last_rejection_code: null,
      },
      {
        channel_listing_id: "channel-listing-mixed-noop",
        status: "succeeded",
        terminal_reason: null,
        last_rejection_code: null,
      },
      {
        channel_listing_id: "channel-listing-mixed-refused",
        status: "failed",
        terminal_reason: "validation",
        last_rejection_code: "validation",
      },
    ],
  });
}

async function installInitialCompositionFailure(phase: "event" | "projection"): Promise<void> {
  const target = phase === "event" ? "event_store_events" : "channel_sync_runs";
  const condition = phase === "event" ? "NEW.event_type = 'channels.tcgplayer-sync-run.composed'" : "TRUE";
  await pools.channels.query(`CREATE FUNCTION reject_initial_${phase}() RETURNS trigger AS $$
    BEGIN
      IF ${condition} THEN RAISE EXCEPTION 'injected composed ${phase} failure'; END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await pools.channels.query(`CREATE TRIGGER reject_initial_${phase}
    BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION reject_initial_${phase}()`);
}

async function removeInitialCompositionFailure(phase: "event" | "projection"): Promise<void> {
  const target = phase === "event" ? "event_store_events" : "channel_sync_runs";
  await pools.channels.query(`DROP TRIGGER reject_initial_${phase} ON ${target}`);
  await pools.channels.query(`DROP FUNCTION reject_initial_${phase}()`);
}

async function initialCompositionState(runId: string) {
  const result = await pools.channels.query<{
    events: string;
    runs: string;
    pending: string;
    in_flight: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM event_store_events WHERE stream_id=$1) AS events,
       (SELECT count(*)::text FROM channel_sync_runs WHERE run_id=$2) AS runs,
       (SELECT count(*)::text FROM channel_outbound_operations WHERE status='pending') AS pending,
       (SELECT count(*)::text FROM channel_outbound_operations WHERE status='in-flight') AS in_flight`,
    [`channels.tcgplayer-sync-run-${runId}`, runId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Initial composition state was unavailable.");
  return { events: row.events, runs: row.runs, pending: row.pending, inFlight: row.in_flight };
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
    if (listing.externalKey !== null) {
      await pools.channels.query(
        `INSERT INTO channels_external_catalog_item_reference_facts
         (provider_key,external_key,catalog_item_id,link_state,updated_at,reference_stream_version)
         VALUES ('tcgplayer',$1,$2,'linked','2026-09-09T00:00:00Z',1)`,
        [listing.externalKey, listing.catalogItemId],
      );
    }
  }
}

async function cloneConnection(connectionId: string): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_connections
     (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
     SELECT $1,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version
     FROM channel_connections WHERE connection_id='connection-production'`,
    [connectionId],
  );
  await pools.channels.query(
    `INSERT INTO channels_connection_facts
     (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     SELECT $1,account_id,provider_key,environment,status,updated_at,connection_stream_version
     FROM channels_connection_facts WHERE connection_id='connection-production'`,
    [connectionId],
  );
}

async function snapshotPersistenceCounts(connectionId: string) {
  const result = await pools.channels.query<{ pins: string; snapshots: string; rows: string }>(
    `SELECT
       (SELECT count(*)::text FROM channel_export_schema_pins WHERE connection_id=$1) AS pins,
       (SELECT count(*)::text FROM channel_inventory_snapshots WHERE connection_id=$1) AS snapshots,
       (SELECT count(*)::text FROM channel_inventory_snapshot_rows WHERE connection_id=$1) AS rows`,
    [connectionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Snapshot persistence counts were unavailable.");
  return row;
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
