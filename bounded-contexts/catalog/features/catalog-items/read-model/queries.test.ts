import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getCatalogItemByGtin, listCatalogItems, loadCatalogItemPublicationIdentityRows } from "./queries";

describe("catalog item read-model queries", () => {
  it("clamps and parameterizes catalog item list pagination", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ catalog_item_id: "cat_1" }]]);

    const result = await listCatalogItems(db, {
      status: "active",
      search: "charizard_%",
      limit: 9e15,
      offset: -5,
    });

    expect(result).toEqual({ items: [{ catalog_item_id: "cat_1" }], total: 1 });
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("ILIKE $2 ESCAPE '\\'");
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $3 OFFSET $4"), [
      "active",
      "%charizard\\_\\%%",
      500,
      0,
    ]);
  });

  it("normalizes the input GTIN before querying the lookup table", async () => {
    const db = queryableSequence([[{ gtin: "00307418529636", catalog_item_id: "cat_1", product_form: null }]]);

    const result = await getCatalogItemByGtin(db, "3074-1852-9636");

    expect(result).toEqual({ gtin: "00307418529636", catalog_item_id: "cat_1", product_form: null });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM catalog_item_gtins AS link"), [
      "00307418529636",
    ]);
  });

  it("returns null without querying when the input does not normalize to a valid GTIN", async () => {
    const db = queryableSequence([[]]);

    const result = await getCatalogItemByGtin(db, "not-a-barcode");

    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns null when no item is linked to the normalized GTIN", async () => {
    const db = queryableSequence([[]]);

    const result = await getCatalogItemByGtin(db, "307418529636");

    expect(result).toBeNull();
  });

  it("loads the raw localized resolver tuple and exact current identity fact together", async () => {
    const title = { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } };
    const db = queryableSequence([
      [
        {
          catalog_item_id: "cat_1",
          language_code: "en",
          title_i18n: title,
          title: "Charizard",
          subtitle_i18n: null,
          subtitle: null,
          blueprint_id: "bpr_card",
          field_values: [{ fieldId: "fld_name", value: "Charizard" }],
          category_ids: ["ctg_cards"],
          identity_catalog_item_id: "cat_1",
          identity_language_code: "en",
          identity_title: "Charizard",
          identity_subtitle: null,
          display_template_key: "card-title",
          display_template_target_kind: "blueprint",
          display_template_target_id: "bpr_card",
          display_identity_hash: "hash",
          resolver_version: 3,
          resolved_at: "2026-09-05T00:00:00.000Z",
          resolution_status: "resolved",
          missing_tokens: [],
        },
      ],
    ]);

    const rows = await loadCatalogItemPublicationIdentityRows(db, ["cat_1"]);

    expect(rows.get("cat_1")).toMatchObject({
      item: {
        title: "Charizard",
        projected_title: "Charizard",
        title_i18n: title,
        blueprint_id: "bpr_card",
      },
      fact: {
        display_identity_hash: "hash",
        resolver_version: 3,
        resolution_status: "resolved",
      },
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("LEFT JOIN catalog_item_display_identities AS identity"),
      [["cat_1"]],
    );
  });
});

function queryableSequence(results: readonly (readonly Record<string, unknown>[])[]): PgQueryable {
  let index = 0;

  return {
    query: vi.fn(async () => {
      const rows = results[Math.min(index, results.length - 1)] ?? [];
      index += 1;
      return {
        rows: [...rows],
        rowCount: rows.length,
      };
    }),
  };
}
