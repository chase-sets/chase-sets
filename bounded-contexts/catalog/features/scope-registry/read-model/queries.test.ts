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
      });

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
    const countSql = String(query.mock.calls[0]?.[0]);
    const listSql = String(query.mock.calls[1]?.[0]);
    expect(countSql).toContain("product_domain = $1");
    expect(countSql).toContain("scope_kind = $2");
    expect(countSql).toContain("lifecycle_status = $3");
    expect(countSql).toContain("product_line_scope_record_id = $4");
    expect(countSql).toContain("series_scope_record_id = $5");
    expect(listSql).toContain("ORDER BY product_domain ASC, scope_kind ASC, name ASC");
  });
});
