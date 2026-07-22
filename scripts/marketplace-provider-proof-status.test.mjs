import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_PROVIDER_PROOF_STATUS_VERSION,
  buildProviderProofStatus,
  parseProviderProofStatusArgs,
  runProviderProofStatus,
  validateProviderProofStatusOptions,
} from "./marketplace-provider-proof-status.mjs";

function emptyInput(overrides = {}) {
  return {
    environment: "production",
    checkedAt: "2026-06-03T01:00:00.000Z",
    payments: {
      providerEventsByKind: [],
      recentProviderEvents: [],
    },
    settlement: {
      moneyMovementEventsByKind: [],
      payoutReadinessByPosture: [],
      payoutsByStatus: [],
      providerOperationsByKind: [],
    },
    fulfillment: {
      postageEventsByKind: [],
      labelOperationsByKind: [],
      shipmentLabelsByStatus: [],
      recentShipmentLabels: [],
    },
    ...overrides,
  };
}

function passingInput(overrides = {}) {
  return emptyInput({
    payments: {
      providerEventsByKind: [
        {
          providerName: "stripe",
          eventKind: "checkout.session.completed",
          count: 5,
          latestReceivedAt: "2026-06-03T00:30:00.000Z",
        },
      ],
      recentProviderEvents: [],
    },
    settlement: {
      moneyMovementEventsByKind: [
        {
          providerName: "stripe",
          eventKind: "payout.failed",
          count: 2,
          latestReceivedAt: "2026-06-03T00:31:00.000Z",
        },
      ],
      payoutReadinessByPosture: [
        {
          payoutAccountDashboard: "none",
          lossesCollector: "application",
          feesCollector: "application",
          requirementsCollector: "application",
          status: "ready",
          count: 1,
          latestUpdatedAt: "2026-06-03T00:32:00.000Z",
        },
      ],
      payoutsByStatus: [{ status: "failed", count: 1, latestUpdatedAt: "2026-06-03T00:33:00.000Z" }],
      providerOperationsByKind: [
        {
          operationKind: "connected-account-payout",
          status: "failed",
          count: 1,
          latestUpdatedAt: "2026-06-03T00:34:00.000Z",
        },
      ],
    },
    fulfillment: {
      postageEventsByKind: [
        {
          providerName: "easypost",
          providerMode: "production",
          eventKind: "tracking-status",
          count: 3,
          latestReceivedAt: "2026-06-03T00:35:00.000Z",
        },
        {
          providerName: "easypost",
          providerMode: "production",
          eventKind: "refund-status",
          count: 1,
          latestReceivedAt: "2026-06-03T00:36:00.000Z",
        },
      ],
      labelOperationsByKind: [
        {
          operationKind: "purchase-usps-label",
          providerMode: "production",
          status: "succeeded",
          count: 1,
          latestUpdatedAt: "2026-06-03T00:37:00.000Z",
        },
        {
          operationKind: "void-label",
          providerMode: "production",
          status: "succeeded",
          count: 1,
          latestUpdatedAt: "2026-06-03T00:38:00.000Z",
        },
      ],
      shipmentLabelsByStatus: [],
      recentShipmentLabels: [],
    },
    ...overrides,
  });
}

describe("marketplace provider proof status", () => {
  it("builds a status-only report with remaining production provider row gaps", () => {
    const report = buildProviderProofStatus(
      emptyInput({
        payments: {
          providerEventsByKind: [
            {
              providerName: "stripe",
              eventKind: "checkout.session.completed",
              count: 4,
              latestReceivedAt: "2026-06-03T00:30:00.000Z",
            },
          ],
          recentProviderEvents: [],
        },
        settlement: {
          moneyMovementEventsByKind: [],
          payoutReadinessByPosture: [
            {
              payoutAccountDashboard: "express",
              lossesCollector: "stripe",
              feesCollector: "stripe",
              requirementsCollector: "stripe",
              status: "ready",
              count: 1,
              latestUpdatedAt: "2026-06-03T00:31:00.000Z",
            },
          ],
          payoutsByStatus: [],
          providerOperationsByKind: [],
        },
        fulfillment: {
          postageEventsByKind: [
            {
              providerName: "easypost",
              providerMode: "production",
              eventKind: "tracking-status",
              count: 2,
              latestReceivedAt: "2026-06-03T00:32:00.000Z",
            },
          ],
          labelOperationsByKind: [
            {
              operationKind: "purchase-usps-label",
              providerMode: "production",
              status: "succeeded",
              count: 1,
              latestUpdatedAt: "2026-06-03T00:33:00.000Z",
            },
          ],
          shipmentLabelsByStatus: [],
          recentShipmentLabels: [],
        },
      }),
    );

    expect(report.schemaVersion).toBe(MARKETPLACE_PROVIDER_PROOF_STATUS_VERSION);
    expect(report.note).toContain("Status report only");
    expect(report.stripeMoney).toMatchObject({
      paymentProviderEventRowCount: 4,
      connectProviderEventRowCount: 0,
      dashboardNoneApplicationReadinessCount: 0,
      settlementPayoutRowCount: 0,
      settlementProviderOperationRowCount: 0,
    });
    expect(report.fulfillmentPostage).toMatchObject({
      providerEventRowCount: 2,
      trackingStatusProviderEventRowCount: 2,
      refundStatusProviderEventRowCount: 0,
      purchaseLabelOperationCount: 1,
      voidLabelOperationCount: 0,
    });
    expect(report.gateStatus).toMatchObject({
      stripeMoneyOperationsCouldPassProviderRowThresholds: false,
      fulfillmentPostageCouldPassProviderRowThresholds: false,
    });
    expect(report.gateStatus.remainingProviderRowGaps).toEqual([
      "Stripe money operations needs at least 5 Payments provider webhook rows; found 4.",
      "Stripe money operations needs at least 2 Settlement money-movement webhook rows; found 0.",
      "Stripe money operations needs at least one dashboard-none/application payout readiness row.",
      "Stripe money operations still has no Settlement payout rows.",
      "Stripe money operations still has no Settlement provider-operation rows.",
      "Fulfillment postage needs at least 4 postage provider-event rows; found 2.",
      "Fulfillment postage needs at least 3 tracking-status rows; found 2.",
      "Fulfillment postage needs at least 1 refund-status row; found 0.",
      "Fulfillment postage still has no label void operation rows.",
    ]);
  });

  it("reports when provider row thresholds could support the money and postage proof records", () => {
    const report = buildProviderProofStatus(passingInput({ environment: "staging" }));

    expect(report.environment).toBe("staging");
    expect(report.gateStatus).toEqual({
      stripeMoneyOperationsCouldPassProviderRowThresholds: true,
      fulfillmentPostageCouldPassProviderRowThresholds: true,
      remainingProviderRowGaps: [],
    });
  });

  it("parses operator flags and falls back to environment variables", () => {
    expect(
      parseProviderProofStatusArgs(
        [
          "--environment",
          "production",
          "--checked-at",
          "2026-06-03T01:00:00.000Z",
          "--payments-database-url",
          "postgres://payments",
          "--settlement-database-url",
          "postgres://settlement",
          "--fulfillment-database-url",
          "postgres://fulfillment",
        ],
        {},
      ),
    ).toMatchObject({
      environment: "production",
      checkedAt: "2026-06-03T01:00:00.000Z",
      paymentsDatabaseUrl: "postgres://payments",
      settlementDatabaseUrl: "postgres://settlement",
      fulfillmentDatabaseUrl: "postgres://fulfillment",
    });

    expect(
      parseProviderProofStatusArgs([], {
        DEPLOYMENT_ENVIRONMENT: "staging",
        DATABASE_URL_PAYMENTS: "postgres://payments-env",
        DATABASE_URL_SETTLEMENT: "postgres://settlement-env",
        DATABASE_URL_FULFILLMENT: "postgres://fulfillment-env",
      }),
    ).toMatchObject({
      environment: "staging",
      paymentsDatabaseUrl: "postgres://payments-env",
      settlementDatabaseUrl: "postgres://settlement-env",
      fulfillmentDatabaseUrl: "postgres://fulfillment-env",
    });
  });

  it("validates required database URLs and ISO timestamps", () => {
    expect(
      validateProviderProofStatusOptions({
        environment: "production",
        checkedAt: "2026-06-03",
      }),
    ).toEqual([
      "PAYMENTS_DATABASE_URL, DATABASE_URL_PAYMENTS, or --payments-database-url is required.",
      "SETTLEMENT_DATABASE_URL, DATABASE_URL_SETTLEMENT, or --settlement-database-url is required.",
      "FULFILLMENT_DATABASE_URL, DATABASE_URL_FULFILLMENT, or --fulfillment-database-url is required.",
      "Provider proof status checkedAt must be an ISO timestamp.",
    ]);
  });

  it("queries each bounded-context read model without leaking full provider identifiers", async () => {
    const queryLog = [];
    class ClientStub {
      constructor(config) {
        this.config = config;
      }

      async connect() {}

      async end() {}

      async query(sql) {
        queryLog.push({ connectionString: this.config.connectionString, ssl: this.config.ssl, sql });
        return { rows: rowsForQuery(this.config.connectionString, sql) };
      }
    }

    const report = await runProviderProofStatus(
      {
        environment: "production",
        checkedAt: "2026-06-03T01:00:00.000Z",
        paymentsDatabaseUrl: "postgres://payments-db",
        settlementDatabaseUrl: "postgres://settlement-db",
        fulfillmentDatabaseUrl: "postgres://fulfillment-db",
      },
      ClientStub,
    );

    expect(new Set(queryLog.map((entry) => entry.connectionString))).toEqual(
      new Set(["postgres://payments-db", "postgres://settlement-db", "postgres://fulfillment-db"]),
    );
    expect(queryLog.every((entry) => entry.ssl?.rejectUnauthorized === true)).toBe(true);
    expect(queryLog.map((entry) => entry.sql).join("\n")).not.toMatch(/\b(DELETE|INSERT|UPDATE|UPSERT|MERGE)\b/i);
    expect(report.gateStatus).toMatchObject({
      stripeMoneyOperationsCouldPassProviderRowThresholds: true,
      fulfillmentPostageCouldPassProviderRowThresholds: true,
    });
    expect(report.stripeMoney.recentPaymentsProviderEvents).toEqual([
      {
        providerName: "stripe",
        eventKind: "checkout.session.completed",
        providerEventId: "evt_paym...3001",
        receivedAt: "2026-06-03T00:40:00.000Z",
      },
    ]);
    expect(report.fulfillmentPostage.recentShipmentLabels).toEqual([
      {
        shipmentId: "ship_con...3001",
        status: "exception",
        labelStatus: "refunded",
        postageProviderMode: "production",
        carrierName: "USPS",
        postageServiceLevel: "Ground Advantage",
        labelRefundStatus: "refunded",
        updatedAt: "2026-06-03T00:41:00.000Z",
      },
    ]);
  });
});

function rowsForQuery(connectionString, sql) {
  if (connectionString === "postgres://payments-db") {
    if (sql.includes("provider_event_id")) {
      return [
        {
          provider_name: "stripe",
          event_kind: "checkout.session.completed",
          provider_event_id: "evt_paymentCheckout20260603001",
          received_at: new Date("2026-06-03T00:40:00.000Z"),
        },
      ];
    }
    return [
      {
        provider_name: "stripe",
        event_kind: "checkout.session.completed",
        count: 5,
        latest_received_at: new Date("2026-06-03T00:30:00.000Z"),
      },
    ];
  }

  if (connectionString === "postgres://settlement-db") {
    if (sql.includes("settlement_money_movement_webhook_events")) {
      return [
        {
          provider_name: "stripe",
          event_kind: "payout.failed",
          count: 2,
          latest_received_at: new Date("2026-06-03T00:31:00.000Z"),
        },
      ];
    }
    if (sql.includes("settlement_payout_readiness_pages")) {
      return [
        {
          payout_account_dashboard: "none",
          losses_collector: "application",
          fees_collector: "application",
          requirements_collector: "application",
          status: "ready",
          count: 1,
          latest_updated_at: new Date("2026-06-03T00:32:00.000Z"),
        },
      ];
    }
    if (sql.includes("settlement_payout_pages")) {
      return [{ status: "failed", count: 1, latest_updated_at: new Date("2026-06-03T00:33:00.000Z") }];
    }
    if (sql.includes("settlement_provider_operations")) {
      return [
        {
          operation_kind: "connected-account-payout",
          status: "failed",
          count: 1,
          latest_updated_at: new Date("2026-06-03T00:34:00.000Z"),
        },
      ];
    }
  }

  if (connectionString === "postgres://fulfillment-db") {
    if (sql.includes("fulfillment_postage_provider_events")) {
      return [
        {
          provider_name: "easypost",
          provider_mode: "production",
          event_kind: "tracking-status",
          count: 3,
          latest_received_at: new Date("2026-06-03T00:35:00.000Z"),
        },
        {
          provider_name: "easypost",
          provider_mode: "production",
          event_kind: "refund-status",
          count: 1,
          latest_received_at: new Date("2026-06-03T00:36:00.000Z"),
        },
      ];
    }
    if (sql.includes("fulfillment_postage_label_operations")) {
      return [
        {
          operation_kind: "purchase-usps-label",
          provider_mode: "production",
          status: "succeeded",
          count: 1,
          latest_updated_at: new Date("2026-06-03T00:37:00.000Z"),
        },
        {
          operation_kind: "void-label",
          provider_mode: "production",
          status: "succeeded",
          count: 1,
          latest_updated_at: new Date("2026-06-03T00:38:00.000Z"),
        },
      ];
    }
    if (sql.includes("shipment_id")) {
      return [
        {
          shipment_id: "ship_controlledParcel20260603001",
          status: "exception",
          label_status: "refunded",
          postage_provider_mode: "production",
          carrier_name: "USPS",
          postage_service_level: "Ground Advantage",
          label_refund_status: "refunded",
          updated_at: new Date("2026-06-03T00:41:00.000Z"),
        },
      ];
    }
    if (sql.includes("fulfillment_shipment_pages")) {
      return [
        {
          status: "exception",
          label_status: "refunded",
          postage_provider_mode: "production",
          count: 1,
          latest_updated_at: new Date("2026-06-03T00:39:00.000Z"),
        },
      ];
    }
  }

  throw new Error(`Unexpected query for ${connectionString}: ${sql}`);
}
