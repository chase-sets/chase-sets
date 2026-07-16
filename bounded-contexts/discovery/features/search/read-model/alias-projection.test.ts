import { afterEach, describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { DISCOVERY_ALIAS_SEARCH_ENV_VAR } from "../domain/alias-rollout";
import type { ResolvedAlias } from "../domain/alias-weighting";
import { buildDiscoverySearchItemProjectionHandlers } from "./projection";

// In-memory PgQueryable that models just enough of the search source/derived
// tables to exercise the alias handler: it stores the resolved_aliases jsonb and
// captures the english/simple search-text params written to discovery_search_items.
class AliasProjectionDb implements PgQueryable {
  public row: Record<string, unknown>;
  public lastEnglishWeights: string[] = [];
  public lastSimpleWeights: string[] = [];
  public lastEmbeddedTextHash: string | null = null;
  public lastDerivedWriteSql = "";
  public derivedWrites = 0;

  constructor(initial: Record<string, unknown> = {}) {
    this.row = catalogItemRow(initial);
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("UPDATE discovery_search_catalog_items") && sql.includes("resolved_aliases = COALESCE")) {
      const current = (this.row.resolved_aliases as Record<string, unknown>) ?? {};
      if (sql.includes("- $2")) {
        const next = { ...current };
        delete next[String(values[1])];
        this.row.resolved_aliases = next;
      } else {
        this.row.resolved_aliases = { ...current, [String(values[1])]: JSON.parse(String(values[2])) };
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SELECT * FROM discovery_search_catalog_items")) {
      return { rows: [this.row] as Row[], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO discovery_search_items")) {
      // VALUES placeholders: the ordered badge list precedes the search-text
      // inputs, so English and simple weights follow the natural-key fields.
      this.lastEnglishWeights = values.slice(25, 29).map(String);
      this.lastSimpleWeights = values.slice(29, 33).map(String);
      this.lastEmbeddedTextHash = String(values[33]);
      this.lastDerivedWriteSql = sql;
      this.derivedWrites += 1;
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("discovery_search_catalog_categories") ||
      sql.includes("discovery_search_catalog_fields") ||
      sql.includes("discovery_search_catalog_blueprints") ||
      sql.includes("discovery_search_product_contents") ||
      sql.includes("DELETE FROM discovery_search_items") ||
      sql.includes("UPDATE discovery_search_catalog_items")
    ) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function catalogItemRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    catalog_item_id: "cat_1",
    slug: "charizard-cat-1",
    language_code: "en",
    title_i18n: { defaultLocale: "en", values: { en: "Charizard" } },
    title: "Charizard",
    subtitle_i18n: null,
    subtitle: "Base Set",
    display_badges: [],
    description_i18n: { defaultLocale: "en", values: { en: "Fire type" } },
    description: "Fire type",
    blueprint_id: null,
    status: "active",
    field_values: [],
    category_ids: [],
    tags: [],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    resolved_aliases: {},
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function aliasesResolvedEvent(aliases: readonly ResolvedAlias[], aliasLanguageCode = "fr"): TransportEvent {
  return buildTransportEvent(
    "catalog.catalog-item.aliases-resolved",
    {
      catalogItemId: "cat_1",
      aliasLanguageCode,
      aliases,
      resolvedAliasHash: "resolved-1",
      resolverVersion: 1,
      resolvedAt: "2026-06-16T00:00:00.000Z",
    },
    {
      id: "evt_alias",
      streamId: "catalog.item-cat_1",
      streamVersion: 5,
      globalPosition: "5",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
      timing: { occurredAt: "2026-06-16T00:00:00.000Z", recordedAt: "2026-06-16T00:00:00.000Z" },
    },
  );
}

function alias(overrides: Partial<ResolvedAlias> & Pick<ResolvedAlias, "aliasText" | "aliasType">): ResolvedAlias {
  return {
    aliasHash: overrides.aliasHash ?? `hash-${overrides.aliasText}`,
    aliasText: overrides.aliasText,
    normalizedAliasText: overrides.normalizedAliasText ?? overrides.aliasText.toLowerCase(),
    aliasType: overrides.aliasType,
    confidence: overrides.confidence ?? "high",
    broad: overrides.broad ?? false,
  };
}

describe("Discovery search alias projection", () => {
  afterEach(() => {
    delete process.env[DISCOVERY_ALIAS_SEARCH_ENV_VAR];
  });

  it("folds an official-equivalent alias into the top-weight english search text", async () => {
    const db = new AliasProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.aliases-resolved"]?.(
      aliasesResolvedEvent([alias({ aliasText: "Dracaufeu", aliasType: "official-equivalent" })]),
    );

    // The top-weight bucket carries title + official equivalent.
    expect(db.lastEnglishWeights[0]).toContain("Charizard");
    expect(db.lastEnglishWeights[0]).toContain("Dracaufeu");
    expect(db.derivedWrites).toBeGreaterThan(0);
  });

  it("folds alias diacritics in both weighted search vectors", async () => {
    const db = new AliasProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.aliases-resolved"]?.(
      aliasesResolvedEvent([alias({ aliasText: "Pokémon", aliasType: "official-equivalent" })]),
    );

    expect(db.lastEnglishWeights[0]).toContain("Pokemon");
    expect(db.lastSimpleWeights[0]).toContain("Pokemon");
    expect(db.lastEnglishWeights.join(" ")).not.toContain("Pokémon");
    expect(db.lastSimpleWeights.join(" ")).not.toContain("Pokémon");
  });

  it("removes a revoked alias from search text on an empty (retraction) fact", async () => {
    const db = new AliasProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.aliases-resolved"]?.(
      aliasesResolvedEvent([alias({ aliasText: "Dracaufeu", aliasType: "official-equivalent" })]),
    );
    expect(db.lastEnglishWeights[0]).toContain("Dracaufeu");
    expect(db.row.resolved_aliases).toMatchObject({ fr: expect.any(Array) });

    // Retraction: empty alias list for the same language drops it from search.
    await handlers["catalog.catalog-item.aliases-resolved"]?.(aliasesResolvedEvent([]));

    expect(db.lastEnglishWeights.join(" ")).not.toContain("Dracaufeu");
    expect(db.row.resolved_aliases).toEqual({});
  });

  it("marks embedding enrichment dirty by hash while preserving unchanged rebuild metadata", async () => {
    const db = new AliasProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.aliases-resolved"]?.(aliasesResolvedEvent([]));
    const unchangedHash = db.lastEmbeddedTextHash;
    await handlers["catalog.catalog-item.aliases-resolved"]?.(aliasesResolvedEvent([]));

    expect(db.lastEmbeddedTextHash).toBe(unchangedHash);
    expect(db.lastDerivedWriteSql).toContain(
      "discovery_search_items.embedded_text_hash IS NOT DISTINCT FROM EXCLUDED.embedded_text_hash",
    );
    expect(db.lastDerivedWriteSql).toContain("ELSE NULL");

    await handlers["catalog.catalog-item.aliases-resolved"]?.(
      aliasesResolvedEvent([alias({ aliasText: "Dracaufeu", aliasType: "official-equivalent" })]),
    );
    expect(db.lastEmbeddedTextHash).not.toBe(unchangedHash);
  });

  it("removes the alias on rebuild after retraction (negative projection on rebuild)", async () => {
    // Source row already lost the alias (retraction persisted); a refresh that
    // reads the source row must not re-introduce it into search text.
    const db = new AliasProjectionDb({ resolved_aliases: {} });
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    // Drive a refresh through any item event that reads + rewrites the row.
    await handlers["catalog.catalog-item.aliases-resolved"]?.(aliasesResolvedEvent([], "fr"));

    expect(db.lastEnglishWeights.join(" ")).not.toContain("Dracaufeu");
  });

  it("drops alias contribution entirely when the rollout kill-switch is closed", async () => {
    process.env[DISCOVERY_ALIAS_SEARCH_ENV_VAR] = "disabled";
    const db = new AliasProjectionDb({
      resolved_aliases: { fr: [alias({ aliasText: "Dracaufeu", aliasType: "official-equivalent" })] },
    });
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.aliases-resolved"]?.(
      aliasesResolvedEvent([alias({ aliasText: "Dracaufeu", aliasType: "official-equivalent" })]),
    );

    // Source row still stores the alias, but it never reaches search text.
    expect(db.row.resolved_aliases).toMatchObject({ fr: expect.any(Array) });
    expect(db.lastEnglishWeights.join(" ")).not.toContain("Dracaufeu");
    expect(db.lastEnglishWeights[0]).toContain("Charizard");
  });

  it("keeps a broad species alias out of the title's top weight tier", async () => {
    const db = new AliasProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.aliases-resolved"]?.(
      aliasesResolvedEvent([alias({ aliasText: "Pikachu", aliasType: "species-name", broad: true })]),
    );

    // Title stays alone in A; the broad species alias is demoted to C.
    expect(db.lastEnglishWeights[0]).toContain("Charizard");
    expect(db.lastEnglishWeights[0]).not.toContain("Pikachu");
    expect(db.lastEnglishWeights[2]).toContain("Pikachu");
  });
});
