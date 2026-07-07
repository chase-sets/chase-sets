import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./account-risk-source-projection";

function event(type: string, data: Record<string, unknown>, streamId = "identity.account-acc_seller"): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: streamId as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_test" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_test" as never,
      forAccountId: "acc_seller" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-01T00:00:00.000Z" as never,
      recordedAt: "2026-05-01T00:00:00.000Z" as never,
    },
  };
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
      ["rev_1", "ord_1", "acc_seller", 5, "2026-05-03T00:00:00.000Z"],
    );
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("review_count"), [
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
});
