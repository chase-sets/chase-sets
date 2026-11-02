import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { redactedTransportAudit, redactedTransportTiming, toTransportEvent } from "@chase-sets/event-core/transport";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  withPgTransaction,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { stageAccountBlockCommand, type AccountBlockCommand } from "../api/transition-staging";
import {
  AccountBlockAuthorityError,
  accountBlockBudgetStreamId,
  accountBlockPairStreamId,
  accountBlockBudgetRecordedEventType,
  accountBlockTransitionRecordedEventType,
  encodeAccountBlockTransition,
  type AccountBlockOperation,
} from "../domain/events";
import {
  blockedAccountId,
  blockingAccountId,
  initiatingUserId,
  instant,
  syntheticContext,
  syntheticPair,
  syntheticTenantId,
  syntheticTransitionId,
} from "./account-block-test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

const plantedTraceId = "trc_planted_account_block_trace";
const plantedSpanId = "spn_planted_account_block_span";
const plantedSessionId = "ses_planted_account_block_session";
const accountBlockTypes = [
  accountBlockBudgetRecordedEventType,
  accountBlockTransitionRecordedEventType,
  "identity.account-blocked",
  "identity.account-unblocked",
];

describeDb("account-block-public-contract-and-privacy on real PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let store: PostgresEventStore;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_account_block_privacy");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.identity;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(eventCorePostgresSchemaSql);
    store = createPostgresEventStore({ pool, now: () => "2031-03-04T05:06:07.890Z" as never });
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  const command = (label: string, operation: AccountBlockOperation): AccountBlockCommand => ({
    operation,
    blockingAccountId,
    blockedAccountId,
    transitionId: syntheticTransitionId(label),
    context: {
      ...syntheticContext(),
      trace: { traceId: plantedTraceId as never, spanId: plantedSpanId as never, traceState: "planted=state" },
    },
  });

  /** Admits one command whose events also carry caller-planted session and trace metadata. */
  async function admitWithPlantedMetadata(input: AccountBlockCommand) {
    return withPgTransaction(pool, async (client) => {
      const staged = await stageAccountBlockCommand(store, client, input);
      if (staged.outcome !== "transition") throw new Error("expected a transition");
      const planted: readonly AppendToStreamInput[] = staged.appends.map((append) => ({
        ...append,
        events: append.events.map((event) => ({
          ...event,
          metadata: { sessionId: plantedSessionId, traceId: plantedTraceId, recordedAt: "2031-03-04T05:06:07.890Z" },
        })),
      }));
      await store.appendToStreamsInTransaction(client, planted);
      return staged;
    });
  }

  it("transports Block and Unblock facts from the real store with only position, tenant and the two Accounts", async () => {
    const blocked = await admitWithPlantedMetadata(command("privacy-block", "block"));
    const unblocked = await admitWithPlantedMetadata(command("privacy-unblock", "unblock"));
    const stored = await store.readAll({ tenantId: syntheticTenantId, eventTypes: accountBlockTypes });
    expect(stored.map((event) => event.eventType)).toEqual([
      accountBlockBudgetRecordedEventType,
      accountBlockTransitionRecordedEventType,
      "identity.account-blocked",
      accountBlockBudgetRecordedEventType,
      accountBlockTransitionRecordedEventType,
      "identity.account-unblocked",
    ]);

    // The store really holds the planted values: User audit, trace, session metadata and process time.
    for (const event of stored) {
      expect(event.performedByUserId).toBe(initiatingUserId);
      expect(event.traceId).toBe(plantedTraceId);
      expect(event.metadata).toMatchObject({ sessionId: plantedSessionId });
      expect(event.recordedAt).toBe("2031-03-04T05:06:07.890Z");
      expect(JSON.stringify(event.payload)).not.toContain(initiatingUserId);
    }

    const forbidden = [
      initiatingUserId,
      plantedTraceId,
      plantedSpanId,
      plantedSessionId,
      "planted=state",
      "2031-03-04T05:06:07.890Z",
      "sessionId",
    ];
    for (const event of stored) {
      const transport = toTransportEvent(event);
      expect(transport.audit).toEqual(redactedTransportAudit);
      expect(transport.timing).toEqual(redactedTransportTiming);
      expect(transport.trace).toEqual({});
      expect(transport.metadata).toEqual({});
      const serialized = JSON.stringify(transport);
      for (const value of forbidden) expect(serialized).not.toContain(value);
    }

    const facts = stored.filter(
      (event) =>
        event.eventType.startsWith("identity.account-") && !event.eventType.startsWith("identity.account-block-"),
    );
    for (const [fact, staged] of [
      [facts[0]!, blocked],
      [facts[1]!, unblocked],
    ] as const) {
      const transport = toTransportEvent(fact);
      expect(Object.keys(transport).sort()).toEqual(
        [
          "audit",
          "data",
          "globalPosition",
          "id",
          "metadata",
          "streamId",
          "streamVersion",
          "tenantId",
          "timing",
          "trace",
          "type",
        ].sort(),
      );
      expect(transport.data).toEqual({ blockingAccountId, blockedAccountId });
      const serialized = JSON.stringify(transport);
      expect(serialized).not.toContain(staged.transitionId);
      expect(serialized).not.toContain(staged.effectiveAt);
      expect(transport.streamId).toBe(accountBlockPairStreamId(syntheticPair));
    }
  });

  it("fails closed on a stored public fact carrying planted recordedAt and traceId fields", async () => {
    const encoded = encodeAccountBlockTransition(
      syntheticPair,
      syntheticTransitionId("planted-fact"),
      "block",
      instant(Date.parse("2026-11-01T12:00:00.000Z")),
    );
    const plantedFact = {
      ...encoded.pairEvents[1],
      payload: { ...encoded.pairEvents[1].payload, recordedAt: "2031-03-04T05:06:07.890Z", traceId: plantedTraceId },
    };
    await withPgTransaction(pool, async (client) => {
      await store.appendToStreamsInTransaction(client, [
        {
          streamId: accountBlockBudgetStreamId(syntheticTenantId, blockingAccountId),
          expectedVersion: "no_stream",
          events: [encoded.budgetEvent],
          context: syntheticContext(),
        },
        {
          streamId: accountBlockPairStreamId(syntheticPair),
          expectedVersion: "no_stream",
          events: [encoded.pairEvents[0], plantedFact],
          context: syntheticContext(),
        },
      ]);
    });

    const [fact] = await store.readAll({ tenantId: syntheticTenantId, eventTypes: ["identity.account-blocked"] });
    expect(() => toTransportEvent(fact!)).toThrow("Account Block fact requires exactly");

    let code: string | undefined;
    try {
      await withPgTransaction(pool, (client) =>
        stageAccountBlockCommand(store, client, command("after-planted", "unblock")),
      );
    } catch (error) {
      code = error instanceof AccountBlockAuthorityError ? error.code : String(error);
    }
    expect(code).toBe("codec");
  });
});
