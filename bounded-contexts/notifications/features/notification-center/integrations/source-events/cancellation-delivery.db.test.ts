import { expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createIsolatedPostgresTestSchema } from "@chase-sets/event-core-postgres/postgres-db-test-support";
import { createPostgresNotificationOutbox, notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { OrderingOrderCancelledPayload } from "@chase-sets/event-core/public-event-payloads";
import { buildNotificationsOrderingProjectionHandlers } from "./notification-projector";

it("cancellation replay stores one web row and one later email row", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for cancellation delivery persistence proof");
  const databaseUrls = createMultiContextTestDatabaseUrls(databaseUrl, ["notifications"], "cancellation_delivery");
  const ownedDatabase = new URL(databaseUrls.notifications);
  const databaseName = ownedDatabase.pathname.slice(1);
  const roleName = ownedDatabase.username;
  if (!/^[a-z0-9_]+$/.test(databaseName) || !/^[a-z0-9_]+$/.test(roleName)) {
    throw new Error("Expected generated test database identifiers");
  }
  const adminPools = createMultiContextTestPools({ admin: databaseUrl });
  let schema: Awaited<ReturnType<typeof createIsolatedPostgresTestSchema>> | undefined;
  try {
    await ensureMultiContextTestDatabases(databaseUrl, databaseUrls);
    schema = await createIsolatedPostgresTestSchema(databaseUrls.notifications, "notifications_cancellation");
    const { pool } = schema;
    await pool.query(notificationOutboxSchemaSql);
    const outbox = createPostgresNotificationOutbox({ db: pool });
    const handler = buildNotificationsOrderingProjectionHandlers(outbox)["ordering.order.cancelled"];
    if (!handler) throw new Error("Missing ordering cancellation handler");
    const orderId = "ord_synthetic_cancellation";
    const key = `notifications:ordering:order_cancelled:${orderId}`;
    const deliveryPrefix =
      "notification-delivery:v1:notifications%3Aordering%3Aorder_cancelled%3Aord_synthetic_cancellation";
    const webId = `${deliveryPrefix}:web:1`;
    const emailId = `${deliveryPrefix}:email:2`;
    async function enqueue(buyerEmail: string | null, position: number) {
      const data: OrderingOrderCancelledPayload = {
        orderId,
        buyerEmail,
        buyerAccountId: "acc_buyer",
        reason: "payment-deadline",
        statusBeforeCancellation: "pending-payment",
        cancelledAt: "2026-09-02T00:00:00.000Z",
        reservationRequests: [],
      };
      const event: TransportEvent = {
        id: `evt_synthetic_${position}`,
        tenantId: "tnt_synthetic",
        streamId: "synthetic_stream",
        streamVersion: position,
        globalPosition: parseGlobalPosition(String(position)),
        trace: { traceId: `synthetic_trace_${position}` },
        audit: { performedByUserId: `usr_synthetic_${position}`, forAccountId: `acc_synthetic_${position}` },
        timing: {
          occurredAt: parseIsoUtcTimestamp("2026-09-02T00:00:00.000Z"),
          recordedAt: parseIsoUtcTimestamp("2026-09-02T00:00:00.000Z"),
        },
        metadata: {},
        type: "ordering.order.cancelled",
        data,
      };
      await handler!(event);
    }
    const readRows = async () =>
      (
        await pool.query<{
          delivery_id: string;
          idempotency_key: string;
          channel: string;
          message_json: string;
          channel_json: string;
          status: string;
        }>(
          "SELECT delivery_id, idempotency_key, channel, message_json, channel_json, status FROM notification_outbox ORDER BY channel",
        )
      ).rows;

    await enqueue(null, 1);
    const initial = await readRows();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ delivery_id: webId, idempotency_key: key, channel: "web", status: "pending" });
    await outbox.markNotificationDeliverySent({
      deliveryId: webId,
      receipt: {
        channel: "web",
        providerName: "synthetic_web",
        providerMessageId: "synthetic_receipt",
        acceptedAt: "2026-09-02T00:00:00.000Z",
        attemptCount: 1,
      },
    });
    await enqueue("buyer@example.test", 2);
    await enqueue(null, 3);
    await enqueue("buyer@example.test", 4);
    const stored = await readRows();
    expect(
      stored.map(({ delivery_id, idempotency_key, channel, status }) => ({
        delivery_id,
        idempotency_key,
        channel,
        status,
      })),
    ).toEqual([
      { delivery_id: emailId, idempotency_key: key, channel: "email", status: "pending" },
      { delivery_id: webId, idempotency_key: key, channel: "web", status: "sent" },
    ]);
    expect(stored[1]?.message_json).toBe(initial[0]?.message_json);
    expect(stored[1]?.channel_json).toBe(initial[0]?.channel_json);
    expect(JSON.parse(stored[0]!.channel_json)).toEqual({ channel: "email", to: [{ email: "buyer@example.test" }] });
  } finally {
    try {
      await schema?.close();
    } finally {
      try {
        await adminPools.admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await adminPools.admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      } finally {
        await closeMultiContextTestPools(adminPools);
      }
    }
  }
});
