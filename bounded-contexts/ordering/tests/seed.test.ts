import { expect, it } from "vitest";
import {
  describeWithMarketplaceSeedDatabase,
  useMarketplaceSeedRuntime,
} from "@chase-sets/marketplace-seed-testing";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";

describeWithMarketplaceSeedDatabase("ordering seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("ordering");

  it("seeds account web notifications for local marketplace testing", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    const notifications = await pools.ordering.query<{
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
      "seed:ordering:notification:checkout-pending",
      "seed:ordering:notification:accepted-offer-ready",
    ]);
    expect(notifications.rows.filter((row) => row.read_at === null)).toHaveLength(1);

    await seedRuntime.seed();
    const after = await pools.ordering.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM web_notifications WHERE delivery_id LIKE 'seed:ordering:notification:%'",
    );
    expect(after.rows[0]?.count).toBe("2");
  }, 120_000);
});
