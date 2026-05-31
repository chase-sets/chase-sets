import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_PRODUCTION_PROOF_READINESS_VERSION,
  REQUIRED_PROOF_SECRETS,
  REQUIRED_PROOF_VARIABLES,
  buildProductionProofReadiness,
  parseProductionProofReadinessArgs,
  readJsonInput,
} from "./marketplace-production-proof-readiness.mjs";

function variable(name, value) {
  return { name, value };
}

function secret(name) {
  return { name, updatedAt: "2026-05-30T12:00:00Z" };
}

const completeVariables = [
  variable("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS", "chasesets.com"),
  variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "false"),
  variable("PRODUCTION_MARKETPLACE_PROOF_ENABLED", "true"),
  variable("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", "PRODUCTION-PROOF-2026-05-30"),
  variable("NOTIFICATION_EMAIL_PROVIDER", "amazon-ses"),
  variable("EASYPOST_MODE", "production"),
  variable("SES_AWS_REGION", "us-east-2"),
  variable("SES_CONFIGURATION_SET_NAME", "transactional-production"),
  variable("SES_FROM_EMAIL", "notifications@chasesets.com"),
];

describe("marketplace production proof readiness", () => {
  it("passes when proof variables and required secret names are present", () => {
    const readiness = buildProductionProofReadiness({
      variables: completeVariables,
      secrets: REQUIRED_PROOF_SECRETS.map(secret),
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(readiness).toMatchObject({
      schemaVersion: MARKETPLACE_PRODUCTION_PROOF_READINESS_VERSION,
      passesProductionProofReadinessGate: true,
      missingVariables: [],
      missingSecrets: [],
      resolvedEasyPostMode: "production",
      providerCallbackSetup: {
        productionProofBaseUrl: "https://chasesets.com",
        dashboardDestinations: expect.arrayContaining([
          expect.objectContaining({
            provider: "stripe",
            destination: "https://chasesets.com/api/payments/provider/webhooks",
          }),
          expect.objectContaining({
            provider: "stripe-connect",
            destination: "https://chasesets.com/api/settlement/provider/money-movement/webhooks",
          }),
          expect.objectContaining({
            provider: "amazon-ses-sns",
            destination: "https://chasesets.com/api/notifications/provider/email/webhooks",
          }),
          expect.objectContaining({
            provider: "easypost",
            destination: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
          }),
        ]),
        stripeConnectOnboarding: {
          privateProofReturnUrl: "https://chasesets.com/api/settlement/payout-setup/progress",
          privateProofRefreshUrl: "https://chasesets.com/api/settlement/payout-setup/progress",
          finalLaunchReturnUrl: "https://marketplace.chasesets.com/account/payouts",
          finalLaunchRefreshUrl: "https://marketplace.chasesets.com/account/payouts/setup",
        },
      },
      operatorSetup: {
        variableCommands: [],
        secretCommands: [],
        stripeMoneySmokeEnvironmentCommands: [
          '$env:PLATFORM_API_BASE_URL="https://chasesets.com"',
          '$env:STRIPE_CONNECT_RETURN_URL="https://chasesets.com/api/settlement/payout-setup/progress"',
          '$env:STRIPE_CONNECT_REFRESH_URL="https://chasesets.com/api/settlement/payout-setup/progress"',
          '$env:STRIPE_MONEY_SMOKE_ALLOW_LIVE="true"',
          '$env:PRODUCTION_MARKETPLACE_PROOF_REFERENCE="PRODUCTION-PROOF-2026-05-30"',
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
              '$env:PLATFORM_AUTH_BASE_URL="https://chasesets.com"',
              '$env:SMOKE_SELLER_EMAIL="<production-proof-seller-email>"',
              '$env:SMOKE_SELLER_PASSWORD="<production-proof-seller-password>"',
            ],
          },
        ],
        sesSnsEventDestinationSetup: {
          configurationSetName: "transactional-production",
          topicName: "chasesets-transactional-production-events",
          destination: "https://chasesets.com/api/notifications/provider/email/webhooks",
          requiredSesEventTypes: ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY"],
          commands: expect.arrayContaining([
            "aws sns create-topic --name chasesets-transactional-production-events",
            'aws sns subscribe --topic-arn <sns-topic-arn> --protocol https --notification-endpoint "https://chasesets.com/api/notifications/provider/email/webhooks"',
            "aws sesv2 get-configuration-set-event-destinations --configuration-set-name transactional-production",
          ]),
          evidenceFields: expect.arrayContaining([
            "gates.transactionalEmail.webhookDestination",
            "gates.transactionalEmail.snsSubscriptionConfirmationReference",
          ]),
        },
        easyPostWebhookSetup: {
          destination: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
          secretName: "EASYPOST_WEBHOOK_SECRET",
          requiredEventKinds: ["provider-event", "tracking-status", "refund-status"],
          evidenceFields: expect.arrayContaining([
            "gates.fulfillmentPostage.webhookDestination",
            "gates.fulfillmentPostage.providerEventQueryReference",
          ]),
        },
        fulfillmentPostageProofApiSetup: {
          purpose:
            "Drive operator-controlled seller shipment label purchase, void/refund, and exception proof while public marketplace promotion remains closed.",
          baseUrl: "https://chasesets.com",
          routedApiPrefixes: ["/api/marketplace/account/sales/shipments"],
          requiredTopologyChecks: expect.arrayContaining([
            "https://chasesets.com/api/marketplace/account/sales/shipments",
            "https://chasesets.com/api/marketplace/account/sales/shipments/topology-proof-shipment/label/purchase",
            "https://chasesets.com/api/marketplace/account/sales/shipments/topology-proof-shipment/label/void",
          ]),
          evidenceFields: expect.arrayContaining([
            "gates.fulfillmentPostage.controlledParcelShipmentId",
            "gates.fulfillmentPostage.parcelProviderLabelId",
          ]),
        },
        launchSupplyProofApiSetup: {
          purpose:
            "Create operator-controlled launch supply listings while public marketplace promotion remains closed.",
          baseUrl: "https://chasesets.com",
          routedApiPrefixes: [
            "/api/inventory/items/listing-stock/ensure",
            "/api/inventory/storage-locations",
            "/api/marketplace/account/listing-availability",
            "/api/marketplace/account/listing-inventory",
            "/api/marketplace/account/listings",
          ],
          requiredTopologyChecks: expect.arrayContaining([
            "https://chasesets.com/api/inventory/items/listing-stock/ensure",
            "https://chasesets.com/api/marketplace/account/listings",
          ]),
          evidenceFields: expect.arrayContaining([
            "gates.launchSupplyMeasurements.activeLaunchListingCount",
            "gates.launchSupplyMeasurements.sampledActiveLaunchListingIds",
          ]),
        },
        stripeMoneySmokeCheckCommand: "pnpm run stripe:money-smoke -- --check-env",
        stripeMoneySmokeCommand: "pnpm run stripe:money-smoke -- --edge-check --seller-flow",
      },
    });
    expect(readiness.requiredVariables).toEqual(REQUIRED_PROOF_VARIABLES);
  });

  it("reports missing live provider secrets and proof variables", () => {
    const readiness = buildProductionProofReadiness({
      variables: [variable("NOTIFICATION_EMAIL_PROVIDER", "amazon-ses")],
      secrets: [secret("SES_AWS_ACCESS_KEY_ID"), secret("SES_AWS_SECRET_ACCESS_KEY"), secret("SES_SOURCE_ARN")],
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(readiness.passesProductionProofReadinessGate).toBe(false);
    expect(readiness.missingVariables).toEqual(
      expect.arrayContaining([
        "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS",
        "PRODUCTION_MARKETPLACE_PROOF_ENABLED",
        "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
        "EASYPOST_MODE",
      ]),
    );
    expect(readiness.missingSecrets).toEqual(
      expect.arrayContaining([
        "STRIPE_SECRET_KEY",
        "STRIPE_CONNECT_WEBHOOK_SECRET",
        "EASYPOST_API_KEY",
        "EASYPOST_WEBHOOK_SECRET",
        "GOOGLE_SOCIAL_LOGIN_CLIENT_ID",
        "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET",
      ]),
    );
    expect(readiness.operatorSetup.variableCommands).toEqual(
      expect.arrayContaining([
        'gh variable set ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS --env production --body "chasesets.com"',
        'gh variable set PRODUCTION_MARKETPLACE_PUBLIC_ENABLED --env production --body "false"',
        'gh variable set PRODUCTION_MARKETPLACE_PROOF_ENABLED --env production --body "true"',
        'gh variable set PRODUCTION_MARKETPLACE_PROOF_REFERENCE --env production --body "PRODUCTION-PROOF-2026-05-30"',
        'gh variable set EASYPOST_MODE --env production --body "production"',
      ]),
    );
    expect(readiness.operatorSetup.secretCommands).toEqual(
      expect.arrayContaining([
        "gh secret set STRIPE_SECRET_KEY --env production",
        "gh secret set STRIPE_CONNECT_WEBHOOK_SECRET --env production",
        "gh secret set EASYPOST_WEBHOOK_SECRET --env production",
        "gh secret set GOOGLE_SOCIAL_LOGIN_CLIENT_ID --env production",
      ]),
    );
    expect(readiness.operatorSetup.stripeMoneySmokeEnvironmentCommands).toContain(
      '$env:PRODUCTION_MARKETPLACE_PROOF_REFERENCE="PRODUCTION-PROOF-2026-05-30"',
    );
    expect(readiness.operatorSetup.stripeMoneySmokeAuthenticationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "password sign-in",
          commands: expect.arrayContaining(['$env:PLATFORM_AUTH_BASE_URL="https://chasesets.com"']),
        }),
      ]),
    );
    expect(readiness.operatorSetup.notes).toContain(
      "Complete sesSnsEventDestinationSetup and easyPostWebhookSetup before collecting Transactional Email and Fulfillment Postage proof records.",
    );
    expect(readiness.operatorSetup.notes).toContain(
      "Choose one stripeMoneySmokeAuthenticationOptions entry before running the seller-flow smoke command; the live proof command needs an authenticated account.",
    );
    expect(readiness.operatorSetup.notes).toContain(
      "Use launchSupplyProofApiSetup only with operator-controlled proof seller accounts; it opens authenticated Inventory and Marketplace listing APIs, not public browse or marketplace web.",
    );
  });

  it("fails unsafe production proof posture", () => {
    const readiness = buildProductionProofReadiness({
      variables: [
        ...completeVariables.filter((row) => row.name !== "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED"),
        variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "true"),
        variable("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", "TODO"),
        variable("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS", "example.com"),
        variable("SES_CONFIGURATION_SET_NAME", "transactional-staging"),
        variable("STRIPE_API_BASE_URL", "https://stripe.test"),
        variable("EASYPOST_MODE", "test"),
      ],
      secrets: REQUIRED_PROOF_SECRETS.map(secret),
      environmentName: "staging",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(readiness.passesProductionProofReadinessGate).toBe(false);
    expect(readiness.errors).toContain(
      "Production proof readiness must be checked against the production GitHub Environment.",
    );
    expect(readiness.errors).toContain(
      "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be false for private production proof readiness.",
    );
    expect(readiness.errors).toContain(
      "PRODUCTION_MARKETPLACE_PROOF_REFERENCE must point to a real external evidence record, not a placeholder.",
    );
    expect(readiness.errors).toContain(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS must include chasesets.com for production admin SSO.",
    );
    expect(readiness.errors).toContain(
      "SES_CONFIGURATION_SET_NAME must be transactional-production for production proof readiness.",
    );
    expect(readiness.errors).toContain(
      "EASYPOST_MODE must be production when set for private production proof readiness.",
    );
    expect(readiness.errors).toContain(
      "STRIPE_API_BASE_URL must be unset for production proof unless an approved provider exception exists.",
    );
  });

  it("rejects short or launch-placeholder proof references", () => {
    for (const proofReference of ["abc", "launch-000"]) {
      const readiness = buildProductionProofReadiness({
        variables: [
          ...completeVariables.filter((row) => row.name !== "PRODUCTION_MARKETPLACE_PROOF_REFERENCE"),
          variable("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", proofReference),
        ],
        secrets: REQUIRED_PROOF_SECRETS.map(secret),
        environmentName: "production",
        checkedAt: "2026-05-30T12:00:00.000Z",
      });

      expect(readiness.passesProductionProofReadinessGate).toBe(false);
      expect(readiness.errors).toContain(
        "PRODUCTION_MARKETPLACE_PROOF_REFERENCE must point to a real external evidence record, not a placeholder.",
      );
    }
  });

  it("resolves input paths from flags and environment", () => {
    expect(
      parseProductionProofReadinessArgs(
        [
          "--variables",
          "vars.json",
          "--secrets",
          "secrets.json",
          "--base-url",
          "https://admin.chasesets.com/proof",
          "--marketplace-url",
          "https://marketplace.chasesets.com/path",
        ],
        {},
      ),
    ).toMatchObject({
      variablesPath: "vars.json",
      secretsPath: "secrets.json",
      environmentName: "production",
      baseUrl: "https://admin.chasesets.com/proof",
      marketplaceUrl: "https://marketplace.chasesets.com/path",
    });

    expect(
      parseProductionProofReadinessArgs([], {
        GITHUB_ENVIRONMENT_VARIABLES_JSON: "env-vars.json",
        GITHUB_ENVIRONMENT_SECRETS_JSON: "env-secrets.json",
        GITHUB_ENVIRONMENT_NAME: "production",
      }),
    ).toMatchObject({
      variablesPath: "env-vars.json",
      secretsPath: "env-secrets.json",
      environmentName: "production",
    });
  });

  it("reads stdin JSON when an input path is '-'", async () => {
    await expect(readJsonInput("-", async () => JSON.stringify({ variables: completeVariables }))).resolves.toEqual({
      variables: completeVariables,
    });
  });
});
