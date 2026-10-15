import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import type { ProviderAdapter } from "../../source-observations/api/provider-adapters/provider-adapter";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import { unitKeyForCatalogProviderProfileVersion } from "../../source-observations/api/governance/catalog-integration-impact-analysis";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import {
  createMtgjsonProviderAdapter,
  createMtgjsonValidationProviderAdapter,
  MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
} from "../../source-observations/api/providers/mtgjson/adapter";
import { createScopeSyncBatchPlanner } from "./planner";

const timestamp = "2026-10-14T00:00:00.000Z";
const selection = {
  mode: "matching-scope",
  query: { productDomain: "magic", scopeKind: "set", languageCode: null },
} as const;
const context = {
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
  it("retains the complete five-unit matching scope with zero Scrydex credits", async () => {
    const fixture = await magicFixture();
    const { preview, plans } = await fixture.resolve();
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      status: "ready",
      confirmAllowed: true,
      counts: { scopes: 1, readyScopes: 1, blockedScopes: 0, providerUnits: 5 },
      providerUnitTotals: { mtgjson: 2, scryfall: 1, tcgplayer: 2 },
      budget: { creditedProviderRequestLimits: { scrydex: 0 } },
      blockers: [],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
    expect(plans[0]!.participationPreview.units.every((unit) => unit.selected && unit.eligibility === "eligible")).toBe(
      true,
    );
    expect(plans[0]!.participationPreview.units.filter((unit) => unit.providerKey === "scrydex")).toEqual([]);
    expect(fixture.planImport).toHaveBeenCalledTimes(2);
    const mtgjsonPlans = await Promise.all(fixture.planImport.mock.results.map((result) => result.value));
    expect(mtgjsonPlans.map((plan) => plan.planKey).sort()).toEqual(["mtgjson:cards:set:TSP", "mtgjson:set:TSP"]);
  });

  it("blocks the entire selection when an accepted mapping loses its required coordinate", async () => {
    const fixture = await magicFixture();
    fixture.mappings = fixture.mappings.map((mapping) =>
      mapping.unit_key === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY ? { ...mapping, set_name: null } : mapping,
    );
    const { preview, plans } = await fixture.resolve();
    expect(preview).toMatchObject({
      confirmAllowed: false,
      counts: { scopes: 1, readyScopes: 0, blockedScopes: 1, providerUnits: 5 },
    });
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "scope-planning-blocked", providerKey: "mtgjson" }),
    );
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
  });

  it("retains a second blocked active Magic scope rather than confirming a ready subset", async () => {
    const fixture = await magicFixture();
    fixture.records.push(scopeRecord("scope_synthetic_magic_unmapped"));
    const { preview, plans } = await fixture.resolve();
    expect(preview).toMatchObject({ confirmAllowed: false, counts: { scopes: 2, readyScopes: 1, blockedScopes: 1 } });
    expect(plans.map((plan) => plan.scopeRecordId)).toEqual(fixture.records.map((record) => record.scope_record_id));
    expect(plans[1]!.participationPreview.units).toHaveLength(5);
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
      (mapping) => mapping.unit_key === "tcgplayer:mtg:sealed-product:source-observation-import",
    )!;
    expect(requiredMapping).toBeDefined();
    expect(baseline.plans[0]!.participationPreview.units).toContainEqual(
      expect.objectContaining({ unitKey: requiredMapping.unit_key, selected: true, requirement: "required" }),
    );
    fixture.mappings = fixture.mappings.filter((mapping) => mapping !== requiredMapping);
    const { preview, plans } = await fixture.resolve();
    expect(fixture.deniedFetch).not.toHaveBeenCalled();
    expect.soft(preview).toMatchObject({ confirmAllowed: false, counts: { scopes: 1, providerUnits: 5 } });
    expect(plans[0]!.participationPreview.units.map((unit) => unit.unitKey).sort()).toEqual(fixture.unitKeys);
  });
});

async function magicFixture() {
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
  const fixture = {
    deniedFetch,
    planImport,
    unitKeys: profiles.map(unitKeyForCatalogProviderProfileVersion).sort(),
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
    previewCatalogSyncScope: (input) =>
      previewCatalogSyncProviderParticipation({
        ...input,
        acceptedScopeMappings: input.acceptedScopeMappings ?? [],
        providerProfileVersions: profiles,
        providerAdapterRegistry: new ProviderAdapterRegistry([
          adapter,
          offlineAdapter("scryfall"),
          offlineAdapter("tcgplayer"),
        ]),
      }),
  });
  return fixture;
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
