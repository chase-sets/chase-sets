import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION,
  REQUIRED_LAUNCH_SECRETS,
  buildProductionLaunchReadiness,
  parseProductionLaunchReadinessArgs,
  readJsonInput,
} from "./marketplace-production-launch-readiness.mjs";

function variable(name, value) {
  return { name, value };
}

function secret(name) {
  return { name, updatedAt: "2026-05-30T12:00:00Z" };
}

const completeVariables = [
  variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "true"),
  variable("PRODUCTION_MARKETPLACE_PROOF_ENABLED", "false"),
  variable("PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE", "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30"),
  variable("PRODUCTION_MARKETPLACE_PROMOTION_APPROVED", "true"),
  variable("PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE", "LAUNCH-REVIEW-2026-05-30"),
  variable("PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED", "true"),
  variable("PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE", "PAYMENTS-FEE-2026-05-30"),
  variable("PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED", "true"),
  variable("PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE", "CHECKOUT-LAUNCH-2026-05-30"),
  variable("PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED", "true"),
  variable("PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE", "STRIPE-MONEY-2026-05-30"),
  variable("PRODUCTION_SUPPORT_OPERATIONS_APPROVED", "true"),
  variable("PRODUCTION_SUPPORT_OPERATIONS_REFERENCE", "SUPPORT-OPS-2026-05-30"),
  variable("PRODUCTION_FULFILLMENT_POSTAGE_APPROVED", "true"),
  variable("PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE", "FULFILLMENT-POSTAGE-2026-05-30"),
  variable("PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED", "true"),
  variable("PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE", "NOTIFICATIONS-SES-2026-05-30"),
  variable("PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED", "true"),
  variable("PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE", "CATALOG-MEASURES-2026-05-30"),
  variable("PRODUCTION_TAX_READINESS_APPROVED", "true"),
  variable("PRODUCTION_TAX_READINESS_REFERENCE", "TAX-READINESS-2026-05-30"),
  variable("TAX_PROVIDER_BACKED_QUOTES_REQUIRED", "false"),
  variable("EASYPOST_MODE", "production"),
  variable("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS", "chasesets.com"),
  variable("NOTIFICATION_EMAIL_PROVIDER", "amazon-ses"),
  variable("SES_AWS_REGION", "us-east-2"),
  variable("SES_CONFIGURATION_SET_NAME", "transactional-production"),
  variable("SES_FROM_EMAIL", "notifications@chasesets.com"),
];

describe("marketplace production launch readiness", () => {
  it("passes when final launch variables and required secret names are present", () => {
    const readiness = buildProductionLaunchReadiness({
      variables: completeVariables,
      secrets: REQUIRED_LAUNCH_SECRETS.map(secret),
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(readiness).toMatchObject({
      schemaVersion: MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION,
      passesProductionLaunchReadinessGate: true,
      missingVariables: [],
      missingSecrets: [],
      productionEnvironment: {
        PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "true",
        PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
      },
      operatorSetup: {
        secretCommands: [],
        googleSocialLoginOAuthSetup: {
          provider: "google",
          authorizedRedirectUris: [
            "https://marketplace.chasesets.com/api/auth/social/google/callback",
            "https://admin.chasesets.com/api/auth/social/google/callback",
            "https://chasesets.com/api/auth/social/google/callback",
          ],
        },
      },
    });
  });

  it("reports current-style missing launch variables and live provider secrets", () => {
    const readiness = buildProductionLaunchReadiness({
      variables: [
        variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "false"),
        variable("NOTIFICATION_EMAIL_PROVIDER", "amazon-ses"),
        variable("SES_AWS_REGION", "us-east-2"),
        variable("SES_CONFIGURATION_SET_NAME", "transactional-production"),
        variable("SES_FROM_EMAIL", "notifications@chasesets.com"),
      ],
      secrets: [
        secret("SES_AWS_ACCESS_KEY_ID"),
        secret("SES_AWS_SECRET_ACCESS_KEY"),
        secret("SES_SOURCE_ARN"),
        secret("CHASE_SETS_DISCORD_INVITE_URL"),
        secret("DIGITALOCEAN_ACCESS_TOKEN"),
        secret("SPACES_ACCESS_ID"),
        secret("SPACES_SECRET_KEY"),
        secret("PLATFORM_INTERNAL_AUTH_SECRET"),
        secret("PLATFORM_ADMIN_EMAIL"),
        secret("PLATFORM_ADMIN_PASSWORD"),
      ],
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(readiness.passesProductionLaunchReadinessGate).toBe(false);
    expect(readiness.missingVariables).toEqual(
      expect.arrayContaining([
        "PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE",
        "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE",
        "PRODUCTION_TAX_READINESS_REFERENCE",
        "EASYPOST_MODE",
      ]),
    );
    expect(readiness.missingSecrets).toEqual(
      expect.arrayContaining([
        "STRIPE_SECRET_KEY",
        "STRIPE_PUBLISHABLE_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_CONNECT_WEBHOOK_SECRET",
        "EASYPOST_API_KEY",
        "EASYPOST_WEBHOOK_SECRET",
      ]),
    );
    expect(readiness.errors).toContain(
      "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be true for final public launch readiness.",
    );
    expect(readiness.operatorSetup.secretCommands).toEqual(
      expect.arrayContaining([
        "gh secret set STRIPE_SECRET_KEY --env production",
        "gh secret set STRIPE_CONNECT_WEBHOOK_SECRET --env production",
        "gh secret set EASYPOST_WEBHOOK_SECRET --env production",
      ]),
    );
    expect(readiness.operatorSetup.notes).toContain(
      "Complete googleSocialLoginOAuthSetup before smoke-testing production marketplace Google sign-in or admin Google Workspace SSO.",
    );
  });

  it("fails unsafe final launch posture", () => {
    const readiness = buildProductionLaunchReadiness({
      variables: [
        ...completeVariables.filter(
          (row) =>
            row.name !== "PRODUCTION_MARKETPLACE_PROOF_ENABLED" &&
            row.name !== "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS" &&
            row.name !== "SES_CONFIGURATION_SET_NAME",
        ),
        variable("PRODUCTION_MARKETPLACE_PROOF_ENABLED", "true"),
        variable("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS", "example.com"),
        variable("SES_CONFIGURATION_SET_NAME", "transactional-staging"),
        variable("STRIPE_API_BASE_URL", "https://stripe.test"),
        variable("EASYPOST_API_BASE_URL", "https://api.easypost.test"),
        variable("EASYPOST_MODE", "test"),
      ],
      secrets: REQUIRED_LAUNCH_SECRETS.map(secret),
      environmentName: "staging",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(readiness.passesProductionLaunchReadinessGate).toBe(false);
    expect(readiness.errors).toContain(
      "Production launch readiness must be checked against the production GitHub Environment.",
    );
    expect(readiness.errors).toContain(
      "PRODUCTION_MARKETPLACE_PROOF_ENABLED must be false or unset for final public launch readiness.",
    );
    expect(readiness.errors).toContain(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS must include chasesets.com for final public launch readiness.",
    );
    expect(readiness.errors).toContain(
      "SES_CONFIGURATION_SET_NAME must be transactional-production for final public launch readiness.",
    );
    expect(readiness.errors).toContain("EASYPOST_MODE must be production when set for final public launch readiness.");
    expect(readiness.errors).toContain("STRIPE_API_BASE_URL must be unset for final public launch.");
    expect(readiness.errors).toContain("EASYPOST_API_BASE_URL must be unset for final public launch.");
  });

  it("resolves input paths from flags and environment", () => {
    expect(
      parseProductionLaunchReadinessArgs(["--variables", "vars.json", "--secrets", "secrets.json"], {}),
    ).toMatchObject({
      variablesPath: "vars.json",
      secretsPath: "secrets.json",
      environmentName: "production",
    });

    expect(
      parseProductionLaunchReadinessArgs([], {
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
