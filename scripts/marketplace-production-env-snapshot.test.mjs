import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_PRODUCTION_ENV_SNAPSHOT_VERSION,
  buildProductionEnvSnapshot,
  parseProductionEnvSnapshotArgs,
} from "./marketplace-production-env-snapshot.mjs";

function variable(name, value) {
  return { name, value };
}

const completeVariables = [
  variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "false"),
  variable("PRODUCTION_MARKETPLACE_PROOF_ENABLED", "false"),
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
];

describe("marketplace production environment snapshot", () => {
  it("builds the productionEnvironment object from GitHub variable JSON", () => {
    const snapshot = buildProductionEnvSnapshot({
      variables: completeVariables,
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      schemaVersion: MARKETPLACE_PRODUCTION_ENV_SNAPSHOT_VERSION,
      environmentName: "production",
      passesProductionEnvSnapshotGate: true,
      productionEnvironment: {
        PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
        PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE: "CHECKOUT-LAUNCH-2026-05-30",
        PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: "STRIPE-MONEY-2026-05-30",
        TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
        EASYPOST_MODE: "production",
      },
    });
    expect(snapshot.productionEnvironment).not.toHaveProperty("STRIPE_SECRET_KEY");
  });

  it("rejects placeholder production evidence references", () => {
    const snapshot = buildProductionEnvSnapshot({
      variables: [
        ...completeVariables.filter((row) => row.name !== "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE"),
        variable("PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE", "TBD"),
      ],
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(snapshot.passesProductionEnvSnapshotGate).toBe(false);
    expect(snapshot.errors).toContain(
      "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when required launch variables are missing or malformed", () => {
    const snapshot = buildProductionEnvSnapshot({
      variables: [
        ...completeVariables.filter((row) => row.name !== "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE"),
        variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "yes"),
      ],
      environmentName: "staging",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(snapshot.passesProductionEnvSnapshotGate).toBe(false);
    expect(snapshot.errors).toContain(
      "Production GitHub Environment variable PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE is required for public launch readiness.",
    );
    expect(snapshot.errors).toContain(
      "Marketplace public launch environment snapshot must come from the production GitHub Environment.",
    );
    expect(snapshot.errors).toContain("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be the string true or false.");
  });

  it("requires production EasyPost mode in public launch readiness", () => {
    const snapshot = buildProductionEnvSnapshot({
      variables: [
        ...completeVariables.filter((row) => row.name !== "EASYPOST_MODE"),
        variable("EASYPOST_MODE", "test"),
      ],
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(snapshot.passesProductionEnvSnapshotGate).toBe(false);
    expect(snapshot.errors).toContain("EASYPOST_MODE must be production for marketplace public launch readiness.");
  });

  it("requires proof reference when proof mode is enabled", () => {
    const snapshot = buildProductionEnvSnapshot({
      variables: [
        ...completeVariables.filter((row) => row.name !== "PRODUCTION_MARKETPLACE_PROOF_ENABLED"),
        variable("PRODUCTION_MARKETPLACE_PROOF_ENABLED", "true"),
      ],
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(snapshot.passesProductionEnvSnapshotGate).toBe(false);
    expect(snapshot.errors).toContain(
      "PRODUCTION_MARKETPLACE_PROOF_REFERENCE is required when PRODUCTION_MARKETPLACE_PROOF_ENABLED=true.",
    );
  });

  it("rejects proof mode when public promotion is enabled", () => {
    const snapshot = buildProductionEnvSnapshot({
      variables: [
        ...completeVariables.filter(
          (row) =>
            row.name !== "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED" && row.name !== "PRODUCTION_MARKETPLACE_PROOF_ENABLED",
        ),
        variable("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", "true"),
        variable("PRODUCTION_MARKETPLACE_PROOF_ENABLED", "true"),
        variable("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", "PRODUCTION-PROOF-2026-05-30"),
      ],
      environmentName: "production",
      checkedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(snapshot.passesProductionEnvSnapshotGate).toBe(false);
    expect(snapshot.errors).toContain(
      "PRODUCTION_MARKETPLACE_PROOF_ENABLED must be false when PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true.",
    );
  });

  it("resolves options from flags and environment", () => {
    expect(parseProductionEnvSnapshotArgs(["--variables", "-", "--environment", "production"], {})).toMatchObject({
      variablesPath: "-",
      environmentName: "production",
    });

    expect(
      parseProductionEnvSnapshotArgs([], {
        GITHUB_ENVIRONMENT_VARIABLES_JSON: "env-vars.json",
        GITHUB_ENVIRONMENT_NAME: "production",
      }),
    ).toMatchObject({
      variablesPath: "env-vars.json",
      environmentName: "production",
    });
  });
});
