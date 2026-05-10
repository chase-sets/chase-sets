import { expect, it } from "vitest";
import {
  describeWithMarketplaceSeedDatabase,
  useMarketplaceSeedRuntime,
} from "@chase-sets/marketplace-seed-testing";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";

describeWithMarketplaceSeedDatabase("fulfillment seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("fulfillment");

  it("projects deterministic shipment lifecycle coverage", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    const shipmentStatuses = await pools.fulfillment.query<{ status: string }>(
      "SELECT status FROM fulfillment_shipment_pages ORDER BY shipment_id ASC",
    );
    expect(new Set(shipmentStatuses.rows.map((row) => row.status))).toEqual(
      new Set([
        "awaiting-package",
        "awaiting-label",
        "label-attached",
        "dispatched",
        "delivered",
        "returned",
        "exception",
      ]),
    );
    const shipmentEmails = await pools.fulfillment.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM notification_outbox
       WHERE message_type = 'fulfillment.shipment.delivered'
         AND channel = 'email'
         AND idempotency_key LIKE 'fulfillment:shipment_delivered:%'`,
    );
    expect(Number(shipmentEmails.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const before = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    await seedRuntime.seed();
    const after = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);

  it("seeds account web notifications for local marketplace testing", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    const notifications = await pools.fulfillment.query<{
      delivery_id: string;
      read_at: string | null;
    }>(
      `SELECT delivery_id, read_at::text AS read_at
       FROM web_notifications
       WHERE account_id = $1
       ORDER BY created_at ASC, delivery_id ASC`,
      [identitySeedIds.collector.accountId],
    );

    expect(notifications.rows.map((row) => row.delivery_id)).toEqual([
      "seed:fulfillment:notification:delivered",
      "seed:fulfillment:notification:exception",
    ]);
    expect(notifications.rows.filter((row) => row.read_at === null)).toHaveLength(1);

    await seedRuntime.seed();
    const after = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM web_notifications WHERE delivery_id LIKE 'seed:fulfillment:notification:%'",
    );
    expect(after.rows[0]?.count).toBe("2");
  }, 120_000);
});
