import { describe, expect, it } from "vitest";
import {
  ALIAS_RESOLVER_VERSION,
  resolveAndPersistCatalogItemAliases,
  resolveCatalogItemAliases,
  resolveReferenceRecordAliases,
} from "./resolved-aliases";

function publishableCatalogItemAliasRow(overrides: Record<string, unknown> = {}) {
  return {
    alias_hash: "hash-fr-1",
    catalog_item_id: "cat_1",
    target_field: "name",
    alias_text: "Dracaufeu",
    normalized_alias_text: "dracaufeu",
    alias_language_code: "fr",
    source_language_code: "en",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "accepted",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: {},
    last_actor: "usr_1",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: "2026-06-16T00:00:00.000Z",
    reviewed_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function resolverDb(options: {
  publishableRows?: Record<string, unknown>[];
  fanOut?: number;
  existingHashes?: Map<string, string>;
  persistedFacts?: Array<{ table: string; params: readonly unknown[] }>;
}) {
  const existingHashes = options.existingHashes ?? new Map<string, string>();
  const persistedFacts = options.persistedFacts ?? [];

  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes("COUNT(DISTINCT catalog_item_id)")) {
        return { rows: [{ count: String(options.fanOut ?? 1) }] as T[] };
      }
      if (sql.includes("FROM catalog_item_aliases") && sql.includes("review_status = ANY")) {
        return { rows: (options.publishableRows ?? []) as T[] };
      }
      if (sql.includes("FROM catalog_reference_record_aliases") && sql.includes("review_status = ANY")) {
        return { rows: (options.publishableRows ?? []) as T[] };
      }
      if (sql.includes("SELECT alias_language_code, resolved_alias_hash")) {
        const targetId = params?.[0] as string;
        const rows = [...existingHashes.entries()].map(([languageCode, hash]) => ({
          alias_language_code: languageCode,
          resolved_alias_hash: hash,
        }));
        return { rows: (targetId ? rows : []) as T[] };
      }
      if (sql.includes("INSERT INTO catalog_item_resolved_aliases")) {
        persistedFacts.push({ table: "catalog_item_resolved_aliases", params: params ?? [] });
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO catalog_reference_record_resolved_aliases")) {
        persistedFacts.push({ table: "catalog_reference_record_resolved_aliases", params: params ?? [] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("resolved alias facts", () => {
  it("folds publishable aliases into one fact per language with a deterministic hash", async () => {
    const db = resolverDb({
      publishableRows: [
        publishableCatalogItemAliasRow(),
        publishableCatalogItemAliasRow({
          alias_hash: "hash-ja-1",
          alias_text: "リザードン",
          normalized_alias_text: "リザードン",
          alias_language_code: "ja",
          alias_type: "provider-localized-name",
        }),
      ],
      fanOut: 1,
    });

    const resolved = await resolveCatalogItemAliases(db, "cat_1", "en");

    expect(resolved.map((fact) => fact.aliasLanguageCode).sort()).toEqual(["fr", "ja"]);
    const fr = resolved.find((fact) => fact.aliasLanguageCode === "fr");
    expect(fr?.aliases).toEqual([
      expect.objectContaining({ aliasHash: "hash-fr-1", aliasText: "Dracaufeu", broad: false }),
    ]);
    expect(fr?.resolverVersion).toBe(ALIAS_RESOLVER_VERSION);
    expect(fr?.resolvedAliasHash).toMatch(/^[0-9a-f]{64}$/);

    // The fact hash is stable across re-resolution of identical evidence.
    const again = await resolveCatalogItemAliases(db, "cat_1", "en");
    expect(again.find((fact) => fact.aliasLanguageCode === "fr")?.resolvedAliasHash).toBe(fr?.resolvedAliasHash);
  });

  it("marks an alias text broad when it fans out to multiple Catalog Items", async () => {
    const db = resolverDb({
      publishableRows: [
        publishableCatalogItemAliasRow({
          alias_hash: "hash-pikachu",
          alias_text: "Pikachu",
          normalized_alias_text: "pikachu",
          alias_language_code: "en",
          alias_type: "species-name",
        }),
      ],
      fanOut: 7,
    });

    const resolved = await resolveCatalogItemAliases(db, "cat_1", "en");
    expect(resolved[0]?.aliases[0]?.broad).toBe(true);
  });

  it("represents removal as an empty resolved fact when no publishable aliases remain", async () => {
    const db = resolverDb({ publishableRows: [] });

    const resolved = await resolveCatalogItemAliases(db, "cat_1", "en");

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.aliasLanguageCode).toBe("en");
    expect(resolved[0]?.aliases).toEqual([]);
    // Empty fact still carries a hash so it differs from a prior non-empty fact.
    expect(resolved[0]?.resolvedAliasHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports changed=true on first resolution and changed=false when the hash is unchanged", async () => {
    const first = resolverDb({ publishableRows: [publishableCatalogItemAliasRow()] });
    const firstResults = await resolveAndPersistCatalogItemAliases(first, "cat_1", "en", "2026-06-16T00:00:00.000Z");
    expect(firstResults[0]?.changed).toBe(true);
    const hash = firstResults[0]?.resolved.resolvedAliasHash as string;

    const second = resolverDb({
      publishableRows: [publishableCatalogItemAliasRow()],
      existingHashes: new Map([["fr", hash]]),
    });
    const secondResults = await resolveAndPersistCatalogItemAliases(second, "cat_1", "en", "2026-06-16T01:00:00.000Z");
    expect(secondResults[0]?.changed).toBe(false);
  });

  it("persists the resolved fact as JSON keyed by target and language", async () => {
    const persistedFacts: Array<{ table: string; params: readonly unknown[] }> = [];
    const db = resolverDb({ publishableRows: [publishableCatalogItemAliasRow()], persistedFacts });

    await resolveAndPersistCatalogItemAliases(db, "cat_1", "en", "2026-06-16T00:00:00.000Z");

    expect(persistedFacts).toHaveLength(1);
    expect(persistedFacts[0]?.table).toBe("catalog_item_resolved_aliases");
    expect(persistedFacts[0]?.params[0]).toBe("cat_1");
    expect(persistedFacts[0]?.params[1]).toBe("fr");
    expect(JSON.parse(persistedFacts[0]?.params[2] as string)).toEqual([
      expect.objectContaining({ aliasHash: "hash-fr-1" }),
    ]);
  });

  it("resolves reference-record set-equivalent aliases into a fact", async () => {
    const db = resolverDb({
      publishableRows: [
        publishableCatalogItemAliasRow({
          alias_hash: "hash-set-1",
          alias_text: "トリプレットビート",
          normalized_alias_text: "トリプレットビート",
          alias_language_code: "ja",
          alias_type: "set-equivalent",
        }),
      ],
    });

    const resolved = await resolveReferenceRecordAliases(db, "ref_1", "en");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.referenceRecordId).toBe("ref_1");
    expect(resolved[0]?.aliases[0]?.aliasType).toBe("set-equivalent");
  });
});
