import { readFileSync } from "node:fs";
import type { JsonValue } from "@chase-sets/primitives/json";
import { buildScopeCoverageMatrix } from "../../provider-scope-mapping/api/scope-coverage-admin-contracts";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { scopeRecordDetailFromRow } from "../../scope-registry/api/route";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import {
  createCatalogProviderOptionQueryCacheRecord,
  queryCatalogProviderIntegrationOptionsWithCache,
} from "../../source-observations/api/providers/provider-option-query-cache";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "../../source-observations/api/providers/provider-option-query-resolver";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../../source-observations/api/providers/registry";
import {
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSetReferenceProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scrydexOnePieceSetReferenceProviderProfile,
} from "../../source-observations/api/providers/scrydex/profiles";
import type { ScrydexCacheCaptureUnitKey } from "../domain/scrydex-cache-capture";

// Synthetic Scrydex cache capture inputs built only through shipped producers:
// mapping rows through the real coverage builder, Scope Records through the
// real Scope Record mapper, and option items through the executable option
// mapper and the cache-only query path with live loads denied. Every
// identifier prefixed "synthetic" is labeled test data, never a staging fact;
// the two provider expansion ids come from the checked-in Scrydex fixtures.

const unitProfiles = {
  "scrydex:one-piece:set:reference-data": scrydexOnePieceSetReferenceProviderProfile,
  "scrydex:one-piece:single-card:source-observation-import": scrydexOnePieceCardPrintProviderProfile,
  "scrydex:one-piece:sealed-product:source-observation-import": scrydexOnePieceSealedProductProviderProfile,
  "scrydex:lorcana:set:reference-data": scrydexLorcanaSetReferenceProviderProfile,
  "scrydex:lorcana:single-card:source-observation-import": scrydexLorcanaCardPrintProviderProfile,
} as const satisfies Record<ScrydexCacheCaptureUnitKey, unknown>;

export const syntheticCaptureStartedAt = "2026-10-20T16:00:00.000Z";
export const syntheticCacheFetchedAt = "2026-10-20T06:00:00.000Z";

export function fixtureExpansionId(
  fixture: "scrydex-one-piece-set-reference" | "scrydex-lorcana-set-reference",
): string {
  const text = readFileSync(
    new URL(`../../source-observations/api/__fixtures__/${fixture}/normal.json`, import.meta.url),
    "utf8",
  );
  return (JSON.parse(text) as { expansion: { id: string } }).expansion.id;
}

export function registryProfileKey(unitKey: ScrydexCacheCaptureUnitKey): string {
  const version = catalogProviderIntegrationProfileVersions.find(
    (candidate) =>
      candidate.providerKey === "scrydex" &&
      candidate.active &&
      catalogProviderProfileVersionIngestionUnitKey(candidate) === unitKey,
  );
  if (!version) throw new Error(`No active registry profile for ${unitKey}.`);
  return version.profileKey;
}

export function syntheticMappingRow(
  input: Readonly<{
    scopeRecordId: string;
    unitKey: string;
    mappingId: string;
    setName: string | null;
    setId?: string | null;
    providerKey?: string;
    reviewStatus?: ProviderScopeMappingRow["review_status"];
    updatedAt?: string;
  }>,
): ProviderScopeMappingRow {
  return {
    mapping_id: input.mappingId,
    scope_record_id: input.scopeRecordId,
    provider_key: input.providerKey ?? "scrydex",
    unit_key: input.unitKey,
    product_line_id: null,
    series_id: null,
    set_id: input.setId ?? null,
    set_name: input.setName,
    language_coordinates: { languageCode: "en" },
    confidence: "exact",
    review_status: input.reviewStatus ?? "accepted",
    provenance: { source: "synthetic-capture-fixture" },
    evidence: {},
    last_actor: null,
    last_reason: null,
    policy_version: "provider-scope-mapping-v1",
    proposed_at: "2026-10-01T00:00:00.000Z",
    reviewed_at: "2026-10-02T00:00:00.000Z",
    updated_at: input.updatedAt ?? "2026-10-03T00:00:00.000Z",
  };
}

// The exact JSON the coverage route serves: the real builder, serialized the
// way Hono's c.json serializes it.
export async function syntheticCoverageJson(
  input: Readonly<{ scopeRecordId: string; productDomain: string; rows: readonly ProviderScopeMappingRow[] }>,
): Promise<unknown> {
  const matrix = await buildScopeCoverageMatrix({
    generatedAt: syntheticCaptureStartedAt,
    scope: {
      scope_record_id: input.scopeRecordId,
      product_domain: input.productDomain as never,
      scope_kind: "set",
      name: `Synthetic ${input.scopeRecordId}`,
      official_set_code: null,
      release_date: null,
      lifecycle_status: "active",
    },
    mappingRows: input.rows,
    loadSyncStatus: async () => ({ totalObservations: 0, promotedObservations: 0 }),
  });
  return JSON.parse(JSON.stringify(matrix));
}

export function syntheticScopeRow(scopeRecordId: string, productDomain: string): CatalogScopeRecordRow {
  return {
    scope_record_id: scopeRecordId,
    product_domain: productDomain as never,
    scope_kind: "set",
    reference_type_key: "synthetic-set",
    reference_record_id: `${scopeRecordId}-reference`,
    reference_record_key: `${scopeRecordId}-key`,
    name_i18n: null,
    name: `Synthetic ${scopeRecordId}`,
    parent_scope_record_id: null,
    product_line_scope_record_id: null,
    series_scope_record_id: null,
    release_date: null,
    official_set_code: null,
    language_editions: ["en"],
    attributes: {},
    relationships: {},
    lifecycle_status: "active",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

// The exact JSON one Scope Record list page serves through the real mapper.
export function syntheticScopePageJson(
  input: Readonly<{ productDomain: string; scopeRecordIds: readonly string[]; total?: number }>,
): unknown {
  const items = input.scopeRecordIds.map((id) => scopeRecordDetailFromRow(syntheticScopeRow(id, input.productDomain)));
  return JSON.parse(JSON.stringify({ items, total: input.total ?? items.length, count: items.length }));
}

const deniedLive = async (): Promise<never> => {
  throw new Error("Live provider option loads are denied in Scrydex cache capture tests.");
};

// The cached option list for one unit: executable option mapper output for the
// given expansion ids, persisted as the shipped cache record at `cachedAt`.
export async function syntheticOptionCacheRecord(
  input: Readonly<{ unitKey: ScrydexCacheCaptureUnitKey; expansionIds: readonly string[]; cachedAt?: string }>,
) {
  const profile = unitProfiles[input.unitKey];
  const records: readonly JsonValue[] = input.expansionIds.map((expansionId) => ({
    expansionId,
    name: `Synthetic ${expansionId}`,
    code: expansionId.toUpperCase(),
    releaseDate: "2026-01-01",
    total: 1,
    language: "English",
    languageCode: "en",
  }));
  const items = await listCatalogProviderIntegrationOptionsFromProfiles({
    profiles: [profile],
    providerKey: "scrydex",
    queryKind: "sets",
    languageCode: "en",
    transports: {
      listScrydexOnePieceSets: async () => records,
      listScrydexLorcanaSets: async () => records,
    },
    defaultProviderKey: "scrydex",
  });
  return createCatalogProviderOptionQueryCacheRecord({
    request: optionRequest(input.unitKey, null, 25),
    items,
    now: new Date(input.cachedAt ?? syntheticCacheFetchedAt),
  });
}

function optionRequest(unitKey: ScrydexCacheCaptureUnitKey, cursor: string | null, limit: number) {
  return {
    providerKey: "scrydex",
    profileKey: registryProfileKey(unitKey),
    profileVersion: "synthetic-profile-version",
    ingestionUnitKey: unitKey,
    queryKind: "sets",
    languageCode: "en",
    parentValue: null,
    cursor,
    limit,
    cacheOnly: true,
    forceRefresh: false,
  };
}

// The exact JSON one cache-only option page serves at `now`, with every live
// load denied: fresh before expiresAt, stale before staleUntil, else thrown.
export async function syntheticOptionPageJson(
  input: Readonly<{
    record: Awaited<ReturnType<typeof syntheticOptionCacheRecord>>;
    unitKey: ScrydexCacheCaptureUnitKey;
    cursor: string | null;
    limit: number;
    now: string;
  }>,
): Promise<unknown> {
  const page = await queryCatalogProviderIntegrationOptionsWithCache({
    request: optionRequest(input.unitKey, input.cursor, input.limit),
    cacheStore: {
      read: async () => input.record,
      write: async () => {
        throw new Error("Cache writes are denied in Scrydex cache capture tests.");
      },
    },
    loadLive: deniedLive,
    now: new Date(input.now),
  });
  return JSON.parse(JSON.stringify(page));
}
