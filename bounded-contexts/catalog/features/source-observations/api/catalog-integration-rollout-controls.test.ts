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
      NODE_ENV: "production",
    });

    expect(policy.decide({ capability: "provider-option-query", providerKey: "tcgplayer" })).toMatchObject({
      allowed: true,
    });
    expect(policy.decide({ capability: "import", providerKey: "mtgjson" })).toMatchObject({ allowed: true });
  });

  it("rejects typoed rollout mode env values with allowed values", () => {
    expect(() =>
      createCatalogIntegrationRolloutControlPolicyFromEnv({
        CATALOG_INTEGRATION_CONTROL_PLANE_MODE: "dryrun-only",
      }),
    ).toThrow(
      "CATALOG_INTEGRATION_CONTROL_PLANE_MODE must be one of 'open', 'false', 'none', 'read-only', 'dry-run-only', 'rollback-ready'. Received 'dryrun-only'.",
    );

    expect(() =>
      createCatalogIntegrationRolloutControlPolicyFromEnv({
        CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES: "cacheonly",
      }),
    ).toThrow(
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES must be one of 'open', 'false', 'none', 'disabled', 'cache-only'. Received 'cacheonly'.",
    );

    expect(() =>
      createCatalogIntegrationRolloutControlPolicyFromEnv({
        CATALOG_INTEGRATION_WORKER_MODE: "disabld",
      }),
    ).toThrow(
      "CATALOG_INTEGRATION_WORKER_MODE must be one of 'open', 'false', 'none', 'disabled', 'lane-limited'. Received 'disabld'.",
    );

    expect(() =>
      createCatalogIntegrationRolloutControlPolicyFromEnv({
        CATALOG_INTEGRATION_ACTIVATION_MODE: "test-profile-only",
      }),
    ).toThrow(
      "CATALOG_INTEGRATION_ACTIVATION_MODE must be one of 'open', 'false', 'none', 'disabled', 'test-profiles-only'. Received 'test-profile-only'.",
    );
  });

  it("rejects unknown provider-key rollout scopes", () => {
    expect(() =>
      createCatalogIntegrationRolloutControlPolicyFromEnv({
        CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP: "alll",
      }),
    ).toThrow(/CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP contains unknown provider key 'alll'.*tcgplayer/);

    expect(() =>
      createCatalogIntegrationRolloutControlPolicyFromEnv({
        CATALOG_INTEGRATION_IMPORTS_DISABLED: "tcgdex,tcgplayr",
      }),
    ).toThrow(/CATALOG_INTEGRATION_IMPORTS_DISABLED contains unknown provider key 'tcgplayr'.*tcgplayer/);
  });

  it("falls back to NODE_ENV production when deployment environment is absent", () => {
    const policy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      NODE_ENV: "production",
    });

    expect(policy.decide({ capability: "import", providerKey: "tcgplayer" })).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({ controlId: "dry-run-only" }),
        expect.objectContaining({ controlId: "imports-disabled", providerKeys: ["mtgjson", "scryfall", "tcgplayer"] }),
        expect.objectContaining({ controlId: "magic-production-signoff-required" }),
      ],
    });
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

  it("requires unit-aware One Piece production signoff without blocking Pokemon or MTG TCGplayer units", () => {
    const openProductionEnv = {
      DEPLOYMENT_ENVIRONMENT: "production",
      CATALOG_INTEGRATION_CONTROL_PLANE_MODE: "open",
      CATALOG_INTEGRATION_IMPORTS_DISABLED: "open",
      CATALOG_INTEGRATION_PROMOTION_DISABLED: "open",
      CATALOG_INTEGRATION_REAPPLY_DISABLED: "open",
      CATALOG_INTEGRATION_ACTIVATION_MODE: "open",
      CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE: "#2025 #2039 staging UAT evidence",
    };
    const unsignedPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv(openProductionEnv);

    expect(
      unsignedPolicy.decide({
        capability: "import",
        providerKey: "scrydex",
        unitKey: "scrydex:one-piece:single-card:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({
          controlId: "one-piece-production-signoff-required",
          providerKeys: ["scrydex", "tcgplayer"],
          unitKeys: [
            "scrydex:one-piece:single-card:source-observation-import",
            "scrydex:one-piece:sealed-product:source-observation-import",
            "tcgplayer:one-piece:single-card:source-observation-import",
            "tcgplayer:one-piece:sealed-product:source-observation-import",
          ],
        }),
      ],
    });
    expect(
      unsignedPolicy.decide({
        capability: "promotion",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:one-piece:sealed-product:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "one-piece-production-signoff-required" })],
    });
    expect(
      unsignedPolicy.decide({
        capability: "import",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      unsignedPolicy.decide({
        capability: "import",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:mtg:single-card:source-observation-import",
      }),
    ).toMatchObject({ allowed: true });

    const signedPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      ...openProductionEnv,
      CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE:
        "#2285 UI-only staging UAT; Scrydex provider usage summary redacted",
    });

    expect(
      signedPolicy.decide({
        capability: "import",
        providerKey: "scrydex",
        unitKey: "scrydex:one-piece:single-card:source-observation-import",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      signedPolicy.decide({
        capability: "activation",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:one-piece:sealed-product:source-observation-import",
        profileLifecycle: "active",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("stops One Piece provider units without stopping shared provider product lines", () => {
    const policy = createCatalogIntegrationRolloutControlPolicy({
      providerApiEmergencyStopUnits: ["scrydex:one-piece:single-card:source-observation-import"],
      disabledImportUnits: ["tcgplayer:one-piece:sealed-product:source-observation-import"],
      disabledPromotionUnits: ["scrydex:one-piece:sealed-product:source-observation-import"],
      disabledReapplyUnits: ["tcgplayer:one-piece:single-card:source-observation-import"],
      disabledProviderOptionQueryUnits: ["scrydex:one-piece:sealed-product:source-observation-import"],
      cacheOnlyProviderOptionQueryUnits: ["tcgplayer:one-piece:single-card:source-observation-import"],
    });

    expect(
      policy.decide({
        capability: "provider-transport",
        providerKey: "scrydex",
        unitKey: "scrydex:one-piece:single-card:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({
          controlId: "provider-api-emergency-stop",
          unitKeys: ["scrydex:one-piece:single-card:source-observation-import"],
        }),
      ],
    });
    expect(
      policy.decide({
        capability: "provider-transport",
        providerKey: "scrydex",
        unitKey: "scrydex:pokemon:single-card:source-observation-import",
      }),
    ).toMatchObject({ allowed: true });

    expect(
      policy.decide({
        capability: "import",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:one-piece:sealed-product:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "imports-disabled" })],
    });
    expect(
      policy.decide({
        capability: "import",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      policy.decide({
        capability: "import",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:mtg:single-card:source-observation-import",
      }),
    ).toMatchObject({ allowed: true });

    expect(
      policy.decide({
        capability: "promotion",
        providerKey: "scrydex",
        unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "promotion-disabled" })],
    });
    expect(
      policy.decide({
        capability: "reapply",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "reapply-disabled" })],
    });
    expect(
      policy.decide({
        capability: "provider-option-query",
        providerKey: "scrydex",
        unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "provider-option-queries-disabled" })],
    });
    expect(
      policy.decide({
        capability: "provider-option-query",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [expect.objectContaining({ controlId: "provider-option-queries-cache-only" })],
    });
  });

  it("parses unit-scoped rollout stops from env", () => {
    const policy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTER_UNITS: "scrydex:one-piece:single-card:source-observation-import",
      CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP_UNITS:
        "scrydex:one-piece:sealed-product:source-observation-import",
      CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED: "tcgplayer:one-piece:sealed-product:source-observation-import",
      CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED: "scrydex:one-piece:sealed-product:source-observation-import",
      CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED: "tcgplayer:one-piece:single-card:source-observation-import",
      CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_DISABLED:
        "scrydex:one-piece:sealed-product:source-observation-import",
      CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_CACHE_ONLY:
        "tcgplayer:one-piece:single-card:source-observation-import",
    });

    expect(
      policy.snapshot().controls.filter((control) => control.unitKeys.some((unitKey) => unitKey.includes("one-piece"))),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controlId: "provider-adapter-disabled" }),
        expect.objectContaining({ controlId: "provider-api-emergency-stop" }),
        expect.objectContaining({ controlId: "imports-disabled" }),
        expect.objectContaining({ controlId: "promotion-disabled" }),
        expect.objectContaining({ controlId: "reapply-disabled" }),
        expect.objectContaining({ controlId: "provider-option-queries-disabled" }),
        expect.objectContaining({ controlId: "provider-option-queries-cache-only" }),
      ]),
    );
    expect(
      policy.decide({
        capability: "import",
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:one-piece:sealed-product:source-observation-import",
      }),
    ).toMatchObject({
      allowed: false,
      controls: [
        expect.objectContaining({ unitKeys: ["tcgplayer:one-piece:sealed-product:source-observation-import"] }),
      ],
    });
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
