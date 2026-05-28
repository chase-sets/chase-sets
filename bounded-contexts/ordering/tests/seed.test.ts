import { expect, it } from "vitest";
import { describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "@chase-sets/marketplace-seed-testing";

describeWithMarketplaceSeedDatabase("ordering seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("ordering");

  it("seeds deterministic order coverage idempotently", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();
    await seedRuntime.seed();

    const before = await pools.ordering.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'ordering.%'",
    );

    await seedRuntime.seed();
    const after = await pools.ordering.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'ordering.%'",
    );

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 240_000);
});
