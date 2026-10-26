import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import type { ProviderAdapter, ProviderImportScope } from "../provider-adapters/provider-adapter";
import {
  aggregateCatalogSyncProviderParticipationEstimate,
  catalogSyncAcceptedScopeMappingFromRow,
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
import {
  classifyProviderScopeDiscoveryTarget,
  providerScopeMappingCoordinates,
} from "../../../provider-scope-discovery/api/scope-observation-matcher";
import { buildProviderScopeMappingCandidate } from "../../../provider-scope-mapping/domain/mapping";
import { createMtgjsonProviderAdapter, createMtgjsonValidationProviderAdapter } from "./mtgjson/adapter";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./scrydex/adapter";
import {
  createTcgplayerProviderAdapter,
  TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../provider-adapters/tcgplayer";
import { createTcgdexProviderAdapter } from "./tcgdex/adapter";

const BASE_SET_SCOPE_RECORD_ID = "scope_pokemon_base_set";

describe("MTGJSON accepted mapping planning parity", () => {
  it.each(["mtg-card-reference-data", "mtg-set-reference-data"])(
    "plans the discovered option value for %s without fetching",
    async (profileKey) => {
      const profile = requireProfile("mtgjson", profileKey);
      const unitKey = unitKeyForCatalogProviderProfileVersion(profile);
      const target = listProviderScopeDiscoveryTargets([profile], classifyProviderScopeDiscoveryTarget).find(
        (candidate) => candidate.providerScope === "set-name",
      )!;
      const {
        items: [option],
      } = await createMtgjsonValidationProviderAdapter().listOptions({
        unitKey,
        optionKind: target.queryKind,
      });
      expect(option).toMatchObject({ value: "TSP", label: "Time Spiral" });
      const coordinates = providerScopeMappingCoordinates(target, {
        providerKey: profile.providerKey,
        unitKey,
        scopeKind: target.scopeKind,
        sourceQueryKind: target.queryKind,
        languageCode: "en",
        externalId: option!.value,
        label: option!.label,
        parents: [],
        imageUrl: null,
        metadata: option!.metadata ?? {},
        scanId: "synthetic-mtgjson-scan",
        scannedAt: "2026-10-14T00:00:00.000Z",
        firstObservedAt: "2026-10-14T00:00:00.000Z",
        observationHash: "synthetic-mtgjson-observation",
        newlyObserved: true,
        changed: true,
      });
      expect(coordinates).toMatchObject({ setId: null, setName: "TSP" });
      const candidate = buildProviderScopeMappingCandidate({
        scopeRecordId: "scope_synthetic_magic_tsp",
        providerKey: profile.providerKey,
        unitKey,
        coordinates: coordinates!,
        confidence: "exact",
        reviewStatus: "accepted",
        provenance: { source: "provider-scope-observation" },
      });
      const mapping = catalogSyncAcceptedScopeMappingFromRow({
        mapping_id: candidate.mappingId,
        scope_record_id: candidate.scopeRecordId,
        provider_key: candidate.providerKey,
        unit_key: candidate.unitKey,
        product_line_id: candidate.coordinates.productLineId,
        series_id: candidate.coordinates.seriesId,
        set_id: candidate.coordinates.setId,
        set_name: candidate.coordinates.setName,
        language_coordinates: { languageCode: "en" },
        review_status: candidate.reviewStatus,
        updated_at: "2026-10-14T00:00:00.000Z",
      });
      expect(mapping.languageCode).toBe("en");
      const deniedFetch = vi.fn<typeof fetch>(async () => {
        throw new Error("Live fetch denied.");
      });
      const adapter = createMtgjsonProviderAdapter({ fetch: deniedFetch });
      const planImport = vi.spyOn(adapter, "planImport");
      const preview = await previewCatalogSyncProviderParticipation({
        scope: {
          scopeVersion: "catalog-sync-scope-v2",
          productDomain: "magic",
          reference: { kind: "set", scopeRecordId: candidate.scopeRecordId },
        },
        acceptedScopeMappings: [mapping],
        providerProfileVersions: [profile],
        providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
        includeOperationalGates: true,
      });
      expect(deniedFetch).not.toHaveBeenCalled();
      expect(preview).toMatchObject({ status: "ready", startAllowed: true, blockers: [] });
      expect(preview.units).toEqual([
        expect.objectContaining({ unitKey, eligibility: "eligible", selected: true, blockers: [] }),
      ]);
      expect(planImport).toHaveBeenCalledOnce();
      await expect(planImport.mock.results[0]!.value).resolves.toMatchObject({
        planKey: profileKey === "mtg-set-reference-data" ? "mtgjson:set:TSP" : "mtgjson:cards:set:TSP",
        scope: { scopeKey: "set", values: { setName: "TSP", setCode: "TSP" } },
      });
    },
  );
});

describe("Pokemon mapping language coordinates", () => {
  it("fails closed for a language-mismatched TCGdex mapping", async () => {
    const profile = requireProfile("tcgdex", "pokemon-tcg");
    const unitKey = unitKeyForCatalogProviderProfileVersion(profile);
    const adapter = createTcgdexProviderAdapter({ loadActiveProfileVersion: async () => profile });
    const planImport = vi.spyOn(adapter, "planImport");
    const preview = await previewCatalogSyncProviderParticipation({
      scope: { ...pokemonBaseSetScope(), languageCode: "ja" },
      acceptedScopeMappings: [tcgdexBaseSetMapping(unitKey, { languageCode: "en" })],
      providerProfileVersions: [profile],
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
    });
    expect(preview.status).toBe("blocked");
    expect(preview.units[0]).toMatchObject({
      eligibility: "ineligible",
      childExecutionScope: null,
      blockers: [expect.objectContaining({ code: "provider-scope-mapping-missing" })],
    });
    expect(planImport).not.toHaveBeenCalled();
  });

  it("uses a mapping language when the Pokemon scope language is blank", async () => {
    const profile = requireProfile("tcgdex", "pokemon-tcg");
    const unitKey = unitKeyForCatalogProviderProfileVersion(profile);
    const adapter = createTcgdexProviderAdapter({ loadActiveProfileVersion: async () => profile });
    const planImport = vi.spyOn(adapter, "planImport");
    const preview = await previewCatalogSyncProviderParticipation({
      scope: { ...pokemonBaseSetScope(), languageCode: null },
      acceptedScopeMappings: [tcgdexBaseSetMapping(unitKey, { languageCode: "ja" })],
      providerProfileVersions: [profile],
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
    });
    expect(preview.status).toBe("ready");
    expect(preview.units[0]?.childExecutionScope).toMatchObject({ language: "ja" });
    expect(planImport).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ language: "ja" }) }),
    );
  });
});

describe("server-unplannable provider units", () => {
  const magicScopeRecordId = "scope_synthetic_magic_tsp";
  const magicProfiles = catalogProviderIntegrationProfileVersions.filter((version) =>
    [
      "mtg-card-reference-data",
      "mtg-set-reference-data",
      "mtg-card-print-reference-data",
      "mtg-single-card-product-sku",
      "mtg-sealed-product-sku",
    ].includes(version.profileKey),
  );
  // Staging Magic shape: MTGJSON, Scryfall and an accepted TCGplayer single-card
  // mapping; the active TCGplayer sealed profile has no mapping.
  const magicMappings = magicProfiles
    .filter((version) => version.profileKey !== "mtg-sealed-product-sku")
    .map((version) =>
      acceptedMapping({
        scopeRecordId: magicScopeRecordId,
        providerKey: version.providerKey,
        unitKey: unitKeyForCatalogProviderProfileVersion(version),
        productLineId: version.providerKey === "tcgplayer" ? "1" : null,
        setName: version.providerKey === "mtgjson" ? "TSP" : version.providerKey === "scryfall" ? "tsp" : "Time Spiral",
      }),
    );
  const deniedFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("Live fetch denied.");
  });

  beforeEach(() => {
    deniedFetch.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Provider fetch denied in participation tests.")));
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    expect(deniedFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  function magicSetScope(providerParticipation?: CatalogSyncScope["providerParticipation"]): CatalogSyncScope {
    return {
      scopeVersion: "catalog-sync-scope-v2",
      productDomain: "magic",
      reference: { kind: "set", scopeRecordId: magicScopeRecordId },
      providerParticipation,
    };
  }

  function magicRegistry(...extra: ProviderAdapter[]): ProviderAdapterRegistry {
    return new ProviderAdapterRegistry([
      createMtgjsonProviderAdapter({ fetch: deniedFetch }),
      fakeAdapter("scryfall", fakePlanImport(1)),
      ...extra,
    ]);
  }

  it.each([
    { name: "default participation", providerParticipation: undefined },
    {
      name: "every Magic unit explicitly selected",
      providerParticipation: { selectedUnitKeys: magicProfiles.map(unitKeyForCatalogProviderProfileVersion) },
    },
  ])(
    "previews a Magic set without the real TCGplayer adapter's units under $name",
    async ({ providerParticipation }) => {
      expect(magicProfiles).toHaveLength(5);
      expect(magicProfiles.find((version) => version.profileKey === "mtg-sealed-product-sku")).toMatchObject({
        active: true,
        lifecycle: "active",
        profile: {
          status: "active",
          capabilities: expect.arrayContaining(["source-observation-import", "catalog-item-promotion"]),
        },
      });
      expect(magicMappings.map((mapping) => mapping.unitKey)).toContain(
        TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      );
      const tcgplayer = realTcgplayerAdapter();
      const preview = await previewCatalogSyncProviderParticipation({
        scope: magicSetScope(providerParticipation),
        acceptedScopeMappings: magicMappings,
        providerProfileVersions: magicProfiles,
        providerAdapterRegistry: magicRegistry(tcgplayer.adapter),
        includeOperationalGates: true,
      });

      expect(preview).toMatchObject({ status: "ready", startAllowed: true, blockers: [] });
      expect(preview.units.map((unit) => unit.providerKey).sort()).toEqual(["mtgjson", "mtgjson", "scryfall"]);
      expect(
        preview.units.every((unit) => unit.eligibility === "eligible" && unit.selected && unit.blockers.length === 0),
      ).toBe(true);
      expectNoAdapterCalls(tcgplayer.calls);
    },
  );

  it("refuses an explicitly required import-unplannable unit as required-provider-unit-missing", async () => {
    const tcgplayer = realTcgplayerAdapter();
    const preview = await previewCatalogSyncProviderParticipation({
      scope: magicSetScope({ requiredUnitKeys: [TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY] }),
      acceptedScopeMappings: magicMappings,
      providerProfileVersions: magicProfiles,
      providerAdapterRegistry: magicRegistry(tcgplayer.adapter),
      includeOperationalGates: true,
    });

    expect(preview).toMatchObject({ status: "blocked", startAllowed: false, units: [] });
    expect(preview.blockers).toEqual([
      expect.objectContaining({
        code: "required-provider-unit-missing",
        severity: "error",
        message: `${TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY} was required for this Catalog scope but no provider profile unit is available.`,
      }),
    ]);
    expectNoAdapterCalls(tcgplayer.calls);
  });

  it("keeps a profile unit with no registered adapter failing closed as provider-adapter-missing", async () => {
    const preview = await previewCatalogSyncProviderParticipation({
      scope: magicSetScope(),
      acceptedScopeMappings: magicMappings,
      providerProfileVersions: magicProfiles,
      providerAdapterRegistry: magicRegistry(),
      includeOperationalGates: true,
    });

    expect(preview).toMatchObject({ status: "blocked", startAllowed: false });
    expect(
      preview.units.find((unit) => unit.unitKey === TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY),
    ).toMatchObject({
      requirement: "required",
      eligibility: "ineligible",
      selected: true,
      blockers: expect.arrayContaining([expect.objectContaining({ code: "provider-adapter-missing" })]),
    });
    expect(preview.blockers).toContainEqual(expect.objectContaining({ code: "provider-adapter-missing" }));
  });

  it("keeps Scrydex credential-missing readiness blocking its required One Piece units", async () => {
    const scopeRecordId = "scope_synthetic_one_piece_op01";
    const scrydexUnitKeys = [
      SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    ];
    const tcgplayer = realTcgplayerAdapter();
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "one-piece",
        reference: { kind: "set", scopeRecordId },
        providerParticipation: {
          selectedUnitKeys: [...scrydexUnitKeys, TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY],
        },
      },
      acceptedScopeMappings: [
        ...scrydexUnitKeys.map((unitKey) =>
          acceptedMapping({ scopeRecordId, providerKey: "scrydex", unitKey, setName: "OP01" }),
        ),
        acceptedMapping({
          scopeRecordId,
          providerKey: "tcgplayer",
          unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          productLineId: "68",
          setName: "Romance Dawn",
        }),
      ],
      providerProfileVersions: catalogProviderIntegrationProfileVersions,
      providerAdapterRegistry: new ProviderAdapterRegistry([
        createScrydexOnePieceProviderAdapter({ credentials: {}, fetch: deniedFetch }),
        tcgplayer.adapter,
      ]),
      includeOperationalGates: true,
    });

    expect(preview).toMatchObject({ status: "blocked", startAllowed: false });
    expect(preview.units.map((unit) => unit.unitKey).sort()).toEqual(scrydexUnitKeys);
    for (const unit of preview.units) {
      expect(unit).toMatchObject({
        requirement: "required",
        eligibility: "ineligible",
        selected: true,
        childExecutionScope: null,
      });
      expect(unit.blockers).toContainEqual(expect.objectContaining({ code: "provider-credential-not-ready" }));
      expect(unit.planningEvidence?.credentials).toContainEqual(
        expect.objectContaining({ state: "missing", diagnosticCode: "credential-missing", importBlocking: true }),
      );
    }
    expect(preview.blockers).toContainEqual(expect.objectContaining({ code: "provider-credential-not-ready" }));
    expectNoAdapterCalls(tcgplayer.calls);
  });
});

describe("Catalog sync scope planner", () => {
  describe("inactive participation", () => {
    const inactive = requireProfile("scrydex", "lorcana-sealed-product-source-observation");
    const active = requireProfile("scrydex", "lorcana-card-print-source-observation");
    const inactiveUnitKey = unitKeyForCatalogProviderProfileVersion(inactive);
    const activeUnitKey = unitKeyForCatalogProviderProfileVersion(active);
    const scope: CatalogSyncScope = {
      scopeVersion: "catalog-sync-scope-v2",
      productDomain: "lorcana",
      languageCode: "en",
      reference: { kind: "set", scopeRecordId: "scope_lorcana_first_chapter" },
    };
    const mappings = catalogProviderIntegrationProfileVersions.map((version) =>
      acceptedMapping({
        scopeRecordId: scope.reference.scopeRecordId,
        providerKey: version.providerKey,
        unitKey: unitKeyForCatalogProviderProfileVersion(version),
        productLineId: "71",
        setId: "1",
        setName: "The First Chapter",
      }),
    );
    const registry = new ProviderAdapterRegistry(
      [...new Set(catalogProviderIntegrationProfileVersions.map((version) => version.providerKey))].map((providerKey) =>
        fakeAdapter(providerKey, fakePlanImport(1)),
      ),
    );

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Provider fetch denied in participation tests.")));
    });

    afterEach(() => {
      expect(fetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("inactive units are never default-required over the full Lorcana registry", async () => {
      const preview = await previewCatalogSyncProviderParticipation({
        scope,
        acceptedScopeMappings: mappings,
        providerProfileVersions: catalogProviderIntegrationProfileVersions,
        providerAdapterRegistry: registry,
      });

      expect(preview.units.find((unit) => unit.unitKey === inactiveUnitKey)).toMatchObject({
        role: "primary-source-observation",
        requirement: "optional",
        eligibility: "ineligible",
        defaultSelected: false,
        selected: false,
        childExecutionScope: null,
        blockers: [expect.objectContaining({ code: "inactive-profile-unit", severity: "error" })],
      });
      const activePrimaries = preview.units.filter(
        (unit) => unit.role === "primary-source-observation" && unit.unitKey !== inactiveUnitKey,
      );
      expect(activePrimaries.map((unit) => unit.unitKey)).toContain(activeUnitKey);
      expect(activePrimaries.every((unit) => unit.requirement === "required" && unit.eligibility === "eligible")).toBe(
        true,
      );
      expect(preview.blockers).toEqual([]);
      expect(preview).toMatchObject({ status: "degraded", startAllowed: true });
    });

    it.each([
      { name: "active flag", changes: { active: false } },
      { name: "version lifecycle", changes: { lifecycle: "test" as const } },
      { name: "profile status", changes: { profile: { ...active.profile, status: "planned" as const } } },
    ])("inactive units are never default-required with an inactive $name", async ({ changes }) => {
      const preview = await previewCatalogSyncProviderParticipation({
        scope,
        acceptedScopeMappings: mappings,
        providerProfileVersions: [{ ...active, ...changes }],
        providerAdapterRegistry: registry,
      });

      expect(preview.units[0]).toMatchObject({
        requirement: "optional",
        eligibility: "ineligible",
        selected: false,
        blockers: [expect.objectContaining({ code: "inactive-profile-unit", severity: "error" })],
      });
      expect(preview.blockers).toEqual([]);
      expect(preview).toMatchObject({ status: "degraded", startAllowed: true });
    });

    it.each([
      { name: "required", selection: { requiredUnitKeys: [inactiveUnitKey] } },
      { name: "selected without explicit required keys", selection: { selectedUnitKeys: [inactiveUnitKey] } },
    ])("explicit inactive participation still refuses when $name", async ({ selection }) => {
      const preview = await previewCatalogSyncProviderParticipation({
        scope: { ...scope, providerParticipation: selection },
        acceptedScopeMappings: mappings,
        providerProfileVersions: catalogProviderIntegrationProfileVersions,
        providerAdapterRegistry: registry,
      });

      expect(preview.units).toHaveLength(1);
      expect(preview.units[0]).toMatchObject({
        requirement: "required",
        eligibility: "ineligible",
        selected: true,
        childExecutionScope: null,
        blockers: [expect.objectContaining({ code: "inactive-profile-unit", severity: "error" })],
      });
      expect(preview.blockers).toEqual([expect.objectContaining({ code: "inactive-profile-unit", severity: "error" })]);
      expect(preview).toMatchObject({ status: "blocked", startAllowed: false });
    });

    it("explicit inactive participation still refuses without changing mixed-input optional precedence", async () => {
      const preview = await previewCatalogSyncProviderParticipation({
        scope: {
          ...scope,
          providerParticipation: { requiredUnitKeys: [activeUnitKey], selectedUnitKeys: [inactiveUnitKey] },
        },
        acceptedScopeMappings: mappings,
        providerProfileVersions: catalogProviderIntegrationProfileVersions,
        providerAdapterRegistry: registry,
      });

      expect(preview.units).toHaveLength(2);
      expect(preview.units.find((unit) => unit.unitKey === activeUnitKey)).toMatchObject({
        requirement: "required",
        eligibility: "eligible",
        selected: true,
      });
      expect(preview.units.find((unit) => unit.unitKey === inactiveUnitKey)).toMatchObject({
        requirement: "optional",
        eligibility: "ineligible",
        selected: true,
        blockers: [expect.objectContaining({ code: "inactive-profile-unit", severity: "error" })],
      });
      expect(preview.blockers).toEqual([]);
      expect(preview).toMatchObject({ status: "degraded", startAllowed: true });
    });

    it("explicit inactive participation still refuses to bypass an active primary's missing mapping", async () => {
      const preview = await previewCatalogSyncProviderParticipation({
        scope,
        acceptedScopeMappings: mappings.filter((mapping) => mapping.unitKey !== activeUnitKey),
        providerProfileVersions: catalogProviderIntegrationProfileVersions,
        providerAdapterRegistry: registry,
      });

      expect(preview.units.find((unit) => unit.unitKey === activeUnitKey)).toMatchObject({
        requirement: "required",
        eligibility: "ineligible",
        selected: true,
        blockers: [expect.objectContaining({ code: "provider-scope-mapping-missing", severity: "error" })],
      });
      expect(preview.blockers).toContainEqual(
        expect.objectContaining({ code: "provider-scope-mapping-missing", severity: "error" }),
      );
      expect(preview).toMatchObject({ status: "blocked", startAllowed: false });
    });
  });

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

  it("keeps each selected unit's estimate count or unavailable reason with its usage-check state", async () => {
    const tcgdex = requireProfile("tcgdex", "pokemon-tcg");
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgdexUnitKey = unitKeyForCatalogProviderProfileVersion(tcgdex);
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const unavailablePlan = async (scope: ProviderImportScope) => ({
      ...(await fakePlanImport(205)(scope)),
      usageEstimate: {
        requestStrategy: "bulk-first" as const,
        estimateState: "estimate-unavailable" as const,
        estimatedRequestCount: null,
        estimateReason: "Synthetic page count is available only after the first paged response.",
        pageSize: 100,
        selectedFields: ["id"],
        perRecordFallbackReason: null,
        usageCheckState: "unavailable" as const,
        creditDiagnostic: null,
        degradedDiagnostic: "Synthetic provider appears degraded with HTTP 503.",
      },
    });
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope(),
      acceptedScopeMappings: [tcgdexBaseSetMapping(tcgdexUnitKey), tcgplayerBaseSetMapping(tcgplayerUnitKey)],
      providerProfileVersions: [tcgdex, tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([
        fakeAdapter("tcgdex", fakePlanImport(102)),
        fakeAdapter("tcgplayer", unavailablePlan),
      ]),
    });

    expect(preview.units.map((unit) => [unit.unitKey, unit.estimate])).toEqual([
      [
        tcgdexUnitKey,
        expect.objectContaining({
          estimateState: "estimated",
          estimatedRequestCount: 1,
          usageCheckState: "not-supported",
          degradedDiagnostic: null,
        }),
      ],
      [
        tcgplayerUnitKey,
        expect.objectContaining({
          estimateState: "estimate-unavailable",
          estimatedRequestCount: null,
          estimateReason: "Synthetic page count is available only after the first paged response.",
          usageCheckState: "unavailable",
          degradedDiagnostic: "Synthetic provider appears degraded with HTTP 503.",
        }),
      ],
    ]);
    expect(preview.estimate).toMatchObject({
      totalEstimatedRequestCount: null,
      estimateState: "estimate-unavailable",
      estimateReason: "Synthetic page count is available only after the first paged response.",
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

  it("never enrols an explicitly selected, fully mapped unit whose real adapter cannot plan imports", async () => {
    const tcgplayer = activeProfile("tcgplayer", "pokemon-single-card-product-sku");
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const adapter = realTcgplayerAdapter();
    const preview = await previewCatalogSyncProviderParticipation({
      scope: pokemonBaseSetScope({ selectedUnitKeys: [tcgplayerUnitKey] }),
      acceptedScopeMappings: [tcgplayerBaseSetMapping(tcgplayerUnitKey, { setName: "Prismatic Evolutions" })],
      providerProfileVersions: [tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter.adapter]),
    });

    expect(preview.units).toEqual([]);
    expect(preview.blockers).toEqual([]);
    expectNoAdapterCalls(adapter.calls);
    // The scope reference carries no raw provider coordinates or names.
    expect(preview.scope.reference).toEqual({ kind: "expansion", scopeRecordId: BASE_SET_SCOPE_RECORD_ID });
  });

  it("plans canonical Magic through an active raw TCGplayer MTG unit and its accepted mapping", async () => {
    const tcgplayer = activeProfile("tcgplayer", "mtg-single-card-product-sku");
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const scopeRecordId = "scope_magic_synthetic_ready_control";
    const mapping = acceptedMapping({
      scopeRecordId,
      providerKey: "tcgplayer",
      unitKey: tcgplayerUnitKey,
      productLineId: "1",
      setName: "Synthetic Magic Ready Control",
      mappingId: "mapping_magic_tcgplayer_mtg_ready_control",
    });
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "magic",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId },
        providerParticipation: { requiredUnitKeys: [tcgplayerUnitKey] },
      },
      acceptedScopeMappings: [mapping],
      providerProfileVersions: [tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgplayer", vi.fn(fakePlanImport(1)))]),
    });

    expect(tcgplayerUnitKey).toBe("tcgplayer:mtg:single-card:source-observation-import");
    expect(preview.status).toBe("ready");
    expect(preview.startAllowed).toBe(true);
    expect(preview.scope.productDomain).toBe("magic");
    expect(preview.units[0]).toMatchObject({
      unitKey: tcgplayerUnitKey,
      eligibility: "eligible",
      blockers: [],
      childExecutionScope: {
        ingestionUnitKey: tcgplayerUnitKey,
        productLineId: "1",
        setName: "Synthetic Magic Ready Control",
      },
    });
    expect(preview.units[0]?.childExecutionScope?.planningFingerprint).toContain(mapping.mappingId);
  });

  it("fails closed when either the canonical scope domain or raw unit-key domain is unknown", async () => {
    const tcgplayer = activeProfile("tcgplayer", "mtg-single-card-product-sku");
    const tcgplayerUnitKey = unitKeyForCatalogProviderProfileVersion(tcgplayer);
    const scopeRecordId = "scope_magic_synthetic_unknown_domain_control";
    const canonicalUnknown = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "synthetic-unknown-domain",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId },
        providerParticipation: { requiredUnitKeys: [tcgplayerUnitKey] },
      },
      acceptedScopeMappings: [
        acceptedMapping({
          scopeRecordId,
          providerKey: "tcgplayer",
          unitKey: tcgplayerUnitKey,
          productLineId: "1",
          setName: "Synthetic Unknown Canonical Domain Control",
        }),
      ],
      providerProfileVersions: [tcgplayer],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgplayer", vi.fn(fakePlanImport(1)))]),
    });
    if (!tcgplayer.ingestionUnitIdentity) {
      throw new Error("The active TCGplayer MTG profile must declare its ingestion-unit identity.");
    }
    const unknownUnitKey = "tcgplayer:synthetic-unknown-domain:single-card:source-observation-import";
    const unknownUnitProfile: CatalogProviderIntegrationProfileVersionRecord = {
      ...tcgplayer,
      ingestionUnitIdentity: {
        ...tcgplayer.ingestionUnitIdentity,
        unitKey: unknownUnitKey,
      },
    };
    const rawUnknown = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "magic",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId },
        providerParticipation: { requiredUnitKeys: [unknownUnitKey] },
      },
      acceptedScopeMappings: [
        acceptedMapping({
          scopeRecordId,
          providerKey: "tcgplayer",
          unitKey: unknownUnitKey,
          productLineId: "1",
          setName: "Synthetic Unknown Raw Domain Control",
        }),
      ],
      providerProfileVersions: [unknownUnitProfile],
      providerAdapterRegistry: new ProviderAdapterRegistry([fakeAdapter("tcgplayer", vi.fn(fakePlanImport(1)))]),
    });

    expect(canonicalUnknown.status).toBe("blocked");
    expect(canonicalUnknown.units[0]?.blockers).toContainEqual(
      expect.objectContaining({ code: "scope-product-domain-mismatch" }),
    );
    expect(rawUnknown.status).toBe("blocked");
    expect(rawUnknown.units[0]?.unitKey).toBe(unknownUnitKey);
    expect(rawUnknown.units[0]?.blockers).toContainEqual(
      expect.objectContaining({ code: "scope-product-domain-mismatch" }),
    );
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

function tcgdexBaseSetMapping(
  unitKey: string,
  overrides: Partial<CatalogSyncAcceptedScopeMapping> = {},
): CatalogSyncAcceptedScopeMapping {
  return acceptedMapping({ providerKey: "tcgdex", unitKey, setId: "base1", seriesId: "base", ...overrides });
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

// The production TCGplayer adapter, which declares no server import planning,
// with every transport-facing method spied so planning can prove it never calls one.
function realTcgplayerAdapter() {
  const adapter = createTcgplayerProviderAdapter({
    loadProfileVersions: async () =>
      catalogProviderIntegrationProfileVersions.filter((version) => version.providerKey === "tcgplayer"),
  });
  const methods = [
    "planImport",
    "listOptions",
    "fetchPayloads",
    "getCredentialReadiness",
    "getTransportDiagnostics",
  ] as const;
  return { adapter, calls: methods.map((method) => [method, vi.spyOn(adapter, method)] as const) };
}

function expectNoAdapterCalls(calls: ReturnType<typeof realTcgplayerAdapter>["calls"]) {
  for (const [method, spy] of calls) {
    expect(spy, method).not.toHaveBeenCalled();
  }
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
