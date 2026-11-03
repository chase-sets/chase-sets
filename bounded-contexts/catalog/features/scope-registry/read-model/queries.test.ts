import { describe, expect, it, vi } from "vitest";
import { listCatalogScopeRecords } from "./queries";

describe("Catalog scope registry queries", () => {
  it("lists scope records by product domain, kind, lifecycle, and hierarchy", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            scope_record_id: "ref_expansion_paldean_fates",
            product_domain: "pokemon",
            scope_kind: "expansion",
            reference_type_key: "expansion",
            reference_record_id: "ref_expansion_paldean_fates",
            reference_record_key: "paldean-fates",
            name_i18n: {},
            name: "Paldean Fates",
            parent_scope_record_id: "ref_series_scarlet_violet",
            product_line_scope_record_id: "ref_product_line_pokemon",
            series_scope_record_id: "ref_series_scarlet_violet",
            release_date: "2024-01-26",
            official_set_code: "PAF",
            language_editions: ["en", "ja"],
            attributes: {},
            relationships: [],
            lifecycle_status: "active",
            updated_at: "2026-07-03T12:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ language_edition: "en" }, { language_edition: "ja" }] });

    const result = await listCatalogScopeRecords(
      { query },
      {
        productDomain: "pokemon",
        scopeKind: "expansion",
        lifecycleStatus: "active",
        productLineScopeRecordId: "ref_product_line_pokemon",
        seriesScopeRecordId: "ref_series_scarlet_violet",
        search: "Paldean",
      },
    );

    expect(result.total).toBe(1);
    expect(result.items[0]?.reference_record_key).toBe("paldean-fates");
    expect(result.facets.languageEditions).toEqual(["en", "ja"]);
    const countSql = String(query.mock.calls[0]?.[0]);
    const listSql = String(query.mock.calls[1]?.[0]);
    expect(countSql).toContain("product_domain = $1");
    expect(countSql).toContain("scope_kind = $2");
    expect(countSql).toContain("lifecycle_status = $3");
    expect(countSql).toContain("product_line_scope_record_id = $4");
    expect(countSql).toContain("series_scope_record_id = $5");
    expect(listSql).toContain("ORDER BY product_domain ASC, scope_kind ASC, name ASC");
  });

  it("shares the language predicate between count and list while keeping facets global", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await listCatalogScopeRecords(
      { query },
      {
        productDomain: "pokemon",
        languageEdition: "ja",
        search: "paldean",
        limit: 20,
        offset: 20,
      },
    );

    const countSql = String(query.mock.calls[0]?.[0]);
    const listSql = String(query.mock.calls[1]?.[0]);
    const facetSql = String(query.mock.calls[2]?.[0]);
    const countValues = query.mock.calls[0]?.[1] as unknown[];
    const listValues = query.mock.calls[1]?.[1] as unknown[];
    const facetValues = query.mock.calls[2]?.[1] as unknown[];

    expect(countSql).toContain("product_domain = $1");
    expect(countSql).toContain("language_editions ? $2");
    expect(listSql).toContain("language_editions ? $2");
    expect(listSql).toContain("LIMIT $4 OFFSET $5");
    expect(countValues).toEqual(["pokemon", "ja", "%paldean%"]);
    expect(listValues).toEqual(["pokemon", "ja", "%paldean%", 20, 20]);
    expect(facetSql).not.toContain("language_editions ?");
    expect(facetValues).toEqual(["pokemon", "%paldean%"]);
  });

  it("binds hostile language editions as values and omits the predicate when absent", async () => {
    const hostile = "ja'); DROP TABLE catalog_scope_records;--";
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await listCatalogScopeRecords({ query }, { languageEdition: hostile });

    expect(String(query.mock.calls[0]?.[0])).not.toContain(hostile);
    expect(String(query.mock.calls[1]?.[0])).not.toContain(hostile);
    expect(query.mock.calls[0]?.[1]).toEqual([hostile]);
    expect(query.mock.calls[1]?.[1]).toEqual([hostile, 50, 0]);

    const unfilteredQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await listCatalogScopeRecords({ query: unfilteredQuery }, { languageEdition: undefined });
    expect(String(unfilteredQuery.mock.calls[0]?.[0])).not.toContain("language_editions ?");
    expect(String(unfilteredQuery.mock.calls[1]?.[0])).not.toContain("language_editions ?");
  });
});
