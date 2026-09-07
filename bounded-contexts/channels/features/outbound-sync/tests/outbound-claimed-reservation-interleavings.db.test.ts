import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelProviderDescriptor } from "../../publication-port/domain/contracts";
import { createOutboundSyncRuntime } from "../api/runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

const claimedRegistry = createChannelProviderRegistry([descriptor("synthetic-claimed", "claimed")]);

describeDb("outbound-claimed-reservation-interleavings", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "outbound_claimed_interleavings");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await insertConnection(pools.channels, "connection-a", "synthetic-claimed");
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("coalesces by producer sequence, preserves immutable in-flight state, and redelivers only an unbound expiry", async () => {
    let current = new Date("2026-09-07T19:00:00.000Z");
    const runtime = createOutboundSyncRuntime(
      { db: pools.channels, clock: { now: () => current }, recordOutcome: async () => "applied" },
      { assertDelistDirective: () => undefined },
    );
    await runtime.enqueueDesiredState(desiredState("listing-a", 1, 7, "event-q1"));
    await runtime.enqueueDesiredState(desiredState("listing-a", 2, 7, "event-q2"));
    await runtime.enqueueDesiredState(desiredState("listing-a", 1, 99, "event-old"));

    const beforeClaim = await rows(pools.channels, "listing-a");
    expect(beforeClaim).toHaveLength(1);
    expect(beforeClaim[0]).toMatchObject({ source_desired_state_sequence: "2", listing_revision: "7", status: "pending" });

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
  });

  it("blocks only the unknown member lane and queues a newer desire until a fenced clear", async () => {
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
    }>("SELECT channel_listing_id, blocked_operation_id, revision::text FROM channel_outbound_lanes ORDER BY channel_listing_id");
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
});

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

function desiredState(listingId: string, desiredStateSequence: number, listingRevision: number, sourceEventId: string) {
  const channelListingId = `channel-${listingId}`;
  return {
    connectionId: "connection-a",
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
      sourceGlobalPosition: BigInt(desiredStateSequence),
      sourceOccurredAt: "2026-09-07T18:59:00.000Z",
    },
  };
}

function memberOutcome(
  operation: NonNullable<Awaited<ReturnType<ReturnType<typeof createOutboundSyncRuntime>["reserveClaimedOutboundOperations"]>>>["operations"][number],
  outcome: Parameters<ReturnType<typeof createOutboundSyncRuntime>["reportClaimedOperationOutcomes"]>[0]["outcomes"][number]["outcome"],
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
