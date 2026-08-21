import { describe, expect, it, vi } from "vitest";
import { isTransientProjectionError } from "@chase-sets/event-core/projector";
import { isPgRetryableTransientError } from "@chase-sets/event-core-postgres";
import {
  buildMarketplaceRiskAlertProjectionHandlers,
  buildPaymentsRiskAlertProjectionHandlers,
  buildRiskAlertProjectionHandlers,
} from "./projection";

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

const canonicalMoneyCases = [
  { value: "12.34", cents: 1_234 },
  { value: "12", cents: 1_200 },
  { value: "12.3", cents: 1_230 },
  { value: "0.00", cents: 0 },
  { value: "9999999999.99", cents: 999_999_999_999 },
  { value: "  12.34", cents: 1_234 },
  { value: "12.34  ", cents: 1_234 },
  { value: null, cents: 0 },
  { value: undefined, cents: 0 },
] as const;

const malformedMoneyStrings = [
  "12.345",
  "1.0001",
  "12. 34",
  "12.34abc",
  "12.34 USD",
  "$12.34",
  "1e2",
  "1.5e3",
  "-12.34",
  "-0.00",
  "+12.34",
  "10000000000.00",
  "9999999999.991",
  "1,234.56",
  "12,34",
  "0x10",
  "",
  "   ",
  "abc",
  "Infinity",
  "NaN",
] as const;

const malformedNonStringMoneyValues: readonly unknown[] = [
  12.34,
  1_234,
  -12.34,
  0.30000000000000004,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  1_234n,
  -1n,
  true,
  false,
  ["12.34"],
  [12.34],
  ["12.34", "56.78"],
  [],
  { amount: "12.34" },
];

function buildMoneyHandlerCases(db: ReturnType<typeof createDb>) {
  return [
    {
      handler: buildMarketplaceRiskAlertProjectionHandlers(db as never)["marketplace.listing.created"]!,
      makeEvent: (value: unknown) =>
        event("marketplace.listing.created", { listingId: "lst_money", accountId: "acc_money", priceAmount: value }),
    },
    {
      handler: buildPaymentsRiskAlertProjectionHandlers(db as never)["payments.payment-created"]!,
      makeEvent: (value: unknown) =>
        event("payments.payment-created", {
          paymentId: "pay_money",
          buyerAccountId: "acc_money",
          amount: value,
          sellerPayouts: [],
        }),
    },
  ];
}

function velocitySourceInsertCalls(db: ReturnType<typeof createDb>) {
  return db.query.mock.calls.filter(
    ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO platform_operations_risk_alert_velocity_sources"),
  );
}

async function captureHandlerError(action: () => Promise<void>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("risk alert projection", () => {
  it("risk projection money consolidation preserves canonical cents and the absent-value default", async () => {
    for (const moneyCase of canonicalMoneyCases) {
      for (const caseIndex of [0, 1] as const) {
        const db = createDb();
        const handlerCase = buildMoneyHandlerCases(db)[caseIndex];

        await handlerCase.handler(handlerCase.makeEvent(moneyCase.value));

        const insertCalls = velocitySourceInsertCalls(db);
        expect(insertCalls).toHaveLength(1);
        expect(insertCalls[0]?.[1]?.[4]).toBe(moneyCase.cents);
      }
    }
  });

  it("risk projection money coercion applies the ruled outcome for every malformed payload shape", async () => {
    for (const value of malformedMoneyStrings) {
      for (const caseIndex of [0, 1] as const) {
        const db = createDb();
        const handlerCase = buildMoneyHandlerCases(db)[caseIndex];
        const error = await captureHandlerError(() => handlerCase.handler(handlerCase.makeEvent(value)));

        expect(error).toBeInstanceOf(Error);
        expect(isTransientProjectionError(error)).toBe(false);
        expect(isPgRetryableTransientError(error)).toBe(false);
        expect(velocitySourceInsertCalls(db)).toHaveLength(0);
      }
    }
  });

  it("risk projection money coercion rejects non-string payload values", async () => {
    for (const value of malformedNonStringMoneyValues) {
      for (const caseIndex of [0, 1] as const) {
        const db = createDb();
        const handlerCase = buildMoneyHandlerCases(db)[caseIndex];
        const error = await captureHandlerError(() => handlerCase.handler(handlerCase.makeEvent(value)));

        expect(error).toBeInstanceOf(Error);
        expect(isTransientProjectionError(error)).toBe(false);
        expect(isPgRetryableTransientError(error)).toBe(false);
        expect(velocitySourceInsertCalls(db)).toHaveLength(0);
      }
    }
  });

  it("risk projection money rejection raises a non-transient projection error and persists no velocity source", async () => {
    for (const caseIndex of [0, 1] as const) {
      const db = createDb();
      const handlerCase = buildMoneyHandlerCases(db)[caseIndex];
      const error = await captureHandlerError(() => handlerCase.handler(handlerCase.makeEvent("-12.34")));

      expect(error).toBeInstanceOf(Error);
      expect(isTransientProjectionError(error)).toBe(false);
      expect(isPgRetryableTransientError(error)).toBe(false);
      expect(velocitySourceInsertCalls(db)).toHaveLength(0);
    }
  });

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
