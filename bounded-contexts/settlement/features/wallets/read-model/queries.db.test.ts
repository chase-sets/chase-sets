import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { listPendingCreditEntriesMaturedBy } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;
const now = "2026-07-05T18:00:00.000Z";

describeDb("settlement money maturity query persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "money_maturity");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("executes the money-maturity SQL predicate across risk, fulfillment, and support holds", async () => {
    await seedWallet("acc_trusted");
    await seedTrustedSeller("acc_trusted");
    await seedWallet("acc_default_risk");
    await seedWallet("acc_linked_risk");
    await seedTrustedSeller("acc_linked_risk", { sharedInstrumentClusterCount: 1 });
    // m108: review_count now reflects as-seller reviews only. A trusted,
    // unlinked account whose reputation is entirely buyer-role (a heavy buyer with
    // zero sales) still has review_count = 0 and must stay on the 7-day tier for
    // its first sales, isolating that conjunct from trusted_seller/link risk.
    await seedWallet("acc_trusted_buyer_only_reviews");
    await seedTrustedSeller("acc_trusted_buyer_only_reviews", { reviewCount: 0, averageRating: null });

    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_default_risk_long",
      accountId: "acc_default_risk",
      orderId: "ord_ready_default_risk_long",
      amount: "40.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_high_value_long",
      accountId: "acc_trusted",
      orderId: "ord_ready_high_value_long",
      amount: "250.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_linked_account_long",
      accountId: "acc_linked_risk",
      orderId: "ord_ready_linked_account_long",
      amount: "40.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_inactive_hold",
      accountId: "acc_trusted",
      orderId: "ord_ready_inactive_hold",
      amount: "65.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedSupportHold({
      supportRequestId: "sup_inactive",
      holdId: "hold_inactive",
      sellerAccountId: "acc_trusted",
      orderId: "ord_ready_inactive_hold",
      active: false,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_fast_trusted",
      accountId: "acc_trusted",
      orderId: "ord_ready_fast_trusted",
      amount: "100.00",
      postedDaysAgo: 3,
      deliveredDaysAgo: 3,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_rebate",
      accountId: "acc_trusted",
      orderId: "ord_ready_rebate",
      amount: "15.00",
      kind: "rebate",
      postedDaysAgo: 3,
      deliveredDaysAgo: 3,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_balance_funded_long",
      accountId: "acc_trusted",
      orderId: "ord_ready_balance_funded_long",
      amount: "32.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
      trustSignalEligible: false,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_balance_funded_short",
      accountId: "acc_trusted",
      orderId: "ord_blocked_balance_funded_short",
      amount: "36.00",
      postedDaysAgo: 3,
      deliveredDaysAgo: 3,
      trustSignalEligible: false,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_recent_post",
      accountId: "acc_trusted",
      orderId: "ord_blocked_recent_post",
      amount: "20.00",
      postedDaysAgo: 1,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_recent_delivery",
      accountId: "acc_trusted",
      orderId: "ord_blocked_recent_delivery",
      amount: "21.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 1,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_default_risk_short",
      accountId: "acc_default_risk",
      orderId: "ord_blocked_default_risk_short",
      amount: "35.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 3,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_high_value_short",
      accountId: "acc_trusted",
      orderId: "ord_blocked_high_value_short",
      amount: "250.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 3,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_linked_account_short",
      accountId: "acc_linked_risk",
      orderId: "ord_blocked_linked_account_short",
      amount: "40.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 3,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_zero_fee_locked_short",
      accountId: "acc_trusted",
      orderId: "ord_blocked_zero_fee_locked_short",
      amount: "38.00",
      postedDaysAgo: 3,
      deliveredDaysAgo: 3,
      trustSignalEligible: false,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_support_hold",
      accountId: "acc_trusted",
      orderId: "ord_blocked_support_hold",
      amount: "70.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedSupportHold({
      supportRequestId: "sup_active",
      holdId: "hold_active",
      sellerAccountId: "acc_trusted",
      orderId: "ord_blocked_support_hold",
      active: true,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_available",
      accountId: "acc_trusted",
      orderId: "ord_blocked_available",
      amount: "45.00",
      fundsStatus: "available",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_debit",
      accountId: "acc_trusted",
      orderId: "ord_blocked_debit",
      amount: "12.00",
      direction: "debit",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_kind",
      accountId: "acc_trusted",
      orderId: "ord_blocked_kind",
      amount: "12.00",
      kind: "adjustment",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_blocked_buyer_only_reviews_short",
      accountId: "acc_trusted_buyer_only_reviews",
      orderId: "ord_blocked_buyer_only_reviews_short",
      amount: "40.00",
      postedDaysAgo: 3,
      deliveredDaysAgo: 3,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_ready_buyer_only_reviews_long",
      accountId: "acc_trusted_buyer_only_reviews",
      orderId: "ord_ready_buyer_only_reviews_long",
      amount: "40.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });

    await expect(listPendingCreditEntriesMaturedBy(pool, { now })).resolves.toEqual([
      expect.objectContaining({ ledger_entry_id: "led_ready_balance_funded_long" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_buyer_only_reviews_long" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_default_risk_long" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_high_value_long" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_inactive_hold" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_linked_account_long" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_fast_trusted" }),
      expect.objectContaining({ ledger_entry_id: "led_ready_rebate" }),
    ]);
  });

  it("claims matured entries with persisted work-claim ownership", async () => {
    await seedWallet("acc_trusted");
    await seedTrustedSeller("acc_trusted");
    await seedMaturityCandidate({
      ledgerEntryId: "led_claim_first",
      accountId: "acc_trusted",
      orderId: "ord_claim_first",
      amount: "30.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });
    await seedMaturityCandidate({
      ledgerEntryId: "led_claim_second",
      accountId: "acc_trusted",
      orderId: "ord_claim_second",
      amount: "31.00",
      postedDaysAgo: 8,
      deliveredDaysAgo: 8,
    });

    await expect(
      listPendingCreditEntriesMaturedBy(pool, { now, claimOwnerId: "worker-a", claimTtlMs: 120_000, limit: 1 }),
    ).resolves.toEqual([expect.objectContaining({ ledger_entry_id: "led_claim_first" })]);
    await expect(
      listPendingCreditEntriesMaturedBy(pool, { now, claimOwnerId: "worker-b", claimTtlMs: 120_000, limit: 10 }),
    ).resolves.toEqual([expect.objectContaining({ ledger_entry_id: "led_claim_second" })]);
    await expect(
      listPendingCreditEntriesMaturedBy(pool, { now, claimOwnerId: "worker-a", claimTtlMs: 120_000, limit: 10 }),
    ).resolves.toEqual([expect.objectContaining({ ledger_entry_id: "led_claim_first" })]);
  });

  async function seedWallet(accountId: string) {
    await pool.query(
      `INSERT INTO settlement_wallet_pages (
         account_id,
         currency_code,
         pending_balance_amount,
         available_balance_amount,
         total_credited_amount,
         total_debited_amount,
         opened_at,
         updated_at
       ) VALUES ($1, 'USD', 0, 0, 0, 0, $2, $2)`,
      [accountId, daysAgo(30)],
    );
  }

  async function seedTrustedSeller(
    accountId: string,
    risk: {
      sharedInstrumentClusterCount?: number;
      sharedAddressClusterCount?: number;
      reviewCount?: number;
      averageRating?: number | null;
    } = {},
  ) {
    const reviewCount = risk.reviewCount ?? 4;
    const averageRating = risk.averageRating === undefined ? 4.75 : risk.averageRating;
    await pool.query(
      `INSERT INTO settlement_account_risk_sources (
         account_id,
         account_created_at,
         trusted_seller,
         manual_payout_review,
         shared_instrument_cluster_count,
         shared_address_cluster_count,
         review_count,
         average_rating,
         updated_at
       ) VALUES ($1, $2, TRUE, FALSE, $3, $4, $5, $6, $7)`,
      [
        accountId,
        daysAgo(365),
        risk.sharedInstrumentClusterCount ?? 0,
        risk.sharedAddressClusterCount ?? 0,
        reviewCount,
        averageRating,
        now,
      ],
    );
  }

  async function seedMaturityCandidate(params: {
    ledgerEntryId: string;
    accountId: string;
    orderId: string;
    amount: string;
    kind?: string;
    direction?: string;
    fundsStatus?: string;
    postedDaysAgo: number;
    deliveredDaysAgo: number;
    trustSignalEligible?: boolean;
  }) {
    await pool.query(
      `INSERT INTO settlement_ledger_entry_pages (
         ledger_entry_id,
         account_id,
         kind,
         direction,
         amount,
         currency_code,
         funds_status,
         order_id,
         payment_id,
         payout_id,
         description,
         posted_at,
         available_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, 'pay_' || $7, NULL, NULL, $8, NULL, $8)`,
      [
        params.ledgerEntryId,
        params.accountId,
        params.kind ?? "sale",
        params.direction ?? "credit",
        params.amount,
        params.fundsStatus ?? "pending",
        params.orderId,
        daysAgo(params.postedDaysAgo),
      ],
    );
    await pool.query(
      `INSERT INTO settlement_order_fulfillment_sources (
         shipment_id,
         order_id,
         buyer_account_id,
         seller_account_id,
         status,
         created_at,
         updated_at,
         dispatched_at,
         delivered_at,
         last_stream_version
       ) VALUES ($1, $2, 'buyer_1', $3, 'delivered', $4, $5, $4, $5, 1)`,
      [`shp_${params.orderId}`, params.orderId, params.accountId, daysAgo(20), daysAgo(params.deliveredDaysAgo)],
    );
    await pool.query(
      `INSERT INTO settlement_order_trust_signal_sources (
         order_id,
         seller_account_id,
         trust_signal_eligible,
         updated_at
       ) VALUES ($1, $2, $3, $4)`,
      [params.orderId, params.accountId, params.trustSignalEligible ?? true, daysAgo(params.postedDaysAgo)],
    );
  }

  async function seedSupportHold(params: {
    supportRequestId: string;
    holdId: string;
    sellerAccountId: string;
    orderId: string;
    active: boolean;
  }) {
    await pool.query(
      `INSERT INTO settlement_support_holds (
         support_request_id,
         hold_id,
         order_id,
         buyer_account_id,
         seller_account_id,
         flow_type,
         status,
         active,
         opened_at,
         updated_at,
         released_at,
         release_reason,
         last_stream_version
       ) VALUES ($1, $2, $3, 'buyer_1', $4, 'order', $5, $6, $7, $7, $8, $9, 1)`,
      [
        params.supportRequestId,
        params.holdId,
        params.orderId,
        params.sellerAccountId,
        params.active ? "open" : "released",
        params.active,
        daysAgo(9),
        params.active ? null : daysAgo(4),
        params.active ? null : "resolved",
      ],
    );
  }
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for settlement money maturity DB tests.");
  }

  return databaseBaseUrl;
}

function daysAgo(days: number): string {
  return new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
}
