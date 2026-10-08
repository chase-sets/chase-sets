import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import type { ConnectorTransportServices } from "../../connector-feed/api/transport";
import {
  describeDb,
  target,
  transportContext,
  transportDatabase,
} from "../../connector-feed/tests/transport-test-support";
import { createOutboundSyncRuntime } from "../api/runtime";
import type {
  ClaimedOperationOutcome,
  ClaimedOperationReservation,
  ClaimedOrderPullOperation,
  ClaimedSubjectOperation,
  ClaimedOutboundOperation,
} from "../domain/contracts";
import {
  decideOrderPullSearchPage,
  deriveOrderPullId,
  orderPullFitsLease,
  type ClaimedOrderPullOutcome,
  type OrderPullAuthority,
} from "../domain/order-pull";
import { outboundSyncSchemaMigrations } from "../read-model/schema";

// Synthetic authority: #8804/#8838 have not fixed production bounds; these values exercise the producer only.
const syntheticAuthority: OrderPullAuthority = {
  revision: 3,
  lawVersion: "ready-to-ship-intake/v1",
  selector: { identity: "synthetic-ready-to-ship-selector", version: 1, pageSize: 500 },
  nRtsMax: 60,
  fMax: 20,
  providerCadenceMs: 1_000,
  providerCallTimeoutMs: 3_000,
  mappingJournalMs: 10_000,
  maxPostsPerOrder: 3,
  postTimeoutMs: 1_000,
  reportTimeoutMs: 5_000,
};
const capable = { capabilities: ["tcgplayer-order-pull"] };
const startedAt = Date.parse("2026-10-07T12:00:00.000Z");

let authority: unknown = syntheticAuthority;
let held = false;

describeDb("order-pull-scheduler-and-claim / order-pull-subject-feed-contract", () => {
  const h = transportDatabase("order_pull_8610", {
    resolveTcgplayerOrderPullAuthority: async () => authority,
    readChannelHealthHold: async () => held,
  });
  beforeEach(() => {
    authority = syntheticAuthority;
    held = false;
  });
  const tick = () => h.services.outboundSync.scheduleDueOrderPulls({ registry: channelProviderRegistry });
  const at = (offsetMs: number) => vi.setSystemTime(new Date(startedAt + offsetMs));
  async function pullState() {
    return {
      operations: (
        await h.db.query("SELECT row_to_json(t) AS row FROM channel_order_pull_operations t ORDER BY operation_id")
      ).rows,
      schedules: (
        await h.db.query("SELECT row_to_json(t) AS row FROM channel_order_pull_schedules t ORDER BY connection_id")
      ).rows,
    };
  }
  async function claim(body: unknown = capable) {
    const response = await h.request("claim", body);
    expect(response.status).toBe(200);
    const value: Awaited<ReturnType<ConnectorTransportServices["claim"]>> = await response.json();
    return value.reservation;
  }
  function pullMember(reservation: ClaimedOperationReservation<ClaimedSubjectOperation> | null) {
    const member = reservation?.operations.find(
      (operation): operation is ClaimedOrderPullOperation => operation.operationKind === "tcgplayer-order-pull",
    );
    if (!member) throw new Error("missing-pull-member");
    return member;
  }
  function pullReport(
    member: ClaimedOrderPullOperation,
    outcome: ClaimedOrderPullOutcome["outcome"],
  ): ClaimedOrderPullOutcome {
    return {
      operationKind: member.operationKind,
      operationId: member.operationId,
      attemptId: member.attemptId,
      claimGeneration: member.claimGeneration,
      pullId: member.pullId,
      payloadDigest: member.payloadDigest,
      outcome,
    };
  }
  function complete(
    member: ClaimedOrderPullOperation,
  ): Extract<ClaimedOrderPullOutcome["outcome"], { kind: "order-pull-complete" }> {
    return {
      kind: "order-pull-complete",
      lawVersion: member.payload.lawVersion,
      selector: member.payload.selector,
      admissionCounts: { readyToShipMembers: 2, followUpReads: 0, admitted: 2 },
    };
  }
  function listingReport(operation: ClaimedOutboundOperation): ClaimedOperationOutcome {
    return {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      claimGeneration: operation.claimGeneration,
      desiredStateSequence: operation.desiredStateSequence,
      outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: `external_${operation.listingId}` } },
    };
  }
  async function listingEffects() {
    const effects = await h.effects();
    return {
      links: effects.e1.channels_channel_listing_links,
      events: effects.e1.event_store_events,
      lanes: effects.e1.channel_outbound_lanes,
      operations: effects.e1.channel_outbound_operations,
    };
  }

  it("AC1 schedules one connection pull; racing, repeated, restarted and not-due ticks stay one with zero writes", async () => {
    const listingBefore = await h.effects();
    const minted = await Promise.all(Array.from({ length: 3 }, () => tick()));
    expect(minted.reduce((sum, count) => sum + count, 0)).toBe(1);
    const scheduled = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      subject: { kind: "connection", connectionId: target.connectionId },
      operationKind: "tcgplayer-order-pull",
      status: "pending",
      scheduleGeneration: 1,
      pullId: deriveOrderPullId(target.connectionId, 1),
      payload: {
        kind: "order-pull",
        version: 1,
        connectionId: target.connectionId,
        pullId: deriveOrderPullId(target.connectionId, 1),
        policyRevision: 3,
        lawVersion: "ready-to-ship-intake/v1",
        selector: syntheticAuthority.selector,
        bounds: { nRtsMax: 60, fMax: 20, maxObservationPosts: 240, budgetMs: 583_000 },
        followUpReferences: [],
      },
    });
    expect(Object.keys(scheduled[0]!.payload).sort()).not.toContain("listingId");
    const [schedule] = (await pullState()).schedules as { row: { generation: number; next_due_at: string } }[];
    expect(schedule?.row.generation).toBe(1);
    expect(Date.parse(schedule!.row.next_due_at)).toBe(startedAt + 60_000);
    // The producer writes only its own tables; listing state is untouched.
    expect(await h.effects()).toEqual(listingBefore);

    const snapshot = await pullState();
    expect(await tick()).toBe(0);
    h.restart();
    expect(await tick()).toBe(0);
    at(61_000);
    // Due again, but the connection already has a live pull: zero writes.
    expect(await Promise.all([tick(), tick()])).toEqual([0, 0]);
    expect(await pullState()).toEqual(snapshot);
  });

  it("AC1 denies unknown, over-budget and absent-bound authority and held connections with zero writes and zero provider calls", async () => {
    const providerCalls: string[] = [];
    const empty = await pullState();
    for (const denied of [
      null,
      { ...syntheticAuthority, reportTimeoutMs: 22_001 },
      { ...syntheticAuthority, nRtsMax: undefined },
      { ...syntheticAuthority, selector: { ...syntheticAuthority.selector, qualifiedAt: "x" } },
    ]) {
      authority = denied;
      expect(await tick()).toBe(0);
      expect(await pullState()).toEqual(empty);
    }
    authority = syntheticAuthority;
    held = true;
    expect(await tick()).toBe(0);
    expect(await pullState()).toEqual(empty);
    held = false;
    // Omitted producer: a capable claim receives nothing, so an executor would make no provider call.
    const reservation = await claim();
    for (const operation of reservation?.operations ?? []) providerCalls.push(operation.operationId);
    expect(reservation).toBeNull();
    expect(providerCalls).toEqual([]);
  });

  it("AC1 paused and revoked connections write zero", async () => {
    await h.pause();
    expect(await tick()).toBe(0);
    expect(await pullState()).toEqual({ operations: [], schedules: [] });
    await h.services.connections.resumeChannelConnection(target, transportContext);
    await h.projectConnection();
    await h.services.connectorFeed.revoke(h.token);
    expect(await tick()).toBe(0);
    expect(await pullState()).toEqual({ operations: [], schedules: [] });
  });

  it("AC2 capable claim -> executor -> complete settles the pull with no listing writes; day-after mints a new pull", async () => {
    expect(await tick()).toBe(1);
    // Incapable connector and manual claimers exclude the kind before reserve.
    expect(await claim({})).toBeNull();
    expect(
      await h.services.outboundSync.reserveClaimedOutboundOperations({
        registry: channelProviderRegistry,
        connectionId: target.connectionId,
        claimant: { claimantKind: "manual", claimantId: "manual_8610" },
        maxOperations: 10,
        leaseMs: 1_800_000,
      }),
    ).toBeNull();
    expect(
      await h.services.outboundSync.processNextInlineOperation({
        registry: channelProviderRegistry,
        claimOwnerId: "inline_8610",
      }),
    ).toBe(0);
    const [pending] = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pending).toMatchObject({ status: "pending", claimGeneration: 0, attemptCount: 0 });

    const reservation = await claim();
    const member = pullMember(reservation);
    expect(reservation?.operations).toHaveLength(1);
    expect(member).toMatchObject({
      operationId: pending!.operationId,
      claimGeneration: 1,
      connectionId: target.connectionId,
      subject: { kind: "connection", connectionId: target.connectionId },
      pullId: pending!.pullId,
      scheduleGeneration: 1,
      payload: pending!.payload,
      payloadDigest: pending!.payloadDigest,
    });
    expect(member).not.toHaveProperty("listingId");
    expect(member).not.toHaveProperty("desiredStateSequence");

    // Test executor: lease preflight, then one closed search page decides the set before any detail read.
    expect(
      orderPullFitsLease({
        budgetMs: member.payload.bounds.budgetMs,
        at: new Date().toISOString(),
        leaseExpiresAt: reservation!.leaseExpiresAt,
      }),
    ).toBe(true);
    expect(
      decideOrderPullSearchPage(member.payload, {
        totalOrders: 2,
        orderNumbers: ["ORDER-1", "ORDER-2"],
        everyRowReadyToShip: true,
      }),
    ).toEqual({ kind: "read-details", orderNumbers: ["ORDER-1", "ORDER-2"] });

    const listingBefore = await listingEffects();
    const body = { reservationId: reservation!.reservationId, outcomes: [pullReport(member, complete(member))] };
    const first = await h.request("report", body);
    expect(first.status).toBe(200);
    const [settled] = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(settled).toMatchObject({ status: "succeeded", outcome: complete(member) });
    expect(await listingEffects()).toEqual(listingBefore);
    const settledState = await pullState();
    const repeat = await h.request("report", body);
    expect(repeat.status).toBe(200);
    expect(await pullState()).toEqual(settledState);

    // Day-after: the next boundary mints a NEW pull; the completed one is never relabelled.
    at(30_000);
    expect(await tick()).toBe(0);
    at(125_000);
    expect(await tick()).toBe(1);
    const pulls = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pulls.map((pull) => [pull.scheduleGeneration, pull.status, pull.pullId])).toEqual([
      [2, "pending", deriveOrderPullId(target.connectionId, 2)],
      [1, "succeeded", pending!.pullId],
    ]);
    const [schedule] = (await pullState()).schedules as { row: { next_due_at: string } }[];
    // The persisted boundary advances on the cadence grid, not from the claim or report instant.
    expect(Date.parse(schedule!.row.next_due_at)).toBe(startedAt + 180_000);
  });

  it("AC2 mixed reservation: partial, stale and subject-bypass reports refuse atomically; unknown settles without Link writes", async () => {
    await h.enqueue("pull_mix");
    expect(await tick()).toBe(1);
    const reservation = await claim();
    expect(reservation?.operations).toHaveLength(2);
    const member = pullMember(reservation);
    const listing = reservation!.operations.find(
      (operation): operation is ClaimedOutboundOperation => operation.operationKind !== "tcgplayer-order-pull",
    )!;
    const unknown = pullReport(member, { kind: "order-pull-unknown", reason: "completeness-unproven" });
    const before = { pulls: await pullState(), listing: await listingEffects() };
    for (const refused of [
      { reservationId: reservation!.reservationId, outcomes: [listingReport(listing)] },
      {
        reservationId: reservation!.reservationId,
        outcomes: [listingReport(listing), { ...unknown, claimGeneration: unknown.claimGeneration + 1 }],
      },
      {
        reservationId: reservation!.reservationId,
        outcomes: [listingReport(listing), { ...unknown, payloadDigest: "0".repeat(64) }],
      },
      {
        reservationId: reservation!.reservationId,
        outcomes: [
          listingReport(listing),
          {
            operationId: member.operationId,
            attemptId: member.attemptId,
            claimGeneration: member.claimGeneration,
            desiredStateSequence: 1,
            outcome: { kind: "outcome-unknown" },
          },
        ],
      },
      {
        reservationId: reservation!.reservationId,
        outcomes: [
          listingReport(listing),
          pullReport(member, {
            ...complete(member),
            admissionCounts: { readyToShipMembers: 61, followUpReads: 0, admitted: 1 },
          }),
        ],
      },
    ]) {
      const response = await h.request("report", refused);
      expect([400, 409]).toContain(response.status);
      expect({ pulls: await pullState(), listing: await listingEffects() }).toEqual(before);
    }
    const accepted = await h.request("report", {
      reservationId: reservation!.reservationId,
      outcomes: [listingReport(listing), unknown],
    });
    expect(accepted.status).toBe(200);
    const [pull] = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pull).toMatchObject({
      status: "failed",
      outcome: { kind: "order-pull-unknown", reason: "completeness-unproven" },
    });
    // The listing member settled through its own Link owner exactly once; the pull added no listing event.
    const publications = await h.db.query(
      "SELECT count(*)::integer AS count FROM event_store_events WHERE event_type='channels.channel-listing.publication-recorded'",
    );
    expect(publications.rows[0]).toEqual({ count: 1 });
  });

  it("AC2 abandoned and lease-expired attempts return the same pull for a new generation; the old report is refused", async () => {
    expect(await tick()).toBe(1);
    const firstReservation = await claim();
    const first = pullMember(firstReservation);
    const released = await h.request("report", {
      reservationId: firstReservation!.reservationId,
      outcomes: [pullReport(first, { kind: "abandoned", reason: "released" })],
    });
    expect(released.status).toBe(200);
    const second = await claim();
    const secondMember = pullMember(second);
    expect(secondMember).toMatchObject({ pullId: first.pullId, claimGeneration: 2 });
    at(1_800_001);
    expect(await h.services.outboundSync.recoverExpiredClaimedOperations()).toBeGreaterThanOrEqual(1);
    const stale = await h.request("report", {
      reservationId: second!.reservationId,
      outcomes: [pullReport(secondMember, complete(secondMember))],
    });
    expect(stale.status).toBe(409);
    const third = pullMember(await claim());
    expect(third).toMatchObject({ pullId: first.pullId, claimGeneration: 3 });
    expect(await tick()).toBe(0);
  });
});

describeDb("order-pull-producer-schema-and-profiles", () => {
  let pools: Readonly<Record<"channels", PgTransactionalPool>>;
  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL!;
    const urls = createMultiContextTestDatabaseUrls(baseUrl, ["channels"], "order_pull_schema_8610");
    await ensureMultiContextTestDatabases(baseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("AC4 the ledgered migration adds the producer tables to a retained queue without touching pending listing operations", async () => {
    const migrationId = "20261008_channels_order_pull_producer";
    const migration = outboundSyncSchemaMigrations.find((entry) => entry.migrationId === migrationId)!;
    const predecessor = {
      ...channelsModule,
      schemaSql: migration.statements.reduce(
        (sql, statement) => sql.replace(`${statement};`, ""),
        channelsModule.schemaSql,
      ),
      schemaMigrations: channelsModule.schemaMigrations!.filter((entry) => entry.migrationId !== migrationId),
    };
    expect(predecessor.schemaSql).not.toContain("channel_order_pull_operations");
    await bootstrapContextDatabase(predecessor, pools.channels);
    expect(await producerTables()).toEqual([]);
    await pools.channels.query(
      `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
       VALUES ('connection-retained','account-retained','tcgplayer','sandbox','active',now(),now(),'[]'::jsonb,now(),1)`,
    );
    const runtime = createOutboundSyncRuntime(
      {
        db: pools.channels,
        recordOutcome: async () => "applied",
        readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
      },
      { assertDelistDirective: () => undefined },
    );
    await runtime.enqueueDesiredState({
      connectionId: "connection-retained",
      channelListingId: "channel-retained",
      listingId: "listing-retained",
      operationKind: "publish",
      listingRevision: 1,
      desiredStateSequence: 1,
      desiredStateHash: "a".repeat(64),
      payload: {
        kind: "draft",
        draft: {
          channelListingId: "channel-retained",
          listingRevision: 1,
          title: "Retained",
          description: "Retained",
          categoryKey: "retained",
          conditionKey: "retained",
          price: { amountMinor: 100, currency: "USD" },
          quantity: 1,
          attributes: [],
        },
      },
      envelope: {
        sourceEventId: "event-retained",
        sourceStreamId: "channels.channel-listing-channel-retained",
        sourceStreamVersion: 1,
        sourceGlobalPosition: parseGlobalPosition("1"),
        sourceOccurredAt: "2026-10-07T12:00:00.000Z",
      },
    });
    const retained = await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id");
    expect(retained.rows).toHaveLength(1);

    // Ledger-only upgrade: boot DDL is omitted, so only the real migration can create the producer tables.
    await bootstrapContextDatabase({ ...channelsModule, schemaSql: "" }, pools.channels);
    expect(await producerTables()).toEqual(["channel_order_pull_operations", "channel_order_pull_schedules"]);
    expect(
      (await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id")).rows,
    ).toEqual(retained.rows);
    const upgradedIndexes = await producerIndexes();
    expect(upgradedIndexes).toEqual([
      "channel_order_pull_operations_expiry_idx",
      "channel_order_pull_operations_one_live_uidx",
      "channel_order_pull_operations_reservation_idx",
      "channel_order_pull_schedules_due_idx",
    ]);
    // Boot after migration and a repeated boot are idempotent and keep the retained listing queue.
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(
      (await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id")).rows,
    ).toEqual(retained.rows);
    expect(
      (
        await pools.channels.query(
          "SELECT count(*)::integer AS count FROM bounded_context_schema_migrations WHERE migration_id=$1",
          [migrationId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    // Fresh-boot parity.
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await producerIndexes()).toEqual(upgradedIndexes);
  });

  async function producerTables(): Promise<string[]> {
    const result = await pools.channels.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'channel_order_pull_%' ORDER BY table_name`,
    );
    return result.rows.map((row) => row.table_name);
  }
  async function producerIndexes(): Promise<string[]> {
    const result = await pools.channels.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename LIKE 'channel_order_pull_%' AND indexname NOT LIKE '%_pkey'
         AND indexname NOT LIKE '%_key' ORDER BY indexname`,
    );
    return result.rows.map((row) => row.indexname);
  }
});
