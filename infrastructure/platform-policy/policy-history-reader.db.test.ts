import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres/event-store";
import {
  createIsolatedPostgresTestSchema,
  type IsolatedPostgresTestSchema,
} from "@chase-sets/event-core-postgres/postgres-db-test-support";
import { createPolicyHistoryReader } from "./index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const context = {
  tenantId: "tnt_policy_history" as never,
  audit: { performedByUserId: "usr_policy_history" as never, forAccountId: "acc_policy_history" as never },
} satisfies EventStoreContext;

describeDb("gap-safe policy history reader", () => {
  let schema: IsolatedPostgresTestSchema;
  let eventStore: EventStore;

  beforeEach(async () => {
    schema ??= await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "policy_history_reader");
    await schema.reset();
    eventStore = createPostgresEventStore({ pool: schema.pool });
  });

  afterAll(async () => {
    await schema?.close();
  });

  it("reads created and revised events without a projection and fixes the horizon", async () => {
    await eventStore.appendToStream({
      streamId: "platform-policy.document-doc_db",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "platform-policy.document.created",
          payload: {
            documentId: "doc_db",
            policyKey: "pricing.shipping-window",
            contextName: "pricing",
            schemaSummary: "{ days: number }",
            status: "active",
            value: { days: 7 },
            effectiveFrom: "2026-01-01T00:00:00Z",
            effectiveUntil: null,
            actorUserId: "usr_policy_history",
          },
        },
        {
          eventType: "platform-policy.document.revised",
          payload: {
            documentId: "doc_db",
            policyKey: "pricing.shipping-window",
            status: "inactive",
            value: { days: 8 },
            effectiveFrom: "2026-02-01T00:00:00Z",
            effectiveUntil: null,
            actorUserId: "usr_policy_history",
          },
        },
      ],
    });

    const reader = createPolicyHistoryReader({ eventStore, pool: schema.pool });
    const start = await reader.start("pricing.shipping-window");
    const page = await reader.readPage(start.continuation);
    expect(page.records).toHaveLength(2);
    expect(page.records.map((record) => record.streamVersion)).toEqual([1, 2]);
    expect(page.complete).toBe(true);

    await eventStore.appendToStream({
      streamId: "platform-policy.document-doc_later",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "platform-policy.document.created",
          payload: {
            documentId: "doc_later",
            policyKey: "pricing.shipping-window",
            contextName: "pricing",
            schemaSummary: "{ days: number }",
            status: "active",
            value: { days: 9 },
            effectiveFrom: "2026-03-01T00:00:00Z",
            effectiveUntil: null,
            actorUserId: "usr_policy_history",
          },
        },
      ],
    });
    const secondPass = await reader.start("pricing.shipping-window");
    expect(secondPass.horizon).not.toBe(start.horizon);
    expect((await reader.readPage(secondPass.continuation)).records).toHaveLength(3);
  });
});
