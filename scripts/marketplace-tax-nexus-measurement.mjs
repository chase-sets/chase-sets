#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp, validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const TAX_NEXUS_MEASUREMENT_QUERY_VERSION = "tax-nexus-measurement-query/v1";

export const TAX_NEXUS_INCLUDED_ORDER_STATUSES = ["pending-reservation", "pending-payment", "ready-for-fulfillment"];

export const TAX_NEXUS_JURISDICTION_CODES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];

const taxNexusJurisdictionCodeSet = new Set(TAX_NEXUS_JURISDICTION_CODES);

export const taxNexusMeasurementSql = `
WITH source_orders AS (
  SELECT
    NULLIF(
      UPPER(
        TRIM(
          COALESCE(
            tax_jurisdiction_state,
            shipping_destination_snapshot ->> 'state',
            shipping_destination_snapshot ->> 'stateCode'
          )
        )
      ),
      ''
    ) AS jurisdiction_code,
    total_amount,
    created_at
  FROM ordering_order_pages
  WHERE tax_jurisdiction_country = 'US'
    AND status = ANY($4::text[])
    AND created_at >= $1::timestamptz
    AND created_at < $3::timestamptz
)
SELECT
  jurisdiction_code,
  COALESCE(
    SUM(total_amount) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz),
    0
  )::text AS current_year_gross_sales_amount,
  COUNT(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz)::integer
    AS current_year_transaction_count,
  COALESCE(
    SUM(total_amount) FILTER (WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz),
    0
  )::text AS previous_year_gross_sales_amount,
  COUNT(*) FILTER (WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz)::integer
    AS previous_year_transaction_count
FROM source_orders
GROUP BY jurisdiction_code
ORDER BY jurisdiction_code NULLS FIRST;
`;

export function parseTaxNexusMeasurementArgs(argv, env = process.env) {
  return {
    databaseUrl:
      readOption(argv, "--database-url") ??
      readEnv("TAX_NEXUS_MEASUREMENT_DATABASE_URL", env) ??
      readEnv("MARKETPLACE_DATABASE_URL", env) ??
      readEnv("DATABASE_URL", env),
    environment:
      readOption(argv, "--environment") ??
      readEnv("TAX_NEXUS_MEASUREMENT_ENVIRONMENT", env) ??
      readEnv("DEPLOYMENT_ENVIRONMENT", env),
    operator: readOption(argv, "--operator") ?? readEnv("TAX_NEXUS_MEASUREMENT_OPERATOR", env),
    projectionFreshnessReference:
      readOption(argv, "--projection-freshness-reference") ?? readEnv("TAX_NEXUS_PROJECTION_FRESHNESS_REFERENCE", env),
    reference: readOption(argv, "--reference") ?? readEnv("TAX_NEXUS_MEASUREMENT_REFERENCE", env),
    asOf: readOption(argv, "--as-of") ?? readEnv("TAX_NEXUS_MEASUREMENT_AS_OF", env) ?? null,
    currentYearStart: readOption(argv, "--current-year-start") ?? readEnv("TAX_NEXUS_CURRENT_YEAR_START", env) ?? null,
    previousYearStart:
      readOption(argv, "--previous-year-start") ?? readEnv("TAX_NEXUS_PREVIOUS_YEAR_START", env) ?? null,
  };
}

export function buildTaxNexusQueryWindow(input) {
  const asOfDate = parseDate(input.asOf ?? new Date().toISOString(), "asOf");
  const currentYearStart = input.currentYearStart
    ? parseDate(input.currentYearStart, "currentYearStart")
    : new Date(Date.UTC(asOfDate.getUTCFullYear(), 0, 1));
  const previousYearStart = input.previousYearStart
    ? parseDate(input.previousYearStart, "previousYearStart")
    : new Date(Date.UTC(currentYearStart.getUTCFullYear() - 1, 0, 1));
  const nextYearStart = new Date(Date.UTC(currentYearStart.getUTCFullYear() + 1, 0, 1));

  if (previousYearStart >= currentYearStart) {
    throw new Error("previousYearStart must be before currentYearStart.");
  }
  if (currentYearStart > asOfDate) {
    throw new Error("currentYearStart must be on or before asOf.");
  }

  return {
    asOf: asOfDate.toISOString(),
    previousYearStart: previousYearStart.toISOString(),
    currentYearStart: currentYearStart.toISOString(),
    nextYearStart: nextYearStart.toISOString(),
  };
}

export function normalizeTaxNexusMeasurementRow(row) {
  return {
    jurisdictionCode: normalizeJurisdictionCode(row?.jurisdiction_code),
    currentYearGrossSalesAmount: normalizeMoney(row?.current_year_gross_sales_amount ?? 0),
    previousYearGrossSalesAmount: normalizeMoney(row?.previous_year_gross_sales_amount ?? 0),
    currentYearTransactionCount: normalizeCount(row?.current_year_transaction_count ?? 0),
    previousYearTransactionCount: normalizeCount(row?.previous_year_transaction_count ?? 0),
  };
}

export function buildTaxNexusMeasurementEvidence(input) {
  const normalizedRows = input.rows.map(normalizeTaxNexusMeasurementRow);
  const rowsByJurisdiction = new Map();
  const unknownJurisdictionCodes = new Set();
  let missingJurisdictionOrderCount = 0;
  let unknownJurisdictionOrderCount = 0;

  for (const row of normalizedRows) {
    const transactionCount = row.currentYearTransactionCount + row.previousYearTransactionCount;
    if (!row.jurisdictionCode) {
      missingJurisdictionOrderCount += transactionCount;
      continue;
    }
    if (!taxNexusJurisdictionCodeSet.has(row.jurisdictionCode)) {
      unknownJurisdictionCodes.add(row.jurisdictionCode);
      unknownJurisdictionOrderCount += transactionCount;
      continue;
    }

    rowsByJurisdiction.set(row.jurisdictionCode, row);
  }

  const activity = TAX_NEXUS_JURISDICTION_CODES.map((jurisdictionCode) => {
    const row = rowsByJurisdiction.get(jurisdictionCode);
    return {
      jurisdictionCode,
      currentYearGrossSalesAmount: row?.currentYearGrossSalesAmount ?? "0.00",
      previousYearGrossSalesAmount: row?.previousYearGrossSalesAmount ?? "0.00",
      currentYearTransactionCount: row?.currentYearTransactionCount ?? 0,
      previousYearTransactionCount: row?.previousYearTransactionCount ?? 0,
      registrationStatus: "not-registered",
      collectionStatus: "not-collecting",
      providerBackedQuotesReady: false,
    };
  });

  const requiresManualReview = missingJurisdictionOrderCount > 0 || unknownJurisdictionOrderCount > 0;
  const errors = validateTaxNexusMeasurementEvidenceInput(input, requiresManualReview);

  return {
    schemaVersion: "marketplace-tax-nexus-measurement/v1",
    queryVersion: TAX_NEXUS_MEASUREMENT_QUERY_VERSION,
    checkedAt: input.checkedAt,
    environment: input.environment,
    reference: input.reference,
    operator: input.operator,
    projectionFreshnessReference: input.projectionFreshnessReference,
    asOf: input.queryWindow.asOf,
    queryWindow: {
      previousYearStart: input.queryWindow.previousYearStart,
      currentYearStart: input.queryWindow.currentYearStart,
      nextYearStart: input.queryWindow.nextYearStart,
    },
    source: {
      table: "ordering_order_pages",
      country: "US",
      includedOrderStatuses: TAX_NEXUS_INCLUDED_ORDER_STATUSES,
    },
    jurisdictionCoverage: {
      missingJurisdictionOrderCount,
      unknownJurisdictionOrderCount,
      unknownJurisdictionCodes: [...unknownJurisdictionCodes].sort(),
      requiresManualReview,
    },
    activity,
    caveats: [
      "This is a redacted source activity measurement for Tax review, not legal or accounting approval.",
      "Registration status, collection status, provider readiness, threshold policy, and filing ownership must be reviewed by Tax counsel/accounting before launch approval.",
      "Included order statuses intentionally overstate live launch exposure by counting non-cancelled checkout pipeline orders.",
    ],
    passesSourceMeasurementGate: !requiresManualReview && errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runTaxNexusMeasurement(options) {
  const queryWindow = buildTaxNexusQueryWindow(options);
  const { Client } = await import("pg");
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    const result = await client.query(taxNexusMeasurementSql, [
      queryWindow.previousYearStart,
      queryWindow.currentYearStart,
      queryWindow.nextYearStart,
      TAX_NEXUS_INCLUDED_ORDER_STATUSES,
    ]);
    return buildTaxNexusMeasurementEvidence({
      rows: result.rows,
      checkedAt: new Date().toISOString(),
      environment: options.environment,
      reference: options.reference,
      operator: options.operator,
      projectionFreshnessReference: options.projectionFreshnessReference,
      queryWindow,
    });
  } finally {
    await client.end();
  }
}

async function main(argv, env = process.env) {
  const options = parseTaxNexusMeasurementArgs(argv, env);
  const errors = validateTaxNexusMeasurementOptions(options);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 2;
  }

  let evidence;
  try {
    evidence = await runTaxNexusMeasurement(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesSourceMeasurementGate) {
    console.error("Tax nexus source measurement requires manual review before launch approval.");
    return 1;
  }

  return 0;
}

function validateTaxNexusMeasurementOptions(options) {
  const errors = [];
  if (!options.databaseUrl) {
    errors.push(
      "DATABASE_URL, MARKETPLACE_DATABASE_URL, TAX_NEXUS_MEASUREMENT_DATABASE_URL, or --database-url is required.",
    );
  }
  if (!options.environment) {
    errors.push("TAX_NEXUS_MEASUREMENT_ENVIRONMENT, DEPLOYMENT_ENVIRONMENT, or --environment is required.");
  }
  if (options.environment && options.environment !== "production") {
    errors.push("Tax nexus measurement must run against production before marketplace launch.");
  }
  if (!options.operator) {
    errors.push("TAX_NEXUS_MEASUREMENT_OPERATOR or --operator is required.");
  }
  if (!options.projectionFreshnessReference) {
    errors.push("TAX_NEXUS_PROJECTION_FRESHNESS_REFERENCE or --projection-freshness-reference is required.");
  } else {
    validateEvidenceReference("TAX_NEXUS_PROJECTION_FRESHNESS_REFERENCE", options.projectionFreshnessReference, errors);
  }
  if (!options.reference) {
    errors.push("TAX_NEXUS_MEASUREMENT_REFERENCE or --reference is required.");
  } else {
    validateEvidenceReference("TAX_NEXUS_MEASUREMENT_REFERENCE", options.reference, errors);
  }

  try {
    buildTaxNexusQueryWindow(options);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return errors;
}

function validateTaxNexusMeasurementEvidenceInput(input, requiresManualReview) {
  const errors = [];
  if (input.environment !== "production") {
    errors.push("Tax nexus source measurement must run against production before marketplace launch.");
  }
  if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Tax nexus source measurement checkedAt must be an ISO timestamp.");
  }
  if (!isNonEmptyString(input.operator)) {
    errors.push("Tax nexus source measurement must include the operator who ran the sweep.");
  }
  if (!isNonEmptyString(input.reference)) {
    errors.push("Tax nexus source measurement must include reference.");
  } else {
    validateEvidenceReference("Tax nexus source measurement reference", input.reference, errors);
  }
  if (!isNonEmptyString(input.projectionFreshnessReference)) {
    errors.push("Tax nexus source measurement must include projectionFreshnessReference.");
  } else {
    validateEvidenceReference(
      "Tax nexus source measurement projectionFreshnessReference",
      input.projectionFreshnessReference,
      errors,
    );
  }
  const queryWindowErrors = validateTaxNexusQueryWindow(input.queryWindow);
  errors.push(...queryWindowErrors);
  if (requiresManualReview) {
    errors.push("Tax nexus source measurement must resolve missing or unknown jurisdiction coverage before launch.");
  }
  return errors;
}

function validateTaxNexusQueryWindow(queryWindow) {
  const errors = [];
  if (!queryWindow || typeof queryWindow !== "object") {
    return ["Tax nexus source measurement must include queryWindow."];
  }
  const previousYearStart = validateDateString(queryWindow.previousYearStart, "previousYearStart", errors);
  const currentYearStart = validateDateString(queryWindow.currentYearStart, "currentYearStart", errors);
  const nextYearStart = validateDateString(queryWindow.nextYearStart, "nextYearStart", errors);
  validateDateString(queryWindow.asOf, "asOf", errors);
  if (previousYearStart && currentYearStart && previousYearStart >= currentYearStart) {
    errors.push("Tax nexus source measurement queryWindow previousYearStart must be before currentYearStart.");
  }
  if (currentYearStart && nextYearStart && currentYearStart >= nextYearStart) {
    errors.push("Tax nexus source measurement queryWindow currentYearStart must be before nextYearStart.");
  }
  return errors;
}

function validateDateString(value, fieldName, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`Tax nexus source measurement queryWindow ${fieldName} must be an ISO timestamp.`);
    return null;
  }
  if (!isIsoTimestamp(value)) {
    errors.push(`Tax nexus source measurement queryWindow ${fieldName} must be an ISO timestamp.`);
    return null;
  }
  return new Date(value);
}

function normalizeJurisdictionCode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Tax nexus gross sales amount must be a non-negative number.");
  }
  return amount.toFixed(2);
}

function normalizeCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Tax nexus transaction count must be a non-negative integer.");
  }
  return count;
}

function parseDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO date or timestamp.`);
  }
  return date;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
