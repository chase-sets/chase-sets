#!/usr/bin/env node
import pg from "pg";
import process from "node:process";
import { fileURLToPath } from "node:url";

const { Client } = pg;

export const POSTAGE_POLICY_CLEANUP_EVIDENCE_VERSION = "postage-policy-cleanup-evidence/v1";

const ACTIVE_ORDER_STATUSES = new Set(["pending", "ready-for-fulfillment"]);
const ACTIVE_SHIPMENT_STATUSES = new Set([
  "awaiting-package",
  "packing",
  "awaiting-label",
  "label-attached",
  "exception",
]);

export function parsePostagePolicyCleanupEvidenceArgs(argv, env = process.env) {
  const sharedDatabaseUrl = readOption(argv, "--database-url") ?? readEnv("DATABASE_URL", env);
  return {
    environment:
      readOption(argv, "--environment") ??
      readEnv("POSTAGE_POLICY_CLEANUP_ENVIRONMENT", env) ??
      readEnv("DEPLOYMENT_ENVIRONMENT", env) ??
      "unknown",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    orderingDatabaseUrl:
      readOption(argv, "--ordering-database-url") ?? readEnv("ORDERING_DATABASE_URL", env) ?? sharedDatabaseUrl,
    fulfillmentDatabaseUrl:
      readOption(argv, "--fulfillment-database-url") ?? readEnv("FULFILLMENT_DATABASE_URL", env) ?? sharedDatabaseUrl,
  };
}

export function validatePostagePolicyCleanupEvidenceOptions(options) {
  const errors = [];
  if (!options.orderingDatabaseUrl) {
    errors.push("ORDERING_DATABASE_URL, DATABASE_URL, --ordering-database-url, or --database-url is required.");
  }
  if (!options.fulfillmentDatabaseUrl) {
    errors.push("FULFILLMENT_DATABASE_URL, DATABASE_URL, --fulfillment-database-url, or --database-url is required.");
  }
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("Postage policy cleanup checkedAt must be an ISO timestamp.");
  }
  return errors;
}

export async function runPostagePolicyCleanupEvidence(options, ClientCtor = Client) {
  const errors = validatePostagePolicyCleanupEvidenceOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const [ordering, fulfillment] = await Promise.all([
    queryOrderingPostageCleanup(options.orderingDatabaseUrl, ClientCtor),
    queryFulfillmentPostageCleanup(options.fulfillmentDatabaseUrl, ClientCtor),
  ]);

  return buildPostagePolicyCleanupEvidence({
    environment: options.environment,
    checkedAt: options.checkedAt,
    ordering,
    fulfillment,
  });
}

export function buildPostagePolicyCleanupEvidence(input) {
  const ordering = normalizeOrderingPostageCleanup(input.ordering);
  const fulfillment = normalizeFulfillmentPostageCleanup(input.fulfillment);
  const activeOrdersWithoutSnapshots = sumRows(ordering.orderPolicySnapshotsByStatus, (row) =>
    ACTIVE_ORDER_STATUSES.has(row.status) ? row.missingPolicySnapshotCount : 0,
  );
  const activeShipmentsWithoutSnapshots = sumRows(fulfillment.shipmentPolicySnapshotsByStatus, (row) =>
    ACTIVE_SHIPMENT_STATUSES.has(row.status) ? row.missingPolicySnapshotCount : 0,
  );
  const activePolicyCount = sumRows(ordering.policyPagesByStatus, (row) => (row.status === "active" ? row.count : 0));
  const capabilityFailureCount = sumRows(fulfillment.labelErrorsByCode, (row) =>
    row.errorCode === "postage_provider_capability_failure" ? row.count : 0,
  );
  const remainingCleanupGaps = [];

  if (activePolicyCount !== 1) {
    remainingCleanupGaps.push(`Expected exactly one active postage policy; found ${activePolicyCount}.`);
  }
  if (activeOrdersWithoutSnapshots > 0) {
    remainingCleanupGaps.push(
      `Ordering has ${activeOrdersWithoutSnapshots} active order(s) without postagePolicySnapshot metadata.`,
    );
  }
  if (activeShipmentsWithoutSnapshots > 0) {
    remainingCleanupGaps.push(
      `Fulfillment has ${activeShipmentsWithoutSnapshots} active shipment(s) without postagePolicySnapshot metadata.`,
    );
  }

  return {
    schemaVersion: POSTAGE_POLICY_CLEANUP_EVIDENCE_VERSION,
    environment: input.environment ?? "unknown",
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    note: "Read-only cleanup evidence. This report supports #893 but does not delete historical immutable policy snapshots.",
    ordering,
    fulfillment,
    cleanupStatus: {
      activePolicyCount,
      activeOrdersWithoutSnapshots,
      activeShipmentsWithoutSnapshots,
      capabilityFailureCount,
      readyToRetireLegacyCompatibility: remainingCleanupGaps.length === 0,
      remainingCleanupGaps,
    },
    cleanupPolicy: {
      historicalSnapshotsRetained: true,
      temporaryMigrationArtifactsAllowedAfterCleanup: false,
      runtimePackagePlanningRequiresResolvedPolicy: true,
    },
  };
}

async function queryOrderingPostageCleanup(databaseUrl, ClientCtor) {
  return queryDatabase(databaseUrl, ClientCtor, async (client) => {
    const [policyPagesByStatus, orderPolicySnapshotsByStatus] = await Promise.all([
      client.query(`
        SELECT status,
               COUNT(*)::int AS count,
               MAX(updated_at) AS latest_updated_at
        FROM ordering_postage_policy_pages
        GROUP BY status
        ORDER BY status
      `),
      client.query(`
        SELECT status,
               COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE shipping_plan_snapshot->'postagePolicySnapshot' IS NULL)::int
                 AS missing_policy_snapshot_count,
               COUNT(*) FILTER (
                 WHERE shipping_plan_snapshot->'postagePolicySnapshot'->>'policyVersion' IS NOT NULL
               )::int AS policy_snapshot_count,
               MAX(updated_at) AS latest_updated_at
        FROM ordering_order_pages
        GROUP BY status
        ORDER BY status
      `),
    ]);

    return {
      policyPagesByStatus: policyPagesByStatus.rows.map(normalizeCountStatusRow),
      orderPolicySnapshotsByStatus: orderPolicySnapshotsByStatus.rows.map(normalizeSnapshotStatusRow),
    };
  });
}

async function queryFulfillmentPostageCleanup(databaseUrl, ClientCtor) {
  return queryDatabase(databaseUrl, ClientCtor, async (client) => {
    const [shipmentPolicySnapshotsByStatus, labelErrorsByCode] = await Promise.all([
      client.query(`
        SELECT status,
               COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE shipping_plan_snapshot->'postagePolicySnapshot' IS NULL)::int
                 AS missing_policy_snapshot_count,
               COUNT(*) FILTER (
                 WHERE shipping_plan_snapshot->'postagePolicySnapshot'->>'policyVersion' IS NOT NULL
               )::int AS policy_snapshot_count,
               MAX(updated_at) AS latest_updated_at
        FROM fulfillment_shipment_pages
        GROUP BY status
        ORDER BY status
      `),
      client.query(`
        SELECT COALESCE(label_error_code, 'none') AS error_code,
               COUNT(*)::int AS count,
               MAX(updated_at) AS latest_updated_at
        FROM fulfillment_shipment_pages
        WHERE label_error_code IS NOT NULL
        GROUP BY label_error_code
        ORDER BY label_error_code
      `),
    ]);

    return {
      shipmentPolicySnapshotsByStatus: shipmentPolicySnapshotsByStatus.rows.map(normalizeSnapshotStatusRow),
      labelErrorsByCode: labelErrorsByCode.rows.map(normalizeLabelErrorRow),
    };
  });
}

async function queryDatabase(databaseUrl, ClientCtor, callback) {
  const client = new ClientCtor({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

function normalizeOrderingPostageCleanup(input = {}) {
  return {
    policyPagesByStatus: (input.policyPagesByStatus ?? []).map(normalizeCountStatusRow),
    orderPolicySnapshotsByStatus: (input.orderPolicySnapshotsByStatus ?? []).map(normalizeSnapshotStatusRow),
  };
}

function normalizeFulfillmentPostageCleanup(input = {}) {
  return {
    shipmentPolicySnapshotsByStatus: (input.shipmentPolicySnapshotsByStatus ?? []).map(normalizeSnapshotStatusRow),
    labelErrorsByCode: (input.labelErrorsByCode ?? []).map(normalizeLabelErrorRow),
  };
}

function normalizeCountStatusRow(row) {
  return {
    status: stringValue(row.status, "unknown"),
    count: numberValue(row.count),
    latestUpdatedAt: timestampValue(row.latest_updated_at ?? row.latestUpdatedAt),
  };
}

function normalizeSnapshotStatusRow(row) {
  return {
    status: stringValue(row.status, "unknown"),
    count: numberValue(row.count),
    missingPolicySnapshotCount: numberValue(row.missing_policy_snapshot_count ?? row.missingPolicySnapshotCount),
    policySnapshotCount: numberValue(row.policy_snapshot_count ?? row.policySnapshotCount),
    latestUpdatedAt: timestampValue(row.latest_updated_at ?? row.latestUpdatedAt),
  };
}

function normalizeLabelErrorRow(row) {
  return {
    errorCode: stringValue(row.error_code ?? row.errorCode, "unknown"),
    count: numberValue(row.count),
    latestUpdatedAt: timestampValue(row.latest_updated_at ?? row.latestUpdatedAt),
  };
}

function sumRows(rows, selector) {
  return rows.reduce((sum, row) => sum + selector(row), 0);
}

function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function timestampValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function readOption(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readEnv(name, env) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function main() {
  const report = await runPostagePolicyCleanupEvidence(parsePostagePolicyCleanupEvidenceArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
