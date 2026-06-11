#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildProductionEnvSnapshot, REQUIRED_LAUNCH_ENV_VARIABLES } from "./marketplace-production-env-snapshot.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION = "marketplace-production-launch-readiness/v1";

export const REQUIRED_LAUNCH_CONFIGURATION_VARIABLES = [
  ...REQUIRED_LAUNCH_ENV_VARIABLES,
  "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS",
  "NOTIFICATION_EMAIL_PROVIDER",
  "SES_AWS_REGION",
  "SES_CONFIGURATION_SET_NAME",
  "SES_FROM_EMAIL",
];

export const REQUIRED_LAUNCH_SECRETS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "EASYPOST_API_KEY",
  "EASYPOST_WEBHOOK_SECRET",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_SOURCE_ARN",
  "CHASE_SETS_DISCORD_INVITE_URL",
  "DIGITALOCEAN_ACCESS_TOKEN",
  "SPACES_ACCESS_ID",
  "SPACES_SECRET_KEY",
  "PLATFORM_INTERNAL_AUTH_SECRET",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_ID",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET",
];

export function parseProductionLaunchReadinessArgs(argv, env = process.env) {
  return {
    variablesPath: readOption(argv, "--variables") ?? readEnv("GITHUB_ENVIRONMENT_VARIABLES_JSON", env),
    secretsPath: readOption(argv, "--secrets") ?? readEnv("GITHUB_ENVIRONMENT_SECRETS_JSON", env),
    environmentName: readOption(argv, "--environment") ?? readEnv("GITHUB_ENVIRONMENT_NAME", env) ?? "production",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runProductionLaunchReadiness(options) {
  return buildProductionLaunchReadiness({
    ...options,
    variables: await readJsonInput(options.variablesPath),
    secrets: await readJsonInput(options.secretsPath),
  });
}

export function buildProductionLaunchReadiness(input) {
  const variables = normalizeNameValueRows(input.variables);
  const secretNames = new Set(normalizeNameRows(input.secrets));
  const missingVariables = REQUIRED_LAUNCH_CONFIGURATION_VARIABLES.filter((name) => !isNonEmptyString(variables[name]));
  const missingSecrets = REQUIRED_LAUNCH_SECRETS.filter((name) => !secretNames.has(name));
  const errors = [
    ...missingVariables.map((name) => `Missing production launch variable ${name}.`),
    ...missingSecrets.map((name) => `Missing production launch secret ${name}.`),
  ];

  const snapshot = buildProductionEnvSnapshot({
    variables: input.variables,
    environmentName: input.environmentName,
    checkedAt: input.checkedAt,
  });
  if (!snapshot.passesProductionEnvSnapshotGate) {
    errors.push(...snapshot.errors.map((error) => `Production launch environment snapshot: ${error}`));
  }

  if (input.environmentName !== "production") {
    errors.push("Production launch readiness must be checked against the production GitHub Environment.");
  }
  if (variables.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED !== "true") {
    errors.push("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be true for final public launch readiness.");
  }
  if (variables.PRODUCTION_MARKETPLACE_PROOF_ENABLED === "true") {
    errors.push("PRODUCTION_MARKETPLACE_PROOF_ENABLED must be false or unset for final public launch readiness.");
  }
  if (variables.NOTIFICATION_EMAIL_PROVIDER && variables.NOTIFICATION_EMAIL_PROVIDER !== "amazon-ses") {
    errors.push("NOTIFICATION_EMAIL_PROVIDER must be amazon-ses for final public launch readiness.");
  }
  if (
    variables.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS &&
    !csvValues(variables.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS).includes("chasesets.com")
  ) {
    errors.push("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS must include chasesets.com for final public launch readiness.");
  }
  if (variables.SES_CONFIGURATION_SET_NAME && variables.SES_CONFIGURATION_SET_NAME !== "transactional-production") {
    errors.push("SES_CONFIGURATION_SET_NAME must be transactional-production for final public launch readiness.");
  }
  if (variables.EASYPOST_MODE && variables.EASYPOST_MODE !== "production") {
    errors.push("EASYPOST_MODE must be production when set for final public launch readiness.");
  }
  if (variables.STRIPE_API_BASE_URL) {
    errors.push(
      "STRIPE_API_BASE_URL must be unset for final public launch unless an approved provider exception exists.",
    );
  }
  if (variables.EASYPOST_API_BASE_URL) {
    errors.push(
      "EASYPOST_API_BASE_URL must be unset for final public launch unless an approved provider exception exists.",
    );
  }

  return {
    schemaVersion: MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION,
    environmentName: input.environmentName,
    checkedAt: input.checkedAt,
    requiredVariables: REQUIRED_LAUNCH_CONFIGURATION_VARIABLES,
    requiredSecrets: REQUIRED_LAUNCH_SECRETS,
    presentVariableNames: Object.keys(variables).sort(),
    presentSecretNames: [...secretNames].sort(),
    missingVariables,
    missingSecrets,
    productionEnvironment: snapshot.productionEnvironment,
    operatorSetup: buildOperatorSetup({ missingSecrets }),
    passesProductionLaunchReadinessGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const options = parseProductionLaunchReadinessArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const readiness = await runProductionLaunchReadiness(options);
  console.log(JSON.stringify(readiness, null, 2));
  if (!readiness.passesProductionLaunchReadinessGate) {
    console.error("Production launch readiness preflight failed.");
    return 1;
  }
  return 0;
}

export async function readJsonInput(path, readStdinImpl = readStdin) {
  if (path === "-") {
    return JSON.parse(await readStdinImpl());
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function buildOperatorSetup({ missingSecrets }) {
  return {
    packetCommand:
      "pnpm run ops marketplace:launch-packet --public-enabled true --launch-evidence-reference <passing-packet-reference> ...",
    environmentCommand:
      "pnpm run ops marketplace:production-env-commands --file <redacted-marketplace-launch-evidence.json>",
    secretCommands: missingSecrets.map((name) => `gh secret set ${name} --env production`),
    googleSocialLoginOAuthSetup: buildGoogleSocialLoginOAuthSetup({
      marketplaceUrl: "https://marketplace.chasesets.com",
      adminUrl: "https://admin.chasesets.com",
      publicUrl: "https://chasesets.com",
    }),
    notes: [
      "Generate launch variables from the passing Marketplace Launch Evidence packet; do not hand-set approval booleans.",
      "Run secret commands interactively or pipe values from a private password manager; never commit secret values.",
      "Complete googleSocialLoginOAuthSetup before smoke-testing production marketplace Google sign-in or admin Google Workspace SSO.",
      "Run this readiness command again after setting variables and secret names, before triggering production promotion.",
    ],
  };
}

function validateOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.variablesPath)) {
    errors.push("GITHUB_ENVIRONMENT_VARIABLES_JSON or --variables is required.");
  }
  if (!isNonEmptyString(options.secretsPath)) {
    errors.push("GITHUB_ENVIRONMENT_SECRETS_JSON or --secrets is required.");
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

function normalizeNameValueRows(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.variables) ? value.variables : [];
  return Object.fromEntries(
    rows
      .filter((row) => isRecord(row) && isNonEmptyString(row.name))
      .map((row) => [String(row.name).trim(), String(row.value ?? "").trim()]),
  );
}

function normalizeNameRows(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.secrets) ? value.secrets : [];
  return rows.filter((row) => isRecord(row) && isNonEmptyString(row.name)).map((row) => String(row.name).trim());
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function csvValues(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function buildGoogleSocialLoginOAuthSetup({ marketplaceUrl, adminUrl, publicUrl }) {
  return {
    provider: "google",
    purpose: "Authorized redirect URIs for Auth-owned Google Social Login and admin Google Workspace SSO.",
    authorizedRedirectUris: [
      `${normalizeUrlOrigin(marketplaceUrl)}/api/auth/social/google/callback`,
      `${normalizeUrlOrigin(adminUrl)}/api/auth/social/google/callback`,
      `${normalizeUrlOrigin(publicUrl)}/api/auth/social/google/callback`,
    ],
    checklist: [
      "Open the Google Cloud OAuth client used by GOOGLE_SOCIAL_LOGIN_CLIENT_ID.",
      "Add every authorizedRedirectUris entry exactly as listed, including scheme, host, path, and trailing path spelling.",
      "Save the OAuth client, then restart the Social Login smoke from the same production host.",
    ],
  };
}

function normalizeUrlOrigin(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
