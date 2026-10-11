import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertCatalogIntegrationProfileUnitAllowed,
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicy,
  createCatalogIntegrationRolloutControlPolicyFromEnv,
} from "./catalog-integration-rollout-controls";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  catalogProviderProfileVersionProductDomain,
} from "../provider-integration-profiles";

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

  it("admits resolved profile units through the existing One Piece signoff with registry-derived membership", () => {
    const unsignedPolicy = createCatalogIntegrationRolloutControlPolicy({ onePieceProductionSignoffReference: null });
    const signedPolicy = createCatalogIntegrationRolloutControlPolicy({
      onePieceProductionSignoffReference: "#2285 UI-only staging UAT evidence",
    });
    const gate = unsignedPolicy
      .snapshot()
      .controls.find((control) => control.controlId === "one-piece-production-signoff-required");
    const onePieceVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) => catalogProviderProfileVersionProductDomain(version) === "one-piece",
    );
    const gatedVersions = onePieceVersions.filter((version) =>
      gate?.unitKeys.includes(catalogProviderProfileVersionIngestionUnitKey(version)),
    );
    const sharedProviderOtherGameVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) =>
        gate?.providerKeys.includes(version.providerKey) &&
        catalogProviderProfileVersionProductDomain(version) !== "one-piece",
    );

    // Membership is unchanged: every gated unit resolves from a registry profile, and only the
    // reference-data units stay outside the gate.
    expect(gatedVersions.map(catalogProviderProfileVersionIngestionUnitKey).sort()).toEqual(
      [...(gate?.unitKeys ?? [])].sort(),
    );
    expect(
      onePieceVersions
        .filter((version) => !gatedVersions.includes(version))
        .every((version) => (version.profile.capabilities as readonly string[]).includes("reference-data-promotion")),
    ).toBe(true);
    expect(sharedProviderOtherGameVersions.length).toBeGreaterThan(0);

    for (const capability of ["import", "promotion", "reapply"] as const) {
      for (const version of gatedVersions) {
        expect(() => assertCatalogIntegrationProfileUnitAllowed(unsignedPolicy, capability, version)).toThrow(
          ONE_PIECE_SIGNOFF_REQUIRED_PATTERN,
        );
        expect(() => assertCatalogIntegrationProfileUnitAllowed(signedPolicy, capability, version)).not.toThrow();
        // The provider-only call shape cannot match the unit-scoped gate; it is supplemental only.
        expect(unsignedPolicy.decide({ capability, providerKey: version.providerKey })).toMatchObject({
          allowed: true,
        });
      }
      for (const version of onePieceVersions.filter((candidate) => !gatedVersions.includes(candidate))) {
        expect(() => assertCatalogIntegrationProfileUnitAllowed(unsignedPolicy, capability, version)).not.toThrow();
      }
      for (const version of sharedProviderOtherGameVersions) {
        expect(() => assertCatalogIntegrationProfileUnitAllowed(unsignedPolicy, capability, version)).not.toThrow();
      }
    }
  });

  it("keeps global and provider denials effective for resolved profile units", () => {
    const [version] = catalogProviderIntegrationProfileVersions.filter(
      (candidate) => candidate.providerKey === "scrydex",
    );
    if (!version) {
      throw new Error("Expected a registry Scrydex profile version.");
    }

    expect(() =>
      assertCatalogIntegrationProfileUnitAllowed(
        createCatalogIntegrationRolloutControlPolicy({ controlPlaneMode: "dry-run-only" }),
        "promotion",
        version,
      ),
    ).toThrow("Catalog Integration Control Plane dry-run-only mode is active.");
    expect(() =>
      assertCatalogIntegrationProfileUnitAllowed(
        createCatalogIntegrationRolloutControlPolicy({ disabledReapply: ["scrydex"] }),
        "reapply",
        version,
      ),
    ).toThrow("Catalog integration reapply is disabled for the configured provider scope.");
    expect(() =>
      assertCatalogIntegrationProfileUnitAllowed(
        createCatalogIntegrationRolloutControlPolicy({ providerApiEmergencyStop: "all" }),
        "import",
        version,
      ),
    ).toThrow("Provider API emergency stop is active for the configured provider scope.");
  });

  it("ships production unit stops that name exactly the registry's Lorcana units", () => {
    const shipped = shippedProductionEnvOverrides();
    const lorcanaUnitKeys = registryLorcanaUnitKeys();

    // Partition of the whole registry: a unit is stopped exactly when it is a Lorcana unit, so a
    // Lorcana unit added to the registry fails here until the shipped stop list is regenerated.
    expect(lorcanaUnitKeys.length).toBeGreaterThan(0);
    for (const name of ["CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED", "CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED"]) {
      const stopped = shipped[name]?.split(",") ?? [];
      expect(stopped).toEqual(lorcanaUnitKeys);
      for (const version of catalogProviderIntegrationProfileVersions) {
        expect(stopped.includes(catalogProviderProfileVersionIngestionUnitKey(version))).toBe(
          catalogProviderProfileVersionProductDomain(version) === "lorcana",
        );
      }
    }
  });

  it("opens the shipped production posture for the founder's four product lines and keeps Lorcana stopped", () => {
    const shipped = shippedProductionEnvOverrides();
    const lorcanaUnitKeys = registryLorcanaUnitKeys();
    const policy = createCatalogIntegrationRolloutControlPolicyFromEnv({
      ...shipped,
      DEPLOYMENT_ENVIRONMENT: "production",
      CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE: "SYNTHETIC Magic signoff reference",
      CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE: "SYNTHETIC One Piece signoff reference",
    });

    expect(policy.snapshot().controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controlId: "control-plane-read-only", status: "open" }),
        expect.objectContaining({ controlId: "activation-disabled", status: "open" }),
      ]),
    );
    expect(
      policy.decide({ capability: "activation", providerKey: "scryfall", profileLifecycle: "draft" }),
    ).toMatchObject({ allowed: true });

    // Every registry unit goes through the runtime's resolved-unit admission, not the provider-only call shape.
    const blockedProviderKeys = ["tcgdex", "ygoprodeck", "ygojson"];
    const admittedProviderKeys = new Set<string>();
    for (const version of catalogProviderIntegrationProfileVersions) {
      const admit = (capability: "import" | "promotion" | "reapply") => () =>
        assertCatalogIntegrationProfileUnitAllowed(policy, capability, version);
      if (blockedProviderKeys.includes(version.providerKey)) {
        expect(admit("import")).toThrow(IMPORTS_PROVIDER_SCOPE_DENIAL);
        expect(admit("promotion")).toThrow(PROMOTION_PROVIDER_SCOPE_DENIAL);
        expect(admit("reapply")).toThrow(REAPPLY_PROVIDER_SCOPE_DENIAL);
      } else if (lorcanaUnitKeys.includes(catalogProviderProfileVersionIngestionUnitKey(version))) {
        expect(admit("import")).toThrow(IMPORTS_UNIT_SCOPE_DENIAL);
        expect(admit("promotion")).toThrow(PROMOTION_UNIT_SCOPE_DENIAL);
      } else {
        expect(admit("import")).not.toThrow();
        expect(admit("promotion")).not.toThrow();
        expect(admit("reapply")).not.toThrow();
        admittedProviderKeys.add(version.providerKey);
      }
    }
    expect([...admittedProviderKeys].sort()).toEqual(["mtgjson", "scrydex", "scryfall", "tcgplayer"]);
  });

  it("keeps the shipped production posture behind the enforced signoff references and a usable emergency stop", () => {
    const shipped = shippedProductionEnvOverrides();
    const signedEnv = {
      ...shipped,
      DEPLOYMENT_ENVIRONMENT: "production",
      CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE: "SYNTHETIC Magic signoff reference",
      CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE: "SYNTHETIC One Piece signoff reference",
    };
    const scrydexOnePieceCard = catalogProviderIntegrationProfileVersions.find(
      (version) =>
        catalogProviderProfileVersionIngestionUnitKey(version) ===
        "scrydex:one-piece:single-card:source-observation-import",
    );
    if (!scrydexOnePieceCard) {
      throw new Error("Expected the registry Scrydex One Piece single-card profile version.");
    }

    const withoutMagic = createCatalogIntegrationRolloutControlPolicyFromEnv({
      ...signedEnv,
      CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE: "",
    });
    for (const providerKey of ["mtgjson", "scryfall", "tcgplayer"]) {
      expect(withoutMagic.decide({ capability: "import", providerKey })).toMatchObject({
        allowed: false,
        controls: [expect.objectContaining({ controlId: "magic-production-signoff-required" })],
      });
    }
    const withoutOnePiece = createCatalogIntegrationRolloutControlPolicyFromEnv({
      ...signedEnv,
      CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE: "",
    });
    expect(() => assertCatalogIntegrationProfileUnitAllowed(withoutOnePiece, "import", scrydexOnePieceCard)).toThrow(
      ONE_PIECE_SIGNOFF_REQUIRED_PATTERN,
    );

    expect(shipped).not.toHaveProperty("CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP");
    const emergencyStopped = createCatalogIntegrationRolloutControlPolicyFromEnv({
      ...signedEnv,
      CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP: "scrydex",
    });
    expect(() => assertCatalogIntegrationProfileUnitAllowed(emergencyStopped, "import", scrydexOnePieceCard)).toThrow(
      "Provider API emergency stop is active for the configured provider scope.",
    );
  });
});

const ONE_PIECE_SIGNOFF_REQUIRED_PATTERN = /^One Piece production sync requires recorded provider-data signoff/;
const IMPORTS_PROVIDER_SCOPE_DENIAL = "Catalog integration imports are disabled for the configured provider scope.";
const PROMOTION_PROVIDER_SCOPE_DENIAL = "Catalog integration promotion is disabled for the configured provider scope.";
const REAPPLY_PROVIDER_SCOPE_DENIAL = "Catalog integration reapply is disabled for the configured provider scope.";
const IMPORTS_UNIT_SCOPE_DENIAL = "Catalog integration imports are disabled for the configured ingestion-unit scope.";
const PROMOTION_UNIT_SCOPE_DENIAL =
  "Catalog integration promotion is disabled for the configured ingestion-unit scope.";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../..");

/** The production overrides the release renders into values.production.yaml, read from the shipped file. */
function shippedProductionEnvOverrides(): Readonly<Record<string, string>> {
  const runtimeValues = JSON.parse(
    readFileSync(path.join(repositoryRoot, "infrastructure/helm/platform/runtime-values.json"), "utf8"),
  ) as { productionEnvOverrides: Record<string, string> };
  return runtimeValues.productionEnvOverrides;
}

function registryLorcanaUnitKeys(): readonly string[] {
  return [
    ...new Set(
      catalogProviderIntegrationProfileVersions
        .filter((version) => catalogProviderProfileVersionProductDomain(version) === "lorcana")
        .map(catalogProviderProfileVersionIngestionUnitKey),
    ),
  ].sort();
}
