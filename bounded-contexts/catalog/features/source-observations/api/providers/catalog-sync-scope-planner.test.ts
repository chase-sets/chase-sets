import { describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import type { ProviderAdapter, ProviderImportScope } from "../provider-adapters/provider-adapter";
import {
  aggregateCatalogSyncProviderParticipationEstimate,
  previewCatalogSyncProviderParticipation,
  type CatalogSyncAcceptedScopeMapping,
  type CatalogSyncScope,
} from "./catalog-sync-scope-planner";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import { unitKeyForCatalogProviderProfileVersion } from "../governance/catalog-integration-impact-analysis";
import { LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY } from "../provider-adapters/lorcanajson";
import { createCatalogIntegrationRolloutControlPolicy } from "../governance/catalog-integration-rollout-controls";
import { listProviderScopeDiscoveryTargets } from "../../../provider-scope-discovery/api/discovery-targets";
import { providerScopeMappingCoordinates } from "../../../provider-scope-discovery/api/scope-observation-matcher";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "./provider-option-query-resolver";
import { tcgplayerAutomationResponseFixtures } from "./tcgplayer-automation-response-fixtures.test-data";

const BASE_SET_SCOPE_RECORD_ID = "scope_pokemon_base_set";

describe("Catalog sync scope planner", () => {
  it("defaults every eligible mapped provider role into Pokemon Expansion participation", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const tcgdexPlanImport = vi.fn(fakePlanImport(102));
    const tcgplayerPlanImport = vi.fn(fakePlanImport(205));
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope(),
      acceptedScopeMappings: [tcgdexBaseSetMapping(tcgdexUnitKey), tcgplayerBaseSetMapping(tcgplayerUnitKey)],
      providerProfileVersions: [tcgdex, tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([
        fakeAdapter("tcgdex", tcgdexPlanImport),
        fakeAdapter("tcgplayer", tcgplayerPlanImport),
      ]),
    });

    expect(preview.status).toBe("ready");
    expect(preview.startAllowed).toBe(true);
    expect(preview.units).toHaveLength(2);
    expect(preview.units.map((unit) => [unit.unitKey, unit.role, unit.requirement, unit.selected])).toEqual([
      [tcgdexUnitKey, "primary-source-observation", "required", true],
      [tcgplayerUnitKey, "supplemental-marketplace-reference", "optional", true],
    ]);
    expect(preview.units.every((unit) => unit.defaultSelected)).toBe(true);
    expect(preview.estimate).toMatchObject({
      totalEstimatedRequestCount: 2,
      estimateState: "estimated",
      creditConsumingProviders: [],
    });
    expect(preview.units[0]?.childExecutionScope).toMatchObject({
      provider: "tcgdex",
      ingestionUnitKey: tcgdexUnitKey,
      language: "en",
      setId: "base1",
      seriesId: "base",
    });
    expect(preview.units[1]?.childExecutionScope).toMatchObject({
      provider: "tcgplayer",
      ingestionUnitKey: tcgplayerUnitKey,
      productLineId: "3",
      setName: "Base Set",
    });
    expect(tcgdexPlanImport).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKey: tcgdexUnitKey,
        values: expect.objectContaining({ setId: "base1", language: "en" }),
      }),
    );
    expect(tcgplayerPlanImport).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKey: tcgplayerUnitKey,
        values: expect.objectContaining({ productLineId: "3", setName: "Base Set" }),
      }),
    );

    expect(aggregateCatalogSyncProviderParticipationEstimate(preview.units, new Set([tcgdexUnitKey]))).toMatchObject({
      totalEstimatedRequestCount: 1,
      estimateState: "estimated",
    });
  });

  it("limits participation to an explicitly selected optional provider unit", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const tcgdexPlanImport = vi.fn(fakePlanImport(102));
    const tcgplayerPlanImport = vi.fn(fakePlanImport(205));
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({ selectedUnitKeys: [tcgplayerUnitKey] }),
      acceptedScopeMappings: [tcgdexBaseSetMapping(tcgdexUnitKey), tcgplayerBaseSetMapping(tcgplayerUnitKey)],
      providerProfileVersions: [tcgdex, tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([
        fakeAdapter("tcgdex", tcgdexPlanImport),
        fakeAdapter("tcgplayer", tcgplayerPlanImport),
      ]),
    });

    expect(preview.status).toBe("ready");
    expect(preview.startAllowed).toBe(true);
    expect(preview.units.map((unit) => [unit.unitKey, unit.role, unit.requirement, unit.selected])).toEqual([
      [tcgplayerUnitKey, "supplemental-marketplace-reference", "optional", true],
    ]);
    expect(preview.units[0]?.childExecutionScope).toMatchObject({
      provider: "tcgplayer",
      ingestionUnitKey: tcgplayerUnitKey,
      productLineId: "3",
      setName: "Base Set",
    });
    expect(tcgdexPlanImport).not.toHaveBeenCalled();
    expect(tcgplayerPlanImport).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKey: tcgplayerUnitKey,
        values: expect.objectContaining({ productLineId: "3", setName: "Base Set" }),
      }),
    );
    expect(JSON.stringify(preview)).not.toContain(tcgdexUnitKey);
  });

  it("blocks required provider units when the transport adapter is unsupported", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope(),
      acceptedScopeMappings: [tcgdexBaseSetMapping(tcgdexUnitKey)],
      providerProfileVersions: [tcgdex],
      providerAdapterRegistry: new ProviderAdapterRegistry([]),
    });

    expect(preview.status).toBe("blocked");
    expect(preview.startAllowed).toBe(false);
    expect(preview.blockers).toEqual([
      expect.objectContaining({
        code: "provider-adapter-missing",
        severity: "error",
      }),
    ]);
    expect(preview.units[0]).toMatchObject({
      providerKey: "tcgdex",
      requirement: "required",
      eligibility: "ineligible",
      selected: true,
      childExecutionScope: null,
    });
  });

  it("captures rollout evidence and blocks batch planning when an import gate is closed", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope(),
      acceptedScopeMappings: [tcgdexBaseSetMapping(tcgdexUnitKey)],
      providerProfileVersions: [tcgdex],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgdex", fakePlanImport(1))]),
      rolloutControlPolicy: createCatalogIntegrationRolloutControlPolicy({ disabledImports: ["tcgdex"] }),
      includeOperationalGates: true,
    });

    expect(preview.startAllowed).toBe(false);
    expect(preview.units[0]?.blockers).toEqual([expect.objectContaining({ code: "provider-rollout-blocked" })]);
    expect(preview.units[0]?.planningEvidence?.rollout).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "import", allowed: false })]),
    );
  });

  it("blocks sync when a required provider unit has no profile inventory", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({
        requiredUnitKeys: ["tcgplayer:pokemon:single-card:source-observation-import"],
      }),
      acceptedScopeMappings: [],
      providerProfileVersions: [tcgdex],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgdex", vi.fn(fakePlanImport(102)))]),
    });

    expect(preview.status).toBe("blocked");
    expect(preview.blockers).toEqual([
      expect.objectContaining({
        code: "required-provider-unit-missing",
        message:
          "tcgplayer:pokemon:single-card:source-observation-import was required for this Catalog scope but no provider profile unit is available.",
      }),
    ]);
  });

  it("resolves a fully mapped scope with no manually supplied provider coordinates", async () => {
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const target = listProviderScopeDiscoveryTargets([tcgplayer]).find(
      (candidate) => candidate.queryKind === "set-names",
    )!;
    const [mappedOption] = await listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [tcgplayer.profile],
      providerKey: "tcgplayer",
      queryKind: "set-names",
      languageCode: "en",
      parentValue: "3",
      defaultProviderKey: "tcgplayer",
      transports: {
        listTcgplayerSetNames: async () => tcgplayerAutomationResponseFixtures.catalogSetNames.results,
      },
    });
    const coordinates = providerScopeMappingCoordinates(target, {
      providerKey: "tcgplayer",
      unitKey: tcgplayerUnitKey,
      scopeKind: target.scopeKind,
      sourceQueryKind: target.queryKind,
      languageCode: "en",
      externalId: mappedOption!.value,
      label: mappedOption!.label,
      parents: [mappedOption!.parentValue!],
      imageUrl: mappedOption!.imageUrl,
      metadata: mappedOption!.metadata,
      scanId: "scan-planner-coordinate-proof",
      scannedAt: "2026-08-27T00:00:00.000Z",
      firstObservedAt: "2026-08-27T00:00:00.000Z",
      observationHash: "planner-coordinate-proof",
      newlyObserved: true,
      changed: true,
    });
    expect(coordinates).toEqual({
      productLineId: "3",
      seriesId: null,
      setId: null,
      setName: "Prismatic Evolutions",
      language: null,
    });
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({ selectedUnitKeys: [tcgplayerUnitKey] }),
      acceptedScopeMappings: [
        acceptedMapping({
          providerKey: "tcgplayer",
          unitKey: tcgplayerUnitKey,
          productLineId: coordinates!.productLineId,
          seriesId: coordinates!.seriesId,
          setId: coordinates!.setId,
          setName: coordinates!.setName,
        }),
      ],
      providerProfileVersions: [tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgplayer", vi.fn(fakePlanImport(205)))]),
    });

    expect(preview.status).toBe("ready");
    expect(preview.startAllowed).toBe(true);
    expect(preview.units[0]).toMatchObject({
      eligibility: "eligible",
      blockers: [],
      childExecutionScope: {
        provider: "tcgplayer",
        productLineId: "3",
        setName: "Prismatic Evolutions",
      },
    });
    // The scope reference carries no raw provider coordinates or names.
    expect(preview.scope.reference).toEqual({ kind: "expansion", scopeRecordId: BASE_SET_SCOPE_RECORD_ID });
  });

  it("blocks a partially mapped scope, pointing at the unmapped-scope inbox", async () => {
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const preview = await previewCatalogSyncProviderParticipation({
      // TCGplayer needs both a product-line/category id and a set name; keep
      // the product-line coordinate but remove the set name.
      scope: pokemonBaseSetScope({ requiredUnitKeys: [tcgplayerUnitKey] }),
      acceptedScopeMappings: [tcgplayerBaseSetMapping(tcgplayerUnitKey, { setName: null })],
      providerProfileVersions: [tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgplayer", vi.fn(fakePlanImport(205)))]),
    });

    expect(preview.status).toBe("blocked");
    expect(preview.startAllowed).toBe(false);
    expect(preview.units[0]).toMatchObject({
      eligibility: "ineligible",
      childExecutionScope: null,
      blockers: [
        expect.objectContaining({
          code: "provider-scope-mapping-missing",
          action: "Resolve this scope in the unmapped-scope inbox before selecting this provider unit.",
        }),
      ],
    });
    expect(preview.units[0]?.blockers[0]?.message).toContain("set-name");
  });

  it("blocks an unmapped scope with an actionable provider-scope-mapping-missing blocker", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({ requiredUnitKeys: [tcgdexUnitKey] }),
      acceptedScopeMappings: [],
      providerProfileVersions: [tcgdex],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgdex", vi.fn(fakePlanImport(102)))]),
    });

    expect(preview.status).toBe("blocked");
    expect(preview.startAllowed).toBe(false);
    expect(preview.blockers).toEqual([
      expect.objectContaining({
        code: "provider-scope-mapping-missing",
        action: "Resolve this scope in the unmapped-scope inbox before selecting this provider unit.",
      }),
    ]);
    expect(preview.units[0]).toMatchObject({ eligibility: "ineligible", childExecutionScope: null });
  });

  it("ignores accepted mappings that belong to a different scope record", async () => {
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({ requiredUnitKeys: [tcgplayerUnitKey] }),
      acceptedScopeMappings: [
        { ...tcgplayerBaseSetMapping(tcgplayerUnitKey), scopeRecordId: "scope_some_other_expansion" },
      ],
      providerProfileVersions: [tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgplayer", vi.fn(fakePlanImport(205)))]),
    });

    expect(preview.status).toBe("blocked");
    expect(preview.units[0]?.blockers[0]?.code).toBe("provider-scope-mapping-missing");
  });

  it("preserves provider set codes for LorcanaJSON set-name sync execution", async () => {
    const lorcanajson = activeProfile("lorcanajson", "lorcana-set-reference-data");
    const planImport = vi.fn(fakePlanImport(1));
    const scopeRecordId = "scope_lorcana_first_chapter";
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "lorcana",
        productForm: "set",
        languageCode: "en",
        reference: { kind: "set", scopeRecordId },
        providerParticipation: {
          selectedUnitKeys: [LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY],
        },
      },
      acceptedScopeMappings: [
        {
          scopeRecordId,
          providerKey: "lorcanajson",
          unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
          productLineId: null,
          seriesId: null,
          setId: "1",
          setName: "The First Chapter",
          mappingId: "mapping_lorcanajson_first_chapter",
          mappingVersion: "2026-07-01T00:00:00.000Z",
          reviewStatus: "accepted",
        },
      ],
      providerProfileVersions: [lorcanajson],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("lorcanajson", planImport)]),
    });

    expect(preview.status).toBe("ready");
    expect(preview.units[0]?.childExecutionScope).toMatchObject({
      provider: "lorcanajson",
      ingestionUnitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      language: "en",
      setId: "1",
      setName: "The First Chapter",
    });
    expect(planImport).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        scopeKey: "set-name",
        values: expect.objectContaining({
          setId: "1",
          setName: "The First Chapter",
        }),
      }),
    );
  });
});

function pokemonBaseSetScope(
  overrides: {
    requiredUnitKeys?: readonly string[];
    selectedUnitKeys?: readonly string[];
  } = {},
): CatalogSyncScope {
  return {
    scopeVersion: "catalog-sync-scope-v2",
    productDomain: "pokemon",
    productForm: "single-card",
    languageCode: "en",
    reference: { kind: "expansion", scopeRecordId: BASE_SET_SCOPE_RECORD_ID },
    providerParticipation: {
      requiredUnitKeys: overrides.requiredUnitKeys ?? [],
      selectedUnitKeys: overrides.selectedUnitKeys ?? [],
    },
  };
}

function acceptedMapping(
  overrides: Partial<CatalogSyncAcceptedScopeMapping> & { providerKey: string; unitKey: string },
): CatalogSyncAcceptedScopeMapping {
  return {
    scopeRecordId: BASE_SET_SCOPE_RECORD_ID,
    productLineId: null,
    seriesId: null,
    setId: null,
    setName: null,
    mappingId: `mapping_${overrides.providerKey}_${overrides.unitKey}`,
    mappingVersion: "2026-07-01T00:00:00.000Z",
    reviewStatus: "accepted",
    ...overrides,
  };
}

function tcgdexBaseSetMapping(unitKey: string): CatalogSyncAcceptedScopeMapping {
  return acceptedMapping({ providerKey: "tcgdex", unitKey, setId: "base1", seriesId: "base" });
}

function tcgplayerBaseSetMapping(
  unitKey: string,
  overrides: Partial<CatalogSyncAcceptedScopeMapping> = {},
): CatalogSyncAcceptedScopeMapping {
  return acceptedMapping({ providerKey: "tcgplayer", unitKey, productLineId: "3", setName: "Base Set", ...overrides });
}

function requireProfile(providerKey: string, profileKey: string): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find(
    (candidate) => candidate.providerKey === providerKey && candidate.profileKey === profileKey,
  );
  if (!version) {
    throw new Error(`Missing ${providerKey}/${profileKey} test profile.`);
  }
  return version;
}

function activeProfile(providerKey: string, profileKey: string): CatalogProviderIntegrationProfileVersionRecord {
  const version = requireProfile(providerKey, profileKey);
  return {
    ...version,
    lifecycle: "active",
    active: true,
    profile: {
      ...version.profile,
      status: "active",
    },
    executableMappingContract: version.executableMappingContract
      ? {
          ...version.executableMappingContract,
          lifecycle: "active",
        }
      : undefined,
  };
}

function fakeAdapter(providerKey: string, planImport: ProviderAdapter["planImport"]): ProviderAdapter {
  return {
    providerKey,
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    listIntegrationUnits: async () => [],
    listOptions: async () => ({ items: [] }),
    planImport,
    fetchPayloads: async function* () {
      return;
    },
    getCredentialReadiness: async () => [],
    getTransportDiagnostics: async () => [],
  };
}

function fakePlanImport(estimatedPayloads: number) {
  return async (scope: ProviderImportScope) => ({
    unitKey: scope.unitKey,
    planKey: `plan:${scope.unitKey}`,
    scope,
    estimatedPayloads,
    transportSteps: [`Plan ${scope.scopeKey}`],
    usageEstimate: {
      requestStrategy: "bulk-first" as const,
      estimateState: "estimated" as const,
      estimatedRequestCount: 1,
      estimateReason: "Scope preview estimate.",
      pageSize: 250,
      selectedFields: ["id", "name"],
      perRecordFallbackReason: null,
      usageCheckState: "not-supported" as const,
      creditDiagnostic: null,
      degradedDiagnostic: null,
    },
  });
}
