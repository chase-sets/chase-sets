#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp, validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION = "launch-supply-measurement-query/v1";

export const launchSupplyMeasurementSql = `
WITH active_holds AS (
  SELECT item_id, SUM(quantity)::integer AS held_quantity
  FROM marketplace_supply_holds
  WHERE status = 'active'
  GROUP BY item_id
),
eligible_listings AS (
  SELECT
    listing.listing_id,
    listing.account_id,
    listing.product_measure_snapshot
  FROM marketplace_listing_pages AS listing
  INNER JOIN marketplace_supply_items AS item
    ON item.item_id = listing.inventory_item_id
  LEFT JOIN active_holds
    ON active_holds.item_id = item.item_id
  LEFT JOIN marketplace_seller_listing_availability_pages AS availability
    ON availability.account_id = listing.account_id
  WHERE listing.status = 'active'
    AND COALESCE(availability.status, 'available') = 'available'
    AND LEAST(
      listing.quantity_cap,
      GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
    ) > 0
)
SELECT
  COUNT(*)::integer AS active_launch_listing_count,
  COUNT(DISTINCT account_id)::integer AS active_launch_seller_account_count,
  COALESCE(
    (
      SELECT ARRAY_AGG(sampled.listing_id ORDER BY sampled.listing_id)
      FROM (
        SELECT listing_id
        FROM eligible_listings
        WHERE product_measure_snapshot IS NOT NULL
        ORDER BY listing_id
        LIMIT 10
      ) AS sampled
    ),
    ARRAY[]::text[]
  ) AS sampled_active_launch_listing_ids,
  COUNT(*) FILTER (WHERE product_measure_snapshot IS NULL)::integer
    AS active_launch_listings_missing_resolved_product_measures,
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(
      100.0
      * COUNT(*) FILTER (WHERE product_measure_snapshot IS NOT NULL)
      / COUNT(*),
      2
    )
  END::numeric AS resolved_product_measure_coverage_percent
FROM eligible_listings;
`;

export function parseLaunchSupplyMeasurementArgs(argv, env = process.env) {
  return {
    databaseUrl:
      readOption(argv, "--database-url") ?? readEnv("MARKETPLACE_DATABASE_URL", env) ?? readEnv("DATABASE_URL", env),
    environment:
      readOption(argv, "--environment") ??
      readEnv("LAUNCH_SUPPLY_ENVIRONMENT", env) ??
      readEnv("DEPLOYMENT_ENVIRONMENT", env),
    operator: readOption(argv, "--operator") ?? readEnv("LAUNCH_SUPPLY_OPERATOR", env),
    projectionFreshnessReference:
      readOption(argv, "--projection-freshness-reference") ??
      readEnv("LAUNCH_SUPPLY_PROJECTION_FRESHNESS_REFERENCE", env),
    queryReference: readOption(argv, "--query-reference") ?? readEnv("LAUNCH_SUPPLY_QUERY_REFERENCE", env),
  };
}

export function normalizeLaunchSupplyMeasurementRow(row) {
  return {
    activeLaunchListingCount: Number(row?.active_launch_listing_count ?? 0),
    activeLaunchSellerAccountCount: Number(row?.active_launch_seller_account_count ?? 0),
    sampledActiveLaunchListingIds: normalizeStringArray(row?.sampled_active_launch_listing_ids),
    activeLaunchListingsMissingResolvedProductMeasures: Number(
      row?.active_launch_listings_missing_resolved_product_measures ?? 0,
    ),
    resolvedProductMeasureCoveragePercent: Number(row?.resolved_product_measure_coverage_percent ?? 0),
  };
}

export function buildLaunchSupplyMeasurementEvidence(input) {
  const measurement = normalizeLaunchSupplyMeasurementRow(input.row);
  const errors = validateLaunchSupplyMeasurementEvidenceInput(input, measurement);
  const passesLaunchSupplyGate = errors.length === 0;

  return {
    queryVersion: LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION,
    checkedAt: input.checkedAt,
    environment: input.environment,
    queryReference: input.queryReference,
    operator: input.operator,
    projectionFreshnessReference: input.projectionFreshnessReference,
    ...measurement,
    passesLaunchSupplyGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runLaunchSupplyMeasurement(options) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    const result = await client.query(launchSupplyMeasurementSql);
    return buildLaunchSupplyMeasurementEvidence({
      row: result.rows[0],
      checkedAt: new Date().toISOString(),
      environment: options.environment,
      queryReference: options.queryReference,
      operator: options.operator,
      projectionFreshnessReference: options.projectionFreshnessReference,
    });
  } finally {
    await client.end();
  }
}

async function main(argv, env = process.env) {
  const options = parseLaunchSupplyMeasurementArgs(argv, env);
  const errors = validateLaunchSupplyMeasurementOptions(options);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runLaunchSupplyMeasurement(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesLaunchSupplyGate) {
    console.error("Launch supply measurement does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function validateLaunchSupplyMeasurementOptions(options) {
  const errors = [];
  if (!options.databaseUrl) {
    errors.push("DATABASE_URL, MARKETPLACE_DATABASE_URL, or --database-url is required.");
  }
  if (!options.environment) {
    errors.push("LAUNCH_SUPPLY_ENVIRONMENT, DEPLOYMENT_ENVIRONMENT, or --environment is required.");
  }
  if (options.environment && options.environment !== "production") {
    errors.push("Launch supply measurement must run against production before marketplace launch.");
  }
  if (!options.operator) {
    errors.push("LAUNCH_SUPPLY_OPERATOR or --operator is required.");
  }
  if (!options.projectionFreshnessReference) {
    errors.push("LAUNCH_SUPPLY_PROJECTION_FRESHNESS_REFERENCE or --projection-freshness-reference is required.");
  } else {
    validateEvidenceReference(
      "LAUNCH_SUPPLY_PROJECTION_FRESHNESS_REFERENCE",
      options.projectionFreshnessReference,
      errors,
    );
  }
  if (!options.queryReference) {
    errors.push("LAUNCH_SUPPLY_QUERY_REFERENCE or --query-reference is required.");
  } else {
    validateEvidenceReference("LAUNCH_SUPPLY_QUERY_REFERENCE", options.queryReference, errors);
  }
  return errors;
}

function validateLaunchSupplyMeasurementEvidenceInput(input, measurement) {
  const errors = [];
  if (!Number.isFinite(measurement.activeLaunchListingCount) || measurement.activeLaunchListingCount <= 0) {
    errors.push("Launch supply measurement must prove at least one active launch listing is eligible for checkout.");
  }
  if (
    !Number.isFinite(measurement.activeLaunchSellerAccountCount) ||
    measurement.activeLaunchSellerAccountCount <= 0 ||
    measurement.activeLaunchSellerAccountCount > measurement.activeLaunchListingCount
  ) {
    errors.push(
      "Launch supply measurement must include activeLaunchSellerAccountCount between 1 and activeLaunchListingCount.",
    );
  }
  validateSampledActiveLaunchListingIds(measurement, errors);
  if (
    !Number.isFinite(measurement.activeLaunchListingsMissingResolvedProductMeasures) ||
    measurement.activeLaunchListingsMissingResolvedProductMeasures !== 0
  ) {
    errors.push("Launch supply measurement must have activeLaunchListingsMissingResolvedProductMeasures=0.");
  }
  if (
    !Number.isFinite(measurement.resolvedProductMeasureCoveragePercent) ||
    measurement.resolvedProductMeasureCoveragePercent !== 100
  ) {
    errors.push("Launch supply measurement must have resolvedProductMeasureCoveragePercent=100.");
  }
  if (input.environment !== "production") {
    errors.push("Launch supply measurement must run against production before marketplace launch.");
  }
  if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Launch supply measurement checkedAt must be an ISO timestamp.");
  }
  if (!isNonEmptyString(input.operator)) {
    errors.push("Launch supply measurement must include the operator who ran the sweep.");
  }
  if (!isNonEmptyString(input.projectionFreshnessReference)) {
    errors.push("Launch supply measurement must include projectionFreshnessReference.");
  } else {
    validateEvidenceReference(
      "Launch supply measurement projectionFreshnessReference",
      input.projectionFreshnessReference,
      errors,
    );
  }
  if (!isNonEmptyString(input.queryReference)) {
    errors.push("Launch supply measurement must include queryReference.");
  } else {
    validateEvidenceReference("Launch supply measurement queryReference", input.queryReference, errors);
    if (input.queryReference.trim() === LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION) {
      errors.push("Launch supply measurement queryReference must point to the production query evidence record.");
    }
  }
  return errors;
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateSampledActiveLaunchListingIds(measurement, errors) {
  const ids = measurement.sampledActiveLaunchListingIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push("Launch supply measurement must include sampledActiveLaunchListingIds from production listings.");
    return;
  }
  if (ids.length > measurement.activeLaunchListingCount) {
    errors.push("Launch supply measurement sampledActiveLaunchListingIds cannot exceed activeLaunchListingCount.");
  }
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    errors.push("Launch supply measurement sampledActiveLaunchListingIds must be distinct.");
  }
  for (const id of ids) {
    if (
      !isNonEmptyString(id) ||
      id.length < 4 ||
      /^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test)$/i.test(id)
    ) {
      errors.push("Launch supply measurement sampledActiveLaunchListingIds must contain concrete listing IDs.");
      return;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
