import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition, type EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as channelsModule } from "../../../index";
import { createChannelListingCompositionRuntime } from "../../listing-composition/api/runtime";
import { createChannelCompositionProfileRegistry } from "../../listing-composition/domain/canonical";
import { assertChannelListingDelistDirective } from "../../listing-composition/domain/codecs";
import { buildChannelListingStateProjectionHandlers } from "../../listing-composition/read-model/state-projection";
import { syntheticProfile } from "../../listing-composition/tests/test-support";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type {
  ChannelProviderDescriptor,
  ChannelPublicationResult,
  DelistListingInput,
  PublishListingInput,
  UpdatePriceQuantityInput,
} from "../../publication-port/domain/contracts";
import { createOutboundSyncRuntime as createOwnedOutboundSyncRuntime } from "../api/runtime";
import { mapOutboundOperationRow, outboundOperationSqlColumns } from "../api/store";
import type {
  BoundClaimedReservationRun,
  ClaimedOperationOutcome,
  ClaimedReservationRunSettlementPort,
  OutboundSyncRuntimeDependencies,
} from "../domain/contracts";
import {
  buildChannelOutboundOperationReactionHandlers,
  createChannelListingPublicationOutcomeRecorder,
} from "../integrations/listing-composition";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;
const productionCompositionContext: EventStoreContext = {
  tenantId: "tnt_channels_production_composition" as never,
  audit: {
    performedByUserId: "usr_channels_production_composition" as never,
    forAccountId: "acc_owner" as never,
  },
};

const claimedRegistry = createChannelProviderRegistry([descriptor("synthetic-claimed", "claimed")]);
const readNoAdditionalOutboundHold: OutboundSyncRuntimeDependencies["readAdditionalOutboundHold"] = async () => ({
  held: false,
  sources: [],
});
const createOutboundSyncRuntime = (
  dependencies: Omit<OutboundSyncRuntimeDependencies, "readAdditionalOutboundHold"> &
    Partial<Pick<OutboundSyncRuntimeDependencies, "readAdditionalOutboundHold">>,
  options: Parameters<typeof createOwnedOutboundSyncRuntime>[1],
) =>
  createOwnedOutboundSyncRuntime(
    {
      ...dependencies,
      readAdditionalOutboundHold: dependencies.readAdditionalOutboundHold ?? readNoAdditionalOutboundHold,
    },
    options,
  );

describeDb(
  "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings",
  () => {
    beforeAll(async () => {
      const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "outbound_claimed_interleavings");
      await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
      pools = createMultiContextTestPools(urls);
    });

    beforeEach(async () => {
      await resetMultiContextTestSchemas(pools);
      await bootstrapContextDatabase(channelsModule, pools.channels);
      await createBoundRunFixtureTable(pools.channels);
      await insertConnection(pools.channels, "connection-a", "synthetic-claimed");
    });

    afterAll(async () => closeMultiContextTestPools(pools));

    it("outbound-per-listing-ordering / outbound-claimed-lane-parking preserves fences without a budget", async () => {
      let current = new Date("2026-09-07T19:00:00.000Z");
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          resolveBudgetPolicy: async () => {
            throw new Error("claimed paths must not resolve an inline provider budget");
          },
          recordOutcome: async () => "applied",
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-a", 1, 7, "event-q1"));
      await runtime.enqueueDesiredState(desiredState("listing-a", 2, 7, "event-q2"));
      await runtime.enqueueDesiredState(desiredState("listing-a", 1, 99, "event-old"));

      const beforeClaim = await rows(pools.channels, "listing-a");
      expect(beforeClaim).toHaveLength(1);
      expect(beforeClaim[0]).toMatchObject({
        source_desired_state_sequence: "2",
        listing_revision: "7",
        status: "pending",
      });

      const reservation = await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant: { claimantKind: "connector", claimantId: "connector-a" },
        maxOperations: 10,
        leaseMs: 60_000,
      });
      expect(reservation?.operations).toHaveLength(1);
      expect(reservation?.operations[0]).toMatchObject({ desiredStateSequence: 2, listingRevision: 7 });
      const q2Digest = reservation!.operations[0]!.payloadDigest;
      const q2Attempt = reservation!.operations[0]!.attemptId;

      current = new Date("2026-09-07T19:01:00.001Z");
      expect(await runtime.recoverExpiredClaimedOperations()).toBe(1);
      const recovered = await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant: { claimantKind: "connector", claimantId: "connector-a" },
        maxOperations: 10,
        leaseMs: 60_000,
      });
      const recoveredQ2 = recovered!.operations.find((operation) => operation.desiredStateSequence === 2)!;
      expect(recoveredQ2.operationId).toBe(reservation!.operations[0]!.operationId);
      expect(recoveredQ2.attemptId).not.toBe(q2Attempt);
      expect(recoveredQ2.claimGeneration).toBe(reservation!.operations[0]!.claimGeneration + 1);

      await runtime.enqueueDesiredState(desiredState("listing-a", 3, 7, "event-q3"));
      const inFlightAndPending = await rows(pools.channels, "listing-a");
      expect(inFlightAndPending).toHaveLength(2);
      expect(inFlightAndPending.find((row) => row.status === "in-flight")).toMatchObject({
        source_desired_state_sequence: "2",
        payload_digest: q2Digest,
        attempt_id: recoveredQ2.attemptId,
      });
      expect(inFlightAndPending.find((row) => row.status === "pending")).toMatchObject({
        source_desired_state_sequence: "3",
        listing_revision: "7",
      });
      await runtime.reportClaimedOperationOutcomes({
        reservationId: recovered!.reservationId,
        claimant: { claimantKind: "connector", claimantId: "connector-a" },
        outcomes: [memberOutcome(recoveredQ2, { kind: "abandoned", reason: "superseded-basis" })],
      });
      const next = await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant: { claimantKind: "connector", claimantId: "connector-a" },
        maxOperations: 10,
        leaseMs: 60_000,
      });
      expect(next!.operations.map((operation) => operation.desiredStateSequence)).toEqual([3]);
    });

    it("serializes concurrent same-lane desires and leaves the highest producer sequence", async () => {
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      const [lower, higher] = await Promise.all([
        runtime.enqueueDesiredState(desiredState("listing-race", 1, 7, "event-race-q1")),
        runtime.enqueueDesiredState(desiredState("listing-race", 2, 7, "event-race-q2")),
      ]);
      expect([lower, higher].filter(Boolean)).not.toHaveLength(0);
      const finalRows = await rows(pools.channels, "listing-race");
      expect(finalRows).toHaveLength(1);
      expect(finalRows[0]).toMatchObject({
        source_desired_state_sequence: "2",
        listing_revision: "7",
        status: "pending",
      });

      const beforeReplay = JSON.stringify(finalRows);
      expect(await runtime.enqueueDesiredState(desiredState("listing-race", 2, 7, "event-race-q2"))).toBeNull();
      expect(JSON.stringify(await rows(pools.channels, "listing-race"))).toBe(beforeReplay);
    });

    it("outbound-coalescing-latest-state-wins replaces a queued update with a higher-sequence delist", async () => {
      const runtime = createOutboundSyncRuntime({ db: pools.channels }, { assertDelistDirective: () => undefined });
      await runtime.enqueueDesiredState(desiredState("listing-delist", 1, 7, "event-update"));
      await runtime.enqueueDesiredState(desiredDelistState("listing-delist", 2, 7, "event-delist"));
      const snapshot = await pools.channels.query<{
        operation_kind: string;
        listing_revision: string;
        source_desired_state_sequence: string;
        payload: unknown;
      }>(
        `SELECT operation_kind, listing_revision::text, source_desired_state_sequence::text, payload
       FROM channel_outbound_operations WHERE listing_id = 'listing-delist'`,
      );
      expect(snapshot.rows).toEqual([
        {
          operation_kind: "delist",
          listing_revision: "7",
          source_desired_state_sequence: "2",
          payload: {
            kind: "delist",
            delist: {
              channelListingId: "channel-listing-delist",
              listingRevision: 7,
              lastPublishedPrice: { amountMinor: 1_000, currency: "USD" },
              lastPublishedQuantity: 1,
              delistReasons: ["listing-not-active"],
            },
          },
        },
      ]);
    });

    it("orders equal-time desired work before its deterministic repair on claimed and inline paths", async () => {
      const fixedClock = { now: () => new Date("2026-09-12T12:00:00.000Z") };
      const claimedRuntime = createOutboundSyncRuntime(
        { db: pools.channels, clock: fixedClock, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      const claimedDesired = desiredState("listing-tie-claimed", 1, 7, "event-tie-1");
      const claimedDesiredOperation = await claimedRuntime.enqueueDesiredState(claimedDesired);
      const claimedRepair = await claimedRuntime.enqueueReconciliationRepair({
        ...claimedDesired,
        reconciliationRepairId: "repair-tie-1",
      });
      expect(claimedDesiredOperation!.enqueuedAt).toBe(claimedRepair!.enqueuedAt);
      expect(claimedDesiredOperation!.operationId > claimedRepair!.operationId).toBe(true);
      await expect(
        claimedRuntime.enqueueReconciliationRepair({
          ...claimedDesired,
          reconciliationRepairId: "repair-tie-1",
        }),
      ).resolves.toMatchObject({ operationId: claimedRepair!.operationId });

      const firstClaimed = await claimedRuntime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant: { claimantKind: "connector", claimantId: "tie-claimed-1" },
        maxOperations: 1,
        leaseMs: 60_000,
      });
      expect(firstClaimed!.operations.map((operation) => operation.operationId)).toEqual([
        claimedDesiredOperation!.operationId,
      ]);
      await claimedRuntime.reportClaimedOperationOutcomes({
        reservationId: firstClaimed!.reservationId,
        claimant: firstClaimed!.claimant,
        outcomes: [
          memberOutcome(firstClaimed!.operations[0]!, {
            kind: "applied",
            result: {
              kind: "succeeded",
              externalListingId: "claimed-tie-listing",
              providerRevision: "claimed-tie-r1",
            },
          }),
        ],
      });
      const secondClaimed = await claimedRuntime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant: { claimantKind: "connector", claimantId: "tie-claimed-2" },
        maxOperations: 1,
        leaseMs: 60_000,
      });
      expect(secondClaimed!.operations.map((operation) => operation.operationId)).toEqual([claimedRepair!.operationId]);

      const repushBasis = desiredState("listing-tie-repush", 1, 7, "unused-repush-event");
      const equalTimeRepush = await claimedRuntime.enqueueRepush({
        ...repushBasis,
        repushOperationId: "repush-tie-1",
      });
      const repushRepair = await claimedRuntime.enqueueReconciliationRepair({
        ...repushBasis,
        reconciliationRepairId: "repair-tie-2",
      });
      expect(equalTimeRepush!.enqueuedAt).toBe(repushRepair!.enqueuedAt);
      expect(equalTimeRepush!.operationId > repushRepair!.operationId).toBe(true);
      const claimedRepush = await claimedRuntime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant: { claimantKind: "connector", claimantId: "tie-repush-1" },
        maxOperations: 1,
        leaseMs: 60_000,
      });
      expect(claimedRepush!.operations.map((operation) => operation.operationId)).toEqual([
        equalTimeRepush!.operationId,
      ]);

      await insertConnection(pools.channels, "connection-inline", "synthetic-inline");
      const inlineCalls: string[] = [];
      const inlineRuntime = createOutboundSyncRuntime(
        { db: pools.channels, clock: fixedClock, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      const inlineDesired = desiredState("listing-tie-inline", 1, 7, "event-tie-inline-1", "connection-inline");
      const inlineDesiredOperation = await inlineRuntime.enqueueDesiredState(inlineDesired);
      const inlineRepair = await inlineRuntime.enqueueReconciliationRepair({
        ...inlineDesired,
        reconciliationRepairId: "repair-tie-2",
      });
      expect(inlineDesiredOperation!.enqueuedAt).toBe(inlineRepair!.enqueuedAt);
      expect(inlineDesiredOperation!.operationId > inlineRepair!.operationId).toBe(true);
      await expect(
        inlineRuntime.enqueueReconciliationRepair({
          ...inlineDesired,
          reconciliationRepairId: "repair-tie-2",
        }),
      ).resolves.toMatchObject({ operationId: inlineRepair!.operationId });
      const registry = createChannelProviderRegistry([
        recordingInlineDescriptor("synthetic-inline", async (operationId) => {
          inlineCalls.push(operationId);
          return {
            kind: "succeeded",
            externalListingId: "inline-tie-listing",
            providerRevision: `inline-tie-r${inlineCalls.length}`,
          };
        }),
      ]);
      await expect(inlineRuntime.processNextInlineOperation({ registry, claimOwnerId: "tie-inline-1" })).resolves.toBe(
        1,
      );
      await expect(inlineRuntime.processNextInlineOperation({ registry, claimOwnerId: "tie-inline-2" })).resolves.toBe(
        1,
      );
      expect(inlineCalls).toEqual([inlineDesiredOperation!.operationId, inlineRepair!.operationId]);

      const repairRows = await pools.channels.query<{ operation_id: string; row_count: number }>(
        `SELECT operation_id,COUNT(*) OVER ()::integer AS row_count
         FROM channel_outbound_operations
         WHERE operation_id=ANY($1::text[])
         ORDER BY operation_id`,
        [[claimedRepair!.operationId, inlineRepair!.operationId]],
      );
      expect(repairRows.rows).toEqual([
        expect.objectContaining({ row_count: 2 }),
        expect.objectContaining({ row_count: 2 }),
      ]);
    });

    it.each(["claimed", "inline"] as const)(
      "supersedes an obsolete pending repush before the newer desired state reaches the %s claim path",
      async (execution) => {
        const providerKey = execution === "claimed" ? "synthetic-claimed" : "synthetic-inline";
        if (execution === "inline") {
          await pools.channels.query(
            `UPDATE channel_connections SET provider_key=$2
             WHERE connection_id=$1 AND provider_key='synthetic-claimed'`,
            ["connection-a", providerKey],
          );
        }
        const providerCalls: string[] = [];
        const runtime = createOutboundSyncRuntime(
          {
            db: pools.channels,
            clock: { now: () => new Date("2026-09-12T12:30:00.000Z") },
            recordOutcome: async () => "applied",
          },
          { assertDelistDirective: () => undefined },
        );
        const desiredOne = desiredState("listing-repush-supersession", 1, 7, "event-desired-1");
        const terminalDesired = await runtime.enqueueDesiredState(desiredOne);
        await pools.channels.query(
          `UPDATE channel_outbound_operations SET status='succeeded',terminal_at=$2
           WHERE operation_id=$1 AND status='pending'`,
          [terminalDesired!.operationId, "2026-09-12T12:30:00.000Z"],
        );
        const repush = await runtime.enqueueRepush({ ...desiredOne, repushOperationId: "repush-1" });
        const repairInput = { ...desiredOne, reconciliationRepairId: "supersession-repair-1" };
        const repair = await runtime.enqueueReconciliationRepair(repairInput);
        await expect(runtime.enqueueReconciliationRepair(repairInput)).resolves.toMatchObject({
          operationId: repair!.operationId,
        });
        await expect(
          runtime.enqueueReconciliationRepair({ ...repairInput, desiredStateHash: "f".repeat(64) }),
        ).rejects.toMatchObject({ code: "stale-fence" });
        const desiredTwo = desiredState("listing-repush-supersession", 2, 8, "event-desired-2");
        const latestDesired = await runtime.enqueueDesiredState(desiredTwo);
        await expect(runtime.enqueueDesiredState(desiredTwo)).resolves.toBeNull();
        await expect(runtime.enqueueDesiredState(desiredOne)).resolves.toBeNull();
        await expect(runtime.enqueueReconciliationRepair(repairInput)).resolves.toBeNull();
        await expect(
          runtime.enqueueReconciliationRepair({ ...repairInput, reconciliationRepairId: "stale-new-repair" }),
        ).rejects.toMatchObject({ code: "stale-fence" });
        await expect(runtime.enqueueRepush({ ...desiredOne, repushOperationId: "repush-1" })).resolves.toMatchObject({
          operationId: repush!.operationId,
          status: "failed",
          terminalReason: "superseded-by-newer-desired-state",
        });

        const operationRows = await pools.channels.query<{
          operation_id: string;
          operation_origin: string;
          source_desired_state_sequence: string;
          status: string;
          terminal_reason: string | null;
        }>(
          `SELECT operation_id,operation_origin,source_desired_state_sequence::text,status,terminal_reason
           FROM channel_outbound_operations
           WHERE channel_listing_id=$1
           ORDER BY source_desired_state_sequence,operation_origin`,
          [desiredOne.channelListingId],
        );
        expect(operationRows.rows.filter((row) => row.status === "pending")).toEqual([
          expect.objectContaining({
            operation_id: latestDesired!.operationId,
            operation_origin: "desired-state",
            source_desired_state_sequence: "2",
          }),
        ]);
        expect(operationRows.rows.find((row) => row.operation_id === repush!.operationId)).toMatchObject({
          status: "failed",
          terminal_reason: "superseded-by-newer-desired-state",
        });
        expect(operationRows.rows.find((row) => row.operation_id === repair!.operationId)).toMatchObject({
          status: "failed",
          terminal_reason: "superseded-by-newer-desired-state",
        });

        if (execution === "claimed") {
          const reservation = await runtime.reserveClaimedOutboundOperations({
            registry: claimedRegistry,
            connectionId: "connection-a",
            claimant: { claimantKind: "connector", claimantId: "repush-supersession" },
            maxOperations: 10,
            leaseMs: 60_000,
          });
          expect(reservation!.operations.map((operation) => operation.operationId)).toEqual([
            latestDesired!.operationId,
          ]);
        } else {
          const registry = createChannelProviderRegistry([
            recordingInlineDescriptor(providerKey, async (operationId) => {
              providerCalls.push(operationId);
              return {
                kind: "succeeded",
                externalListingId: "inline-repush-supersession",
                providerRevision: "inline-repush-supersession-r1",
              };
            }),
          ]);
          await expect(
            runtime.processNextInlineOperation({ registry, claimOwnerId: "repush-supersession" }),
          ).resolves.toBe(1);
          expect(providerCalls).toEqual([latestDesired!.operationId]);
        }
      },
    );

    it("reads only the exact connection-owned operation IDs in one closed bounded batch", async () => {
      const runtime = createOutboundSyncRuntime({ db: pools.channels }, { assertDelistDirective: () => undefined });
      const first = await runtime.enqueueReconciliationRepair({
        ...desiredState("listing-batch-a", 1, 7, "event-batch-a"),
        reconciliationRepairId: "repair-batch-a",
      });
      const second = await runtime.enqueueReconciliationRepair({
        ...desiredState("listing-batch-b", 1, 7, "event-batch-b"),
        reconciliationRepairId: "repair-batch-b",
      });
      const query = vi.spyOn(pools.channels, "query");
      try {
        const result = await runtime.readOutboundOperationsByIds({
          connectionId: "connection-a",
          operationIds: [second!.operationId, first!.operationId],
        });
        expect(result.map((row) => row.operationId)).toEqual([first!.operationId, second!.operationId].sort());
        expect(query).toHaveBeenCalledTimes(1);
        await expect(
          runtime.readOutboundOperationsByIds({ connectionId: "synthetic-other", operationIds: [first!.operationId] }),
        ).resolves.toEqual([]);
        query.mockClear();
        for (const input of [
          { connectionId: "connection-a", operationIds: [first!.operationId], extra: true },
          { connectionId: "connection-a", operationIds: [first!.operationId, first!.operationId] },
          { connectionId: "connection-a", operationIds: ["invalid-operation-id"] },
          { connectionId: "connection-a", operationIds: Array<string>(100_001).fill(first!.operationId) },
          { connectionId: "", operationIds: [first!.operationId] },
        ]) {
          await expect(runtime.readOutboundOperationsByIds(input)).rejects.toMatchObject({ code: "invalid-input" });
        }
        await expect(
          runtime.readOutboundOperationsByIds({ connectionId: "connection-a", operationIds: [] }),
        ).resolves.toEqual([]);
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    });

    it("rolls back obsolete-operation supersession when a candidate revision changes before write-back", async () => {
      const runtime = createOutboundSyncRuntime({ db: pools.channels }, { assertDelistDirective: () => undefined });
      const basis = desiredState("listing-supersession-fence", 1, 7, "event-fence-1");
      const repush = await runtime.enqueueRepush({ ...basis, repushOperationId: "fenced-repush" });
      let injected = false;
      const interleavingPool: PgTransactionalPool = {
        query: pools.channels.query.bind(pools.channels),
        connect: async () => {
          const client = await pools.channels.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              if (sql.includes("terminal_reason='superseded-by-newer-desired-state'")) {
                const newer = await client.query(
                  `UPDATE channel_outbound_operations SET revision=revision+1
                   WHERE operation_id=$1 AND revision=1 AND status='pending'`,
                  [repush!.operationId],
                );
                expect(newer.rowCount).toBe(1);
                injected = true;
              }
              return client.query<Row>(sql, values);
            },
          };
        },
      };
      const racingRuntime = createOutboundSyncRuntime(
        { db: interleavingPool },
        { assertDelistDirective: () => undefined },
      );
      await expect(
        racingRuntime.enqueueDesiredState(desiredState("listing-supersession-fence", 2, 8, "event-fence-2")),
      ).rejects.toMatchObject({ code: "stale-fence" });
      expect(injected).toBe(true);
      await expect(
        pools.channels.query(
          `SELECT operation_id,status,revision::text,terminal_reason FROM channel_outbound_operations`,
        ),
      ).resolves.toMatchObject({
        rows: [{ operation_id: repush!.operationId, status: "pending", revision: "1", terminal_reason: null }],
      });
    });

    it("outbound-stale-success-sequence-adoption", async () => {
      expect(
        await pools.channels.query(
          `UPDATE channel_connections
           SET account_id='acc_owner', provider_key='synthetic-provider'
           WHERE connection_id='connection-a' AND account_id='acc-owner'
             AND provider_key='synthetic-claimed' AND environment='sandbox' AND status='active'`,
        ),
      ).toMatchObject({ rowCount: 1 });
      await seedProductionCompositionFacts(pools.channels);

      const eventStore = createPostgresEventStore({ pool: pools.channels });
      const listingComposition = createChannelListingCompositionRuntime({
        db: pools.channels,
        eventStore,
        transactionalEventStore: eventStore,
        profiles: createChannelCompositionProfileRegistry([syntheticProfile]),
      });
      const recordOutcome = createChannelListingPublicationOutcomeRecorder(listingComposition);
      const outbound = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome },
        { assertDelistDirective: assertChannelListingDelistDirective },
      );
      const reaction = buildChannelOutboundOperationReactionHandlers(outbound);

      let markPublishEntered!: () => void;
      let releasePublish!: () => void;
      const publishEntered = new Promise<void>((resolve) => {
        markPublishEntered = resolve;
      });
      const publishRelease = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      const providerCalls: Array<Readonly<{ kind: "publish" | "update" | "delist"; operationId: string }>> = [];
      const registry = createChannelProviderRegistry([
        {
          ...descriptorWithoutPublication("synthetic-provider"),
          publication: {
            execution: "inline",
            publishListing: async (input) => {
              providerCalls.push({ kind: "publish", operationId: input.operationId });
              markPublishEntered();
              await publishRelease;
              return {
                kind: "succeeded",
                externalListingId: "synthetic-external-listing",
                externalOfferId: "synthetic-external-offer",
                providerRevision: "synthetic-provider-r1",
              };
            },
            updatePriceQuantity: async (input) => {
              providerCalls.push({ kind: "update", operationId: input.operationId });
              return {
                kind: "succeeded",
                externalListingId: "synthetic-external-listing",
                externalOfferId: "synthetic-external-offer",
                providerRevision: "synthetic-provider-r2",
              };
            },
            delistListing: async (input) => {
              providerCalls.push({ kind: "delist", operationId: input.operationId });
              return {
                kind: "succeeded",
                externalListingId: "synthetic-external-listing",
                externalOfferId: "synthetic-external-offer",
                providerRevision: "synthetic-provider-r3",
              };
            },
            fetchChannelState: async () => ({
              kind: "complete",
              items: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
            fetchSales: async () => ({
              kind: "complete",
              lines: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
          },
        },
      ]);

      const source = { connectionId: "connection-a", listingId: "listing-production-composed" };
      const q1 = await listingComposition.recordChannelListingDesiredState(source, productionCompositionContext);
      expect(q1).toMatchObject({ kind: "applied", streamVersion: 1 });
      if (q1.kind === "refused") throw new Error("Expected Q1 desired state.");
      const streamId = `channels.channel-listing-${q1.value.channelListingId}`;
      const q1Event = await desiredStateEvent(pools.channels, streamId, 1);
      await dispatchDesiredState(reaction, q1Event);

      const q1Execution = outbound.processNextInlineOperation({ registry, claimOwnerId: "synthetic-worker-q1" });
      await publishEntered;
      const q1Operation = await outboundOperation(pools.channels, q1Event.event_id);
      expect(q1Operation).toMatchObject({
        operationKind: "publish",
        listingRevision: 7,
        sourceDesiredStateSequence: 1,
        sourceDesiredStateHash: q1Event.payload.desiredStateHash,
        sourceStreamVersion: 1,
        sourceEventId: q1Event.event_id,
        sourceStreamId: streamId,
      });
      expect(q1Operation.operationId).not.toBe(q1Operation.sourceEventId);
      expect(q1Operation.payloadDigest).not.toBe(q1Operation.sourceDesiredStateHash);

      expect(
        await pools.channels.query(
          `UPDATE channels_inventory_item_facts SET total_quantity=2, item_stream_version=2
           WHERE item_id='item-production-composed' AND account_id='acc_owner'
             AND catalog_item_id='catalog-production-composed' AND total_quantity=3 AND item_stream_version=1`,
        ),
      ).toMatchObject({ rowCount: 1 });
      const q2 = await listingComposition.recordChannelListingDesiredState(source, productionCompositionContext);
      expect(q2).toMatchObject({ kind: "applied", streamVersion: 2 });
      const q2Event = await desiredStateEvent(pools.channels, streamId, 2);
      expect(q2Event.payload).toMatchObject({
        intent: "publish",
        listingRevision: 7,
        desiredStateSequence: 2,
        draft: { quantity: 2 },
      });
      expect(q2Event.payload.desiredStateHash).not.toBe(q1Event.payload.desiredStateHash);
      await dispatchDesiredState(reaction, q2Event);
      const q2Operation = await outboundOperation(pools.channels, q2Event.event_id);
      expect(q2Operation).toMatchObject({
        operationKind: "publish",
        listingRevision: 7,
        sourceDesiredStateSequence: 2,
        sourceDesiredStateHash: q2Event.payload.desiredStateHash,
        sourceStreamVersion: 2,
        status: "pending",
      });
      expect(q2Operation.operationId).not.toBe(q1Operation.operationId);
      expect(q2Operation.payloadDigest).not.toBe(q2Operation.sourceDesiredStateHash);

      releasePublish();
      await expect(q1Execution).resolves.toBe(1);
      const q1Terminal = await outboundOperation(pools.channels, q1Event.event_id);
      expect(q1Terminal).toMatchObject({
        operationId: q1Operation.operationId,
        payloadDigest: q1Operation.payloadDigest,
        status: "succeeded",
        linkWriteState: "applied",
        sourceDesiredStateSequence: 1,
        listingRevision: 7,
        sourceDesiredStateHash: q1Event.payload.desiredStateHash,
        sourceStreamVersion: 1,
      });
      expect(await laneBlockState(pools.channels, q1.value.channelListingId)).toEqual({ blocked_operation_id: null });

      const afterQ1 = await producerEvents(pools.channels, streamId);
      expect(afterQ1.map((row) => [row.stream_version, row.event_type])).toEqual([
        [1, "channels.channel-listing.desired-state-changed"],
        [2, "channels.channel-listing.desired-state-changed"],
        [3, "channels.channel-listing.publication-recorded"],
        [4, "channels.channel-listing.desired-state-changed"],
      ]);
      expect(afterQ1[2]!.payload).toMatchObject({
        operationId: q1Operation.operationId,
        reportedDesiredStateSequence: 1,
        reportedListingRevision: 7,
        reportedDesiredStateHash: q1Event.payload.desiredStateHash,
        adoption: "identity-adopted",
        outcome: { kind: "succeeded", externalListingId: "synthetic-external-listing" },
      });
      expect(afterQ1[3]!.payload).toMatchObject({
        intent: "update",
        desiredStateSequence: 4,
        listingRevision: 7,
        draft: { quantity: 2 },
      });

      await projectProducerEvents(pools.channels, afterQ1);
      expect(await linkProjection(pools.channels, q1.value.channelListingId)).toMatchObject({
        last_desired_state_sequence: "4",
        last_desired_listing_revision: "7",
        last_desired_state_hash: afterQ1[3]!.payload.desiredStateHash,
        last_desired_intent: "update",
        last_pushed_listing_revision: null,
        last_pushed_quantity: null,
        external_listing_id: "synthetic-external-listing",
        publish_state: "pending",
      });

      const successorEvent = await desiredStateEvent(pools.channels, streamId, 4);
      await dispatchDesiredState(reaction, successorEvent);
      const successor = await outboundOperation(pools.channels, successorEvent.event_id);
      expect(successor).toMatchObject({
        operationKind: "update",
        sourceDesiredStateSequence: 4,
        listingRevision: 7,
        sourceDesiredStateHash: successorEvent.payload.desiredStateHash,
        sourceStreamVersion: 4,
        status: "pending",
      });
      expect(successor.operationId).not.toBe(q2Operation.operationId);
      expect(successor.payloadDigest).toBe(q2Operation.payloadDigest);
      expect(successor.sourceDesiredStateHash).not.toBe(q2Operation.sourceDesiredStateHash);
      expect(successor.payloadDigest).not.toBe(successor.sourceDesiredStateHash);
      await expect(
        outbound.processNextInlineOperation({ registry, claimOwnerId: "synthetic-worker-successor" }),
      ).resolves.toBe(1);
      expect(providerCalls.map((call) => call.kind)).toEqual(["publish", "update"]);
      expect(new Set(providerCalls.map((call) => call.operationId)).size).toBe(2);
      expect(await outboundOperation(pools.channels, successorEvent.event_id)).toMatchObject({
        operationId: successor.operationId,
        payloadDigest: successor.payloadDigest,
        status: "succeeded",
        linkWriteState: "applied",
        sourceDesiredStateSequence: 4,
        listingRevision: 7,
        sourceDesiredStateHash: successorEvent.payload.desiredStateHash,
        sourceStreamVersion: 4,
      });
      expect(await laneBlockState(pools.channels, q1.value.channelListingId)).toEqual({ blocked_operation_id: null });

      const finalEvents = await producerEvents(pools.channels, streamId);
      expect(finalEvents.map((row) => [row.stream_version, row.event_type])).toEqual([
        [1, "channels.channel-listing.desired-state-changed"],
        [2, "channels.channel-listing.desired-state-changed"],
        [3, "channels.channel-listing.publication-recorded"],
        [4, "channels.channel-listing.desired-state-changed"],
        [5, "channels.channel-listing.publication-recorded"],
      ]);
      expect(finalEvents[4]!.payload).toMatchObject({
        operationId: successor.operationId,
        reportedDesiredStateSequence: 4,
        reportedListingRevision: 7,
        reportedDesiredStateHash: successorEvent.payload.desiredStateHash,
        adoption: "identity-and-state-applied",
      });
      await projectProducerEvents(pools.channels, finalEvents);
      expect(await linkProjection(pools.channels, q1.value.channelListingId)).toMatchObject({
        last_desired_state_sequence: "4",
        last_desired_listing_revision: "7",
        last_desired_state_hash: successorEvent.payload.desiredStateHash,
        last_desired_intent: "update",
        last_pushed_listing_revision: "7",
        last_pushed_price_amount_minor: "2000",
        last_pushed_price_currency: "USD",
        last_pushed_quantity: 2,
        external_listing_id: "synthetic-external-listing",
        publish_state: "published",
      });

      await insertConnection(pools.channels, "connection-account-mismatch", "synthetic-provider");
      const producerOutcome = vi.spyOn(listingComposition, "recordChannelListingPublicationOutcome");
      const negativeRecorder = createChannelListingPublicationOutcomeRecorder(listingComposition);
      const publicationCountBefore = await publicationRecordedCount(pools.channels, streamId);
      await expect(
        negativeRecorder(
          pools.channels,
          { ...q1Terminal, operationId: "synthetic-missing-source", sourceEventId: "synthetic-event-missing" },
          { kind: "succeeded", externalListingId: "synthetic-missing-source-result" },
        ),
      ).resolves.toBe("link-write-refused");
      await expect(
        negativeRecorder(
          pools.channels,
          { ...q1Terminal, operationId: "synthetic-account-mismatch", connectionId: "connection-account-mismatch" },
          { kind: "succeeded", externalListingId: "synthetic-account-mismatch-result" },
        ),
      ).resolves.toBe("link-write-refused");
      expect(producerOutcome).not.toHaveBeenCalled();
      expect(await publicationRecordedCount(pools.channels, streamId)).toBe(publicationCountBefore);
      expect(
        await pools.channels.query(
          `SELECT source.tenant_id AS source_tenant_id,
                  source.performed_by_user_id AS source_user_id,
                  source.for_account_id AS source_account_id,
                  connection.account_id AS connection_account_id
           FROM event_store_events AS source
           CROSS JOIN channel_connections AS connection
           WHERE source.event_id=$1 AND connection.connection_id='connection-account-mismatch'`,
          [q1Event.event_id],
        ),
      ).toMatchObject({
        rows: [
          {
            source_tenant_id: "tnt_channels_production_composition",
            source_user_id: "usr_channels_production_composition",
            source_account_id: "acc_owner",
            connection_account_id: "acc-owner",
          },
        ],
      });
    });

    it("rolls back publication recomposition when the outer outbound settlement fails", async () => {
      expect(
        await pools.channels.query(
          `UPDATE channel_connections
           SET account_id='acc_owner', provider_key='synthetic-provider'
           WHERE connection_id='connection-a' AND account_id='acc-owner'
             AND provider_key='synthetic-claimed' AND environment='sandbox' AND status='active'`,
        ),
      ).toMatchObject({ rowCount: 1 });
      await seedProductionCompositionFacts(pools.channels);

      const eventStore = createPostgresEventStore({ pool: pools.channels });
      const listingComposition = createChannelListingCompositionRuntime({
        db: pools.channels,
        eventStore,
        transactionalEventStore: eventStore,
        profiles: createChannelCompositionProfileRegistry([syntheticProfile]),
      });
      const recordOutcome = createChannelListingPublicationOutcomeRecorder(listingComposition);
      const outbound = createOutboundSyncRuntime(
        {
          db: pools.channels,
          recordOutcome: async (db, operation, outcome) => {
            await recordOutcome(db, operation, outcome);
            throw new Error("synthetic outer outbound settlement failure");
          },
        },
        { assertDelistDirective: assertChannelListingDelistDirective },
      );
      const reaction = buildChannelOutboundOperationReactionHandlers(outbound);

      let markPublishEntered!: () => void;
      let releasePublish!: () => void;
      const publishEntered = new Promise<void>((resolve) => {
        markPublishEntered = resolve;
      });
      const publishRelease = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      const providerCalls: string[] = [];
      const registry = createChannelProviderRegistry([
        {
          ...descriptorWithoutPublication("synthetic-provider"),
          publication: {
            execution: "inline",
            publishListing: async (input) => {
              providerCalls.push(input.operationId);
              markPublishEntered();
              await publishRelease;
              return { kind: "succeeded", externalListingId: "synthetic-rollback-external-listing" };
            },
            updatePriceQuantity: async () => {
              throw new Error("rollback control must not update");
            },
            delistListing: async () => {
              throw new Error("rollback control must not delist");
            },
            fetchChannelState: async () => ({
              kind: "complete",
              items: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
            fetchSales: async () => ({
              kind: "complete",
              lines: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
          },
        },
      ]);

      const source = { connectionId: "connection-a", listingId: "listing-production-composed" };
      const q1 = await listingComposition.recordChannelListingDesiredState(source, productionCompositionContext);
      expect(q1).toMatchObject({ kind: "applied", streamVersion: 1 });
      if (q1.kind === "refused") throw new Error("Expected rollback-control Q1 desired state.");
      const streamId = `channels.channel-listing-${q1.value.channelListingId}`;
      const q1Event = await desiredStateEvent(pools.channels, streamId, 1);
      await dispatchDesiredState(reaction, q1Event);

      const q1Execution = outbound.processNextInlineOperation({ registry, claimOwnerId: "synthetic-rollback-worker" });
      await publishEntered;
      const q1Operation = await outboundOperation(pools.channels, q1Event.event_id);

      expect(
        await pools.channels.query(
          `UPDATE channels_inventory_item_facts SET total_quantity=2, item_stream_version=2
           WHERE item_id='item-production-composed' AND account_id='acc_owner'
             AND catalog_item_id='catalog-production-composed' AND total_quantity=3 AND item_stream_version=1`,
        ),
      ).toMatchObject({ rowCount: 1 });
      const q2 = await listingComposition.recordChannelListingDesiredState(source, productionCompositionContext);
      expect(q2).toMatchObject({ kind: "applied", streamVersion: 2 });
      const q2Event = await desiredStateEvent(pools.channels, streamId, 2);
      await dispatchDesiredState(reaction, q2Event);

      releasePublish();
      await expect(q1Execution).rejects.toThrow("synthetic outer outbound settlement failure");
      expect(providerCalls).toEqual([q1Operation.operationId]);
      expect(
        (await producerEvents(pools.channels, streamId)).map((row) => [row.stream_version, row.event_type]),
      ).toEqual([
        [1, "channels.channel-listing.desired-state-changed"],
        [2, "channels.channel-listing.desired-state-changed"],
      ]);
      expect(
        await pools.channels.query(
          "SELECT operation_id FROM channels_channel_publication_operations WHERE operation_id=$1",
          [q1Operation.operationId],
        ),
      ).toMatchObject({ rows: [] });
      expect(await outboundOperation(pools.channels, q1Event.event_id)).toMatchObject({
        operationId: q1Operation.operationId,
        status: "in-flight",
        linkWriteState: "pending",
      });
      expect(await outboundOperation(pools.channels, q2Event.event_id)).toMatchObject({
        status: "pending",
        sourceDesiredStateSequence: 2,
      });
      expect(await laneBlockState(pools.channels, q1.value.channelListingId)).toEqual({ blocked_operation_id: null });
    });

    it("outbound-coalescing-latest-state-wins gives a pending replacement its own full retry budget", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      let current = new Date("2026-09-07T19:00:00.000Z");
      let providerCalls = 0;
      let providerResult: ChannelPublicationResult = { kind: "rejected", code: "rate-limited" };
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-inline", async () => {
          providerCalls += 1;
          return providerResult;
        }),
      ]);
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          resolveBudgetPolicy: async () => ({
            incidentMultiplier: 1,
            providers: {
              "synthetic-inline:sandbox": {
                maxRequestsPerWindow: 6_400,
                maxAttempts: 5,
                baseBackoffMs: 1_000,
                maxBackoffMs: 10_000,
              },
            },
          }),
          recordOutcome: async () => "applied",
        },
        { assertDelistDirective: () => undefined },
      );
      // Every step moves past the longest backoff and the rate-limit throttle so
      // the only thing gating the next attempt is the operation's own budget.
      const attemptOnce = async () => {
        current = new Date(current.getTime() + 15_000);
        return runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-a" });
      };

      await runtime.enqueueDesiredState(desiredState("listing-budget", 1, 7, "event-budget-q1"));
      for (let attempt = 1; attempt <= 4; attempt += 1) expect(await attemptOnce()).toBe(1);
      expect(providerCalls).toBe(4);
      const consumed = await retryBudgetRow(pools.channels, "listing-budget");
      expect(consumed).toMatchObject({
        status: "pending",
        attempt_count: 4,
        claim_generation: "4",
        source_desired_state_sequence: "1",
        listing_revision: "7",
        terminal_reason: null,
      });

      expect(await runtime.enqueueDesiredState(desiredState("listing-budget", 2, 8, "event-budget-q2"))).not.toBeNull();
      const replaced = await retryBudgetRow(pools.channels, "listing-budget");
      expect(replaced).toMatchObject({
        status: "pending",
        attempt_count: 0,
        claim_generation: consumed.claim_generation,
        revision: String(Number(consumed.revision) + 1),
        source_desired_state_sequence: "2",
        listing_revision: "8",
        last_rejection_code: null,
        terminal_reason: null,
      });
      expect(replaced.operation_id).not.toBe(consumed.operation_id);

      for (let attempt = 1; attempt <= 4; attempt += 1) expect(await attemptOnce()).toBe(1);
      expect(providerCalls).toBe(8);
      expect(await retryBudgetRow(pools.channels, "listing-budget")).toMatchObject({
        operation_id: replaced.operation_id,
        status: "pending",
        attempt_count: 4,
        last_rejection_code: "rate-limited",
        terminal_reason: null,
      });

      providerResult = { kind: "succeeded", externalListingId: "external-budget" };
      expect(await attemptOnce()).toBe(1);
      expect(providerCalls).toBe(9);
      expect(await retryBudgetRow(pools.channels, "listing-budget")).toMatchObject({
        operation_id: replaced.operation_id,
        status: "succeeded",
        attempt_count: 5,
        claim_generation: "9",
        terminal_reason: null,
      });
      expect(await laneBlockState(pools.channels, "channel-listing-budget")).toEqual({ blocked_operation_id: null });
    });

    it("keeps boot-twice and the idle day-after runner byte-inert", async () => {
      await bootstrapContextDatabase(channelsModule, pools.channels);
      await bootstrapContextDatabase(channelsModule, pools.channels);
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      const before = await outboundStateSnapshot(pools.channels);
      expect(await runtime.recoverExpiredClaimedOperations()).toBe(0);
      expect(await runtime.processNextInlineOperation({ registry: claimedRegistry, claimOwnerId: "idle-worker" })).toBe(
        0,
      );
      expect(
        await runtime.reserveClaimedOutboundOperations({
          registry: claimedRegistry,
          connectionId: "connection-a",
          claimant: { claimantKind: "connector", claimantId: "idle-connector" },
          maxOperations: 1,
          leaseMs: 60_000,
        }),
      ).toBeNull();
      expect(await outboundStateSnapshot(pools.channels)).toEqual(before);
    });

    it("reserves concurrent lanes disjointly and refuses a partial acknowledgement without writing", async () => {
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-a", 1, 7, "event-a"));
      await runtime.enqueueDesiredState(desiredState("listing-b", 1, 7, "event-b"));
      const claimantA = { claimantKind: "manual" as const, claimantId: "manual-a" };
      const claimantB = { claimantKind: "connector" as const, claimantId: "connector-b" };
      const [first, second] = await Promise.all([
        runtime.reserveClaimedOutboundOperations({
          registry: claimedRegistry,
          connectionId: "connection-a",
          claimant: claimantA,
          maxOperations: 1,
          leaseMs: 60_000,
        }),
        runtime.reserveClaimedOutboundOperations({
          registry: claimedRegistry,
          connectionId: "connection-a",
          claimant: claimantB,
          maxOperations: 1,
          leaseMs: 60_000,
        }),
      ]);
      expect(first?.operations).toHaveLength(1);
      expect(second?.operations).toHaveLength(1);
      expect(first!.operations[0]!.operationId).not.toBe(second!.operations[0]!.operationId);

      const snapshot = await rows(pools.channels);
      await expect(
        runtime.reportClaimedOperationOutcomes({
          reservationId: first!.reservationId,
          claimant: claimantA,
          outcomes: [],
        }),
      ).rejects.toMatchObject({ code: "reservation-membership-mismatch" });
      expect(await rows(pools.channels)).toEqual(snapshot);
      const valid = memberOutcome(first!.operations[0]!, { kind: "abandoned", reason: "released" });
      const invalidReports = [
        { claimant: claimantA, outcomes: [valid, valid] },
        {
          claimant: claimantA,
          outcomes: [{ ...valid, operationId: "operation-not-in-reservation" }],
        },
        { claimant: claimantB, outcomes: [valid] },
        { claimant: claimantA, outcomes: [{ ...valid, attemptId: "attempt-stale" }] },
        { claimant: claimantA, outcomes: [{ ...valid, claimGeneration: valid.claimGeneration + 1 }] },
        { claimant: claimantA, outcomes: [{ ...valid, desiredStateSequence: 7 }] },
        { claimant: claimantA, outcomes: [{ ...valid, desiredStateSequence: 999 }] },
      ];
      for (const invalid of invalidReports) {
        await expect(
          runtime.reportClaimedOperationOutcomes({
            reservationId: first!.reservationId,
            claimant: invalid.claimant,
            outcomes: invalid.outcomes,
          }),
        ).rejects.toMatchObject({ code: "reservation-membership-mismatch" });
        expect(await rows(pools.channels)).toEqual(snapshot);
      }
    });

    it("outbound-poison-isolation blocks only the unknown lane until a fenced clear", async () => {
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-a", 1, 7, "event-a"));
      await runtime.enqueueDesiredState(desiredState("listing-b", 1, 7, "event-b"));
      const claimant = { claimantKind: "connector" as const, claimantId: "connector-a" };
      const reservation = await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 2,
        leaseMs: 60_000,
      });
      const [unknown, applied] = reservation!.operations;
      await runtime.reportClaimedOperationOutcomes({
        reservationId: reservation!.reservationId,
        claimant,
        outcomes: [
          memberOutcome(unknown!, { kind: "outcome-unknown" }),
          memberOutcome(applied!, {
            kind: "applied",
            result: { kind: "succeeded", externalListingId: "synthetic-external-listing" },
          }),
        ],
      });
      const lanes = await pools.channels.query<{
        channel_listing_id: string;
        blocked_operation_id: string | null;
        revision: string;
      }>(
        "SELECT channel_listing_id, blocked_operation_id, revision::text FROM channel_outbound_lanes ORDER BY channel_listing_id",
      );
      expect(lanes.rows.filter((lane) => lane.blocked_operation_id)).toHaveLength(1);

      await runtime.enqueueDesiredState(desiredState(unknown!.listingId, 2, 7, "event-newer"));
      const blockedReservation = await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 2,
        leaseMs: 60_000,
      });
      expect(blockedReservation).toBeNull();
      const blockedLane = lanes.rows.find((lane) => lane.blocked_operation_id)!;
      await runtime.clearOutboundOperationLane({
        connectionId: "connection-a",
        channelListingId: blockedLane.channel_listing_id,
        expectedRevision: Number(blockedLane.revision),
      });
      expect(
        await runtime.reserveClaimedOutboundOperations({
          registry: claimedRegistry,
          connectionId: "connection-a",
          claimant,
          maxOperations: 2,
          leaseMs: 60_000,
        }),
      ).not.toBeNull();
    });

    it("runs the four provider admission states through the durable engine", async () => {
      await insertConnection(pools.channels, "connection-absent", "synthetic-absent");
      await insertConnection(pools.channels, "connection-null", "synthetic-null");
      await insertConnection(pools.channels, "connection-claimed", "synthetic-claimed");
      await insertConnection(pools.channels, "connection-inline", "synthetic-inline");
      const providerCalls: string[] = [];
      const registry = createChannelProviderRegistry([
        descriptorWithoutPublication("synthetic-null"),
        descriptor("synthetic-claimed", "claimed"),
        inlineDescriptor("synthetic-inline", async (connectionId) => {
          providerCalls.push(connectionId);
          return { kind: "succeeded", externalListingId: "synthetic-inline-listing" };
        }),
      ]);
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      for (const connectionId of ["connection-absent", "connection-null", "connection-claimed", "connection-inline"]) {
        await runtime.enqueueDesiredState(
          desiredState(`listing-${connectionId}`, 1, 7, `event-${connectionId}`, connectionId),
        );
      }
      for (let index = 0; index < 5; index += 1) {
        if ((await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-a" })) === 0) break;
      }

      expect(await operationAdmissionStates(pools.channels)).toEqual([
        {
          connection_id: "connection-absent",
          status: "failed",
          attempt_count: 0,
          terminal_reason: "provider-descriptor-unregistered",
        },
        {
          connection_id: "connection-claimed",
          status: "pending",
          attempt_count: 0,
          terminal_reason: null,
        },
        { connection_id: "connection-inline", status: "succeeded", attempt_count: 1, terminal_reason: null },
        {
          connection_id: "connection-null",
          status: "failed",
          attempt_count: 0,
          terminal_reason: "provider-publication-unregistered",
        },
      ]);
      expect(providerCalls).toEqual(["connection-inline"]);
    });

    it("outbound-inline-execution-owner-inventory invokes only the exact operation wrapper", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      const publishListing = vi.fn(async (_input: PublishListingInput) => ({
        kind: "succeeded" as const,
        externalListingId: "unexpected-publish",
      }));
      const updatePriceQuantity = vi.fn(async (_input: UpdatePriceQuantityInput) => ({
        kind: "succeeded" as const,
        externalListingId: "updated-listing",
      }));
      const delistListing = vi.fn(async (_input: DelistListingInput) => ({
        kind: "succeeded" as const,
        externalListingId: "delisted-listing",
      }));
      const registry = createChannelProviderRegistry([
        {
          ...descriptorWithoutPublication("synthetic-inline"),
          publication: {
            execution: "inline",
            publishListing,
            updatePriceQuantity,
            delistListing,
            fetchChannelState: async () => ({
              kind: "complete",
              items: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
            fetchSales: async () => ({
              kind: "complete",
              lines: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
          },
        },
      ]);
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState({
        ...desiredState("listing-update", 1, 7, "event-update-wrapper"),
        operationKind: "update",
      });
      await runtime.enqueueDesiredState(desiredDelistState("listing-delist-wrapper", 1, 9, "event-delist-wrapper"));
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-wrapper" })).toBe(2);
      expect(publishListing).not.toHaveBeenCalled();
      expect(updatePriceQuantity).toHaveBeenCalledExactlyOnceWith({
        operationId: expect.any(String),
        connectionId: "connection-a",
        channelListingId: "channel-listing-update",
        listingRevision: 7,
        price: { amountMinor: 1_000, currency: "USD" },
        quantity: 1,
      });
      expect(delistListing).toHaveBeenCalledExactlyOnceWith({
        operationId: expect.any(String),
        connectionId: "connection-a",
        channelListingId: "channel-listing-delist-wrapper",
        listingRevision: 9,
      });
    });

    it("refuses an isolated invalid locked provider rate-state before admission without changing the operation or lane", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      await pools.channels.query(
        `INSERT INTO channel_provider_rate_state (
           provider_key, environment, window_started_at, request_count, adaptive_divisor
         ) VALUES ('synthetic-inline', 'sandbox', '2026-09-07T19:00:00.000Z', 0, 1)`,
      );
      const constraint = await pools.channels.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'channel_provider_rate_state'::regclass
           AND pg_get_constraintdef(oid) LIKE '%adaptive_divisor%'
         ORDER BY conname`,
      );
      expect(constraint.rows).toHaveLength(1);
      const { conname, definition } = constraint.rows[0]!;
      expect(conname).toMatch(/^[a-z0-9_]+$/);
      await pools.channels.query(`ALTER TABLE channel_provider_rate_state DROP CONSTRAINT ${conname}`);
      await pools.channels.query(
        "UPDATE channel_provider_rate_state SET adaptive_divisor = 0 WHERE provider_key = 'synthetic-inline' AND environment = 'sandbox'",
      );

      let providerCalls = 0;
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-inline", async () => {
          providerCalls += 1;
          return { kind: "succeeded", externalListingId: "must-not-be-called" };
        }),
      ]);
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-invalid-rate", 1, 7, "event-invalid-rate"));
      await expectInvalidLockedRateState("worker-invalid-divisor");

      await pools.channels.query(
        "UPDATE channel_provider_rate_state SET adaptive_divisor = 1 WHERE provider_key = 'synthetic-inline' AND environment = 'sandbox'",
      );
      await pools.channels.query(`ALTER TABLE channel_provider_rate_state ADD CONSTRAINT ${conname} ${definition}`);
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-valid-rate" })).toBe(1);
      expect(providerCalls).toBe(1);
      providerCalls = 0;

      for (const [column, listingId] of [
        ["request_count", "listing-null-request-count"],
        ["consecutive_successes", "listing-null-consecutive-successes"],
      ] as const) {
        await pools.channels.query(`ALTER TABLE channel_provider_rate_state ALTER COLUMN ${column} DROP NOT NULL`);
        try {
          await pools.channels.query(
            `UPDATE channel_provider_rate_state SET ${column} = NULL WHERE provider_key = 'synthetic-inline' AND environment = 'sandbox'`,
          );
          await runtime.enqueueDesiredState(desiredState(listingId, 1, 7, `event-${listingId}`));
          await expectInvalidLockedRateState(`worker-invalid-${column}`);
        } finally {
          await pools.channels.query(
            `UPDATE channel_provider_rate_state SET ${column} = 0 WHERE provider_key = 'synthetic-inline' AND environment = 'sandbox'`,
          );
          await pools.channels.query(`ALTER TABLE channel_provider_rate_state ALTER COLUMN ${column} SET NOT NULL`);
        }
        const removedInvalidControl = await pools.channels.query(
          "DELETE FROM channel_outbound_operations WHERE listing_id = $1 AND status = 'pending'",
          [listingId],
        );
        expect(Number(removedInvalidControl.rowCount ?? 0)).toBe(1);
      }

      await pools.channels.query(
        "UPDATE channel_provider_rate_state SET revision = 9007199254740992 WHERE provider_key = 'synthetic-inline' AND environment = 'sandbox'",
      );
      await runtime.enqueueDesiredState(desiredState("listing-bigint-revision", 1, 7, "event-bigint-revision"));
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-bigint-revision" })).toBe(1);
      expect(providerCalls).toBe(1);
      const revision = await pools.channels.query<{ revision: string }>(
        "SELECT revision::text FROM channel_provider_rate_state WHERE provider_key = 'synthetic-inline' AND environment = 'sandbox'",
      );
      expect(revision.rows).toEqual([{ revision: "9007199254740994" }]);

      async function expectInvalidLockedRateState(claimOwnerId: string) {
        const beforeOperation = await operationAdmissionStates(pools.channels);
        const beforeRate = await lockedRateState(pools.channels, "synthetic-inline");
        const beforeLanes = await laneAdmissionStates(pools.channels, "connection-a");
        await expect(runtime.processNextInlineOperation({ registry, claimOwnerId })).rejects.toMatchObject({
          code: "invalid-input",
        });
        expect(providerCalls).toBe(0);
        expect(await operationAdmissionStates(pools.channels)).toEqual(beforeOperation);
        expect(await lockedRateState(pools.channels, "synthetic-inline")).toEqual(beforeRate);
        expect(await laneAdmissionStates(pools.channels, "connection-a")).toEqual(beforeLanes);
      }
    });

    it("enforces a durable per-connection cap while a fair neighboring connection advances", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      await insertConnection(pools.channels, "connection-b", "synthetic-inline");
      let releaseFirst!: () => void;
      let markEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const calls: string[] = [];
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-inline", async (connectionId) => {
          calls.push(connectionId);
          if (connectionId === "connection-a") {
            markEntered();
            await firstRelease;
          }
          return { kind: "succeeded", externalListingId: `external-${connectionId}` };
        }),
      ]);
      const policy = {
        incidentMultiplier: 1,
        providers: {
          "synthetic-inline:sandbox": { maxRequestsPerWindow: 100, maxInFlightPerConnection: 1 },
        },
      };
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, resolveBudgetPolicy: async () => policy, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-cap-a1", 1, 7, "event-cap-a1", "connection-a"));
      await runtime.enqueueDesiredState(desiredState("listing-cap-a2", 1, 7, "event-cap-a2", "connection-a"));
      await runtime.enqueueDesiredState(desiredState("listing-cap-b", 1, 7, "event-cap-b", "connection-b"));

      const first = runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-a" });
      await firstEntered;
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-b" })).toBe(0);
      releaseFirst();
      expect(await first).toBe(2);
      expect(calls.sort()).toEqual(["connection-a", "connection-b"]);
      expect(await rateState(pools.channels, "synthetic-inline")).toMatchObject({
        request_count: 2,
        adaptive_divisor: 1,
      });

      const restarted = createOutboundSyncRuntime(
        { db: pools.channels, resolveBudgetPolicy: async () => policy, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      expect(await restarted.processNextInlineOperation({ registry, claimOwnerId: "worker-restart" })).toBe(1);
      expect(calls.sort()).toEqual(["connection-a", "connection-a", "connection-b"]);
      expect(await rateState(pools.channels, "synthetic-inline")).toMatchObject({ request_count: 3 });
    });

    it("retries only proven non-application and isolates an unknown provider result", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      let current = new Date("2026-09-07T19:00:00.000Z");
      let calls = 0;
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-inline", async () => {
          calls += 1;
          if (calls === 1) return { kind: "rejected", code: "rate-limited" };
          if (calls === 3) throw new Error("synthetic ambiguous provider failure");
          return { kind: "succeeded", externalListingId: `external-${calls}` };
        }),
      ]);
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          resolveBudgetPolicy: async () => ({
            incidentMultiplier: 1,
            providers: {
              "synthetic-inline:sandbox": {
                maxRequestsPerWindow: 100,
                maxAttempts: 2,
                baseBackoffMs: 1_000,
                maxBackoffMs: 10_000,
              },
            },
          }),
          recordOutcome: async () => "applied",
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-retry", 1, 7, "event-retry"));
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-a" })).toBe(1);
      expect(await operationAdmissionStates(pools.channels)).toContainEqual({
        connection_id: "connection-a",
        status: "pending",
        attempt_count: 1,
        terminal_reason: null,
      });
      current = new Date("2026-09-07T19:00:02.001Z");
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-a" })).toBe(1);
      await runtime.enqueueDesiredState(desiredState("listing-poison", 1, 7, "event-poison"));
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-a" })).toBe(1);
      expect(await operationStates(pools.channels)).toEqual([
        { listing_id: "listing-poison", status: "failed", terminal_reason: "outcome-unknown" },
        { listing_id: "listing-retry", status: "succeeded", terminal_reason: null },
      ]);
      expect(await rateState(pools.channels, "synthetic-inline")).toMatchObject({ adaptive_divisor: 2 });
    });

    it("fences a late inline success after the attempt lease becomes outcome-unknown", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      let current = new Date("2026-09-07T19:00:00.000Z");
      let markEntered!: () => void;
      let releaseProvider!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-inline", async () => {
          markEntered();
          await release;
          return { kind: "succeeded", externalListingId: "synthetic-late-success" };
        }),
      ]);
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          resolveBudgetPolicy: async () => ({
            incidentMultiplier: 1,
            providers: { "synthetic-inline:sandbox": { maxBackoffMs: 1_000 } },
          }),
          recordOutcome: async () => "applied",
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-inline-expiry", 1, 7, "event-inline-expiry"));
      const originalAttempt = runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-original" });
      await entered;
      current = new Date("2026-09-07T19:00:01.001Z");
      expect(await runtime.recoverExpiredClaimedOperations()).toBe(1);
      releaseProvider();
      await expect(originalAttempt).rejects.toMatchObject({ code: "stale-fence" });
      expect(await operationStates(pools.channels)).toEqual([
        { listing_id: "listing-inline-expiry", status: "failed", terminal_reason: "outcome-unknown" },
      ]);
    });

    it("turns an inline wrapper timeout into terminal uncertainty without retry", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-inline' WHERE connection_id = 'connection-a'",
      );
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-inline", async () => new Promise<ChannelPublicationResult>(() => undefined)),
      ]);
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          resolveBudgetPolicy: async () => ({
            incidentMultiplier: 1,
            providers: { "synthetic-inline:sandbox": { baseBackoffMs: 1, maxBackoffMs: 1 } },
          }),
          recordOutcome: async () => "applied",
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-timeout", 1, 7, "event-timeout"));
      expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "worker-timeout" })).toBe(1);
      expect(await operationStates(pools.channels)).toEqual([
        { listing_id: "listing-timeout", status: "failed", terminal_reason: "outcome-unknown" },
      ]);
    });

    it("outbound-claimed-acknowledgement-totality settles composed expiry from the immutable member vector", async () => {
      let current = new Date("2026-09-07T19:00:00.000Z");
      const recordedSequences: number[] = [];
      const runPort = createBoundRunFixturePort();
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          recordOutcome: async (_db, operation) => {
            recordedSequences.push(operation.sourceDesiredStateSequence);
            return "applied";
          },
          claimedReservationRunSettlement: runPort,
        },
        { assertDelistDirective: () => undefined },
      );
      for (const listingId of ["listing-composed", "listing-refused", "listing-satisfied"]) {
        await runtime.enqueueDesiredState(desiredState(listingId, 1, 7, `event-${listingId}`));
      }
      const claimant = { claimantKind: "connector" as const, claimantId: "connector-a" };
      const reservation = (await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 3,
        leaseMs: 60_000,
      }))!;
      const operation = (listingId: string) => reservation.operations.find((member) => member.listingId === listingId)!;
      const outcomes = [
        memberOutcome(operation("listing-composed"), { kind: "abandoned", reason: "released" }),
        memberOutcome(operation("listing-refused"), { kind: "rejected", code: "validation" }),
        memberOutcome(operation("listing-satisfied"), {
          kind: "applied",
          result: { kind: "succeeded", externalListingId: "synthetic-already-satisfied" },
        }),
      ];
      await insertBoundRun(pools.channels, {
        runId: "run-composed",
        reservationId: reservation.reservationId,
        claimant,
        state: "composed",
        submitMayHaveOccurred: false,
        uploadAttemptedAt: null,
        outcomes,
      });

      current = new Date("2026-09-07T19:01:00.001Z");
      expect(await runtime.recoverExpiredClaimedOperations()).toBe(3);
      expect(await operationStates(pools.channels)).toEqual([
        { listing_id: "listing-composed", status: "pending", terminal_reason: null },
        { listing_id: "listing-refused", status: "failed", terminal_reason: "validation" },
        { listing_id: "listing-satisfied", status: "succeeded", terminal_reason: null },
      ]);
      expect(await boundRunState(pools.channels, "run-composed")).toEqual({ state: "abandoned", revision: "2" });
      expect(recordedSequences).toEqual([1, 1]);
    });

    it("turns causal awaiting-verification expiry into unknown without a pending interval", async () => {
      let current = new Date("2026-09-07T19:00:00.000Z");
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          recordOutcome: async () => "applied",
          claimedReservationRunSettlement: createBoundRunFixturePort(),
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-awaiting", 1, 7, "event-awaiting"));
      const claimant = { claimantKind: "manual" as const, claimantId: "manual-a" };
      const reservation = (await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 1,
        leaseMs: 60_000,
      }))!;
      const outcome = memberOutcome(reservation.operations[0]!, { kind: "outcome-unknown" });
      await insertBoundRun(pools.channels, {
        runId: "run-awaiting",
        reservationId: reservation.reservationId,
        claimant,
        state: "awaiting-verification",
        submitMayHaveOccurred: true,
        uploadAttemptedAt: "2026-09-07T19:00:30.000Z",
        outcomes: [outcome],
      });

      current = new Date("2026-09-07T19:01:00.001Z");
      expect(await runtime.recoverExpiredClaimedOperations()).toBe(1);
      expect(await operationStates(pools.channels)).toEqual([
        { listing_id: "listing-awaiting", status: "failed", terminal_reason: "outcome-unknown" },
      ]);
      expect(await boundRunState(pools.channels, "run-awaiting")).toEqual({
        state: "application-unknown",
        revision: "2",
      });
      expect(
        await runtime.reserveClaimedOutboundOperations({
          registry: claimedRegistry,
          connectionId: "connection-a",
          claimant,
          maxOperations: 1,
          leaseMs: 60_000,
        }),
      ).toBeNull();
      expect(await runtime.recoverExpiredClaimedOperations()).toBe(0);

      await runtime.enqueueDesiredState(desiredState("listing-late-upload", 1, 7, "event-late-upload"));
      const lateReservation = (await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 1,
        leaseMs: 60_000,
      }))!;
      const lateOutcome = memberOutcome(lateReservation.operations[0]!, { kind: "outcome-unknown" });
      await insertBoundRun(pools.channels, {
        runId: "run-late-upload",
        reservationId: lateReservation.reservationId,
        claimant,
        state: "awaiting-verification",
        submitMayHaveOccurred: true,
        uploadAttemptedAt: "2026-09-07T19:02:00.500Z",
        outcomes: [lateOutcome],
      });
      current = new Date("2026-09-07T19:02:00.002Z");
      await expect(runtime.recoverExpiredClaimedOperations()).rejects.toMatchObject({ code: "stale-fence" });
      expect(await boundRunState(pools.channels, "run-late-upload")).toEqual({
        state: "awaiting-verification",
        revision: "1",
      });
      expect((await rows(pools.channels, "listing-late-upload"))[0]).toMatchObject({ status: "in-flight" });
    });

    it("outbound-claimed-acknowledgement-totality admits the same-claimant exception once across an expiry race", async () => {
      let current = new Date("2026-09-07T19:00:00.000Z");
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => current },
          recordOutcome: async () => "applied",
          claimedReservationRunSettlement: createBoundRunFixturePort(),
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("listing-race", 1, 7, "event-run-race"));
      const claimant = { claimantKind: "connector" as const, claimantId: "connector-a" };
      const reservation = (await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 1,
        leaseMs: 60_000,
      }))!;
      const outcomes = [memberOutcome(reservation.operations[0]!, { kind: "abandoned", reason: "released" })];
      await insertBoundRun(pools.channels, {
        runId: "run-race",
        reservationId: reservation.reservationId,
        claimant,
        state: "claimed",
        submitMayHaveOccurred: false,
        uploadAttemptedAt: null,
        outcomes,
      });
      current = new Date("2026-09-07T19:01:00.001Z");

      await expect(
        runtime.reportClaimedOperationOutcomes({
          reservationId: reservation.reservationId,
          claimant,
          outcomes: [{ ...outcomes[0]!, desiredStateSequence: 2 }],
          runSettlement: fixtureRunSettlement("run-race", 1),
        }),
      ).rejects.toMatchObject({ code: "reservation-membership-mismatch" });
      const results = await Promise.allSettled([
        runtime.reportClaimedOperationOutcomes({
          reservationId: reservation.reservationId,
          claimant,
          outcomes,
          runSettlement: fixtureRunSettlement("run-race", 1),
        }),
        runtime.recoverExpiredClaimedOperations(),
      ]);
      expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      expect(await boundRunState(pools.channels, "run-race")).toEqual({ state: "abandoned", revision: "2" });
      expect(await operationStates(pools.channels)).toEqual([
        { listing_id: "listing-race", status: "pending", terminal_reason: null },
      ]);
      await expect(
        runtime.reportClaimedOperationOutcomes({
          reservationId: reservation.reservationId,
          claimant,
          outcomes,
          runSettlement: fixtureRunSettlement("run-race", 1),
        }),
      ).resolves.toBeUndefined();
    });

    it("outbound-operation-log-completeness / outbound-event-to-ack-latency pages to the independent total", async () => {
      const current = new Date("2026-09-07T19:00:00.000Z");
      const runtime = createOutboundSyncRuntime(
        { db: pools.channels, clock: { now: () => current }, recordOutcome: async () => "applied" },
        { assertDelistDirective: () => undefined },
      );
      for (const listingId of ["listing-log-a", "listing-log-b", "listing-log-c"]) {
        await runtime.enqueueDesiredState(desiredState(listingId, 1, 7, `event-${listingId}`));
      }
      const claimant = { claimantKind: "connector" as const, claimantId: "connector-log" };
      const reservation = (await runtime.reserveClaimedOutboundOperations({
        registry: claimedRegistry,
        connectionId: "connection-a",
        claimant,
        maxOperations: 3,
        leaseMs: 60_000,
      }))!;
      await runtime.reportClaimedOperationOutcomes({
        reservationId: reservation.reservationId,
        claimant,
        outcomes: reservation.operations.map((operation) =>
          memberOutcome(operation, {
            kind: "applied",
            result: { kind: "succeeded", externalListingId: `external-${operation.listingId}` },
          }),
        ),
      });

      const first = await runtime.readOutboundOperationLog({
        accountId: "acc-owner",
        connectionId: "connection-a",
        limit: 2,
      });
      const second = await runtime.readOutboundOperationLog({
        accountId: "acc-owner",
        connectionId: "connection-a",
        cursor: first.nextCursor!,
        limit: 2,
      });
      expect([...first.items, ...second.items]).toHaveLength(3);
      expect(first.completeness).toEqual({ kind: "complete", total: 3 });
      expect(second).toMatchObject({ completeness: { kind: "complete", total: 3 } });
      expect(second.nextCursor).toBeUndefined();
      expect([...first.items, ...second.items].map((item) => item.eventToProviderAckMs)).toEqual([
        60_000, 60_000, 60_000,
      ]);

      const summary = await runtime.readOutboundOperationSummary({
        accountId: "acc-owner",
        connectionId: "connection-a",
        window: { from: "2026-09-07T18:58:00.000Z", to: "2026-09-07T19:01:00.000Z" },
      });
      expect(summary).toMatchObject({
        completeness: { kind: "complete", total: 3 },
        succeeded: 3,
        claimedEventToProviderAckMs: { p50: 60_000, p95: 60_000, p99: 60_000 },
      });

      await runtime.enqueueDesiredState(desiredState("listing-log-d", 1, 7, "event-listing-log-d"));
      expect(
        await runtime.readOutboundOperationLog({
          accountId: "acc-owner",
          connectionId: "connection-a",
          cursor: first.nextCursor!,
          limit: 2,
        }),
      ).toMatchObject({ completeness: { kind: "bounded-incomplete", reason: "authoritative-total-changed" } });
      const foreign = await runtime.readOutboundOperationLog({
        accountId: "acc-foreign",
        connectionId: "connection-a",
      });
      const missing = await runtime.readOutboundOperationLog({ accountId: "acc-owner", connectionId: "missing" });
      expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    });

    it("outbound-backlog-fairness-drill drains 10,000 listings while a provider neighbor advances", async () => {
      await pools.channels.query(
        "UPDATE channel_connections SET provider_key = 'synthetic-drill' WHERE connection_id = 'connection-a'",
      );
      await insertConnection(pools.channels, "connection-neighbor", "synthetic-neighbor");
      await seedBacklogFairnessDrill(pools.channels);
      let drillCalls = 0;
      let neighborCalls = 0;
      const drillCountAtNeighbor: number[] = [];
      const registry = createChannelProviderRegistry([
        inlineDescriptor("synthetic-drill", async () => {
          drillCalls += 1;
          return { kind: "succeeded", externalListingId: `drill-${drillCalls}` };
        }),
        inlineDescriptor("synthetic-neighbor", async () => {
          neighborCalls += 1;
          drillCountAtNeighbor.push(drillCalls);
          return { kind: "succeeded", externalListingId: `neighbor-${neighborCalls}` };
        }),
      ]);
      const policy = {
        incidentMultiplier: 1,
        providers: {
          "synthetic-drill:sandbox": {
            maxRequestsPerWindow: 10_000,
            windowMs: 900_000,
            maxInFlightPerConnection: 42,
          },
          "synthetic-neighbor:sandbox": {
            maxRequestsPerWindow: 5_000,
            windowMs: 900_000,
            maxInFlightPerConnection: 21,
          },
        },
      };
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          clock: { now: () => new Date("2026-09-07T19:00:00.000Z") },
          resolveBudgetPolicy: async () => policy,
          recordOutcome: async () => "applied",
        },
        { assertDelistDirective: () => undefined },
      );
      const startedAt = Date.now();
      let processed = 0;
      let processedInPass: number;
      while (
        (processedInPass = await runtime.processNextInlineOperation({ registry, claimOwnerId: "drill-default-lane" })) >
        0
      ) {
        processed += processedInPass;
      }
      const wallClockMs = Date.now() - startedAt;

      expect({ processed, drillCalls, neighborCalls }).toEqual({
        processed: 15_000,
        drillCalls: 10_000,
        neighborCalls: 5_000,
      });
      expect(wallClockMs).toBeLessThan(900_000);
      expect(drillCountAtNeighbor).toHaveLength(5_000);
      expect(drillCountAtNeighbor[0]).toBeLessThan(500);
      expect(drillCountAtNeighbor[2_499]).toBeGreaterThan(4_000);
      expect(drillCountAtNeighbor[2_499]).toBeLessThan(6_000);
      expect(drillCountAtNeighbor[4_999]).toBeGreaterThan(9_500);
      expect(await terminalCounts(pools.channels)).toEqual([
        { connection_id: "connection-a", terminal_count: 10_000 },
        { connection_id: "connection-neighbor", terminal_count: 5_000 },
      ]);
      expect(await rateState(pools.channels, "synthetic-drill")).toMatchObject({
        request_count: 10_000,
        adaptive_divisor: 1,
      });
    });
  },
);

type ProducerEventRow = Readonly<{
  event_id: string;
  event_type: string;
  payload: Readonly<
    Record<string, unknown> & {
      desiredStateHash?: string;
      draft?: Readonly<{ quantity?: number }>;
    }
  >;
  metadata: JsonObject;
  stream_id: string;
  stream_version: number;
  global_position: string;
  tenant_id: string;
  occurred_at: Date | string;
  recorded_at: Date | string;
  performed_by_user_id: string;
  for_account_id: string;
}>;

async function desiredStateEvent(
  db: PgTransactionalPool,
  streamId: string,
  streamVersion: number,
): Promise<ProducerEventRow> {
  const result = await db.query<ProducerEventRow>(
    `SELECT event_id,event_type,payload,metadata,stream_id,stream_version::integer AS stream_version,global_position::text,
            tenant_id,occurred_at,recorded_at,performed_by_user_id,for_account_id
     FROM event_store_events
     WHERE stream_id=$1 AND stream_version=$2 AND event_type='channels.channel-listing.desired-state-changed'`,
    [streamId, streamVersion],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function producerEvents(db: PgTransactionalPool, streamId: string): Promise<readonly ProducerEventRow[]> {
  const result = await db.query<ProducerEventRow>(
    `SELECT event_id,event_type,payload,metadata,stream_id,stream_version::integer AS stream_version,global_position::text,
            tenant_id,occurred_at,recorded_at,performed_by_user_id,for_account_id
     FROM event_store_events
     WHERE stream_id=$1
     ORDER BY stream_version`,
    [streamId],
  );
  return result.rows;
}

async function dispatchDesiredState(
  handlers: ReturnType<typeof buildChannelOutboundOperationReactionHandlers>,
  row: ProducerEventRow,
): Promise<void> {
  await handlers["channels.channel-listing.desired-state-changed"]!(transportEvent(row));
}

async function projectProducerEvents(db: PgTransactionalPool, rows: readonly ProducerEventRow[]): Promise<void> {
  const handlers = buildChannelListingStateProjectionHandlers(db);
  for (const row of rows) await handlers[row.event_type]!(transportEvent(row));
}

function transportEvent(row: ProducerEventRow) {
  return buildTransportEvent(row.event_type, row.payload, {
    id: row.event_id as never,
    streamId: row.stream_id,
    streamVersion: Number(row.stream_version),
    globalPosition: parseGlobalPosition(row.global_position),
    tenantId: row.tenant_id as never,
    metadata: row.metadata,
    audit: {
      performedByUserId: row.performed_by_user_id,
      forAccountId: row.for_account_id,
    },
    timing: {
      occurredAt: instant(row.occurred_at),
      recordedAt: instant(row.recorded_at),
    },
  });
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function outboundOperation(db: PgTransactionalPool, sourceEventId: string) {
  const result = await db.query<Parameters<typeof mapOutboundOperationRow>[0]>(
    `SELECT ${outboundOperationSqlColumns}
     FROM channel_outbound_operations
     WHERE source_event_id=$1`,
    [sourceEventId],
  );
  expect(result.rows).toHaveLength(1);
  return mapOutboundOperationRow(result.rows[0]!);
}

async function linkProjection(db: PgTransactionalPool, channelListingId: string) {
  const result = await db.query<{
    last_desired_state_sequence: string;
    last_desired_listing_revision: string;
    last_desired_state_hash: string;
    last_desired_intent: string;
    last_pushed_listing_revision: string | null;
    last_pushed_price_amount_minor: string | null;
    last_pushed_price_currency: string | null;
    last_pushed_quantity: number | null;
    external_listing_id: string | null;
    publish_state: string;
  }>(
    `SELECT last_desired_state_sequence::text,last_desired_listing_revision::text,last_desired_state_hash,
            last_desired_intent,last_pushed_listing_revision::text,last_pushed_price_amount_minor::text,
            last_pushed_price_currency,last_pushed_quantity,external_listing_id,publish_state
     FROM channels_channel_listing_links
     WHERE channel_listing_id=$1`,
    [channelListingId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function publicationRecordedCount(db: PgTransactionalPool, streamId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS count
     FROM event_store_events
     WHERE stream_id=$1 AND event_type='channels.channel-listing.publication-recorded'`,
    [streamId],
  );
  return result.rows[0]?.count ?? 0;
}

async function seedProductionCompositionFacts(db: PgTransactionalPool): Promise<void> {
  await db.query(`
    INSERT INTO channels_connection_facts VALUES
      ('connection-a','acc_owner','synthetic-provider','sandbox','active',now(),2);
    INSERT INTO channels_listing_publication_facts
      (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
       selected_options,selected_option_key,listing_status,pause_reason,item_title,item_subtitle,product_summary,graded_card,
       updated_at,listing_stream_version)
    VALUES ('listing-production-composed','acc_owner','item-production-composed','catalog-production-composed',
      '20.00','USD',10,
      '[{"dimensionId":"condition","optionId":"near-mint"}]'::jsonb,'condition:near-mint','active',NULL,
      'Synthetic production composition card',NULL,'Synthetic production composition fixture',NULL,now(),7);
    INSERT INTO channels_inventory_item_facts
      (item_id,account_id,catalog_item_id,total_quantity,updated_at,item_stream_version) VALUES
      ('item-production-composed','acc_owner','catalog-production-composed',3,now(),1);
    INSERT INTO channels_catalog_item_category_facts VALUES
      ('catalog-production-composed','cards',true,now(),1);
    INSERT INTO channels_external_product_reference_facts VALUES
      ('synthetic-provider','sku:production-composed','catalog-production-composed',
       '[{"dimensionId":"condition","optionId":"near-mint"}]'::jsonb,
       'condition:near-mint','linked',now(),1);
    INSERT INTO channels_external_catalog_item_reference_facts VALUES
      ('synthetic-provider','product:production-composed','catalog-production-composed','linked',now(),1);
    INSERT INTO channels_connection_publication_settings VALUES
      ('connection-a','','','','["cards"]'::jsonb,'[]'::jsonb,now(),1);
    INSERT INTO channels_channel_mappings VALUES
      ('connection-a','category','catalog-category:cards','trading-cards','manual','accepted','operator',
       '{"listingId":"listing-production-composed","derivedFrom":"synthetic production composition fixture"}'::jsonb,
       now(),1),
      ('connection-a','condition','selected-option:condition:near-mint','near-mint','manual','accepted','operator',
       '{"listingId":"listing-production-composed","derivedFrom":"synthetic production composition fixture"}'::jsonb,
       now(),1);
  `);
}

function descriptor(providerKey: string, execution: "claimed"): ChannelProviderDescriptor {
  return {
    identity: { providerKey, environment: "sandbox" },
    setup: {
      providerKey,
      environment: "sandbox",
      requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
    },
    publication: { execution },
  };
}

function descriptorWithoutPublication(providerKey: string): ChannelProviderDescriptor {
  return {
    identity: { providerKey, environment: "sandbox" },
    setup: {
      providerKey,
      environment: "sandbox",
      requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
    },
  };
}

function inlineDescriptor(
  providerKey: string,
  execute: (connectionId: string) => Promise<ChannelPublicationResult>,
): ChannelProviderDescriptor {
  return {
    ...descriptorWithoutPublication(providerKey),
    publication: {
      execution: "inline",
      publishListing: (input) => execute(input.connectionId),
      updatePriceQuantity: (input) => execute(input.connectionId),
      delistListing: (input) => execute(input.connectionId),
      fetchChannelState: async () => ({
        kind: "complete",
        items: [],
        collectedCount: 0,
        authorityTotal: 0,
        pageCount: 1,
      }),
      fetchSales: async () => ({ kind: "complete", lines: [], collectedCount: 0, authorityTotal: 0, pageCount: 1 }),
    },
  };
}

function recordingInlineDescriptor(
  providerKey: string,
  execute: (operationId: string) => Promise<ChannelPublicationResult>,
): ChannelProviderDescriptor {
  return {
    ...descriptorWithoutPublication(providerKey),
    publication: {
      execution: "inline",
      publishListing: (input) => execute(input.operationId),
      updatePriceQuantity: (input) => execute(input.operationId),
      delistListing: (input) => execute(input.operationId),
      fetchChannelState: async () => ({
        kind: "complete",
        items: [],
        collectedCount: 0,
        authorityTotal: 0,
        pageCount: 1,
      }),
      fetchSales: async () => ({ kind: "complete", lines: [], collectedCount: 0, authorityTotal: 0, pageCount: 1 }),
    },
  };
}

function desiredState(
  listingId: string,
  desiredStateSequence: number,
  listingRevision: number,
  sourceEventId: string,
  connectionId: string = "connection-a",
) {
  const channelListingId = `channel-${listingId}`;
  return {
    connectionId,
    channelListingId,
    listingId,
    operationKind: "publish" as const,
    listingRevision,
    desiredStateSequence,
    desiredStateHash: desiredStateSequence.toString(16).padStart(64, "0"),
    payload: {
      kind: "draft" as const,
      draft: {
        channelListingId,
        listingRevision,
        title: `Synthetic ${listingId}`,
        description: "Synthetic fixture",
        categoryKey: "category-1",
        conditionKey: "condition-1",
        price: { amountMinor: 1_000, currency: "USD" },
        quantity: 1,
        attributes: [],
      },
    },
    envelope: {
      sourceEventId,
      sourceStreamId: `channels.channel-listing-${channelListingId}`,
      sourceStreamVersion: desiredStateSequence,
      sourceGlobalPosition: parseGlobalPosition(String(desiredStateSequence)),
      sourceOccurredAt: "2026-09-07T18:59:00.000Z",
    },
  };
}

function desiredDelistState(
  listingId: string,
  desiredStateSequence: number,
  listingRevision: number,
  sourceEventId: string,
) {
  const channelListingId = `channel-${listingId}`;
  return {
    connectionId: "connection-a",
    channelListingId,
    listingId,
    operationKind: "delist" as const,
    listingRevision,
    desiredStateSequence,
    desiredStateHash: desiredStateSequence.toString(16).padStart(64, "0"),
    payload: {
      kind: "delist" as const,
      delist: {
        channelListingId,
        listingRevision,
        lastPublishedPrice: { amountMinor: 1_000, currency: "USD" },
        lastPublishedQuantity: 1,
        delistReasons: ["listing-not-active"],
      },
    },
    envelope: {
      sourceEventId,
      sourceStreamId: `channels.channel-listing-${channelListingId}`,
      sourceStreamVersion: desiredStateSequence,
      sourceGlobalPosition: parseGlobalPosition(String(desiredStateSequence)),
      sourceOccurredAt: "2026-09-07T18:59:00.000Z",
    },
  };
}

function memberOutcome(
  operation: NonNullable<
    Awaited<ReturnType<ReturnType<typeof createOutboundSyncRuntime>["reserveClaimedOutboundOperations"]>>
  >["operations"][number],
  outcome: Parameters<
    ReturnType<typeof createOutboundSyncRuntime>["reportClaimedOperationOutcomes"]
  >[0]["outcomes"][number]["outcome"],
) {
  return {
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    claimGeneration: operation.claimGeneration,
    desiredStateSequence: operation.desiredStateSequence,
    outcome,
  };
}

async function insertConnection(db: PgTransactionalPool, connectionId: string, providerKey: string) {
  await db.query(
    `INSERT INTO channel_connections (
       connection_id, account_id, provider_key, environment, status, created_at,
       created_at_instant, bindings, projection_updated_at, last_stream_version
     ) VALUES ($1, 'acc-owner', $2, 'sandbox', 'active', $3::text,
               $3::timestamptz, '[]'::jsonb, $3::timestamptz, 1)`,
    [connectionId, providerKey, "2026-09-07T18:00:00.000Z"],
  );
}

async function rows(db: PgTransactionalPool, listingId?: string) {
  const result = await db.query<{
    operation_id: string;
    status: string;
    listing_revision: string;
    source_desired_state_sequence: string;
    payload_digest: string;
    attempt_id: string | null;
  }>(
    `SELECT operation_id, status, listing_revision::text, source_desired_state_sequence::text,
            payload_digest, attempt_id
     FROM channel_outbound_operations
     WHERE ($1::text IS NULL OR listing_id = $1)
     ORDER BY source_desired_state_sequence`,
    [listingId ?? null],
  );
  return result.rows;
}

async function retryBudgetRow(db: PgTransactionalPool, listingId: string) {
  const result = await db.query<{
    operation_id: string;
    status: string;
    attempt_count: number;
    claim_generation: string;
    revision: string;
    source_desired_state_sequence: string;
    listing_revision: string;
    last_rejection_code: string | null;
    terminal_reason: string | null;
  }>(
    `SELECT operation_id, status, attempt_count, claim_generation::text, revision::text,
            source_desired_state_sequence::text, listing_revision::text, last_rejection_code, terminal_reason
     FROM channel_outbound_operations
     WHERE listing_id = $1`,
    [listingId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function laneBlockState(db: PgTransactionalPool, channelListingId: string) {
  const result = await db.query<{ blocked_operation_id: string | null }>(
    "SELECT blocked_operation_id FROM channel_outbound_lanes WHERE channel_listing_id = $1",
    [channelListingId],
  );
  return result.rows[0];
}

async function createBoundRunFixtureTable(db: PgTransactionalPool) {
  await db.query(`CREATE TABLE outbound_bound_run_fixture (
    run_id text PRIMARY KEY,
    reservation_id text NOT NULL UNIQUE,
    claimant_kind text NOT NULL,
    claimant_id text NOT NULL,
    state text NOT NULL,
    submit_may_have_occurred boolean NOT NULL,
    upload_attempted_at timestamptz NULL,
    outcomes jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 1
  )`);
}

function createBoundRunFixturePort(): ClaimedReservationRunSettlementPort {
  return {
    lockBoundRun: async (db, input) => {
      const values: unknown[] = [input.reservationId];
      const runFence = input.runId === undefined ? "" : ` AND run_id = $${values.push(input.runId)}`;
      const revisionFence =
        input.expectedRunRevision === undefined ? "" : ` AND revision = $${values.push(input.expectedRunRevision)}`;
      const result = await db.query<{
        run_id: string;
        reservation_id: string;
        claimant_kind: "connector" | "manual";
        claimant_id: string;
        state: BoundClaimedReservationRun["state"] | "abandoned" | "application-unknown";
        submit_may_have_occurred: boolean;
        upload_attempted_at: Date | null;
        outcomes: ClaimedOperationOutcome[];
        revision: string;
      }>(
        `SELECT run_id, reservation_id, claimant_kind, claimant_id, state,
                submit_may_have_occurred, upload_attempted_at, outcomes, revision::text
         FROM outbound_bound_run_fixture
         WHERE reservation_id = $1${runFence}${revisionFence}
         FOR UPDATE`,
        values,
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        runId: row.run_id,
        revision: Number(row.revision),
        reservationId: row.reservation_id,
        state: ["composed", "claimed", "awaiting-verification"].includes(row.state) ? (row.state as never) : "terminal",
        submitMayHaveOccurred: row.submit_may_have_occurred,
        uploadAttemptedAt: row.upload_attempted_at?.toISOString() ?? null,
        claimant: { claimantKind: row.claimant_kind, claimantId: row.claimant_id },
        outcomes: row.outcomes,
      };
    },
    settleBoundRun: async (db, input) => {
      const result = await db.query(
        `UPDATE outbound_bound_run_fixture
         SET state = $4, revision = revision + 1
         WHERE run_id = $1 AND revision = $2 AND state = $3`,
        [input.runId, input.expectedRunRevision, input.fromState, input.toState],
      );
      if (Number(result.rowCount ?? 0) !== 1) throw new Error("fixture-run-stale-fence");
    },
  };
}

function fixtureRunSettlement(runId: string, expectedRunRevision: number) {
  return {
    runId,
    expectedRunRevision,
    fromState: "claimed" as const,
    toState: "abandoned" as const,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    context: null,
  };
}

async function insertBoundRun(
  db: PgTransactionalPool,
  input: Readonly<{
    runId: string;
    reservationId: string;
    claimant: { claimantKind: "connector" | "manual"; claimantId: string };
    state: "composed" | "claimed" | "awaiting-verification";
    submitMayHaveOccurred: boolean;
    uploadAttemptedAt: string | null;
    outcomes: readonly ClaimedOperationOutcome[];
  }>,
) {
  await db.query(
    `INSERT INTO outbound_bound_run_fixture (
       run_id, reservation_id, claimant_kind, claimant_id, state,
       submit_may_have_occurred, upload_attempted_at, outcomes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.runId,
      input.reservationId,
      input.claimant.claimantKind,
      input.claimant.claimantId,
      input.state,
      input.submitMayHaveOccurred,
      input.uploadAttemptedAt,
      JSON.stringify(input.outcomes),
    ],
  );
}

async function operationStates(db: PgTransactionalPool) {
  const result = await db.query<{ listing_id: string; status: string; terminal_reason: string | null }>(
    `SELECT listing_id, status, terminal_reason
     FROM channel_outbound_operations
     ORDER BY listing_id`,
  );
  return result.rows;
}

async function boundRunState(db: PgTransactionalPool, runId: string) {
  const result = await db.query<{ state: string; revision: string }>(
    "SELECT state, revision::text FROM outbound_bound_run_fixture WHERE run_id = $1",
    [runId],
  );
  return result.rows[0];
}

async function operationAdmissionStates(db: PgTransactionalPool) {
  const result = await db.query<{
    connection_id: string;
    status: string;
    attempt_count: number;
    terminal_reason: string | null;
  }>(
    `SELECT connection_id, status, attempt_count, terminal_reason
     FROM channel_outbound_operations
     ORDER BY connection_id`,
  );
  return result.rows;
}

async function rateState(db: PgTransactionalPool, providerKey: string) {
  const result = await db.query<{ request_count: number; adaptive_divisor: number }>(
    `SELECT request_count, adaptive_divisor
     FROM channel_provider_rate_state
     WHERE provider_key = $1 AND environment = 'sandbox'`,
    [providerKey],
  );
  return result.rows[0];
}

async function lockedRateState(db: PgTransactionalPool, providerKey: string) {
  const result = await db.query<{
    request_count: string | null;
    adaptive_divisor: string;
    consecutive_successes: string | null;
    revision: string;
  }>(
    `SELECT request_count::text, adaptive_divisor::text, consecutive_successes::text, revision::text
     FROM channel_provider_rate_state
     WHERE provider_key = $1 AND environment = 'sandbox'`,
    [providerKey],
  );
  return result.rows[0];
}

async function laneAdmissionStates(db: PgTransactionalPool, connectionId: string) {
  const result = await db.query(
    `SELECT channel_listing_id, generation::text, blocked_operation_id, blocked_reason,
            blocked_at::text, cleared_at::text, revision::text
     FROM channel_outbound_lanes
     WHERE connection_id = $1
     ORDER BY channel_listing_id`,
    [connectionId],
  );
  return result.rows;
}

async function seedBacklogFairnessDrill(db: PgTransactionalPool) {
  await db.query(`WITH source AS (
      SELECT
        'connection-a'::text AS connection_id,
        ('drill-channel-' || lpad(value::text, 5, '0'))::text AS channel_listing_id,
        ('drill-listing-' || lpad(value::text, 5, '0'))::text AS listing_id,
        ('drill-event-' || lpad(value::text, 5, '0'))::text AS source_event_id,
        value::bigint AS source_global_position,
        ('2026-09-07T18:59:00.000Z'::timestamptz + value * interval '5 milliseconds') AS enqueued_at
      FROM generate_series(1, 10000) AS value
      UNION ALL
      SELECT
        'connection-neighbor'::text,
        ('neighbor-channel-' || lpad(value::text, 5, '0'))::text,
        ('neighbor-listing-' || lpad(value::text, 5, '0'))::text,
        ('neighbor-event-' || lpad(value::text, 5, '0'))::text,
        (10000 + value)::bigint,
        ('2026-09-07T18:59:00.002Z'::timestamptz + value * interval '10 milliseconds')
      FROM generate_series(1, 5000) AS value
    ), lanes AS (
      INSERT INTO channel_outbound_lanes (connection_id, channel_listing_id)
      SELECT connection_id, channel_listing_id FROM source
      ON CONFLICT DO NOTHING
      RETURNING connection_id
    )
    INSERT INTO channel_outbound_operations (
      operation_id, connection_id, channel_listing_id, listing_id, operation_kind,
      listing_revision, source_desired_state_sequence, payload, payload_digest,
      status, revision, next_attempt_at, source_event_id, source_stream_id,
      source_stream_version, source_global_position, source_desired_state_hash,
      source_occurred_at, enqueued_at
    )
    SELECT
      'drill-operation-' || source_event_id,
      connection_id,
      channel_listing_id,
      listing_id,
      'publish',
      1,
      1,
      jsonb_build_object(
        'kind', 'draft',
        'draft', jsonb_build_object(
          'channelListingId', channel_listing_id,
          'listingRevision', 1,
          'title', 'Synthetic drill listing',
          'description', 'Synthetic outbound fairness drill',
          'categoryKey', 'synthetic-category',
          'conditionKey', 'synthetic-condition',
          'price', jsonb_build_object('amountMinor', 1000, 'currency', 'USD'),
          'quantity', 1,
          'attributes', jsonb_build_array()
        )
      ),
      repeat('0', 64),
      'pending',
      1,
      '2026-09-07T19:00:00.000Z'::timestamptz,
      source_event_id,
      'channels.channel-listing-' || channel_listing_id,
      1,
      source_global_position,
      repeat('1', 64),
      '2026-09-07T18:58:00.000Z'::timestamptz,
      enqueued_at
    FROM source`);
}

async function terminalCounts(db: PgTransactionalPool) {
  const result = await db.query<{ connection_id: string; terminal_count: number }>(
    `SELECT connection_id, count(*)::integer AS terminal_count
     FROM channel_outbound_operations
     WHERE status IN ('succeeded', 'failed')
     GROUP BY connection_id
     ORDER BY connection_id`,
  );
  return result.rows;
}

async function outboundStateSnapshot(db: PgTransactionalPool) {
  const result = await db.query<{
    operations: number;
    lanes: number;
    rate_states: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM channel_outbound_operations) AS operations,
       (SELECT count(*)::integer FROM channel_outbound_lanes) AS lanes,
       (SELECT count(*)::integer FROM channel_provider_rate_state) AS rate_states`,
  );
  return result.rows[0];
}
