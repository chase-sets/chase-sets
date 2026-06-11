#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
  validateMarketplaceLaunchEvidence,
} from "./marketplace-launch-evidence.mjs";

export function parseLaunchPacketArgs(argv, env = process.env) {
  return {
    productionEnvironmentPath:
      readOption(argv, "--production-env") ?? readEnv("MARKETPLACE_LAUNCH_PRODUCTION_ENV", env),
    publicEnabled:
      readOption(argv, "--public-enabled") ?? readEnv("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", env) ?? "false",
    proofEnabled:
      readOption(argv, "--proof-enabled") ?? readEnv("PRODUCTION_MARKETPLACE_PROOF_ENABLED", env) ?? "false",
    proofReference:
      readOption(argv, "--proof-reference") ?? readEnv("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", env) ?? "",
    launchEvidenceReference:
      readOption(argv, "--launch-evidence-reference") ??
      readEnv("PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE", env),
    launchSupplyReference:
      readOption(argv, "--launch-supply-reference") ?? readEnv("PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE", env),
    promotionPath: readOption(argv, "--promotion") ?? readEnv("MARKETPLACE_PROMOTION_EVIDENCE", env),
    checkoutFeePath: readOption(argv, "--checkout-fee") ?? readEnv("MARKETPLACE_CHECKOUT_FEE_EVIDENCE", env),
    checkoutLaunchPath: readOption(argv, "--checkout-launch") ?? readEnv("CHECKOUT_LAUNCH_EVIDENCE", env),
    stripeMoneyPath: readOption(argv, "--stripe-money") ?? readEnv("STRIPE_MONEY_OPERATIONS_EVIDENCE", env),
    supportPath: readOption(argv, "--support") ?? readEnv("SUPPORT_OPERATIONS_EVIDENCE", env),
    fulfillmentPostagePath: readOption(argv, "--fulfillment-postage") ?? readEnv("FULFILLMENT_POSTAGE_EVIDENCE", env),
    transactionalEmailPath: readOption(argv, "--transactional-email") ?? readEnv("TRANSACTIONAL_EMAIL_EVIDENCE", env),
    launchSupplyPath: readOption(argv, "--launch-supply") ?? readEnv("LAUNCH_SUPPLY_MEASUREMENT_EVIDENCE", env),
    taxReadinessPath: readOption(argv, "--tax-readiness") ?? readEnv("TAX_READINESS_EVIDENCE", env),
    launchSupplyOwner: readOption(argv, "--launch-supply-owner") ?? readEnv("LAUNCH_SUPPLY_OWNER", env) ?? "Catalog",
  };
}

export async function runLaunchPacketAssembly(options) {
  const optionErrors = validateLaunchPacketOptions(options);
  if (optionErrors.length > 0) {
    throw new Error(optionErrors.join("\n"));
  }
  const inputs = await readLaunchPacketInputs(options);
  return buildLaunchPacket(inputs, options);
}

export async function readLaunchPacketInputs(options) {
  const productionEnvironmentPromise = isNonEmptyString(options.productionEnvironmentPath)
    ? readJson(options.productionEnvironmentPath)
    : Promise.resolve(null);
  const [
    productionEnvironment,
    promotion,
    marketplaceCheckoutFee,
    checkoutLaunchEvidence,
    stripeMoneyOperations,
    supportOperations,
    fulfillmentPostage,
    transactionalEmail,
    launchSupplyMeasurements,
    taxReadiness,
  ] = await Promise.all([
    productionEnvironmentPromise,
    readJson(options.promotionPath),
    readJson(options.checkoutFeePath),
    readJson(options.checkoutLaunchPath),
    readJson(options.stripeMoneyPath),
    readJson(options.supportPath),
    readJson(options.fulfillmentPostagePath),
    readJson(options.transactionalEmailPath),
    readJson(options.launchSupplyPath),
    readJson(options.taxReadinessPath),
  ]);

  return {
    productionEnvironment,
    promotion,
    marketplaceCheckoutFee,
    checkoutLaunchEvidence,
    stripeMoneyOperations,
    supportOperations,
    fulfillmentPostage,
    transactionalEmail,
    launchSupplyMeasurements,
    taxReadiness,
  };
}

export function buildLaunchPacket(input, options = {}) {
  const promotion = requireRecord(input.promotion, "promotion evidence");
  const marketplacePromotion = requireRecord(promotion.marketplacePromotion, "marketplace promotion gate");
  const marketplaceCheckoutFee = requireRecord(input.marketplaceCheckoutFee, "marketplace checkout fee gate");
  const checkoutLaunchEvidence = requireRecord(input.checkoutLaunchEvidence, "checkout launch evidence gate");
  const stripeMoneyOperations = requireRecord(input.stripeMoneyOperations, "stripe money operations gate");
  const supportOperations = requireRecord(input.supportOperations, "support operations gate");
  const fulfillmentPostage = requireRecord(input.fulfillmentPostage, "fulfillment postage gate");
  const transactionalEmail = requireRecord(input.transactionalEmail, "transactional email gate");
  const taxReadiness = requireRecord(input.taxReadiness, "tax readiness gate");
  const launchSupplyMeasurements = requireRecord(input.launchSupplyMeasurements, "launch supply measurement");
  const productionEnvironment = input.productionEnvironment
    ? requireRecord(input.productionEnvironment, "productionEnvironment")
    : buildDesiredProductionEnvironment(
        {
          marketplacePromotion,
          marketplaceCheckoutFee,
          checkoutLaunchEvidence,
          stripeMoneyOperations,
          supportOperations,
          fulfillmentPostage,
          transactionalEmail,
          launchSupplyMeasurements,
          taxReadiness,
        },
        options,
      );

  return {
    schemaVersion: MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
    environment: "production",
    productionEnvironment,
    gates: {
      marketplacePromotion,
      marketplaceCheckoutFee,
      checkoutLaunchEvidence,
      stripeMoneyOperations,
      supportOperations,
      fulfillmentPostage,
      transactionalEmail,
      launchSupplyMeasurements: normalizeLaunchSupplyGate(
        launchSupplyMeasurements,
        productionEnvironment,
        options.launchSupplyOwner,
      ),
      taxReadiness,
      ucpAp2Marketing: requireRecord(promotion.ucpAp2Marketing, "UCP/AP2 marketing gate"),
    },
  };
}

export function buildDesiredProductionEnvironment(gates, options = {}) {
  const launchSupplyReference =
    readDesiredReference(options.launchSupplyReference) ??
    readDesiredReference(gates.launchSupplyMeasurements.reference);
  if (!isNonEmptyString(launchSupplyReference)) {
    throw new Error(
      "Marketplace launch packet assembly requires --launch-supply-reference when --production-env is omitted.",
    );
  }

  const productionEnvironment = {
    PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: normalizeBooleanString(options.publicEnabled ?? "false", "--public-enabled"),
    PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: requireDesiredReference(
      options.launchEvidenceReference,
      "--launch-evidence-reference",
    ),
    PRODUCTION_MARKETPLACE_PROMOTION_APPROVED: approvalString(gates.marketplacePromotion, "marketplace promotion"),
    PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: referenceString(gates.marketplacePromotion, "marketplace promotion"),
    PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED: approvalString(
      gates.marketplaceCheckoutFee,
      "marketplace checkout fee",
    ),
    PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE: referenceString(
      gates.marketplaceCheckoutFee,
      "marketplace checkout fee",
    ),
    PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED: approvalString(
      gates.checkoutLaunchEvidence,
      "checkout launch evidence",
    ),
    PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE: referenceString(
      gates.checkoutLaunchEvidence,
      "checkout launch evidence",
    ),
    PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED: approvalString(gates.stripeMoneyOperations, "stripe money operations"),
    PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: referenceString(
      gates.stripeMoneyOperations,
      "stripe money operations",
    ),
    PRODUCTION_SUPPORT_OPERATIONS_APPROVED: approvalString(gates.supportOperations, "support operations"),
    PRODUCTION_SUPPORT_OPERATIONS_REFERENCE: referenceString(gates.supportOperations, "support operations"),
    PRODUCTION_FULFILLMENT_POSTAGE_APPROVED: approvalString(gates.fulfillmentPostage, "fulfillment postage"),
    PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: referenceString(gates.fulfillmentPostage, "fulfillment postage"),
    PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED: approvalString(gates.transactionalEmail, "transactional email"),
    PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE: referenceString(gates.transactionalEmail, "transactional email"),
    PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED: launchSupplyApprovalString(gates.launchSupplyMeasurements),
    PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE: launchSupplyReference,
    PRODUCTION_TAX_READINESS_APPROVED: approvalString(gates.taxReadiness, "tax readiness"),
    PRODUCTION_TAX_READINESS_REFERENCE: referenceString(gates.taxReadiness, "tax readiness"),
    TAX_PROVIDER_BACKED_QUOTES_REQUIRED: normalizeBooleanString(
      gates.taxReadiness.taxProviderBackedQuotesRequired,
      "taxReadiness.taxProviderBackedQuotesRequired",
    ),
    EASYPOST_MODE: requireProductionEasyPostMode(gates.fulfillmentPostage),
  };

  const proofEnabled = normalizeBooleanString(options.proofEnabled ?? "false", "--proof-enabled");
  productionEnvironment.PRODUCTION_MARKETPLACE_PROOF_ENABLED = proofEnabled;
  if (proofEnabled === "true" || isNonEmptyString(options.proofReference)) {
    productionEnvironment.PRODUCTION_MARKETPLACE_PROOF_REFERENCE = String(options.proofReference ?? "").trim();
  }

  return productionEnvironment;
}

async function main(argv, env = process.env) {
  const options = parseLaunchPacketArgs(argv, env);
  const optionErrors = validateLaunchPacketOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const packet = await runLaunchPacketAssembly(options);
  const validation = validateMarketplaceLaunchEvidence(packet);
  console.log(JSON.stringify(packet, null, 2));

  if (!validation.ok) {
    console.error("Assembled marketplace launch evidence packet failed validation:");
    for (const error of validation.errors) {
      console.error(`- ${error}`);
    }
    return 1;
  }

  for (const warning of validation.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  return 0;
}

function normalizeLaunchSupplyGate(measurementInput, productionEnvironment, owner) {
  const measurement = requireRecord(measurementInput, "launch supply measurement");
  const approved = measurement.passesLaunchSupplyGate === true;
  return {
    ...measurement,
    approved,
    reference: productionEnvironment.PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE,
    owner,
  };
}

function validateLaunchPacketOptions(options) {
  const required = [
    ["--promotion", options.promotionPath],
    ["--checkout-fee", options.checkoutFeePath],
    ["--checkout-launch", options.checkoutLaunchPath],
    ["--stripe-money", options.stripeMoneyPath],
    ["--support", options.supportPath],
    ["--fulfillment-postage", options.fulfillmentPostagePath],
    ["--transactional-email", options.transactionalEmailPath],
    ["--launch-supply", options.launchSupplyPath],
    ["--tax-readiness", options.taxReadinessPath],
  ];
  const errors = required
    .filter(([, value]) => !isNonEmptyString(value))
    .map(([flag]) => `Marketplace launch packet assembly requires ${flag}.`);
  if (!isNonEmptyString(options.productionEnvironmentPath) && !isNonEmptyString(options.launchSupplyReference)) {
    errors.push(
      "Marketplace launch packet assembly requires --launch-supply-reference when --production-env is omitted.",
    );
  }
  if (!isNonEmptyString(options.productionEnvironmentPath) && !isNonEmptyString(options.launchEvidenceReference)) {
    errors.push(
      "Marketplace launch packet assembly requires --launch-evidence-reference when --production-env is omitted.",
    );
  }
  return errors;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function approvalString(gate, label) {
  if (typeof gate.approved !== "boolean") {
    throw new Error(`${label} gate approved must be a boolean.`);
  }
  return gate.approved ? "true" : "false";
}

function launchSupplyApprovalString(gate) {
  if (typeof gate.approved === "boolean") {
    return gate.approved ? "true" : "false";
  }
  if (typeof gate.passesLaunchSupplyGate === "boolean") {
    return gate.passesLaunchSupplyGate ? "true" : "false";
  }
  throw new Error("launch supply gate approved or passesLaunchSupplyGate must be a boolean.");
}

function referenceString(gate, label) {
  if (!isNonEmptyString(gate.reference)) {
    throw new Error(`${label} gate reference must be a non-empty string.`);
  }
  return gate.reference.trim();
}

function normalizeBooleanString(value, label) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "false") {
      return normalized;
    }
  }
  throw new Error(`${label} must be true or false.`);
}

function requireProductionEasyPostMode(gate) {
  if (gate.easyPostMode !== "production") {
    throw new Error("fulfillmentPostage.easyPostMode must be production for marketplace launch packet assembly.");
  }
  return "production";
}

function readDesiredReference(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function requireDesiredReference(value, label) {
  const reference = readDesiredReference(value);
  if (!reference) {
    throw new Error(`${label} must be a non-empty evidence reference.`);
  }
  return reference;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
