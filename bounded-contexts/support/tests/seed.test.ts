import { expect, it } from "vitest";
import { describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "@chase-sets/marketplace-seed-testing";
import { supportSeedIds } from "../support/seed-support/ids";

describeWithMarketplaceSeedDatabase("support seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("support");

  it("creates support requests and cross-context effects for local development", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    const supportRequests = await pools.support.query<{
      support_request_id: string;
      status: string;
      flow_type: string;
    }>(
      `SELECT support_request_id, status, flow_type
       FROM support_request_pages
       WHERE support_request_id = ANY($1::text[])
       ORDER BY support_request_id ASC`,
      [[supportSeedIds.supportRequests.activeProductNotReceived, supportSeedIds.supportRequests.resolvedPartialRefund]],
    );
    expect(supportRequests.rows).toHaveLength(2);
    expect(new Set(supportRequests.rows.map((row) => row.status))).toEqual(new Set(["waiting-on-seller", "resolved"]));

    const refundEffect = await pools.payments.query<{
      status: string;
      requested_amount: string;
    }>(
      `SELECT status, requested_amount::text AS requested_amount
       FROM payments_support_refund_effects
       WHERE support_request_id = $1`,
      [supportSeedIds.supportRequests.resolvedPartialRefund],
    );
    expect(refundEffect.rows[0]).toMatchObject({
      status: "refund-requested",
      requested_amount: "5.00",
    });

    const activeHolds = await pools.settlement.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM settlement_support_holds
       WHERE support_request_id = ANY($1::text[])
         AND active = TRUE`,
      [[supportSeedIds.supportRequests.activeProductNotReceived, supportSeedIds.supportRequests.resolvedPartialRefund]],
    );
    expect(Number(activeHolds.rows[0]?.count ?? 0)).toBe(2);

    const before = await pools.support.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'support.%'",
    );
    await seedRuntime.seed();
    const after = await pools.support.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'support.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 240_000);
});
