import { describe, expect, it, vi } from "vitest";
import { createPostgresAgentWebhookOutbox } from "./agent-webhook-outbox";

function fakeDb(rows: readonly unknown[] = []) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    }),
  };
  return { db: db as never, calls };
}

const now = () => new Date("2026-07-08T00:00:00.000Z");

describe("agent webhook outbox", () => {
  it("enqueues idempotently on the idempotency key", async () => {
    const { db, calls } = fakeDb();
    const outbox = createPostgresAgentWebhookOutbox({ db, now });
    await outbox.enqueueDelivery({
      clientId: "ocl_1",
      accountId: "acc_buyer",
      callbackUrl: "https://agent.example/hooks",
      sourceEventId: "evt_1",
      eventType: "ordering.order.created",
      orderId: "ord_1",
      orderStatus: "created",
      payloadJson: "{}",
      idempotencyKey: "ocl_1:evt_1:ord_1",
    });
    expect(calls[0].sql).toContain("INSERT INTO identity_agent_webhook_deliveries");
    expect(calls[0].sql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(calls[0].values[0]).toBe("ocl_1:evt_1:ord_1");
    expect(calls[0].values).toContain("acc_buyer");
  });

  it("claims pending deliveries and maps rows", async () => {
    const { db, calls } = fakeDb([
      {
        outbox_id: 7,
        delivery_id: "ocl_1:evt_1:ord_1",
        client_id: "ocl_1",
        account_id: "acc_buyer",
        callback_url: "https://agent.example/hooks",
        source_event_id: "evt_1",
        event_type: "ordering.order.created",
        order_id: "ord_1",
        order_status: "created",
        payload_json: "{}",
        status: "sending",
        attempt_count: 1,
        max_attempts: 8,
        next_attempt_at: "2026-07-08T00:00:00.000Z",
        last_error: null,
      },
    ]);
    const outbox = createPostgresAgentWebhookOutbox({ db, now });
    const claimed = await outbox.claimPendingDeliveries({ limit: 10, claimOwnerId: "worker-1", claimTtlMs: 60_000 });
    expect(calls[0].sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ deliveryId: "ocl_1:evt_1:ord_1", clientId: "ocl_1", attemptCount: 1 });
  });

  it("marks a delivery sent", async () => {
    const { db, calls } = fakeDb();
    const outbox = createPostgresAgentWebhookOutbox({ db, now });
    await outbox.markDelivered({ deliveryId: "d1", responseStatus: 202 });
    expect(calls[0].sql).toContain("SET status = 'sent'");
    expect(calls[0].values).toEqual(["2026-07-08T00:00:00.000Z", 202, "d1"]);
  });

  it("returns a failed delivery to pending when a retry time is supplied", async () => {
    const { db, calls } = fakeDb();
    const outbox = createPostgresAgentWebhookOutbox({ db, now });
    await outbox.markFailed({
      deliveryId: "d1",
      error: "boom",
      responseStatus: 500,
      retryAt: "2026-07-08T00:05:00.000Z",
    });
    expect(calls[0].values[1]).toBe("pending");
    expect(calls[0].values[2]).toBe("2026-07-08T00:05:00.000Z");
  });

  it("dead-letters a failed delivery when no retry time is supplied", async () => {
    const { db, calls } = fakeDb();
    const outbox = createPostgresAgentWebhookOutbox({ db, now });
    await outbox.markFailed({ deliveryId: "d1", error: "exhausted", retryAt: null });
    expect(calls[0].values[1]).toBe("failed");
    expect(calls[0].values[2]).toBeNull();
  });

  it("lists dead-lettered deliveries for ops", async () => {
    const { db, calls } = fakeDb([]);
    const outbox = createPostgresAgentWebhookOutbox({ db, now });
    await outbox.listDeadLettered(50);
    expect(calls[0].sql).toContain("WHERE status = 'failed'");
    expect(calls[0].values).toEqual([50]);
  });
});
