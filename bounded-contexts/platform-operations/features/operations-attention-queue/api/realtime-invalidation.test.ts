import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { authorizeRealtimeTopics } from "@chase-sets/platform-runtime/realtime";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { withOperationsAttentionRealtimeInvalidation } from "./realtime-invalidation";
import { OPERATIONS_ATTENTION_REALTIME_TOPIC, platformOperationsRealtimeTopicPolicyManifest } from "./realtime-topics";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_platform_admin",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["projection-operations.view"],
} satisfies ResolvedActor;

function recordingDb() {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
    rows: sql.includes("RETURNING outbox_id") ? [{ outbox_id: "42" }] : [],
  }));
  return { db: { query } satisfies PgQueryable, query };
}

const event = {
  type: "support.request.opened",
  streamId: "support.request-sr_1",
  globalPosition: "9",
  streamPosition: "1",
  data: {},
  metadata: {},
  timing: { recordedAt: "2026-11-21T12:00:00.000Z" },
} as never;

describe("Operations Attention realtime topic", () => {
  it("admits staff who may open the queue and refuses everyone else", () => {
    expect(
      authorizeRealtimeTopics(
        [OPERATIONS_ATTENTION_REALTIME_TOPIC],
        actor,
        platformOperationsRealtimeTopicPolicyManifest,
      ),
    ).toEqual([OPERATIONS_ATTENTION_REALTIME_TOPIC]);
    expect(
      authorizeRealtimeTopics(
        [OPERATIONS_ATTENTION_REALTIME_TOPIC],
        { ...actor, permissions: ["support.manage", "platform-feedback.view"] },
        platformOperationsRealtimeTopicPolicyManifest,
      ),
    ).toBeNull();
    expect(
      authorizeRealtimeTopics(
        [OPERATIONS_ATTENTION_REALTIME_TOPIC],
        null,
        platformOperationsRealtimeTopicPolicyManifest,
      ),
    ).toBeNull();
  });

  it("records an invalidation naming only the source after the projection handler writes", async () => {
    const { db, query } = recordingDb();
    const handler = vi.fn(async () => {
      await db.query("UPDATE support_requests SET status = $1", ["open"]);
    });
    const handlers = withOperationsAttentionRealtimeInvalidation({ "support.request.opened": handler }, db, {
      projectionName: "support-request-projection",
      source: "support-request-deadline",
    });

    await handlers["support.request.opened"]?.(event);

    expect(handler).toHaveBeenCalledOnce();
    const sql = query.mock.calls.map(([statement]) => statement);
    expect(sql[0]).toContain("UPDATE support_requests");
    const outbox = query.mock.calls.find(([statement]) => statement.includes("INSERT INTO realtime_projection_outbox"));
    const values = outbox?.[1] as readonly unknown[];
    expect(values[0]).toBe("9");
    expect(values[1]).toBe("support-request-projection");
    expect(values[2]).toBe("support-request-deadline");
    expect(JSON.parse(String(values[4]))).toEqual({
      kind: "projection.patch",
      context: "platform-operations",
      projection: "support-request-projection",
      topics: [OPERATIONS_ATTENTION_REALTIME_TOPIC],
      changes: [
        {
          op: "summary",
          entity: "platformOperations.operationsAttention",
          id: "support-request-deadline",
          value: { source: "support-request-deadline" },
        },
      ],
    });
  });

  it("writes the invalidation through the projection's transaction", async () => {
    const base = recordingDb();
    const tx = recordingDb();
    const handler = vi.fn(async () => undefined);
    const handlers = withOperationsAttentionRealtimeInvalidation({ "support.request.opened": handler }, base.db, {
      projectionName: "support-request-projection",
      source: "support-request-deadline",
    });

    await handlers["support.request.opened"]?.(event, { db: tx.db as never });

    expect(handler).toHaveBeenCalledWith(expect.any(Object), { db: tx.db });
    expect(base.query).not.toHaveBeenCalled();
    expect(
      tx.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO realtime_projection_outbox")),
    ).toBe(true);
  });

  it("records nothing when the projection handler fails", async () => {
    const { db, query } = recordingDb();
    const handlers = withOperationsAttentionRealtimeInvalidation(
      {
        "support.request.opened": async () => {
          throw new Error("projection failed");
        },
      },
      db,
      { projectionName: "support-request-projection", source: "support-request-deadline" },
    );

    await expect(handlers["support.request.opened"]?.(event)).rejects.toThrow("projection failed");
    expect(query).not.toHaveBeenCalled();
  });
});
