import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { compareGlobalPosition } from "@chase-sets/event-core/storage";
import {
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  createPostgresEventStore,
  readGapSafeEventStoreHead,
  type PgPoolClient,
} from "@chase-sets/event-core-postgres";
import {
  createIsolatedPostgresTestSchema,
  type IsolatedPostgresTestSchema,
} from "@chase-sets/event-core-postgres/postgres-db-test-support";
import { definePolicy } from "./define-policy";
import { createPolicyHistoryReader } from "./index";
import { platformPolicySchemaSql } from "./schema";
import { createPolicyRuntime } from "./runtime";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const context = {
  tenantId: "tnt_policy_history" as never,
  audit: { performedByUserId: "usr_policy_history" as never, forAccountId: "acc_policy_history" as never },
};
const policy = definePolicy({
  policyKey: "pricing.shipping-window",
  contextName: "pricing",
  schemaSummary: "{ days: number }",
  defaultValue: { days: 1 },
  decodeValue(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid policy value");
    return raw as { days: number };
  },
});

describeDb("gap-safe policy history reader", () => {
  let schema: IsolatedPostgresTestSchema;
  let eventStore: EventStore;

  beforeEach(async () => {
    schema ??= await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "policy_history_reader");
    await schema.reset();
    await schema.pool.query(platformPolicySchemaSql);
    eventStore = createPostgresEventStore({ pool: schema.pool });
  });

  afterAll(async () => {
    await schema?.close();
  });

  it("gap-safe policy history without projections", async () => {
    const runtime = createPolicyRuntime({ eventStore, db: schema.pool });
    const created = await runtime.createPolicyDocument(
      policy,
      {
        value: { days: 7 },
        status: "active",
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveUntil: null,
        actorUserId: "usr_policy_history",
      },
      context,
    );
    await runtime.revisePolicyDocument(
      policy,
      created.documentId,
      {
        value: { days: 8 },
        status: "inactive",
        effectiveFrom: "2026-02-01T00:00:00Z",
        effectiveUntil: null,
        actorUserId: "usr_policy_history",
      },
      context,
    );

    const reader = createPolicyHistoryReader({ eventStore, pool: schema.pool });
    const inflight = await beginUncommittedPolicyAppend(schema.pool, "doc-inflight");
    let released = false;
    const waitingStart = reader.start(policy.policyKey);
    try {
      await expect(hasSettledWithin(waitingStart, 50)).resolves.toBe(false);
      await inflight.query("ROLLBACK");
      inflight.release();
      released = true;

      const oldStart = await waitingStart;
      const expectedOldHorizon = await readGapSafeEventStoreHead(schema.pool);
      expect(oldStart.horizon).toBe(expectedOldHorizon);
      const oldPage = await reader.readPage(oldStart.continuation);
      expect(oldPage.records).toHaveLength(2);
      expect(oldPage.complete).toBe(true);

      await runtime.createPolicyDocumentWithId(
        policy,
        "doc-later",
        {
          value: { days: 9 },
          status: "active",
          effectiveFrom: "2026-03-01T00:00:00Z",
          effectiveUntil: null,
          actorUserId: "usr_policy_history",
        },
        context,
      );

      const oldPageAfterAppend = await reader.readPage(oldStart.continuation);
      expect(oldPageAfterAppend.records).toHaveLength(2);
      expect(oldPageAfterAppend.records.every((record) => record.documentId !== "doc-later")).toBe(true);
      expect(oldPageAfterAppend.complete).toBe(true);
      expect(oldPageAfterAppend.horizon).toBe(oldStart.horizon);

      const newStart = await reader.start(policy.policyKey);
      expect(compareGlobalPosition(newStart.horizon, oldStart.horizon)).toBeGreaterThan(0);
      expect(newStart.horizon).toBe(await readGapSafeEventStoreHead(schema.pool));
      expect((await reader.readPage(newStart.continuation)).records).toHaveLength(3);
    } finally {
      if (!released) {
        await inflight.query("ROLLBACK").catch(() => undefined);
        inflight.release();
      }
    }
  });
});

async function beginUncommittedPolicyAppend(
  pool: IsolatedPostgresTestSchema["pool"],
  documentId: string,
): Promise<PgPoolClient> {
  const client = await pool.connect();
  const streamId = `platform-policy.document-${documentId}`;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock_shared($1::bigint)", [
      EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
    ]);
    await client.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ($1, 1, $2::timestamptz)`,
      [streamId, "2026-01-01T00:00:00.000Z"],
    );
    await client.query(
      `INSERT INTO event_store_events (
         event_id, stream_id, stream_version, tenant_id, stream_context_name,
         stream_category, event_type, payload, metadata, occurred_at,
         recorded_at, performed_by_user_id, for_account_id
       ) VALUES (
         $1, $2, 1, 'tnt_policy_history', 'platform-policy',
         'platform-policy.document', 'platform-policy.document.created', $3::jsonb,
         '{}'::jsonb, $4::timestamptz, $4::timestamptz,
         'usr_policy_history', 'acc_policy_history'
       )`,
      [
        `evt_${documentId}`,
        streamId,
        JSON.stringify({
          documentId,
          policyKey: policy.policyKey,
          contextName: "pricing",
          schemaSummary: "{ days: number }",
          status: "active",
          value: { days: 10 },
          effectiveFrom: "2026-04-01T00:00:00Z",
          effectiveUntil: null,
          actorUserId: "usr_policy_history",
        }),
        "2026-04-01T00:00:00.000Z",
      ],
    );
    return client;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(error);
    throw error;
  }
}

async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
