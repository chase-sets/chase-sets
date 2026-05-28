import { expect, it } from "vitest";
import { describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "@chase-sets/marketplace-seed-testing";

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
    const before = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    await seedRuntime.seed();
    const after = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 240_000);
});
