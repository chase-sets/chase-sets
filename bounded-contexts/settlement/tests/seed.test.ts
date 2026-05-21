import { expect, it } from "vitest";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "@chase-sets/marketplace-seed-testing";

describeWithMarketplaceSeedDatabase("settlement seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("settlement");

  it("creates deterministic wallet and payout projections", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    const wallet = await pools.settlement.query<{
      pending_balance_amount: string;
      available_balance_amount: string;
    }>(
      `SELECT pending_balance_amount, available_balance_amount
       FROM settlement_wallet_pages
       WHERE account_id = $1`,
      [identitySeedIds.demo.accountId],
    );
    expect(wallet.rows[0]).toMatchObject({
      pending_balance_amount: "43.07",
      available_balance_amount: "26.20",
    });

    const payoutStatuses = await pools.settlement.query<{ status: string }>(
      "SELECT status FROM settlement_payout_pages ORDER BY payout_id ASC",
    );
    expect(new Set(payoutStatuses.rows.map((row) => row.status))).toEqual(new Set(["completed", "failed"]));
    const payoutEmails = await pools.settlement.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM transactional_email_outbox
       WHERE message_type = 'settlement.payout.completed'
         AND idempotency_key LIKE 'settlement:payout_completed:%'`,
    );
    expect(Number(payoutEmails.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const before = await pools.settlement.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'settlement.%'",
    );
    await seedRuntime.seed();
    const after = await pools.settlement.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'settlement.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);
});
