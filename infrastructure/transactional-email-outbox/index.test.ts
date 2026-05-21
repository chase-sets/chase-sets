import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedTransactionalEmail,
  TransactionalEmailMessage,
  TransactionalEmailOutboxStore,
} from "@chase-sets/communications-email";
import {
  createPostgresTransactionalEmailOutbox,
  createTransactionalEmailOutboxDispatcher,
  transactionalEmailOutboxSchemaSql,
} from "./index";

const message: TransactionalEmailMessage = {
  messageType: "ordering.order.created",
  criticality: "commerce",
  to: [{ email: "buyer@example.com" }],
  subject: "Order confirmed",
  templateId: "order_confirmed",
  templateVersion: 1,
  locale: "en",
  templateData: { orderId: "ord_1" },
  idempotencyKey: "ordering:order_confirmed:ord_1",
  correlationId: "req_1",
  actor: { userId: null, accountId: null },
};

describe("transactional email outbox", () => {
  it("records transactional email messages by idempotency key", async () => {
    const queries: unknown[][] = [];
    const db = {
      query: vi.fn(async (_sql: string, values?: readonly unknown[]) => {
        queries.push([...(values ?? [])]);
        return { rows: [], rowCount: 1 };
      }),
    };
    const outbox = createPostgresTransactionalEmailOutbox({
      db,
      now: () => new Date("2026-04-02T00:00:00.000Z"),
    });

    await outbox.enqueueTransactionalEmail({
      message,
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-transactional-email-projection",
        occurredAt: "2026-04-02T00:00:00.000Z",
      },
    });

    expect(db.query).toHaveBeenCalledOnce();
    expect(queries[0]?.[0]).toBe(message.idempotencyKey);
    expect(queries[0]?.[4]).toBe(JSON.stringify(message));
    expect(transactionalEmailOutboxSchemaSql).toContain("transactional_email_outbox");
  });

  it("dispatches claimed messages and records sent receipts", async () => {
    const outbox = createMemoryOutbox([
      {
        outboxId: "1",
        message,
        source: {
          sourceEventId: "evt_1",
          sourceGlobalPosition: "12",
          projectionName: "ordering-order-transactional-email-projection",
          occurredAt: "2026-04-02T00:00:00.000Z",
        },
        status: "sending",
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        nextAttemptAt: "2026-04-02T00:00:00.000Z",
        lastError: null,
      },
    ]);
    const gateway = {
      sendTransactionalEmail: vi.fn(async () => ({
        providerName: "amazon-ses" as const,
        providerMessageId: "msg_1",
        acceptedAt: "2026-04-02T00:00:01.000Z",
        attemptCount: 1,
      })),
    };
    const dispatcher = createTransactionalEmailOutboxDispatcher({
      outbox,
      gateway,
      claimOwnerId: "worker_1",
      now: () => new Date("2026-04-02T00:00:00.000Z"),
    });

    const result = await dispatcher.runOnce();

    expect(result.processed).toBe(1);
    expect(gateway.sendTransactionalEmail).toHaveBeenCalledWith(message);
    expect(outbox.sent).toEqual([message.idempotencyKey]);
  });
});

function createMemoryOutbox(claimed: readonly ClaimedTransactionalEmail[]): TransactionalEmailOutboxStore &
  Readonly<{
    sent: readonly string[];
  }> {
  const sent: string[] = [];

  return {
    sent,
    async enqueueTransactionalEmail() {
      return undefined;
    },
    async claimPendingTransactionalEmails() {
      return claimed;
    },
    async markTransactionalEmailSent(input) {
      sent.push(input.idempotencyKey);
    },
    async markTransactionalEmailFailed() {
      return undefined;
    },
  };
}
