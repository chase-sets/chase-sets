#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isValidEvidenceReference, validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const MARKETPLACE_PRODUCTION_PROOF_READINESS_VERSION = "marketplace-production-proof-readiness/v1";

export const REQUIRED_PROOF_VARIABLES = [
  "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS",
  "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED",
  "PRODUCTION_MARKETPLACE_PROOF_ENABLED",
  "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
  "NOTIFICATION_EMAIL_PROVIDER",
  "EASYPOST_MODE",
  "SES_AWS_REGION",
  "SES_CONFIGURATION_SET_NAME",
  "SES_FROM_EMAIL",
];

export const REQUIRED_PROOF_SECRETS = [
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
  "GOOGLE_SOCIAL_LOGIN_CLIENT_ID",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET",
  "SPACES_ACCESS_ID",
  "SPACES_SECRET_KEY",
  "PLATFORM_INTERNAL_AUTH_SECRET",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
];

const PROOF_VARIABLE_RECOMMENDATIONS = {
  ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS: "chasesets.com",
  PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
  PRODUCTION_MARKETPLACE_PROOF_ENABLED: "true",
  PRODUCTION_MARKETPLACE_PROOF_REFERENCE: ({ checkedAt }) => `PRODUCTION-PROOF-${checkedAt.slice(0, 10)}`,
  NOTIFICATION_EMAIL_PROVIDER: "amazon-ses",
  EASYPOST_MODE: "production",
  SES_AWS_REGION: "us-east-2",
  SES_CONFIGURATION_SET_NAME: "transactional-production",
  SES_FROM_EMAIL: "notifications@chasesets.com",
};

export function parseProductionProofReadinessArgs(argv, env = process.env) {
  return {
    variablesPath: readOption(argv, "--variables") ?? readEnv("GITHUB_ENVIRONMENT_VARIABLES_JSON", env),
    secretsPath: readOption(argv, "--secrets") ?? readEnv("GITHUB_ENVIRONMENT_SECRETS_JSON", env),
    environmentName: readOption(argv, "--environment") ?? readEnv("GITHUB_ENVIRONMENT_NAME", env) ?? "production",
    baseUrl: readOption(argv, "--base-url") ?? readEnv("PRODUCTION_PROOF_BASE_URL", env) ?? "https://chasesets.com",
    marketplaceUrl:
      readOption(argv, "--marketplace-url") ??
      readEnv("PRODUCTION_MARKETPLACE_URL", env) ??
      "https://marketplace.chasesets.com",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runProductionProofReadiness(options) {
  return buildProductionProofReadiness({
    ...options,
    variables: await readJsonInput(options.variablesPath),
    secrets: await readJsonInput(options.secretsPath),
  });
}

export function buildProductionProofReadiness(input) {
  const variables = normalizeNameValueRows(input.variables);
  const secretNames = new Set(normalizeNameRows(input.secrets));
  const providerCallbackSetup = buildProviderCallbackSetup({
    baseUrl: input.baseUrl ?? "https://chasesets.com",
    marketplaceUrl: input.marketplaceUrl ?? "https://marketplace.chasesets.com",
  });
  const errors = [];
  const missingVariables = [];
  const missingSecrets = [];

  if (input.environmentName !== "production") {
    errors.push("Production proof readiness must be checked against the production GitHub Environment.");
  }

  for (const name of REQUIRED_PROOF_VARIABLES) {
    if (!isNonEmptyString(variables[name])) {
      missingVariables.push(name);
    }
  }
  for (const name of REQUIRED_PROOF_SECRETS) {
    if (!secretNames.has(name)) {
      missingSecrets.push(name);
    }
  }

  errors.push(...missingVariables.map((name) => `Missing production proof variable ${name}.`));
  errors.push(...missingSecrets.map((name) => `Missing production proof secret ${name}.`));

  if (variables.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED && variables.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED !== "false") {
    errors.push("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be false for private production proof readiness.");
  }
  if (variables.PRODUCTION_MARKETPLACE_PROOF_ENABLED && variables.PRODUCTION_MARKETPLACE_PROOF_ENABLED !== "true") {
    errors.push("PRODUCTION_MARKETPLACE_PROOF_ENABLED must be true for private production proof readiness.");
  }
  if (
    variables.PRODUCTION_MARKETPLACE_PROOF_REFERENCE &&
    !isValidEvidenceReference(variables.PRODUCTION_MARKETPLACE_PROOF_REFERENCE)
  ) {
    validateEvidenceReference(
      "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
      variables.PRODUCTION_MARKETPLACE_PROOF_REFERENCE,
      errors,
    );
  }
  if (variables.NOTIFICATION_EMAIL_PROVIDER && variables.NOTIFICATION_EMAIL_PROVIDER !== "amazon-ses") {
    errors.push("NOTIFICATION_EMAIL_PROVIDER must be amazon-ses for transactional email proof readiness.");
  }
  if (
    variables.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS &&
    !csvValues(variables.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS).includes("chasesets.com")
  ) {
    errors.push("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS must include chasesets.com for production admin SSO.");
  }
  if (variables.SES_CONFIGURATION_SET_NAME && variables.SES_CONFIGURATION_SET_NAME !== "transactional-production") {
    errors.push("SES_CONFIGURATION_SET_NAME must be transactional-production for production proof readiness.");
  }
  if (variables.EASYPOST_MODE && variables.EASYPOST_MODE !== "production") {
    errors.push("EASYPOST_MODE must be production when set for private production proof readiness.");
  }
  if (variables.STRIPE_API_BASE_URL) {
    errors.push("STRIPE_API_BASE_URL must be unset for production proof unless an approved provider exception exists.");
  }
  if (variables.EASYPOST_API_BASE_URL) {
    errors.push(
      "EASYPOST_API_BASE_URL must be unset for production proof unless an approved provider exception exists.",
    );
  }

  return {
    schemaVersion: MARKETPLACE_PRODUCTION_PROOF_READINESS_VERSION,
    environmentName: input.environmentName,
    checkedAt: input.checkedAt,
    requiredVariables: REQUIRED_PROOF_VARIABLES,
    requiredSecrets: REQUIRED_PROOF_SECRETS,
    resolvedEasyPostMode: variables.EASYPOST_MODE || null,
    providerCallbackSetup,
    presentVariableNames: Object.keys(variables).sort(),
    presentSecretNames: [...secretNames].sort(),
    missingVariables,
    missingSecrets,
    operatorSetup: buildOperatorSetup({
      checkedAt: input.checkedAt,
      missingVariables,
      missingSecrets,
      proofReference: variables.PRODUCTION_MARKETPLACE_PROOF_REFERENCE,
      providerCallbackSetup,
    }),
    passesProductionProofReadinessGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const options = parseProductionProofReadinessArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const readiness = await runProductionProofReadiness(options);
  console.log(JSON.stringify(readiness, null, 2));
  if (!readiness.passesProductionProofReadinessGate) {
    console.error("Production proof readiness preflight failed.");
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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

function buildOperatorSetup({ checkedAt, missingVariables, missingSecrets, proofReference, providerCallbackSetup }) {
  const suggestedProofReference = isValidEvidenceReference(proofReference)
    ? proofReference
    : PROOF_VARIABLE_RECOMMENDATIONS.PRODUCTION_MARKETPLACE_PROOF_REFERENCE({ checkedAt });
  const sesSnsEventDestinationSetup = buildSesSnsEventDestinationSetup(providerCallbackSetup);
  const easyPostWebhookSetup = buildEasyPostWebhookSetup(providerCallbackSetup);
  const fulfillmentPostageProofApiSetup = buildFulfillmentPostageProofApiSetup(providerCallbackSetup);
  const launchSupplyProofApiSetup = buildLaunchSupplyProofApiSetup(providerCallbackSetup);

  return {
    variableCommands: missingVariables.map((name) => {
      const recommendation = PROOF_VARIABLE_RECOMMENDATIONS[name];
      const body = typeof recommendation === "function" ? recommendation({ checkedAt }) : recommendation;
      return `gh variable set ${name} --env production --body "${body ?? ""}"`;
    }),
    secretCommands: missingSecrets.map((name) => `gh secret set ${name} --env production`),
    stripeMoneySmokeEnvironmentCommands: [
      `$env:PLATFORM_API_BASE_URL="${providerCallbackSetup.productionProofBaseUrl}"`,
      `$env:STRIPE_CONNECT_RETURN_URL="${providerCallbackSetup.stripeConnectOnboarding.privateProofReturnUrl}"`,
      `$env:STRIPE_CONNECT_REFRESH_URL="${providerCallbackSetup.stripeConnectOnboarding.privateProofRefreshUrl}"`,
      '$env:STRIPE_MONEY_SMOKE_ALLOW_LIVE="true"',
      `$env:PRODUCTION_MARKETPLACE_PROOF_REFERENCE="${suggestedProofReference}"`,
    ],
    stripeMoneySmokeAuthenticationOptions: [
      {
        kind: "existing bearer token",
        commands: ['$env:PLATFORM_API_AUTHORIZATION="Bearer <production-proof-session-token>"'],
      },
      {
        kind: "existing browser session",
        commands: ['$env:PLATFORM_API_COOKIE="<production-proof-cookie-header>"'],
      },
      {
        kind: "password sign-in",
        commands: [
          `$env:PLATFORM_AUTH_BASE_URL="${providerCallbackSetup.productionProofBaseUrl}"`,
          '$env:SMOKE_SELLER_EMAIL="<production-proof-seller-email>"',
          '$env:SMOKE_SELLER_PASSWORD="<production-proof-seller-password>"',
        ],
      },
    ],
    sesSnsEventDestinationSetup,
    easyPostWebhookSetup,
    fulfillmentPostageProofApiSetup,
    launchSupplyProofApiSetup,
    stripeMoneySmokeCheckCommand: "pnpm run stripe:money-smoke -- --check-env",
    stripeMoneySmokeCommand: "pnpm run stripe:money-smoke -- --edge-check --seller-flow",
    notes: [
      "Run secret commands interactively or pipe values from a private password manager; never commit secret values.",
      "Set PRODUCTION_MARKETPLACE_PROOF_REFERENCE to the private proof evidence record if the suggested date-based reference is not the final record id.",
      "Complete sesSnsEventDestinationSetup and easyPostWebhookSetup before collecting Transactional Email and Fulfillment Postage proof records.",
      "Use fulfillmentPostageProofApiSetup only with operator-controlled proof orders; it opens authenticated seller shipment APIs, not public fulfillment surfaces.",
      "Use launchSupplyProofApiSetup only with operator-controlled proof seller accounts; it opens authenticated Inventory and Marketplace listing APIs, not public browse or marketplace web.",
      "Choose one stripeMoneySmokeAuthenticationOptions entry before running the seller-flow smoke command; the live proof command needs an authenticated account.",
      "Use stripeMoneySmokeEnvironmentCommands for private production proof only after topology evidence passes and live Stripe secrets are loaded into the shell.",
    ],
  };
}

function buildFulfillmentPostageProofApiSetup(providerCallbackSetup) {
  const baseUrl = providerCallbackSetup.productionProofBaseUrl;
  return {
    purpose:
      "Drive operator-controlled seller shipment label purchase, void/refund, and exception proof while public marketplace promotion remains closed.",
    baseUrl,
    routedApiPrefixes: ["/api/marketplace/account/sales/shipments"],
    requiredTopologyChecks: [
      `${baseUrl}/api/marketplace/account/sales/shipments`,
      `${baseUrl}/api/marketplace/account/sales/shipments/topology-proof-shipment/label/purchase`,
      `${baseUrl}/api/marketplace/account/sales/shipments/topology-proof-shipment/label/void`,
      `${baseUrl}/api/marketplace/account/sales/shipments/topology-proof-shipment/exception`,
    ],
    evidenceFields: [
      "gates.fulfillmentPostage.controlledParcelShipmentId",
      "gates.fulfillmentPostage.parcelProviderShipmentId",
      "gates.fulfillmentPostage.parcelProviderLabelId",
      "gates.fulfillmentPostage.labelVoidRefundProviderObjectReference",
      "gates.fulfillmentPostage.deliveryExceptionEvidenceKind",
      "gates.fulfillmentPostage.deliveryExceptionProviderEventId or deliveryExceptionRehearsalShipmentId",
    ],
    checklist: [
      "Run production proof topology evidence and verify each Fulfillment seller shipment private API returns a JSON 401 without redirects.",
      "Authenticate with the operator-controlled proof seller that owns the shipment created from the deferred checkout order.",
      "List seller shipments, pack the controlled shipment, purchase a USPS label through EasyPost production mode, void the label, and rehearse a delivery exception or provider-simulated exception.",
      "Attach the redacted Fulfillment shipment id, EasyPost shipment/label/tracker ids, void/refund reference, delivery-exception evidence kind, and provider-event query output to PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE.",
    ],
  };
}

function buildLaunchSupplyProofApiSetup(providerCallbackSetup) {
  const baseUrl = providerCallbackSetup.productionProofBaseUrl;
  return {
    purpose: "Create operator-controlled launch supply listings while public marketplace promotion remains closed.",
    baseUrl,
    routedApiPrefixes: [
      "/api/inventory/items/listing-stock/ensure",
      "/api/inventory/storage-locations",
      "/api/marketplace/account/listing-availability",
      "/api/marketplace/account/listing-inventory",
      "/api/marketplace/account/listings",
    ],
    requiredTopologyChecks: [
      `${baseUrl}/api/inventory/items/listing-stock/ensure`,
      `${baseUrl}/api/inventory/storage-locations`,
      `${baseUrl}/api/marketplace/account/listing-availability`,
      `${baseUrl}/api/marketplace/account/listing-inventory`,
      `${baseUrl}/api/marketplace/account/listings`,
    ],
    evidenceFields: [
      "gates.launchSupplyMeasurements.activeLaunchListingCount",
      "gates.launchSupplyMeasurements.activeLaunchSellerAccountCount",
      "gates.launchSupplyMeasurements.sampledActiveLaunchListingIds",
      "gates.launchSupplyMeasurements.queryReference",
    ],
    checklist: [
      "Run production proof topology evidence and verify each launch-supply private API returns a JSON 401 without redirects.",
      "Authenticate with an operator-controlled proof seller session on the proof API origin.",
      "Create or reuse listing stock with a complete ship-from address, create the Marketplace Listing, publish it, then run launch-supply measurement.",
      "Attach the redacted listing ids, seller account id, product-measure coverage output, and projection freshness reference to PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE.",
    ],
  };
}

function buildSesSnsEventDestinationSetup(providerCallbackSetup) {
  const destination = providerCallbackSetup.dashboardDestinations.find(
    (entry) => entry.provider === "amazon-ses-sns",
  )?.destination;
  const configurationSetName = "transactional-production";
  const topicName = "chasesets-transactional-production-events";
  return {
    configurationSetName,
    topicName,
    destination,
    requiredSesEventTypes: ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY"],
    evidenceFields: [
      "gates.transactionalEmail.webhookDestination",
      "gates.transactionalEmail.snsSubscriptionConfirmationReference",
      "gates.transactionalEmail.deliveryEventReference",
      "gates.transactionalEmail.bounceEventReference",
      "gates.transactionalEmail.complaintEventReference",
    ],
    commands: [
      "$env:AWS_REGION=$env:SES_AWS_REGION",
      `aws sns create-topic --name ${topicName}`,
      `aws sns subscribe --topic-arn <sns-topic-arn> --protocol https --notification-endpoint "${destination}"`,
      [
        "aws sesv2 create-configuration-set-event-destination",
        `--configuration-set-name ${configurationSetName}`,
        "--event-destination-name transactional-production-sns",
        '--event-destination "{""Enabled"":true,""MatchingEventTypes"":[""SEND"",""REJECT"",""BOUNCE"",""COMPLAINT"",""DELIVERY""],""SnsDestination"":{""TopicArn"":""<sns-topic-arn>""}}"',
      ].join(" "),
      `aws sesv2 get-configuration-set-event-destinations --configuration-set-name ${configurationSetName}`,
    ],
    notes: [
      "Use the production AWS account and region from SES_AWS_REGION.",
      "Confirm the SNS subscription before collecting delivery, bounce, and complaint proof.",
      "Attach the SNS topic ARN, subscription ARN/status, SES event destination output, and redacted Notifications provider-event query output to PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE.",
    ],
  };
}

function buildEasyPostWebhookSetup(providerCallbackSetup) {
  const destination = providerCallbackSetup.dashboardDestinations.find(
    (entry) => entry.provider === "easypost",
  )?.destination;
  return {
    destination,
    secretName: "EASYPOST_WEBHOOK_SECRET",
    requiredEventKinds: ["provider-event", "tracking-status", "refund-status"],
    evidenceFields: [
      "gates.fulfillmentPostage.webhookDestination",
      "gates.fulfillmentPostage.webhookDestinationReference",
      "gates.fulfillmentPostage.providerEventQueryReference",
      "gates.fulfillmentPostage.trackingEventReference",
      "gates.fulfillmentPostage.labelVoidRefundReference",
    ],
    checklist: [
      "Create or update the production EasyPost webhook destination to the listed URL.",
      "Set the EasyPost webhook signing secret into GitHub production as EASYPOST_WEBHOOK_SECRET and redeploy proof mode.",
      "Run production proof topology evidence and verify the postage callback path returns a JSON API response without redirects.",
      "Collect controlled parcel label, void/refund, tracking, delivery-exception, and Letter Mailpiece proof before approving Fulfillment Postage.",
    ],
  };
}

function buildProviderCallbackSetup({ baseUrl, marketplaceUrl }) {
  const normalizedBaseUrl = normalizeUrlOrigin(baseUrl);
  const normalizedMarketplaceUrl = normalizeUrlOrigin(marketplaceUrl);
  return {
    productionProofBaseUrl: normalizedBaseUrl,
    dashboardDestinations: [
      {
        provider: "stripe",
        purpose: "payment webhooks",
        destination: `${normalizedBaseUrl}/api/payments/provider/webhooks`,
        launchEvidenceField: "gates.stripeMoneyOperations.paymentWebhookDestination",
      },
      {
        provider: "stripe-connect",
        purpose: "money movement webhooks",
        destination: `${normalizedBaseUrl}/api/settlement/provider/money-movement/webhooks`,
        launchEvidenceField: "gates.stripeMoneyOperations.connectWebhookDestination",
      },
      {
        provider: "amazon-ses-sns",
        purpose: "transactional email delivery, bounce, and complaint events",
        destination: `${normalizedBaseUrl}/api/notifications/provider/email/webhooks`,
        launchEvidenceField: "gates.transactionalEmail.webhookDestination",
      },
      {
        provider: "easypost",
        purpose: "postage tracking, refund, and exception events",
        destination: `${normalizedBaseUrl}/api/fulfillment/provider/postage/webhooks`,
        launchEvidenceField: "gates.fulfillmentPostage.webhookDestination",
      },
    ],
    stripeConnectOnboarding: {
      privateProofReturnUrl: `${normalizedBaseUrl}/api/settlement/payout-setup/progress`,
      privateProofRefreshUrl: `${normalizedBaseUrl}/api/settlement/payout-setup/progress`,
      finalLaunchReturnUrl: `${normalizedMarketplaceUrl}/account/payouts`,
      finalLaunchRefreshUrl: `${normalizedMarketplaceUrl}/account/payouts/setup`,
      launchEvidenceFields: [
        "gates.stripeMoneyOperations.connectReturnUrl",
        "gates.stripeMoneyOperations.connectRefreshUrl",
      ],
      privateProofNote:
        "Use the private proof URLs for live smoke tests against the proof API origin. Final launch evidence still requires the marketplace-domain seller return pages.",
    },
  };
}

function normalizeUrlOrigin(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
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

function csvValues(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
