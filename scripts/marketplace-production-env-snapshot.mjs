#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const MARKETPLACE_PRODUCTION_ENV_SNAPSHOT_VERSION = "marketplace-production-env-snapshot/v1";

export const REQUIRED_LAUNCH_ENV_VARIABLES = [
  "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED",
  "PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE",
  "PRODUCTION_MARKETPLACE_PROMOTION_APPROVED",
  "PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE",
  "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED",
  "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE",
  "PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED",
  "PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE",
  "PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED",
  "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE",
  "PRODUCTION_SUPPORT_OPERATIONS_APPROVED",
  "PRODUCTION_SUPPORT_OPERATIONS_REFERENCE",
  "PRODUCTION_FULFILLMENT_POSTAGE_APPROVED",
  "PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE",
  "PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED",
  "PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE",
  "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED",
  "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE",
  "PRODUCTION_TAX_READINESS_APPROVED",
  "PRODUCTION_TAX_READINESS_REFERENCE",
  "TAX_PROVIDER_BACKED_QUOTES_REQUIRED",
  "EASYPOST_MODE",
];

export const OPTIONAL_LAUNCH_ENV_VARIABLES = [
  "PRODUCTION_MARKETPLACE_PROOF_ENABLED",
  "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
];

export function parseProductionEnvSnapshotArgs(argv, env = process.env) {
  return {
    variablesPath: readOption(argv, "--variables") ?? readEnv("GITHUB_ENVIRONMENT_VARIABLES_JSON", env),
    environmentName: readOption(argv, "--environment") ?? readEnv("GITHUB_ENVIRONMENT_NAME", env) ?? "production",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readGitHubEnvironmentVariables(path) {
  if (path === "-") {
    return JSON.parse(await readStdin());
  }
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runProductionEnvSnapshot(options) {
  const variables = await readGitHubEnvironmentVariables(options.variablesPath);
  return buildProductionEnvSnapshot({
    ...options,
    variables,
  });
}

export function buildProductionEnvSnapshot(input) {
  const variableMap = normalizeGitHubVariableList(input.variables);
  const productionEnvironment = {};
  const errors = [];

  for (const name of REQUIRED_LAUNCH_ENV_VARIABLES) {
    if (!isNonEmptyString(variableMap[name])) {
      errors.push(`Production GitHub Environment variable ${name} is required for launch evidence.`);
      continue;
    }
    productionEnvironment[name] = variableMap[name];
  }

  for (const name of OPTIONAL_LAUNCH_ENV_VARIABLES) {
    if (isNonEmptyString(variableMap[name])) {
      productionEnvironment[name] = variableMap[name];
    }
  }

  if (input.environmentName !== "production") {
    errors.push("Marketplace launch production environment snapshot must come from the production GitHub Environment.");
  }

  validateBooleanVariables(productionEnvironment, errors);
  validateReferencePair(
    productionEnvironment,
    "PRODUCTION_MARKETPLACE_PROOF_ENABLED",
    "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
    errors,
    { optional: true },
  );
  validateProofModePublicSwitch(productionEnvironment, errors);
  validateProductionRuntimeModes(productionEnvironment, errors);
  validateProductionEvidenceReferences(productionEnvironment, errors);

  return {
    schemaVersion: MARKETPLACE_PRODUCTION_ENV_SNAPSHOT_VERSION,
    environmentName: input.environmentName,
    checkedAt: input.checkedAt,
    productionEnvironment,
    passesProductionEnvSnapshotGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function validateProductionEvidenceReferences(productionEnvironment, errors) {
  for (const [name, value] of Object.entries(productionEnvironment)) {
    if (!name.endsWith("_REFERENCE") || !isNonEmptyString(value)) {
      continue;
    }
    validateEvidenceReference(name, value, errors);
  }
}

async function main(argv, env = process.env) {
  const options = parseProductionEnvSnapshotArgs(argv, env);
  const optionErrors = validateProductionEnvSnapshotOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const snapshot = await runProductionEnvSnapshot(options);
  console.log(JSON.stringify(snapshot.productionEnvironment, null, 2));
  if (!snapshot.passesProductionEnvSnapshotGate) {
    console.error("Production GitHub Environment snapshot does not satisfy launch evidence requirements:");
    for (const error of snapshot.errors) {
      console.error(`- ${error}`);
    }
    return 1;
  }

  return 0;
}

function normalizeGitHubVariableList(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.variables) ? value.variables : null;
  if (!rows) {
    throw new Error("GitHub Environment variables JSON must be an array or an object with a variables array.");
  }

  return Object.fromEntries(
    rows
      .filter((row) => isRecord(row) && isNonEmptyString(row.name))
      .map((row) => [String(row.name).trim(), String(row.value ?? "").trim()]),
  );
}

function validateProductionEnvSnapshotOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.variablesPath)) {
    errors.push("GITHUB_ENVIRONMENT_VARIABLES_JSON or --variables is required.");
  }
  return errors;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateBooleanVariables(productionEnvironment, errors) {
  for (const name of Object.keys(productionEnvironment)) {
    if (
      !name.endsWith("_APPROVED") &&
      name !== "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED" &&
      name !== "PRODUCTION_MARKETPLACE_PROOF_ENABLED" &&
      name !== "TAX_PROVIDER_BACKED_QUOTES_REQUIRED"
    ) {
      continue;
    }
    if (!["true", "false"].includes(productionEnvironment[name])) {
      errors.push(`${name} must be the string true or false.`);
    }
  }
}

function validateReferencePair(productionEnvironment, approvedName, referenceName, errors, options = {}) {
  const approved = productionEnvironment[approvedName];
  if (!isNonEmptyString(approved)) {
    if (!options.optional) {
      errors.push(`${approvedName} is required.`);
    }
    return;
  }
  if (!["true", "false"].includes(approved)) {
    return;
  }
  const reference = productionEnvironment[referenceName];
  if (approved === "true" && !isNonEmptyString(reference)) {
    errors.push(`${referenceName} is required when ${approvedName}=true.`);
  }
}

function validateProofModePublicSwitch(productionEnvironment, errors) {
  if (
    productionEnvironment.PRODUCTION_MARKETPLACE_PROOF_ENABLED === "true" &&
    productionEnvironment.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED === "true"
  ) {
    errors.push("PRODUCTION_MARKETPLACE_PROOF_ENABLED must be false when PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true.");
  }
}

function validateProductionRuntimeModes(productionEnvironment, errors) {
  if (productionEnvironment.EASYPOST_MODE && productionEnvironment.EASYPOST_MODE !== "production") {
    errors.push("EASYPOST_MODE must be production for marketplace launch evidence.");
  }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
