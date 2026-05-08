import { expect, it } from "vitest";
import {
  describeWithMarketplaceSeedDatabase,
  useMarketplaceSeedRuntime,
} from "@chase-sets/marketplace-seed-testing";

describeWithMarketplaceSeedDatabase("reputation seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("reputation");

  it("creates review lifecycle projections and summary data", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    const reviewStatuses = await pools.reputation.query<{ status: string }>(
      "SELECT status FROM reputation_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["active", "withdrawn"]),
    );

    const summary = await pools.reputation.query<{
      review_count: number;
      average_rating: string | null;
    }>(
      "SELECT review_count, average_rating::text AS average_rating FROM review_summary_pages",
    );
    expect(summary.rows[0]).toMatchObject({
      review_count: 1,
      average_rating: "5.00",
    });

    const before = await pools.reputation.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    await seedRuntime.seed();
    const after = await pools.reputation.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);
});
