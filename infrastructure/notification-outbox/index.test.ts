import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedNotificationDelivery,
  NotificationMessage,
  NotificationOutboxStore,
  RenewClaimedNotificationDeliveryInput,
} from "@chase-sets/outbound-messaging";
import {
  createNotificationOutboxDispatcher,
  createPostgresNotificationOutbox,
  notificationOutboxSchemaSql,
} from "./index";

const message: NotificationMessage = {
  messageType: "ordering.order.created",
  criticality: "commerce",
  title: "Order confirmed",
  body: "Order ord_1 is confirmed.",
  actionHref: "/account/purchases/ord_1",
  templateId: "order_confirmed",
  templateVersion: 1,
  locale: "en",
  templateData: { orderId: "ord_1" },
  channels: [
    { channel: "email", to: [{ email: "buyer@example.com" }] },
    {
      channel: "sms",
      to: { e164: "+15551234567" },
      body: "Order ord_1 is confirmed.",
    },
    {
      channel: "rcs",
      to: { e164: "+15551234567" },
      title: "Order confirmed",
      body: "Order ord_1 is confirmed.",
      actionHref: "/account/purchases/ord_1",
      smsFallback: {
        to: { e164: "+15551234567" },
        body: "Order ord_1 is confirmed.",
      },
    },
    {
      channel: "web",
      recipient: { accountId: "acc_buyer" as never },
      actionHref: "/account/purchases/ord_1",
    },
  ],
  idempotencyKey: "ordering:order_confirmed:ord_1",
  correlationId: "req_1",
  actor: { userId: null, accountId: null },
};

describe("notification outbox", () => {
  it("records one delivery per requested channel", async () => {
    const expandedChannelMessage: NotificationMessage = {
      ...message,
      channels: [
        ...message.channels,
        {
          channel: "push",
          recipient: { accountId: "acc_buyer" as never },
          title: "Order confirmed",
          body: "Order ord_1 is confirmed.",
          actionHref: "/account/purchases/ord_1",
        },
      ],
    };
    const queries: unknown[][] = [];
    const db = {
      query: vi.fn(async (_sql: string, values?: readonly unknown[]) => {
        queries.push([...(values ?? [])]);
        return { rows: [], rowCount: 1 };
      }),
    };
    const outbox = createPostgresNotificationOutbox({
      db,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    await outbox.enqueueNotification({
      message: expandedChannelMessage,
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-notification-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(db.query).toHaveBeenCalledTimes(5);
    expect(queries[0]?.[0]).toBe("notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_1:email:1");
    expect(queries[1]?.[0]).toBe("notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_1:sms:2");
    expect(queries[2]?.[0]).toBe("notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_1:rcs:3");
    expect(queries[3]?.[0]).toBe("notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_1:web:4");
    expect(queries[4]?.[0]).toBe("notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_1:push:5");
    expect(notificationOutboxSchemaSql).toContain("notification_outbox");
    expect(notificationOutboxSchemaSql).toContain("notification_outbox_terminal_retention_idx");
    expect(notificationOutboxSchemaSql).not.toContain("channel IN ('email', 'web')");
  });

  it("records a single email delivery by the message idempotency key", async () => {
    const queries: unknown[][] = [];
    const db = {
      query: vi.fn(async (_sql: string, values?: readonly unknown[]) => {
        queries.push([...(values ?? [])]);
        return { rows: [], rowCount: 1 };
      }),
    };
    const outbox = createPostgresNotificationOutbox({
      db,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    await outbox.enqueueNotification({
      message: {
        ...message,
        channels: [{ channel: "email", to: [{ email: "seller@example.com" }], subject: "Payout completed" }],
        idempotencyKey: "settlement:payout_completed:po_123",
      },
      source: {
        sourceEventId: "evt_2",
        sourceGlobalPosition: "13",
        projectionName: "settlement-payout-transactional-email-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(db.query).toHaveBeenCalledOnce();
    expect(queries[0]?.[0]).toBe("settlement:payout_completed:po_123");
    expect(queries[0]?.[1]).toBe("settlement:payout_completed:po_123");
    expect(queries[0]?.[2]).toBe("email");
  });

  it("dispatches claimed deliveries through their channel adapters", async () => {
    const delivery: ClaimedNotificationDelivery = {
      outboxId: "1",
      deliveryId: "ordering:order_confirmed:ord_1:web:4",
      message,
      channel: message.channels[3],
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-notification-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
      status: "sending",
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      nextAttemptAt: "2026-05-09T00:00:00.000Z",
      lastError: null,
    };
    const outbox = createMemoryOutbox([delivery]);
    const adapter = {
      channel: "web" as const,
      sendNotificationChannel: vi.fn(async () => ({
        channel: "web" as const,
        providerName: "web-notification-feed" as const,
        providerMessageId: "web_1",
        acceptedAt: "2026-05-09T00:00:01.000Z",
        attemptCount: 1,
      })),
    };
    const dispatcher = createNotificationOutboxDispatcher({
      outbox,
      adapters: [adapter],
      claimOwnerId: "worker_1",
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    const result = await dispatcher.runOnce();

    expect(result.processed).toBe(1);
    expect(outbox.renewed).toEqual([
      {
        deliveryId: delivery.deliveryId,
        claimOwnerId: "worker_1",
        claimTtlMs: 60_000,
        now: "2026-05-09T00:00:00.000Z",
      },
    ]);
    expect(adapter.sendNotificationChannel).toHaveBeenCalledWith(delivery);
    expect(outbox.sent).toEqual([delivery.deliveryId]);
  });

  it("renews a claimed delivery before sending so another dispatcher cannot claim it mid-batch", async () => {
    const delivery: ClaimedNotificationDelivery = {
      outboxId: "1",
      deliveryId: "ordering:order_confirmed:ord_1:web:4",
      message,
      channel: message.channels[3],
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-notification-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
      status: "sending",
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      nextAttemptAt: "2026-05-09T00:00:00.000Z",
      lastError: null,
    };
    const outbox = createMemoryOutbox([delivery]);
    const adapter = {
      channel: "web" as const,
      sendNotificationChannel: vi.fn(async () => {
        expect(outbox.claimableBySecondDispatcherAt("2026-05-09T00:01:30.000Z")).toEqual([]);
        return {
          channel: "web" as const,
          providerName: "web-notification-feed" as const,
          providerMessageId: "web_1",
          acceptedAt: "2026-05-09T00:01:30.000Z",
          attemptCount: 1,
        };
      }),
    };
    const dispatcher = createNotificationOutboxDispatcher({
      outbox,
      adapters: [adapter],
      claimOwnerId: "worker_1",
      claimTtlMs: 120_000,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    await dispatcher.runOnce();

    expect(adapter.sendNotificationChannel).toHaveBeenCalledOnce();
    expect(outbox.renewed).toHaveLength(1);
  });

  it("dispatches future channels through configured adapters", async () => {
    const delivery: ClaimedNotificationDelivery = {
      outboxId: "1",
      deliveryId: "identity:security_notice:1:secure-inbox:1",
      message: {
        messageType: "identity.security.notice",
        criticality: "security",
        title: "Security notice",
        body: "Review your account.",
        templateId: "security_notice",
        templateVersion: 1,
        locale: "en",
        templateData: {},
        channels: [
          {
            channel: "secure-inbox",
            payload: { severity: "high" },
          },
        ],
        idempotencyKey: "identity:security_notice:1",
        correlationId: "req_1",
        actor: { userId: null, accountId: null },
      },
      channel: {
        channel: "secure-inbox",
        payload: { severity: "high" },
      },
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "identity-security-notification-projection",
        occurredAt: "2026-05-15T00:00:00.000Z",
      },
      status: "sending",
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
      nextAttemptAt: "2026-05-15T00:00:00.000Z",
      lastError: null,
    };
    const outbox = createMemoryOutbox([delivery]);
    const adapter = {
      channel: "secure-inbox" as const,
      sendNotificationChannel: vi.fn(async () => ({
        channel: "secure-inbox" as const,
        providerName: "internal-secure-inbox" as const,
        providerMessageId: "secure_1",
        acceptedAt: "2026-05-15T00:00:01.000Z",
        attemptCount: 1,
      })),
    };
    const dispatcher = createNotificationOutboxDispatcher({
      outbox,
      adapters: [adapter],
      claimOwnerId: "worker_1",
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });

    const result = await dispatcher.runOnce();

    expect(result.processed).toBe(1);
    expect(adapter.sendNotificationChannel).toHaveBeenCalledWith(delivery);
    expect(outbox.sent).toEqual([delivery.deliveryId]);
  });

  it("returns failed provider sends to pending status with a retry delay", async () => {
    const delivery: ClaimedNotificationDelivery = {
      outboxId: "2",
      deliveryId: "ordering:order_confirmed:ord_1:sms:2",
      message,
      channel: message.channels[1],
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-notification-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
      status: "sending",
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      nextAttemptAt: "2026-05-09T00:00:00.000Z",
      lastError: null,
    };
    const outbox = createMemoryOutbox([delivery]);
    const adapter = {
      channel: "sms" as const,
      sendNotificationChannel: vi.fn(async () => {
        throw new Error("Twilio temporarily unavailable.");
      }),
    };
    const dispatcher = createNotificationOutboxDispatcher({
      outbox,
      adapters: [adapter],
      claimOwnerId: "worker_1",
      retryDelayMs: () => 60_000,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    const result = await dispatcher.runOnce();

    expect(result.processed).toBe(1);
    expect(outbox.failed).toEqual([
      {
        deliveryId: delivery.deliveryId,
        error: "Twilio temporarily unavailable.",
        retryAt: "2026-05-09T00:01:00.000Z",
        now: "2026-05-09T00:00:00.000Z",
      },
    ]);
  });

  it("uses a live owner fence when renewing a Postgres delivery claim", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }),
    };
    const outbox = createPostgresNotificationOutbox({ db });

    await expect(
      outbox.renewClaimedNotificationDelivery({
        deliveryId: "ordering:order_confirmed:ord_1:web:4",
        claimOwnerId: "worker_1",
        claimTtlMs: 120_000,
        now: "2026-05-09T00:00:00.000Z",
      }),
    ).resolves.toBe(true);

    expect(calls[0]?.sql).toContain("claim_owner_id = $3");
    expect(calls[0]?.sql).toContain("status = 'sending'");
    expect(calls[0]?.sql).toContain("claimed_until > $1::timestamptz");
    expect(calls[0]?.values).toEqual([
      "2026-05-09T00:00:00.000Z",
      "ordering:order_confirmed:ord_1:web:4",
      "worker_1",
      "2026-05-09T00:02:00.000Z",
    ]);
  });

  it("recovers expired sending deliveries that exhausted their final attempt before claiming more work", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }),
    };
    const outbox = createPostgresNotificationOutbox({ db });

    await outbox.claimPendingNotificationDeliveries({
      limit: 50,
      claimOwnerId: "worker_1",
      claimTtlMs: 60_000,
      now: "2026-05-09T00:00:00.000Z",
    });

    expect(calls[0]?.sql).toContain("status = 'sending'");
    expect(calls[0]?.sql).toContain("attempt_count >= max_attempts");
    expect(calls[0]?.sql).toContain("SET status = 'failed'");
    expect(calls[0]?.sql).toContain("last_error = $5");
    expect(calls[0]?.values[4]).toBe("attempts exhausted after crash");
  });
});

function createMemoryOutbox(claimed: readonly ClaimedNotificationDelivery[]): NotificationOutboxStore &
  Readonly<{
    sent: readonly string[];
    renewed: readonly RenewClaimedNotificationDeliveryInput[];
    failed: readonly {
      deliveryId: string;
      error: string;
      retryAt: string | null | undefined;
      now: string | undefined;
    }[];
    claimableBySecondDispatcherAt: (at: string) => readonly string[];
  }> {
  const sent: string[] = [];
  const renewed: RenewClaimedNotificationDeliveryInput[] = [];
  const failed: {
    deliveryId: string;
    error: string;
    retryAt: string | null | undefined;
    now: string | undefined;
  }[] = [];
  const claimedUntilByDeliveryId = new Map<string, string>(
    claimed.map((delivery) => [delivery.deliveryId, "2026-05-09T00:01:00.000Z"]),
  );

  return {
    sent,
    renewed,
    failed,
    claimableBySecondDispatcherAt(at) {
      return claimed
        .filter((delivery) => {
          const claimedUntil = claimedUntilByDeliveryId.get(delivery.deliveryId);
          return delivery.attemptCount < delivery.maxAttempts && claimedUntil !== undefined && claimedUntil <= at;
        })
        .map((delivery) => delivery.deliveryId);
    },
    async enqueueNotification() {
      return undefined;
    },
    async claimPendingNotificationDeliveries() {
      return claimed;
    },
    async renewClaimedNotificationDelivery(input) {
      renewed.push(input);
      claimedUntilByDeliveryId.set(
        input.deliveryId,
        new Date(new Date(input.now ?? "2026-05-09T00:00:00.000Z").getTime() + input.claimTtlMs).toISOString(),
      );
      return true;
    },
    async markNotificationDeliverySent(input) {
      sent.push(input.deliveryId);
    },
    async markNotificationDeliveryFailed(input) {
      failed.push({
        deliveryId: input.deliveryId,
        error: input.error,
        retryAt: input.retryAt,
        now: input.now,
      });
      return undefined;
    },
  };
}
