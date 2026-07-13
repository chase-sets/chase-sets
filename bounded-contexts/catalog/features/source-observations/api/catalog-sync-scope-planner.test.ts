import { describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import type { ProviderAdapter, ProviderImportScope } from "./provider-adapters/provider-adapter";
import {
  aggregateCatalogSyncProviderParticipationEstimate,
  previewCatalogSyncProviderParticipation,
  type CatalogSyncScope,
} from "./catalog-sync-scope-planner";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { unitKeyForCatalogProviderProfileVersion } from "./catalog-integration-impact-analysis";
import { LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY } from "./provider-adapters/lorcanajson";

describe("Catalog sync scope planner", () => {
  it("defaults every eligible mapped provider role into Pokemon Expansion participation", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const tcgdexPlanImport = vi.fn(fakePlanImport(102));
    const tcgplayerPlanImport = vi.fn(fakePlanImport(205));
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({
        requiredUnitKeys: [],
        selectedUnitKeys: [],
      }),
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
      scope: pokemonBaseSetScope({
        selectedUnitKeys: [tcgplayerUnitKey],
      }),
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
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope(),
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

  it("blocks sync when a required provider unit has no profile inventory", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({
        requiredUnitKeys: ["tcgplayer:pokemon:single-card:source-observation-import"],
      }),
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

  it("marks selected optional units ineligible without blocking the required unit", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({
        requiredUnitKeys: [tcgdexUnitKey],
        selectedUnitKeys: [tcgplayerUnitKey],
        providerHints: [],
      }),
      providerProfileVersions: [tcgdex, tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([
        fakeAdapter("tcgdex", vi.fn(fakePlanImport(102))),
        fakeAdapter("tcgplayer", vi.fn(fakePlanImport(205))),
      ]),
    });

    expect(preview.status).toBe("degraded");
    expect(preview.startAllowed).toBe(true);
    expect(preview.units.find((unit) => unit.unitKey === tcgplayerUnitKey)).toMatchObject({
      providerKey: "tcgplayer",
      requirement: "optional",
      eligibility: "ineligible",
      blockers: [expect.objectContaining({ code: "scope-parent-required" })],
    });
  });

  it("preserves provider set codes for LorcanaJSON set-name sync execution", async () => {
    const lorcanajson = activeProfile("lorcanajson", "lorcana-set-reference-data");
    const planImport = vi.fn(fakePlanImport(1));
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v1",
        productDomain: "lorcana",
        productForm: "set",
        languageCode: "en",
        reference: {
          kind: "set",
          id: "1",
          name: "The First Chapter",
        },
        providerHints: [
          {
            providerKey: "lorcanajson",
            unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
            setId: "1",
            setName: "The First Chapter",
          },
        ],
        providerParticipation: {
          selectedUnitKeys: [LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY],
        },
      },
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
  overrides: Partial<
    Pick<CatalogSyncScope, "providerHints"> & {
      requiredUnitKeys: readonly string[];
      selectedUnitKeys: readonly string[];
    }
  > = {},
): CatalogSyncScope {
  return {
    scopeVersion: "catalog-sync-scope-v1",
    productDomain: "pokemon",
    productForm: "single-card",
    languageCode: "en",
    reference: {
      kind: "expansion",
      id: "base1",
      name: "Base Set",
      seriesId: "base",
      seriesName: "Base",
    },
    providerHints: overrides.providerHints ?? [
      {
        providerKey: "tcgplayer",
        productLineId: "3",
        productLineName: "Pokemon",
        setName: "Base Set",
      },
    ],
    providerParticipation: {
      requiredUnitKeys: overrides.requiredUnitKeys ?? [],
      selectedUnitKeys: overrides.selectedUnitKeys ?? [],
    },
  };
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
