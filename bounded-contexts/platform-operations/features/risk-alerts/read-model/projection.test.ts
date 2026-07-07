import { describe, expect, it, vi } from "vitest";
import { buildRiskAlertProjectionHandlers } from "./projection";

function createDb() {
  const sources: Record<
    string,
    { kind: string; id: string; accountId: string; occurredAt: string; amountCents: number }
  > = {};
  const alerts = new Map<string, Record<string, unknown>>();
  const accountCreatedAt = new Map<string, string>();
  const db = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO platform_operations_risk_alert_account_sources")) {
        accountCreatedAt.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO platform_operations_risk_alert_velocity_sources")) {
        sources[`${params[0]}:${params[1]}:${params[2]}`] = {
          kind: String(params[0]),
          id: String(params[1]),
          accountId: String(params[2]),
          occurredAt: String(params[3]),
          amountCents: Number(params[4]),
        };
        return { rows: [] };
      }
      if (sql.includes("UPDATE platform_operations_risk_alert_velocity_sources")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT DISTINCT account_id")) {
        return { rows: [] };
      }
      if (sql.includes("WITH counters AS")) {
        const accountId = String(params[0]);
        const rows = Object.values(sources).filter((source) => source.accountId === accountId);
        return {
          rows: [
            {
              account_created_at: accountCreatedAt.get(accountId) ?? null,
              chargeback_30d_count: String(rows.filter((source) => source.kind === "chargeback-received").length),
              chargeback_30d_rate_bps: "10000",
              listing_24h_count: String(rows.filter((source) => source.kind === "listing-created").length),
              listing_24h_value_cents: String(
                rows
                  .filter((source) => source.kind === "listing-created")
                  .reduce((sum, source) => sum + source.amountCents, 0),
              ),
              review_24h_count: String(rows.filter((source) => source.kind === "review-received").length),
              review_24h_median_reviewer_age_days: rows.some((source) => source.kind === "review-received")
                ? "1"
                : null,
              buyer_order_24h_count: String(rows.filter((source) => source.kind === "buyer-payment-created").length),
              buyer_spend_24h_cents: String(
                rows
                  .filter((source) => source.kind === "buyer-payment-created")
                  .reduce((sum, source) => sum + source.amountCents, 0),
              ),
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO platform_operations_risk_alert_queue_pages")) {
        alerts.set(String(params[0]), {
          alert_id: params[0],
          account_id: params[1],
          alert_kind: params[2],
          status: "needs-review",
          severity: params[3],
          manual_payout_review_candidate: params[4],
          evidence: JSON.parse(String(params[5])),
          threshold: JSON.parse(String(params[6])),
        });
        return { rows: [] };
      }
      if (sql.includes("UPDATE platform_operations_risk_alert_queue_pages")) {
        const existing = alerts.get(String(params[0]));
        if (existing) {
          alerts.set(String(params[0]), {
            ...existing,
            status: params[1],
            last_action: params[2],
            last_action_note: params[4],
          });
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    alerts,
  };
  return db;
}

function event(type: string, data: Record<string, unknown>) {
  return {
    type,
    data,
    streamId: `${type}-stream`,
    timing: {
      occurredAt: "2026-07-07T00:00:00.000Z",
      recordedAt: "2026-07-07T00:00:00.000Z",
    },
  } as never;
}

describe("risk alert projection", () => {
  it("creates threshold alerts with evidence and records manual operator actions", async () => {
    const db = createDb();
    const handlers = buildRiskAlertProjectionHandlers(db as never);

    await handlers["identity.account.created"]!(
      event("identity.account.created", { accountId: "acc_seller", createdAt: "2026-07-01T00:00:00.000Z" }),
    );
    await handlers["identity.account.created"]!(
      event("identity.account.created", { accountId: "acc_buyer", createdAt: "2026-07-06T00:00:00.000Z" }),
    );
    await handlers["marketplace.listing.created"]!(
      event("marketplace.listing.created", { listingId: "lst_1", accountId: "acc_seller", priceAmount: "2500.00" }),
    );
    await handlers["payments.payment-created"]!(
      event("payments.payment-created", {
        paymentId: "pay_1",
        buyerAccountId: "acc_buyer",
        amount: "2000.00",
        sellerPayouts: [{ orderId: "ord_1", sellerAccountId: "acc_seller" }],
      }),
    );
    await handlers["payments.payment-disputed"]!(
      event("payments.payment-disputed", {
        paymentId: "pay_1",
        providerDisputeId: "dp_1",
        sellerPayouts: [{ orderId: "ord_1", sellerAccountId: "acc_seller" }],
      }),
    );
    await handlers["payments.payment-disputed"]!(
      event("payments.payment-disputed", {
        paymentId: "pay_2",
        providerDisputeId: "dp_2",
        sellerPayouts: [{ orderId: "ord_2", sellerAccountId: "acc_seller" }],
      }),
    );

    expect(db.alerts.get("risk_acc_seller_chargeback-velocity")).toMatchObject({
      alert_kind: "chargeback-velocity",
      manual_payout_review_candidate: true,
    });
    expect(db.alerts.get("risk_acc_seller_new-seller-listing-velocity")).toMatchObject({
      alert_kind: "new-seller-listing-velocity",
    });
    expect(db.alerts.get("risk_acc_buyer_young-buyer-spend-velocity")).toMatchObject({
      alert_kind: "young-buyer-spend-velocity",
    });

    await handlers["platform-operations.risk-alert.action-recorded"]!(
      event("platform-operations.risk-alert.action-recorded", {
        alertId: "risk_acc_seller_chargeback-velocity",
        action: "request-manual-payout-review",
        note: "Badge requested.",
        operatorUserId: "usr_ops",
        recordedAt: "2026-07-07T00:01:00.000Z",
      }),
    );

    expect(db.alerts.get("risk_acc_seller_chargeback-velocity")).toMatchObject({
      status: "manual-payout-review-requested",
      last_action: "request-manual-payout-review",
    });
  });
});
