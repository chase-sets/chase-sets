import { describe, expect, it } from "vitest";
import {
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicy,
  createCatalogIntegrationRolloutControlPolicyFromEnv,
} from "./catalog-integration-rollout-controls";

describe("Catalog integration rollout controls", () => {
  it("defaults control-plane operations to open", () => {
    const policy = createCatalogIntegrationRolloutControlPolicy({}, "2026-06-08T00:00:00.000Z");

    expect(policy.decide({ capability: "import", providerKey: "tcgdex" })).toMatchObject({ allowed: true });
    expect(policy.decide({ capability: "promotion", providerKey: "tcgdex" })).toMatchObject({ allowed: true });
  });

  it("keeps non-production env defaults open for provider UAT", () => {
    const policy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      DEPLOYMENT_ENVIRONMENT: "staging",
    });

    expect(policy.decide({ capability: "provider-option-query", providerKey: "tcgplayer" })).toMatchObject({
      allowed: true,
    });
    expect(policy.decide({ capability: "import", providerKey: "mtgjson" })).toMatchObject({ allowed: true });
  });

  it("defaults production Magic provider writes to dry-run and disabled until activation gates pass", () => {
    const policy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      DEPLOYMENT_ENVIRONMENT: "production",
    });

    expect(policy.decide({ capability: "provider-option-query", providerKey: "tcgplayer" })).toMatchObject({
      allowed: true,
    });
    expect(policy.decide({ capability: "import", providerKey: "tcgplayer" })).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({ controlId: "dry-run-only" }),
        expect.objectContaining({ controlId: "imports-disabled", providerKeys: ["mtgjson", "scryfall", "tcgplayer"] }),
        expect.objectContaining({
          controlId: "magic-production-signoff-required",
          providerKeys: ["mtgjson", "scryfall", "tcgplayer"],
        }),
      ],
    });
    expect(policy.decide({ capability: "promotion", providerKey: "scryfall" })).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({ controlId: "dry-run-only" }),
        expect.objectContaining({ controlId: "promotion-disabled" }),
        expect.objectContaining({ controlId: "magic-production-signoff-required" }),
      ],
    });
    expect(
      policy.decide({ capability: "activation", providerKey: "mtgjson", profileLifecycle: "draft" }),
    ).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({ controlId: "dry-run-only" }),
        expect.objectContaining({ controlId: "activation-test-profiles-only" }),
        expect.objectContaining({ controlId: "magic-production-signoff-required" }),
      ],
    });
  });

  it("requires Magic production signoff when production write controls are explicitly opened", () => {
    const openProductionEnv = {
      DEPLOYMENT_ENVIRONMENT: "production",
      CATALOG_INTEGRATION_CONTROL_PLANE_MODE: "open",
      CATALOG_INTEGRATION_IMPORTS_DISABLED: "open",
      CATALOG_INTEGRATION_PROMOTION_DISABLED: "open",
      CATALOG_INTEGRATION_REAPPLY_DISABLED: "open",
      CATALOG_INTEGRATION_ACTIVATION_MODE: "open",
    };
    const unsignedPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv(openProductionEnv);

    expect(unsignedPolicy.decide({ capability: "import", providerKey: "mtgjson" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "magic-production-signoff-required" })],
    });
    expect(unsignedPolicy.decide({ capability: "promotion", providerKey: "scryfall" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "magic-production-signoff-required" })],
    });
    expect(unsignedPolicy.decide({ capability: "reapply", providerKey: "tcgplayer" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "magic-production-signoff-required" })],
    });
    expect(
      unsignedPolicy.decide({ capability: "activation", providerKey: "tcgplayer", profileLifecycle: "active" }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "magic-production-signoff-required" })],
    });
    expect(unsignedPolicy.decide({ capability: "import", providerKey: "tcgdex" })).toMatchObject({ allowed: true });

    const signedPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      ...openProductionEnv,
      CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE: "#2025 #2039 staging UAT evidence",
    });

    expect(signedPolicy.decide({ capability: "import", providerKey: "mtgjson" })).toMatchObject({ allowed: true });
    expect(signedPolicy.decide({ capability: "promotion", providerKey: "scryfall" })).toMatchObject({
      allowed: true,
    });
    expect(signedPolicy.decide({ capability: "reapply", providerKey: "tcgplayer" })).toMatchObject({ allowed: true });
    expect(
      signedPolicy.decide({ capability: "activation", providerKey: "tcgplayer", profileLifecycle: "active" }),
    ).toMatchObject({ allowed: true });
  });

  it("blocks provider transport and option queries when a provider adapter is disabled", () => {
    const policy = createCatalogIntegrationRolloutControlPolicy({
      disabledProviderAdapters: ["tcgdex"],
    });

    expect(policy.decide({ capability: "provider-option-query", providerKey: "tcgdex" })).toMatchObject({
      allowed: false,
      diagnosticCode: "catalog-integration-rollout-control-denied",
      controls: [expect.objectContaining({ controlId: "provider-adapter-disabled" })],
    });
    expect(policy.decide({ capability: "provider-option-query", providerKey: "tcgplayer" })).toMatchObject({
      allowed: true,
    });
  });

  it("blocks import, promotion, reapply, activation, and worker processing controls independently", () => {
    const policy = createCatalogIntegrationRolloutControlPolicy({
      disabledImports: "all",
      disabledPromotion: ["tcgdex"],
      disabledReapply: ["tcgplayer"],
      activationMode: "test-profiles-only",
      workerMode: "disabled",
    });

    expect(policy.decide({ capability: "import", providerKey: "scryfall" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "imports-disabled" })],
    });
    expect(policy.decide({ capability: "promotion", providerKey: "tcgdex" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "promotion-disabled" })],
    });
    expect(policy.decide({ capability: "reapply", providerKey: "tcgplayer" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "reapply-disabled" })],
    });
    expect(policy.decide({ capability: "activation", providerKey: "tcgdex", profileLifecycle: "draft" })).toMatchObject(
      {
        allowed: false,
        controls: [expect.objectContaining({ controlId: "activation-test-profiles-only" })],
      },
    );
    expect(policy.decide({ capability: "activation", providerKey: "tcgdex", profileLifecycle: "test" })).toMatchObject({
      allowed: true,
    });
    expect(policy.decide({ capability: "worker-job-processing" })).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "worker-processing-disabled" })],
    });
  });

  it("throws structured rollout denial evidence from assertAllowed", () => {
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledImports: ["tcgdex"] });

    expect(() => policy.assertAllowed({ capability: "import", providerKey: "tcgdex" })).toThrow(
      CatalogIntegrationRolloutControlError,
    );
    try {
      policy.assertAllowed({ capability: "import", providerKey: "tcgdex" });
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationRolloutControlError);
      expect((error as CatalogIntegrationRolloutControlError).decision.controls[0]).toMatchObject({
        controlId: "imports-disabled",
        auditEventName: "rollout-control-denied",
        metricKey: "catalog.integration.rollout.imports_disabled",
      });
    }
  });
});
