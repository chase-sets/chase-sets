import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./account-risk-source-projection";

function event(type: string, data: Record<string, unknown>, streamId = "identity.account-acc_seller"): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_seller" },
    timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
  });
}

describe("settlement account risk source projection", () => {
  it("projects trusted seller badges and reputation reviews into payout release inputs", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [{ subject_account_id: "acc_seller" }] };
        }
        return { rows: [] };
      }),
    };
    const identityHandlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);
    const reputationHandlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never);

    await identityHandlers["identity.account.badge-assigned"]!(
      event("identity.account.badge-assigned", { badgeKey: "trusted-seller" }),
    );
    await reputationHandlers["marketplace.review.submitted"]!(
      event(
        "marketplace.review.submitted",
        {
          reviewId: "rev_1",
          orderId: "ord_1",
          subjectAccountId: "acc_seller",
          authorRole: "buyer",
          rating: 5,
          submittedAt: "2026-05-03T00:00:00.000Z",
        },
        "marketplace.review-rev_1",
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("trusted_seller"), [
      "acc_seller",
      true,
      "2026-05-01T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO settlement_account_review_sources"),
      [
        "rev_1",
        "ord_1",
        "acc_seller",
        "buyer",
        5,
        "2026-05-03T00:00:00.000Z",
        "included",
        "normal-completion",
        "resolution-aware-v1",
        "[]",
        null,
      ],
    );
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("review_count"), [
      "acc_seller",
      "2026-05-03T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("author_role = 'buyer'"), [
      "acc_seller",
      "2026-05-03T00:00:00.000Z",
    ]);
  });

  it("projects Stripe fraud signals into buyer risk sources", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await handlers["payments.payment-fraud-warning-received"]!(
      event("payments.payment-fraud-warning-received", {
        buyerAccountId: "acc_buyer",
        receivedAt: "2026-07-06T12:05:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("stripe_fraud_signal_count"), [
      "acc_buyer",
      "2026-07-06T12:05:00.000Z",
    ]);
  });

  it("projects shared payment instrument clusters into account risk sources", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT DISTINCT account_id")) {
          return { rows: [{ account_id: "acc_buyer" }, { account_id: "acc_linked" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await handlers["payments.checkout-affordances-published"]!(
      event(
        "payments.checkout-affordances-published",
        {
          accountId: "acc_buyer",
          savedCheckoutInstruments: [
            {
              instrumentId: "sci_card",
              instrumentRiskClusterKey: "instrument:shared",
              readiness: "ready",
            },
          ],
          publishedAt: "2026-07-07T13:05:00.000Z",
        },
        "payments.checkout-affordances-acc_buyer",
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("settlement_account_instrument_risk_sources"), [
      "acc_buyer",
      "sci_card",
      "instrument:shared",
      true,
      "2026-07-07T13:05:00.000Z",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("shared_instrument_cluster_count"), [
      "acc_linked",
      "2026-07-07T13:05:00.000Z",
    ]);
  });

  it("projects shared shipping address clusters into account risk sources", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT DISTINCT account_id")) {
          return { rows: [{ account_id: "acc_buyer" }, { account_id: "acc_linked" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);

    await handlers["identity.shipping-address.added"]!(
      event("identity.shipping-address.added", {
        accountId: "acc_buyer",
        shippingAddressId: "adr_1",
        address: {
          name: "Buyer",
          company: null,
          line1: "10 Main St",
          line2: null,
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
          phone: null,
          email: null,
        },
        addedAt: "2026-07-07T14:05:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("settlement_account_address_risk_sources"), [
      "acc_buyer",
      "adr_1",
      "us|78701|tx|austin|10 main st|",
      "2026-07-07T14:05:00.000Z",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("shared_address_cluster_count"), [
      "acc_linked",
      "2026-07-07T14:05:00.000Z",
    ]);
  });

  it("projects event-sourced velocity counters for listing, review, spend, and chargeback windows", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT DISTINCT account_id")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const identityHandlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);
    const marketplaceHandlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never);
    const paymentsHandlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await identityHandlers["identity.account.created"]!(
      event("identity.account.created", {
        accountId: "acc_reviewer",
        createdAt: "2026-07-06T00:00:00.000Z",
      }),
    );
    await marketplaceHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_1",
          accountId: "acc_seller",
          priceAmount: "2600.00",
        },
        "marketplace.listing-lst_1",
      ),
    );
    await marketplaceHandlers["marketplace.review.submitted"]!(
      event(
        "marketplace.review.submitted",
        {
          reviewId: "rev_2",
          orderId: "ord_2",
          authorAccountId: "acc_reviewer",
          subjectAccountId: "acc_seller",
          authorRole: "buyer",
          rating: 5,
          submittedAt: "2026-07-07T00:00:00.000Z",
        },
        "marketplace.review-rev_2",
      ),
    );
    await paymentsHandlers["payments.payment-created"]!(
      event("payments.payment-created", {
        paymentId: "pay_1",
        buyerAccountId: "acc_buyer",
        amount: "2100.00",
        createdAt: "2026-07-07T00:00:00.000Z",
        sellerPayouts: [{ orderId: "ord_2", sellerAccountId: "acc_seller", sellerPayoutAmount: "1900.00" }],
      }),
    );
    await paymentsHandlers["payments.payment-disputed"]!(
      event("payments.payment-disputed", {
        paymentId: "pay_1",
        providerDisputeId: "dp_1",
        disputedAt: "2026-07-07T00:00:00.000Z",
        sellerPayouts: [{ orderId: "ord_2", sellerAccountId: "acc_seller", sellerPayoutAmount: "1900.00" }],
      }),
    );

    const velocitySourceCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO settlement_account_velocity_sources"),
    );

    expect(velocitySourceCalls).toContainEqual([
      expect.stringContaining("settlement_account_velocity_sources"),
      ["listing-created", "lst_1", "acc_seller", "2026-05-01T00:00:00.000Z", 260000, null, "2026-05-01T00:00:00.000Z"],
    ]);
    // Trailing params are the settlement fraud/velocity policy's compiled launch
    // defaults (see ../../domain/fraud-velocity-policy.ts), stamped onto the SQL
    // as parameters instead of hardcoded interval/threshold literals.
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("review_24h_median_reviewer_age_days"), [
      "acc_seller",
      expect.any(String),
      7, // chargebackReportingWindowDays
      30, // chargebackVelocity.lookbackDays
      24, // newSellerListingVelocity.windowHours
      24, // reviewVelocity.windowHours
      24, // youngBuyerSpendVelocity.windowHours
      2, // chargebackVelocity.minCount
      200, // chargebackVelocity.minRateBps
      30, // newSellerListingVelocity.newAccountAgeDays
      250_000, // newSellerListingVelocity.minValueCents
      5, // reviewVelocity.minCount
      7, // reviewVelocity.maxMedianReviewerAgeDays
      7, // youngBuyerSpendVelocity.newAccountAgeDays
      200_000, // youngBuyerSpendVelocity.minSpendCents
    ]);
    expect(velocitySourceCalls).toContainEqual([
      expect.stringContaining("settlement_account_velocity_sources"),
      [
        "buyer-payment-created",
        "pay_1",
        "acc_buyer",
        "2026-07-07T00:00:00.000Z",
        210000,
        null,
        "2026-05-01T00:00:00.000Z",
      ],
    ]);
    expect(velocitySourceCalls).toContainEqual([
      expect.stringContaining("settlement_account_velocity_sources"),
      [
        "chargeback-received",
        "dp_1:ord_2",
        "acc_seller",
        "2026-07-07T00:00:00.000Z",
        0,
        null,
        "2026-05-01T00:00:00.000Z",
      ],
    ]);
  });
});
