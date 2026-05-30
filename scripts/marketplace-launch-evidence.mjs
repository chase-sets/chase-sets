#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION = "marketplace-launch-evidence/v1";

const MAX_EVIDENCE_AGE_DAYS = 30;

const REQUIRED_APPROVAL_GATES = [
  {
    key: "marketplacePromotion",
    label: "Marketplace promotion",
    approvedEnv: "PRODUCTION_MARKETPLACE_PROMOTION_APPROVED",
    referenceEnv: "PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE",
  },
  {
    key: "marketplaceCheckoutFee",
    label: "Marketplace Checkout Fee",
    approvedEnv: "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED",
    referenceEnv: "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE",
  },
  {
    key: "stripeMoneyOperations",
    label: "Stripe money operations",
    approvedEnv: "PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED",
    referenceEnv: "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE",
  },
  {
    key: "supportOperations",
    label: "Support operations",
    approvedEnv: "PRODUCTION_SUPPORT_OPERATIONS_APPROVED",
    referenceEnv: "PRODUCTION_SUPPORT_OPERATIONS_REFERENCE",
  },
  {
    key: "fulfillmentPostage",
    label: "Fulfillment postage",
    approvedEnv: "PRODUCTION_FULFILLMENT_POSTAGE_APPROVED",
    referenceEnv: "PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE",
  },
  {
    key: "transactionalEmail",
    label: "Transactional email",
    approvedEnv: "PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED",
    referenceEnv: "PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE",
  },
  {
    key: "launchSupplyMeasurements",
    label: "Launch supply measurements",
    approvedEnv: "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED",
    referenceEnv: "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE",
  },
  {
    key: "taxReadiness",
    label: "Tax readiness",
    approvedEnv: "PRODUCTION_TAX_READINESS_APPROVED",
    referenceEnv: "PRODUCTION_TAX_READINESS_REFERENCE",
  },
];

const PLACEHOLDER_REFERENCE_PATTERN =
  /^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test|ticket|record|launch-000)$/i;

export function validateMarketplaceLaunchEvidence(packet, options = {}) {
  const errors = [];
  const warnings = [];
  const now = options.now ?? new Date();

  if (!isRecord(packet)) {
    return {
      ok: false,
      errors: ["Evidence packet must be a JSON object."],
      warnings,
      summary: { checkedGateCount: 0 },
    };
  }

  if (packet.schemaVersion !== MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION}.`);
  }

  if (packet.environment !== "production") {
    errors.push("environment must be production.");
  }

  const gates = isRecord(packet.gates) ? packet.gates : {};
  if (!isRecord(packet.gates)) {
    errors.push("gates must be an object.");
  }

  for (const gateConfig of REQUIRED_APPROVAL_GATES) {
    validateApprovalGate(gateConfig, gates[gateConfig.key], packet.productionEnvironment, now, errors, warnings);
  }

  validateLaunchSupplyMeasurements(gates.launchSupplyMeasurements, errors);
  validateTaxReadiness(gates.taxReadiness, packet.productionEnvironment, errors);
  validateUcpAp2Marketing(gates.ucpAp2Marketing, errors, warnings);
  validateProductionEnvironment(packet.productionEnvironment, errors, warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      checkedGateCount: REQUIRED_APPROVAL_GATES.length,
      requiredGates: REQUIRED_APPROVAL_GATES.map((gate) => gate.key),
    },
  };
}

async function main(argv) {
  const filePath = readFileArgument(argv);
  if (!filePath) {
    console.error("Usage: node ./scripts/marketplace-launch-evidence.mjs --file <redacted-evidence.json>");
    return 2;
  }

  let packet;
  try {
    packet = JSON.parse(await readFile(resolve(filePath), "utf8"));
  } catch (error) {
    console.error(`Unable to read launch evidence packet: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const result = validateMarketplaceLaunchEvidence(packet);
  if (result.ok) {
    console.log(`Marketplace launch evidence passed ${result.summary.checkedGateCount} gates.`);
    for (const warning of result.warnings) {
      console.warn(`Warning: ${warning}`);
    }
    return 0;
  }

  console.error("Marketplace launch evidence failed:");
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  return 1;
}

function validateApprovalGate(config, gate, productionEnvironment, now, errors, warnings) {
  if (!isRecord(gate)) {
    errors.push(`${config.label} gate is required at gates.${config.key}.`);
    return;
  }

  if (gate.approved !== true) {
    errors.push(`${config.label} gate must have approved=true.`);
  }

  validateReference(`${config.label} reference`, gate.reference, errors);

  if (!isNonEmptyString(gate.owner)) {
    errors.push(`${config.label} gate must name an accountable owner.`);
  }

  validateCheckedAt(config.label, gate.checkedAt, now, errors, warnings);

  if (isRecord(productionEnvironment)) {
    validateEnvironmentBoolean(config.approvedEnv, productionEnvironment[config.approvedEnv], true, errors);
    validateEnvironmentReference(
      config.referenceEnv,
      productionEnvironment[config.referenceEnv],
      gate.reference,
      errors,
    );
  }
}

function validateLaunchSupplyMeasurements(gate, errors) {
  if (!isRecord(gate)) {
    return;
  }

  const activeCount = Number(gate.activeLaunchListingCount);
  const missingCount = Number(gate.activeLaunchListingsMissingResolvedProductMeasures);
  const coverage = Number(gate.resolvedProductMeasureCoveragePercent);

  if (!Number.isFinite(activeCount) || activeCount <= 0) {
    errors.push("Launch supply measurements must prove at least one active launch listing is eligible for checkout.");
  }

  if (!Number.isFinite(missingCount) || missingCount !== 0) {
    errors.push("Launch supply measurements must have activeLaunchListingsMissingResolvedProductMeasures=0.");
  }

  if (!Number.isFinite(coverage) || coverage !== 100) {
    errors.push("Launch supply measurements must have resolvedProductMeasureCoveragePercent=100.");
  }

  if (!isNonEmptyString(gate.queryReference)) {
    errors.push("Launch supply measurements must include queryReference for the data-quality sweep.");
  }
}

function validateTaxReadiness(gate, productionEnvironment, errors) {
  if (!isRecord(gate)) {
    return;
  }

  const posture = gate.posture;
  if (!Array.isArray(gate.collectionRequiredJurisdictions)) {
    errors.push("Tax readiness collectionRequiredJurisdictions must be an array.");
    return;
  }
  const collectionRequiredJurisdictions = gate.collectionRequiredJurisdictions;

  if (!["no_collection_required", "provider_backed_quotes_required"].includes(posture)) {
    errors.push("Tax readiness posture must be no_collection_required or provider_backed_quotes_required.");
    return;
  }

  if (posture === "no_collection_required") {
    if (collectionRequiredJurisdictions.length > 0) {
      errors.push(
        "Tax readiness cannot use no_collection_required while collectionRequiredJurisdictions is non-empty.",
      );
    }
    if (gate.taxProviderBackedQuotesRequired !== false) {
      errors.push("Tax readiness no_collection_required posture requires taxProviderBackedQuotesRequired=false.");
    }
    if (isRecord(productionEnvironment)) {
      validateEnvironmentBoolean(
        "TAX_PROVIDER_BACKED_QUOTES_REQUIRED",
        productionEnvironment.TAX_PROVIDER_BACKED_QUOTES_REQUIRED,
        false,
        errors,
      );
    }
  }

  if (posture === "provider_backed_quotes_required") {
    if (collectionRequiredJurisdictions.length === 0) {
      errors.push("Tax provider_backed_quotes_required posture must list collectionRequiredJurisdictions.");
    }
    if (gate.taxProviderBackedQuotesRequired !== true) {
      errors.push("Tax provider_backed_quotes_required posture requires taxProviderBackedQuotesRequired=true.");
    }
    if (gate.providerBackedResolverComposed !== true) {
      errors.push("Tax provider_backed_quotes_required posture requires providerBackedResolverComposed=true.");
    }
    if (isRecord(productionEnvironment)) {
      validateEnvironmentBoolean(
        "TAX_PROVIDER_BACKED_QUOTES_REQUIRED",
        productionEnvironment.TAX_PROVIDER_BACKED_QUOTES_REQUIRED,
        true,
        errors,
      );
    }
  }
}

function validateUcpAp2Marketing(gate, errors, warnings) {
  if (!isRecord(gate)) {
    errors.push("UCP/AP2 marketing gate is required so public launch claims remain explicit.");
    return;
  }

  if (gate.publicLaunchClaimsEnabled === true) {
    if (gate.certificationApproved !== true) {
      errors.push("UCP/AP2 public launch claims require certificationApproved=true.");
    }
    validateReference("UCP/AP2 certification reference", gate.certificationReference, errors);
  }
}

function validateProductionEnvironment(productionEnvironment, errors, warnings) {
  if (!isRecord(productionEnvironment)) {
    errors.push("productionEnvironment is required so packet gates can be compared to GitHub Environment values.");
    return;
  }

  const publicEnabled = productionEnvironment.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED;
  if (!["true", "false", true, false].includes(publicEnabled)) {
    errors.push("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be present as true or false in productionEnvironment.");
  }
}

function validateReference(label, value, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
    return;
  }

  const normalized = value.trim();
  if (normalized.length < 6 || PLACEHOLDER_REFERENCE_PATTERN.test(normalized)) {
    errors.push(`${label} must point to a real external evidence record, not a placeholder.`);
  }
}

function validateCheckedAt(label, value, now, errors, warnings) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} gate must include checkedAt.`);
    return;
  }

  const checkedAt = new Date(value);
  if (Number.isNaN(checkedAt.getTime())) {
    errors.push(`${label} checkedAt must be an ISO timestamp.`);
    return;
  }

  if (checkedAt.getTime() > now.getTime() + 60_000) {
    errors.push(`${label} checkedAt cannot be in the future.`);
    return;
  }

  const ageDays = (now.getTime() - checkedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_EVIDENCE_AGE_DAYS) {
    warnings.push(`${label} evidence is older than ${MAX_EVIDENCE_AGE_DAYS} days; refresh before launch.`);
  }
}

function validateEnvironmentBoolean(name, value, expected, errors) {
  const normalized = normalizeEnvironmentBoolean(value);
  if (normalized === null) {
    errors.push(`${name} must be present as true or false in productionEnvironment.`);
    return;
  }
  if (normalized !== expected) {
    errors.push(`${name} must be ${expected ? "true" : "false"} for this launch evidence packet.`);
  }
}

function validateEnvironmentReference(name, value, expected, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${name} must be present in productionEnvironment.`);
    return;
  }
  if (value.trim() !== String(expected).trim()) {
    errors.push(`${name} must match the gate reference.`);
  }
}

function normalizeEnvironmentBoolean(value) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function readFileArgument(argv) {
  const fileIndex = argv.indexOf("--file");
  if (fileIndex >= 0) {
    return argv[fileIndex + 1];
  }
  return argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
