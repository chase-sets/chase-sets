import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import type { ProviderAdapter } from "../../source-observations/api/provider-adapters/provider-adapter";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../../source-observations/api/provider-integration-profiles";
import { unitKeyForCatalogProviderProfileVersion } from "../../source-observations/api/governance/catalog-integration-impact-analysis";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import {
  createMtgjsonProviderAdapter,
  createMtgjsonValidationProviderAdapter,
  MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
} from "../../source-observations/api/providers/mtgjson/adapter";
import { createTcgplayerProviderAdapter } from "../../source-observations/api/provider-adapters/tcgplayer";
import { createTcgdexProviderAdapter } from "../../source-observations/api/providers/tcgdex/adapter";
import { createScopeSyncBatchPlanner } from "./planner";

const timestamp = "2026-10-14T00:00:00.000Z";
const selection = {
  mode: "matching-scope",
  query: { productDomain: "magic", scopeKind: "set", languageCode: null },
} as const;
const context: EventStoreContext = {
  tenantId: "tnt_synthetic_9645",
  audit: { performedByUserId: "usr_synthetic_9645", forAccountId: "acc_synthetic_9645" },
};
const profileKeys = [
  "mtg-card-reference-data",
  "mtg-set-reference-data",
  "mtg-card-print-reference-data",
  "mtg-single-card-product-sku",
  "mtg-sealed-product-sku",
];
const profiles = catalogProviderIntegrationProfileVersions.filter((profile) =>
  profileKeys.includes(profile.profileKey),
);

describe("whole Magic mapping preview", () => {
  it("plans the mapped Magic scope from MTGJSON and Scryfall alone, with zero Scrydex credits", async () => {
    const fixture = await magicFixture();
    const { preview, plans } = await fixture.resolve();
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      status: "ready",
      confirmAllowed: true,
      counts: { scopes: 1, readyScopes: 1, blockedScopes: 0, providerUnits: 3 },
      budget: { creditedProviderRequestLimits: { scrydex: 0 } },
      blockers: [],
    });
    expect(preview.providerUnitTotals).toEqual({ mtgjson: 2, scryfall: 1 });
    expect(plans).toHaveLength(1);
    expect(preview.planFingerprint).toMatchInlineSnapshot(
      `"87dbc83a2bcd872ff3981b8aaca10eca0738c7a7e196b0cbc764140842614052"`,
    );
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
    expect(plans[0]!.participationPreview.units.every((unit) => unit.selected && unit.eligibility === "eligible")).toBe(
      true,
    );
    expect(plans[0]!.participationPreview.units.filter((unit) => unit.providerKey === "scrydex")).toEqual([]);
    expect(fixture.planImport).toHaveBeenCalledTimes(2);
    const mtgjsonPlans = await Promise.all(fixture.planImport.mock.results.map((result) => result.value));
    expect(mtgjsonPlans.map((plan) => plan.planKey).sort()).toEqual(["mtgjson:cards:set:TSP", "mtgjson:set:TSP"]);
    expectNoAdapterCalls(fixture.tcgplayerCalls);
  });

  it("keeps the three plannable mapped units with every active Magic profile, without planning the requirement pass", async () => {
    const activeMagicProfiles = catalogProviderIntegrationProfileVersions.filter(
      (profile) =>
        profile.active &&
        profile.lifecycle === "active" &&
        profile.profile.status === "active" &&
        unitKeyForCatalogProviderProfileVersion(profile).split(":")[1] === "mtg",
    );
    expect(activeMagicProfiles.map((profile) => profile.profileKey)).toContain("mtg-card-image-evidence");
    const fixture = await magicFixture(activeMagicProfiles);
    const { preview, plans } = await fixture.resolve();
    expect(preview).toMatchObject({
      confirmAllowed: true,
      counts: { scopes: 1, readyScopes: 1, blockedScopes: 0, providerUnits: 3 },
      budget: { creditedProviderRequestLimits: { scrydex: 0 } },
      blockers: [],
    });
    expect(preview.providerUnitTotals).toEqual({ mtgjson: 2, scryfall: 1 });
    expect(plans[0]!.scope.providerParticipation?.selectedUnitKeys).toEqual(
      fixture.mappings.map((mapping) => mapping.unit_key),
    );
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
    expect(fixture.previewCatalogSyncScope).toHaveBeenCalledTimes(2);
    const baseline = await (await magicFixture()).resolve();
    expect(preview.planFingerprint).toBe(baseline.preview.planFingerprint);
    const requirementInput = fixture.previewCatalogSyncScope.mock.calls[0]![0];
    expect(requirementInput).toMatchObject({ acceptedScopeMappings: [], includeOperationalGates: false });
    expect(requirementInput.scope.providerParticipation).toBeUndefined();
    expect(fixture.planImport).toHaveBeenCalledTimes(2);
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
    expectNoAdapterCalls(fixture.tcgplayerCalls);
  });

  it("blocks the entire selection when an accepted mapping loses its required coordinate", async () => {
    const fixture = await magicFixture();
    fixture.mappings = fixture.mappings.map((mapping) =>
      mapping.unit_key === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY ? { ...mapping, set_name: null } : mapping,
    );
    const { preview, plans } = await fixture.resolve();
    expect(preview).toMatchObject({
      confirmAllowed: false,
      counts: { scopes: 1, readyScopes: 0, blockedScopes: 1, providerUnits: 3 },
    });
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "scope-planning-blocked", providerKey: "mtgjson" }),
    );
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
  });

  it("retains a second blocked active Magic scope rather than confirming a ready subset", async () => {
    const fixture = await magicFixture();
    fixture.records.push({
      ...scopeRecord("scope_synthetic_magic_unmapped"),
      reference_record_id: "ref_synthetic_magic_unmapped",
      reference_record_key: "synthetic_unmapped",
      name: "Synthetic unmapped Magic set",
      official_set_code: null,
    });
    const { preview, plans } = await fixture.resolve();
    expect(preview).toMatchObject({ confirmAllowed: false, counts: { scopes: 2, readyScopes: 1, blockedScopes: 1 } });
    expect(plans.map((plan) => plan.scopeRecordId)).toEqual(fixture.records.map((record) => record.scope_record_id));
    expect(plans[1]!.participationPreview.units).toHaveLength(3);
    expect(plans[1]!.scope.providerParticipation?.selectedUnitKeys).toEqual([]);
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "mapping-missing", scopeRecordId: fixture.records[1]!.scope_record_id }),
    );
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
  });

  it("refuses confirmation after removing an accepted mapping instead of dropping its unit", async () => {
    const fixture = await magicFixture();
    const baseline = await fixture.resolve();
    expect(baseline.preview.confirmAllowed).toBe(true);
    const requiredMapping = fixture.mappings.find(
      (mapping) => mapping.unit_key === "scryfall:mtg:single-card:reference-data",
    )!;
    expect(requiredMapping).toBeDefined();
    expect(baseline.plans[0]!.participationPreview.units).toContainEqual(
      expect.objectContaining({ unitKey: requiredMapping.unit_key, selected: true, requirement: "required" }),
    );
    fixture.mappings = fixture.mappings.filter((mapping) => mapping !== requiredMapping);
    const { preview, plans } = await fixture.resolve();
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      confirmAllowed: false,
      counts: { scopes: 1, readyScopes: 0, blockedScopes: 1, providerUnits: 3 },
    });
    expect(plans[0]!.participationPreview.units).toContainEqual(
      expect.objectContaining({ unitKey: requiredMapping.unit_key, selected: true, requirement: "required" }),
    );
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "scope-planning-blocked", providerKey: "scryfall" }),
    );
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
  });
});

describe("Pokemon English preview regression", () => {
  it("keeps the selected ids, units, and fingerprint stable for English records", async () => {
    const record = scopeRecord("scope_synthetic_pokemon_en");
    const pokemonRecord = {
      ...record,
      product_domain: "pokemon" as const,
      scope_kind: "expansion" as const,
      reference_type_key: "expansion",
      language_editions: ["en"],
    };
    const pokemonProfile = catalogProviderIntegrationProfileVersions.find(
      (profile) => profile.providerKey === "tcgdex" && profile.profileKey === "pokemon-tcg",
    );
    expect(pokemonProfile).toBeDefined();
    const pokemonUnitKey = unitKeyForCatalogProviderProfileVersion(pokemonProfile!);
    const pokemonMapping: ProviderScopeMappingRow = {
      mapping_id: `mapping_tcgdex_${pokemonUnitKey}`,
      scope_record_id: pokemonRecord.scope_record_id,
      provider_key: "tcgdex",
      unit_key: pokemonUnitKey,
      product_line_id: null,
      series_id: "base",
      set_id: "base1",
      set_name: null,
      language_coordinates: { languageCode: "en" },
      confidence: "exact",
      review_status: "accepted",
      provenance: {},
      evidence: {},
      last_actor: null,
      last_reason: null,
      policy_version: "synthetic",
      proposed_at: timestamp,
      reviewed_at: timestamp,
      updated_at: timestamp,
    };
    const db: PgQueryable = {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        if (sql.includes("FROM catalog_scope_records")) {
          expect(values).toEqual(["pokemon", "expansion", "en"]);
          expect(sql).toContain("language_editions ? $3");
          return { rows: [pokemonRecord] as Row[] };
        }
        expect(sql).toContain("FROM catalog_provider_scope_mappings");
        return { rows: [pokemonMapping] as Row[] };
      },
    };
    const pokemonAdapter = createTcgdexProviderAdapter({ loadActiveProfileVersion: async () => pokemonProfile! });
    const planner = createScopeSyncBatchPlanner({
      db,
      now: () => timestamp,
      previewCatalogSyncScope: (input) =>
        previewCatalogSyncProviderParticipation({
          ...input,
          acceptedScopeMappings: input.acceptedScopeMappings ?? [],
          providerProfileVersions: [pokemonProfile!],
          providerAdapterRegistry: new ProviderAdapterRegistry([pokemonAdapter]),
        }),
    });
    const { preview, plans } = await planner.resolve({
      selection: {
        mode: "matching-scope",
        query: { productDomain: "pokemon", scopeKind: "expansion", languageCode: "en" },
      },
      context,
    });
    expect(plans.map((plan) => plan.scopeRecordId)).toEqual(["scope_synthetic_pokemon_en"]);
    expect(preview.counts).toMatchObject({ scopes: 1, providerUnits: 1 });
    expect(plans[0]!.participationPreview.units).toEqual([
      expect.objectContaining({
        unitKey: pokemonUnitKey,
        eligibility: "eligible",
        selected: true,
        childExecutionScope: expect.objectContaining({ language: "en", setId: "base1" }),
      }),
    ]);
    expect(preview.planFingerprint).toBe("2e68c249dcc7ae746014eb006ef329615d20f20df84bfe61660390d7390b3c33");
  });
});

describe("held-set batch required participation", () => {
  it("retains every non-TCGplayer required unit and blocks the zero-unit Yu-Gi-Oh scope", async () => {
    const domains = [
      ["magic", "mtg", "set"],
      ["pokemon", "pokemon", "expansion"],
      ["yugioh", "yugioh", "set"],
      ["one-piece", "one-piece", "set"],
    ] as const;
    const records = domains.map(([productDomain, , kind]) => ({
      ...scopeRecord(`scope_synthetic_held_${productDomain}`),
      product_domain: productDomain,
      scope_kind: kind,
      reference_record_id: `ref_synthetic_held_${productDomain}`,
      reference_record_key: `synthetic_held_${productDomain}`,
      name: `Synthetic ${productDomain} held set`,
      official_set_code: null,
    }));
    const fixture = await magicFixture();
    const tcgplayerMapping = fixture.mappings.find(
      (mapping) => mapping.unit_key === "tcgplayer:mtg:single-card:source-observation-import",
    )!;
    const mappings = domains.map(([domain, unitDomain]) => ({
      ...tcgplayerMapping,
      mapping_id: `mapping_synthetic_held_${domain}`,
      scope_record_id: `scope_synthetic_held_${domain}`,
      unit_key: `tcgplayer:${unitDomain}:single-card:source-observation-import`,
    }));
    const db: PgQueryable = {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const scopeRecordIds = values?.[0] as readonly string[];
        const rows: readonly { scope_record_id: string }[] = sql.includes("FROM catalog_scope_records")
          ? records
          : mappings;
        return { rows: rows.filter((row) => scopeRecordIds.includes(row.scope_record_id)) as Row[] };
      },
    };
    const tcgplayer = realTcgplayerAdapter();
    const planner = createScopeSyncBatchPlanner({
      db,
      now: () => timestamp,
      previewCatalogSyncScope: (input) =>
        previewCatalogSyncProviderParticipation({
          ...input,
          acceptedScopeMappings: input.acceptedScopeMappings ?? [],
          providerProfileVersions: catalogProviderIntegrationProfileVersions,
          providerAdapterRegistry: new ProviderAdapterRegistry([tcgplayer.adapter]),
        }),
    });
    const { preview, plans } = await planner.resolve({
      selection: { mode: "ids", scopeRecordIds: records.map((record) => record.scope_record_id) },
      context,
    });
    expect(plans.map((plan) => plan.participationPreview.units.map((unit) => unit.unitKey).sort())).toEqual([
      ["scryfall:mtg:single-card:reference-data"],
      ["tcgdex:pokemon:single-card:source-observation-import"],
      [],
      [
        "scrydex:one-piece:sealed-product:source-observation-import",
        "scrydex:one-piece:single-card:source-observation-import",
      ],
    ]);
    expect(
      plans.every((plan) =>
        plan.participationPreview.units.every((unit) => unit.requirement === "required" && unit.selected),
      ),
    ).toBe(true);
    expect(plans[2]!.blockers).toEqual([
      {
        code: "scope-planning-blocked",
        scopeRecordId: "scope_synthetic_held_yugioh",
        providerKey: null,
        message: "Catalog Scope Record has no selected provider units.",
      },
    ]);
    expect(preview).toMatchObject({
      confirmAllowed: false,
      counts: { scopes: 4, readyScopes: 0, blockedScopes: 4, providerUnits: 4 },
    });
    expect(preview.providerUnitTotals).toEqual({ scrydex: 2, scryfall: 1, tcgdex: 1 });

    const yugiohOnly = await planner.resolve({
      selection: { mode: "ids", scopeRecordIds: ["scope_synthetic_held_yugioh"] },
      context,
    });
    expect(yugiohOnly.preview).toMatchObject({
      status: "blocked",
      confirmAllowed: false,
      counts: { scopes: 1, readyScopes: 0, blockedScopes: 1, providerUnits: 0 },
    });
    expectNoAdapterCalls(tcgplayer.calls);
  });
});

async function magicFixture(providerProfiles: readonly CatalogProviderIntegrationProfileVersionRecord[] = profiles) {
  expect(profiles).toHaveLength(5);
  const {
    items: [option],
  } = await createMtgjsonValidationProviderAdapter().listOptions({
    unitKey: MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  expect(option).toMatchObject({ value: "TSP", label: "Time Spiral" });
  const deniedFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("Live fetch denied.");
  });
  const adapter = createMtgjsonProviderAdapter({ fetch: deniedFetch });
  const planImport = vi.spyOn(adapter, "planImport");
  const scryfall = offlineAdapter("scryfall");
  const tcgplayer = realTcgplayerAdapter();
  const planningCalls = [planImport, vi.spyOn(scryfall, "planImport")];
  const fixture = {
    deniedFetch,
    planImport,
    tcgplayerCalls: tcgplayer.calls,
    previewCatalogSyncScope: vi.fn<Parameters<typeof createScopeSyncBatchPlanner>[0]["previewCatalogSyncScope"]>(
      async (input) => {
        const callsBefore = planningCalls.map((call) => call.mock.calls.length);
        const result = await previewCatalogSyncProviderParticipation({
          ...input,
          acceptedScopeMappings: input.acceptedScopeMappings ?? [],
          providerProfileVersions: providerProfiles,
          providerAdapterRegistry: new ProviderAdapterRegistry([adapter, scryfall, tcgplayer.adapter]),
        });
        if (input.acceptedScopeMappings?.length === 0) {
          expect(planningCalls.map((call) => call.mock.calls.length)).toEqual(callsBefore);
          expect(result.units.every((unit) => unit.childExecutionScope === null)).toBe(true);
        }
        return result;
      },
    ),
    // The TCGplayer profiles stay mapped, but the real adapter cannot plan them.
    unitKeys: profiles
      .filter((profile) => profile.providerKey !== "tcgplayer")
      .map(unitKeyForCatalogProviderProfileVersion)
      .sort(),
    records: [scopeRecord("scope_synthetic_magic_tsp")],
    mappings: profiles.map(
      (profile): ProviderScopeMappingRow => ({
        mapping_id: `synthetic-${profile.profileKey}`,
        scope_record_id: "scope_synthetic_magic_tsp",
        provider_key: profile.providerKey,
        unit_key: unitKeyForCatalogProviderProfileVersion(profile),
        product_line_id: profile.providerKey === "tcgplayer" ? "1" : null,
        series_id: null,
        set_id: null,
        set_name:
          profile.providerKey === "mtgjson"
            ? option!.value
            : profile.providerKey === "scryfall"
              ? option!.value.toLowerCase()
              : option!.label,
        language_coordinates: {},
        confidence: "exact",
        review_status: "accepted",
        provenance: {},
        evidence: {},
        last_actor: null,
        last_reason: null,
        policy_version: "synthetic",
        proposed_at: timestamp,
        reviewed_at: timestamp,
        updated_at: timestamp,
      }),
    ),
    resolve: () => planner.resolve({ selection, budget: { creditedProviderRequestLimits: { scrydex: 0 } }, context }),
  };
  const db: PgQueryable = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("FROM catalog_scope_records")) {
        expect(sql).toContain("lifecycle_status = 'active'");
        expect(sql).toContain("LIMIT 5001");
        expect(sql).not.toContain("scope_record_id = ANY");
        expect(values).toEqual(["magic", "set"]);
        return { rows: fixture.records as Row[] };
      }
      expect(sql).toContain("FROM catalog_provider_scope_mappings");
      expect(sql).toContain("review_status IN ('accepted', 'auto-accepted')");
      expect(values).toEqual([fixture.records.map((record) => record.scope_record_id)]);
      return { rows: fixture.mappings as Row[] };
    },
  };
  const planner = createScopeSyncBatchPlanner({
    db,
    now: () => timestamp,
    previewCatalogSyncScope: fixture.previewCatalogSyncScope,
  });
  return fixture;
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

function offlineAdapter(providerKey: string): ProviderAdapter {
  return {
    providerKey,
    capabilities: { supportsOptionQueries: true, supportsImportPlanning: true, supportsPayloadFetch: true },
    listIntegrationUnits: async () => [],
    listOptions: async () => ({ items: [] }),
    planImport: async (scope) => ({
      unitKey: scope.unitKey,
      planKey: `synthetic:${scope.unitKey}`,
      scope,
      estimatedPayloads: 1,
      transportSteps: [],
    }),
    fetchPayloads: async function* () {
      throw new Error("Payload fetch denied.");
    },
    getCredentialReadiness: async () => [],
    getTransportDiagnostics: async () => [],
  };
}

function scopeRecord(id: string): CatalogScopeRecordRow {
  return {
    scope_record_id: id,
    product_domain: "magic",
    scope_kind: "set",
    reference_type_key: "magic-set",
    reference_record_id: "ref_synthetic_tsp",
    reference_record_key: "TSP",
    name_i18n: {},
    name: "Time Spiral",
    parent_scope_record_id: null,
    product_line_scope_record_id: null,
    series_scope_record_id: null,
    release_date: "2006-10-06",
    official_set_code: "TSP",
    language_editions: [],
    attributes: {},
    relationships: {},
    lifecycle_status: "active",
    updated_at: timestamp,
  };
}
