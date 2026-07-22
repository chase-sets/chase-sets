#!/usr/bin/env node
import pg from "pg";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { postgresClientConfig, safeFailureFields } from "./lib/postgres-connection.mjs";

const { Client } = pg;

export const MARKETPLACE_PROVIDER_PROOF_STATUS_VERSION = "marketplace-provider-proof-status/v1";

const STRIPE_PAYMENT_PROVIDER_EVENT_MINIMUM = 5;
const STRIPE_CONNECT_PROVIDER_EVENT_MINIMUM = 2;
const FULFILLMENT_PROVIDER_EVENT_MINIMUM = 4;
const FULFILLMENT_TRACKING_STATUS_MINIMUM = 3;
const FULFILLMENT_REFUND_STATUS_MINIMUM = 1;

export function parseProviderProofStatusArgs(argv, env = process.env) {
  return {
    environment:
      readOption(argv, "--environment") ??
      readEnv("MARKETPLACE_PROVIDER_PROOF_ENVIRONMENT", env) ??
      readEnv("DEPLOYMENT_ENVIRONMENT", env) ??
      "unknown",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    paymentsDatabaseUrl:
      readOption(argv, "--payments-database-url") ??
      readEnv("PAYMENTS_DATABASE_URL", env) ??
      readEnv("DATABASE_URL_PAYMENTS", env),
    settlementDatabaseUrl:
      readOption(argv, "--settlement-database-url") ??
      readEnv("SETTLEMENT_DATABASE_URL", env) ??
      readEnv("DATABASE_URL_SETTLEMENT", env),
    fulfillmentDatabaseUrl:
      readOption(argv, "--fulfillment-database-url") ??
      readEnv("FULFILLMENT_DATABASE_URL", env) ??
      readEnv("DATABASE_URL_FULFILLMENT", env),
  };
}

export function validateProviderProofStatusOptions(options) {
  const errors = [];
  if (!options.paymentsDatabaseUrl) {
    errors.push("PAYMENTS_DATABASE_URL, DATABASE_URL_PAYMENTS, or --payments-database-url is required.");
  }
  if (!options.settlementDatabaseUrl) {
    errors.push("SETTLEMENT_DATABASE_URL, DATABASE_URL_SETTLEMENT, or --settlement-database-url is required.");
  }
  if (!options.fulfillmentDatabaseUrl) {
    errors.push("FULFILLMENT_DATABASE_URL, DATABASE_URL_FULFILLMENT, or --fulfillment-database-url is required.");
  }
  if (!options.environment) {
    errors.push("MARKETPLACE_PROVIDER_PROOF_ENVIRONMENT, DEPLOYMENT_ENVIRONMENT, or --environment is required.");
  }
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("Provider proof status checkedAt must be an ISO timestamp.");
  }
  return errors;
}

export async function runProviderProofStatus(options, ClientCtor = Client) {
  const errors = validateProviderProofStatusOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const [payments, settlement, fulfillment] = await Promise.all([
    queryPaymentsStatus(options.paymentsDatabaseUrl, ClientCtor),
    querySettlementStatus(options.settlementDatabaseUrl, ClientCtor),
    queryFulfillmentStatus(options.fulfillmentDatabaseUrl, ClientCtor),
  ]);

  return buildProviderProofStatus({
    environment: options.environment,
    checkedAt: options.checkedAt,
    payments,
    settlement,
    fulfillment,
  });
}

export function buildProviderProofStatus(input) {
  const stripeMoney = buildStripeMoneyStatus(input.payments, input.settlement);
  const fulfillmentPostage = buildFulfillmentPostageStatus(input.fulfillment);

  return {
    schemaVersion: MARKETPLACE_PROVIDER_PROOF_STATUS_VERSION,
    environment: input.environment ?? "unknown",
    checkedAt: input.checkedAt,
    note: "Status report only. Counts help assemble private proof records but do not approve production launch gates.",
    stripeMoney,
    fulfillmentPostage,
    gateStatus: {
      stripeMoneyOperationsCouldPassProviderRowThresholds:
        stripeMoney.paymentProviderEventRowCount >= STRIPE_PAYMENT_PROVIDER_EVENT_MINIMUM &&
        stripeMoney.connectProviderEventRowCount >= STRIPE_CONNECT_PROVIDER_EVENT_MINIMUM &&
        stripeMoney.dashboardNoneApplicationReadinessCount > 0,
      fulfillmentPostageCouldPassProviderRowThresholds:
        fulfillmentPostage.providerEventRowCount >= FULFILLMENT_PROVIDER_EVENT_MINIMUM &&
        fulfillmentPostage.trackingStatusProviderEventRowCount >= FULFILLMENT_TRACKING_STATUS_MINIMUM &&
        fulfillmentPostage.refundStatusProviderEventRowCount >= FULFILLMENT_REFUND_STATUS_MINIMUM,
      remainingProviderRowGaps: [
        ...stripeMoney.remainingProviderRowGaps,
        ...fulfillmentPostage.remainingProviderRowGaps,
      ],
    },
  };
}

async function queryPaymentsStatus(databaseUrl, ClientCtor) {
  return queryDatabase(databaseUrl, ClientCtor, async (client) => {
    const [providerEventsByKind, recentProviderEvents] = await Promise.all([
      client.query(`
        SELECT provider_name,
               event_kind,
               COUNT(*)::int AS count,
               MAX(received_at) AS latest_received_at
        FROM payments_provider_webhook_events
        GROUP BY provider_name, event_kind
        ORDER BY provider_name, event_kind
      `),
      client.query(`
        SELECT provider_name,
               event_kind,
               provider_event_id,
               received_at
        FROM payments_provider_webhook_events
        ORDER BY received_at DESC
        LIMIT 5
      `),
    ]);

    return {
      providerEventsByKind: providerEventsByKind.rows.map(normalizeProviderEventAggregateRow),
      recentProviderEvents: recentProviderEvents.rows.map(normalizeRecentProviderEventRow),
    };
  });
}

async function querySettlementStatus(databaseUrl, ClientCtor) {
  return queryDatabase(databaseUrl, ClientCtor, async (client) => {
    const [moneyMovementEventsByKind, payoutReadinessByPosture, payoutsByStatus, providerOperationsByKind] =
      await Promise.all([
        client.query(`
          SELECT provider_name,
                 event_kind,
                 COUNT(*)::int AS count,
                 MAX(received_at) AS latest_received_at
          FROM settlement_money_movement_webhook_events
          GROUP BY provider_name, event_kind
          ORDER BY provider_name, event_kind
        `),
        client.query(`
          SELECT payout_account_dashboard,
                 losses_collector,
                 fees_collector,
                 requirements_collector,
                 status,
                 COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM settlement_payout_readiness_pages
          GROUP BY payout_account_dashboard,
                   losses_collector,
                   fees_collector,
                   requirements_collector,
                   status
          ORDER BY payout_account_dashboard,
                   losses_collector,
                   fees_collector,
                   requirements_collector,
                   status
        `),
        client.query(`
          SELECT status,
                 COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM settlement_payout_pages
          GROUP BY status
          ORDER BY status
        `),
        client.query(`
          SELECT operation_kind,
                 status,
                 COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM settlement_provider_operations
          GROUP BY operation_kind, status
          ORDER BY operation_kind, status
        `),
      ]);

    return {
      moneyMovementEventsByKind: moneyMovementEventsByKind.rows.map(normalizeProviderEventAggregateRow),
      payoutReadinessByPosture: payoutReadinessByPosture.rows.map(normalizePayoutReadinessPostureRow),
      payoutsByStatus: payoutsByStatus.rows.map(normalizeStatusAggregateRow),
      providerOperationsByKind: providerOperationsByKind.rows.map(normalizeOperationAggregateRow),
    };
  });
}

async function queryFulfillmentStatus(databaseUrl, ClientCtor) {
  return queryDatabase(databaseUrl, ClientCtor, async (client) => {
    const [postageEventsByKind, labelOperationsByKind, shipmentLabelsByStatus, recentShipmentLabels] =
      await Promise.all([
        client.query(`
          SELECT provider_name,
                 provider_mode,
                 event_kind,
                 COUNT(*)::int AS count,
                 MAX(received_at) AS latest_received_at
          FROM fulfillment_postage_provider_events
          GROUP BY provider_name, provider_mode, event_kind
          ORDER BY provider_name, provider_mode, event_kind
        `),
        client.query(`
          SELECT operation_kind,
                 provider_mode,
                 status,
                 COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM fulfillment_postage_label_operations
          GROUP BY operation_kind, provider_mode, status
          ORDER BY operation_kind, provider_mode, status
        `),
        client.query(`
          SELECT status,
                 label_status,
                 postage_provider_mode,
                 COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM fulfillment_shipment_pages
          WHERE postage_provider_mode IS NOT NULL
             OR label_status <> 'not-purchased'
          GROUP BY status, label_status, postage_provider_mode
          ORDER BY status, label_status, postage_provider_mode
        `),
        client.query(`
          SELECT shipment_id,
                 status,
                 label_status,
                 postage_provider_mode,
                 carrier_name,
                 postage_service_level,
                 label_refund_status,
                 updated_at
          FROM fulfillment_shipment_pages
          WHERE postage_provider_mode IS NOT NULL
             OR label_status <> 'not-purchased'
          ORDER BY updated_at DESC
          LIMIT 5
        `),
      ]);

    return {
      postageEventsByKind: postageEventsByKind.rows.map(normalizePostageProviderEventAggregateRow),
      labelOperationsByKind: labelOperationsByKind.rows.map(normalizeLabelOperationAggregateRow),
      shipmentLabelsByStatus: shipmentLabelsByStatus.rows.map(normalizeShipmentLabelStatusRow),
      recentShipmentLabels: recentShipmentLabels.rows.map(normalizeRecentShipmentLabelRow),
    };
  });
}

async function queryDatabase(databaseUrl, ClientCtor, queryFn) {
  const client = new ClientCtor(postgresClientConfig(databaseUrl));
  await client.connect();
  try {
    return await queryFn(client);
  } finally {
    await client.end();
  }
}

function buildStripeMoneyStatus(payments, settlement) {
  const paymentProviderEventRowCount = sumCounts(payments.providerEventsByKind);
  const connectProviderEventRowCount = sumCounts(settlement.moneyMovementEventsByKind);
  const dashboardNoneApplicationReadinessCount = sumCounts(
    settlement.payoutReadinessByPosture.filter(
      (row) =>
        row.payoutAccountDashboard === "none" &&
        row.lossesCollector === "application" &&
        row.feesCollector === "application" &&
        row.requirementsCollector === "application",
    ),
  );
  const settlementPayoutRowCount = sumCounts(settlement.payoutsByStatus);
  const settlementProviderOperationRowCount = sumCounts(settlement.providerOperationsByKind);

  return {
    paymentProviderEventRowCount,
    connectProviderEventRowCount,
    dashboardNoneApplicationReadinessCount,
    settlementPayoutRowCount,
    settlementProviderOperationRowCount,
    paymentsProviderEventsByKind: payments.providerEventsByKind,
    settlementMoneyMovementEventsByKind: settlement.moneyMovementEventsByKind,
    settlementPayoutReadinessByPosture: settlement.payoutReadinessByPosture,
    settlementPayoutsByStatus: settlement.payoutsByStatus,
    settlementProviderOperationsByKind: settlement.providerOperationsByKind,
    recentPaymentsProviderEvents: payments.recentProviderEvents,
    remainingProviderRowGaps: stripeMoneyProviderRowGaps({
      paymentProviderEventRowCount,
      connectProviderEventRowCount,
      dashboardNoneApplicationReadinessCount,
      settlementPayoutRowCount,
      settlementProviderOperationRowCount,
    }),
  };
}

function buildFulfillmentPostageStatus(fulfillment) {
  const providerEventRowCount = sumCounts(fulfillment.postageEventsByKind);
  const trackingStatusProviderEventRowCount = sumCounts(
    fulfillment.postageEventsByKind.filter((row) => row.eventKind === "tracking-status"),
  );
  const refundStatusProviderEventRowCount = sumCounts(
    fulfillment.postageEventsByKind.filter((row) => row.eventKind === "refund-status"),
  );
  const purchaseLabelOperationCount = sumCounts(
    fulfillment.labelOperationsByKind.filter((row) => row.operationKind === "purchase-usps-label"),
  );
  const voidLabelOperationCount = sumCounts(
    fulfillment.labelOperationsByKind.filter((row) => row.operationKind === "void-label"),
  );

  return {
    providerEventRowCount,
    trackingStatusProviderEventRowCount,
    refundStatusProviderEventRowCount,
    purchaseLabelOperationCount,
    voidLabelOperationCount,
    postageEventsByKind: fulfillment.postageEventsByKind,
    labelOperationsByKind: fulfillment.labelOperationsByKind,
    shipmentLabelsByStatus: fulfillment.shipmentLabelsByStatus,
    recentShipmentLabels: fulfillment.recentShipmentLabels,
    remainingProviderRowGaps: fulfillmentPostageProviderRowGaps({
      providerEventRowCount,
      trackingStatusProviderEventRowCount,
      refundStatusProviderEventRowCount,
      purchaseLabelOperationCount,
      voidLabelOperationCount,
    }),
  };
}

function stripeMoneyProviderRowGaps(status) {
  const gaps = [];
  if (status.paymentProviderEventRowCount < STRIPE_PAYMENT_PROVIDER_EVENT_MINIMUM) {
    gaps.push(
      `Stripe money operations needs at least ${STRIPE_PAYMENT_PROVIDER_EVENT_MINIMUM} Payments provider webhook rows; found ${status.paymentProviderEventRowCount}.`,
    );
  }
  if (status.connectProviderEventRowCount < STRIPE_CONNECT_PROVIDER_EVENT_MINIMUM) {
    gaps.push(
      `Stripe money operations needs at least ${STRIPE_CONNECT_PROVIDER_EVENT_MINIMUM} Settlement money-movement webhook rows; found ${status.connectProviderEventRowCount}.`,
    );
  }
  if (status.dashboardNoneApplicationReadinessCount < 1) {
    gaps.push("Stripe money operations needs at least one dashboard-none/application payout readiness row.");
  }
  if (status.settlementPayoutRowCount < 1) {
    gaps.push("Stripe money operations still has no Settlement payout rows.");
  }
  if (status.settlementProviderOperationRowCount < 1) {
    gaps.push("Stripe money operations still has no Settlement provider-operation rows.");
  }
  return gaps;
}

function fulfillmentPostageProviderRowGaps(status) {
  const gaps = [];
  if (status.providerEventRowCount < FULFILLMENT_PROVIDER_EVENT_MINIMUM) {
    gaps.push(
      `Fulfillment postage needs at least ${FULFILLMENT_PROVIDER_EVENT_MINIMUM} postage provider-event rows; found ${status.providerEventRowCount}.`,
    );
  }
  if (status.trackingStatusProviderEventRowCount < FULFILLMENT_TRACKING_STATUS_MINIMUM) {
    gaps.push(
      `Fulfillment postage needs at least ${FULFILLMENT_TRACKING_STATUS_MINIMUM} tracking-status rows; found ${status.trackingStatusProviderEventRowCount}.`,
    );
  }
  if (status.refundStatusProviderEventRowCount < FULFILLMENT_REFUND_STATUS_MINIMUM) {
    gaps.push(
      `Fulfillment postage needs at least ${FULFILLMENT_REFUND_STATUS_MINIMUM} refund-status row; found ${status.refundStatusProviderEventRowCount}.`,
    );
  }
  if (status.purchaseLabelOperationCount < 1) {
    gaps.push("Fulfillment postage still has no label purchase operation rows.");
  }
  if (status.voidLabelOperationCount < 1) {
    gaps.push("Fulfillment postage still has no label void operation rows.");
  }
  return gaps;
}

function normalizeProviderEventAggregateRow(row) {
  return {
    providerName: stringOrNull(row.provider_name),
    eventKind: stringOrNull(row.event_kind),
    count: numberOrZero(row.count),
    latestReceivedAt: timestampOrNull(row.latest_received_at),
  };
}

function normalizePostageProviderEventAggregateRow(row) {
  return {
    providerName: stringOrNull(row.provider_name),
    providerMode: stringOrNull(row.provider_mode),
    eventKind: stringOrNull(row.event_kind),
    count: numberOrZero(row.count),
    latestReceivedAt: timestampOrNull(row.latest_received_at),
  };
}

function normalizeRecentProviderEventRow(row) {
  return {
    providerName: stringOrNull(row.provider_name),
    eventKind: stringOrNull(row.event_kind),
    providerEventId: redactIdentifier(row.provider_event_id),
    receivedAt: timestampOrNull(row.received_at),
  };
}

function normalizePayoutReadinessPostureRow(row) {
  return {
    payoutAccountDashboard: normalizeKnown(row.payout_account_dashboard, ["none", "express", "full"]),
    lossesCollector: normalizeKnown(row.losses_collector, ["application", "stripe"]),
    feesCollector: normalizeKnown(row.fees_collector, ["application", "stripe"]),
    requirementsCollector: normalizeKnown(row.requirements_collector, ["application", "stripe"]),
    status: stringOrNull(row.status) ?? "unknown",
    count: numberOrZero(row.count),
    latestUpdatedAt: timestampOrNull(row.latest_updated_at),
  };
}

function normalizeStatusAggregateRow(row) {
  return {
    status: stringOrNull(row.status) ?? "unknown",
    count: numberOrZero(row.count),
    latestUpdatedAt: timestampOrNull(row.latest_updated_at),
  };
}

function normalizeOperationAggregateRow(row) {
  return {
    operationKind: stringOrNull(row.operation_kind),
    status: stringOrNull(row.status) ?? "unknown",
    count: numberOrZero(row.count),
    latestUpdatedAt: timestampOrNull(row.latest_updated_at),
  };
}

function normalizeLabelOperationAggregateRow(row) {
  return {
    operationKind: stringOrNull(row.operation_kind),
    providerMode: stringOrNull(row.provider_mode),
    status: stringOrNull(row.status) ?? "unknown",
    count: numberOrZero(row.count),
    latestUpdatedAt: timestampOrNull(row.latest_updated_at),
  };
}

function normalizeShipmentLabelStatusRow(row) {
  return {
    status: stringOrNull(row.status) ?? "unknown",
    labelStatus: stringOrNull(row.label_status) ?? "unknown",
    postageProviderMode: stringOrNull(row.postage_provider_mode),
    count: numberOrZero(row.count),
    latestUpdatedAt: timestampOrNull(row.latest_updated_at),
  };
}

function normalizeRecentShipmentLabelRow(row) {
  return {
    shipmentId: redactIdentifier(row.shipment_id),
    status: stringOrNull(row.status) ?? "unknown",
    labelStatus: stringOrNull(row.label_status) ?? "unknown",
    postageProviderMode: stringOrNull(row.postage_provider_mode),
    carrierName: stringOrNull(row.carrier_name),
    postageServiceLevel: stringOrNull(row.postage_service_level),
    labelRefundStatus: stringOrNull(row.label_refund_status),
    updatedAt: timestampOrNull(row.updated_at),
  };
}

function sumCounts(rows) {
  return rows.reduce((total, row) => total + numberOrZero(row.count), 0);
}

function normalizeKnown(value, knownValues) {
  const normalized = stringOrNull(value);
  return normalized && knownValues.includes(normalized) ? normalized : "unknown";
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function stringOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function timestampOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return stringOrNull(value);
}

function redactIdentifier(value) {
  const normalized = stringOrNull(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length <= 12) {
    return `${normalized.slice(0, 4)}...`;
  }
  return `${normalized.slice(0, 8)}...${normalized.slice(-4)}`;
}

function isIsoTimestamp(value) {
  if (!stringOrNull(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

async function main(argv, env = process.env) {
  try {
    const report = await runProviderProofStatus(parseProviderProofStatusArgs(argv, env));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify(safeFailureFields("marketplace-provider-proof-status-failed", error)));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
