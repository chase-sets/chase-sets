import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { module as settlementModule } from "../../../index";
import { createSettlementServices } from "../../../support/runtime-support/services";
import { createSettlementPayoutReviewHoldPort } from "./payout-review-hold-port";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const now = "2026-10-17T12:00:00.000Z";
const heldAccountId = "acc_synthetic_held_seller";
const controlAccountId = "acc_synthetic_control_seller";
const context = {
  tenantId: "tnt_synthetic_hold" as const,
  audit: { performedByUserId: "usr_synthetic_operator" as const, forAccountId: "acc_synthetic_operator" as const },
};

describeDb("payout review hold maturity on real Postgres", () => {
  let pools: Readonly<Record<"settlement", PgTransactionalPool>> | undefined;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["settlement"], "payout_review_hold_maturity");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each(["operator", "risk-alert"] as const)(
    "a committed hold blocks maturity before its projection (%s source)",
    async (source) => {
      const services = createSettlementServices(pool);
      for (const accountId of [heldAccountId, controlAccountId]) {
        await seedMatureBaseClearanceCandidate(services, accountId);
      }
      const holdInput = { accountId: heldAccountId, reason: "Synthetic chargeback review" };
      if (source === "operator") {
        await services.payoutReviewHold.place({ ...holdInput, accountId: heldAccountId as never, source }, context);
      } else {
        await createSettlementPayoutReviewHoldPort(() => services.payoutReviewHold).placeRiskAlertHold(
          { ...holdInput, sourceReference: "alert_synthetic", actorPermissions: ["payout-review-holds.manage"] },
          context,
        );
      }
      // The badge is false and the hold projector has not run: only the committed stream can extend clearance.
      await expect(
        pool.query(
          `SELECT manual_payout_review, payout_review_hold, payout_review_hold_stream_version::integer AS version
           FROM settlement_account_risk_sources WHERE account_id = $1`,
          [heldAccountId],
        ),
      ).resolves.toMatchObject({ rows: [{ manual_payout_review: false, payout_review_hold: false, version: 0 }] });
      const eventStore = createPostgresEventStore({ pool });
      const heldWalletBefore = await readCompleteStream(eventStore, { streamId: `settlement.wallet-${heldAccountId}` });

      await expect(
        services.wallets.releaseMaturePendingSaleCredits(
          { now, limit: 500, claimOwnerId: "worker_synthetic", claimTtlMs: 60_000 },
          context,
        ),
      ).resolves.toEqual({ released: 1, skipped: 0 });

      expect(await readCompleteStream(eventStore, { streamId: `settlement.wallet-${heldAccountId}` })).toEqual(
        heldWalletBefore,
      );
      expect((await services.wallets.loadWalletState(heldAccountId as never)).entries).toEqual([
        expect.objectContaining({ ledgerEntryId: `led_${heldAccountId}`, fundsStatus: "pending" }),
      ]);
      expect((await services.wallets.loadWalletState(controlAccountId as never)).entries).toEqual([
        expect.objectContaining({ ledgerEntryId: `led_${controlAccountId}`, fundsStatus: "available" }),
      ]);
    },
  );

  /** A trusted, reviewed seller's delivered sale three days old: mature on base, not extended, clearance. */
  async function seedMatureBaseClearanceCandidate(
    services: ReturnType<typeof createSettlementServices>,
    accountId: string,
  ) {
    const ledgerEntryId = `led_${accountId}`;
    const orderId = `ord_${accountId}`;
    const postedAt = daysAgo(3);
    await services.wallets.postEntry(
      {
        accountId: accountId as never,
        ledgerEntryId: ledgerEntryId as never,
        kind: "sale",
        direction: "credit",
        amount: "40.00",
        currencyCode: "usd",
        fundsStatus: "pending",
        orderId: orderId as never,
        paymentId: `pay_${orderId}` as never,
        postedAt,
      },
      context,
    );
    await pool.query(
      `INSERT INTO settlement_account_risk_sources (
         account_id, account_created_at, trusted_seller, manual_payout_review, review_count, average_rating, updated_at
       ) VALUES ($1, $2, TRUE, FALSE, 4, 4.75, $3)`,
      [accountId, daysAgo(365), now],
    );
    await pool.query(
      `INSERT INTO settlement_ledger_entry_pages (
         ledger_entry_id, account_id, kind, direction, amount, currency_code, funds_status,
         order_id, payment_id, payout_id, description, posted_at, available_at, updated_at
       ) VALUES ($1, $2, 'sale', 'credit', 40.00, 'USD', 'pending', $3, $4, NULL, NULL, $5, NULL, $5)`,
      [ledgerEntryId, accountId, orderId, `pay_${orderId}`, postedAt],
    );
    await pool.query(
      `INSERT INTO settlement_order_fulfillment_sources (
         shipment_id, order_id, buyer_account_id, seller_account_id, status,
         created_at, updated_at, dispatched_at, delivered_at, last_stream_version
       ) VALUES ($1, $2, 'acc_synthetic_buyer', $3, 'delivered', $4, $5, $4, $5, 1)`,
      [`shp_${orderId}`, orderId, accountId, daysAgo(20), postedAt],
    );
    await pool.query(
      `INSERT INTO settlement_order_trust_signal_sources (order_id, seller_account_id, trust_signal_eligible, updated_at)
       VALUES ($1, $2, TRUE, $3)`,
      [orderId, accountId, postedAt],
    );
  }
});

function daysAgo(days: number): string {
  return new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
}
