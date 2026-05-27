import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import {
  loadRepresentativeCatalogUsageCandidates,
  normalizeRepresentativeCatalogCandidateLimit,
  prepareRepresentativeCatalogUsageCandidates,
} from "../support/seed-support/representative-commerce-state";

describe("catalog representative commerce state", () => {
  it("loads active current Catalog Items with resolved product measures and product schema", async () => {
    const queries: unknown[][] = [];
    const db: Pick<PgQueryable, "query"> = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);

        if (sql.includes("FROM catalog_items item")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_real_1",
                language_code: "en",
                title: "Real Imported Card",
                subtitle: "Provider expansion 12/123",
                blueprint_id: "bp_card",
                status: "active",
                product_measure_snapshots: [
                  {
                    catalogItemId: "cat_real_1",
                    productId: "cat_real_1::dim_form:opt_raw",
                    selectedOptions: [{ dimensionId: "dim_form", optionId: "opt_raw" }],
                  },
                ],
                updated_at: "2026-05-27T00:00:00.000Z",
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("FROM catalog_blueprints")) {
          return {
            rows: [
              {
                blueprint_id: "bp_card",
                dimension_rules: [{ dimensionId: "dim_form", required: true, allowedOptionIds: ["opt_raw"] }],
                canonical_dimension_order: ["dim_form"],
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("FROM catalog_dimensions")) {
          return { rows: [{ id: "dim_form", name: "Form" }] as Row[], rowCount: 1 };
        }

        if (sql.includes("FROM catalog_dimension_options")) {
          return {
            rows: [{ option_id: "opt_raw", code: "raw", label_i18n: null, label: "Raw" }] as Row[],
            rowCount: 1,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    const candidates = await loadRepresentativeCatalogUsageCandidates(db, { limit: 25 });

    expect(candidates).toEqual([
      expect.objectContaining({
        catalogItemId: "cat_real_1",
        languageCode: "en",
        status: "active",
        productSchema: {
          canonicalDimensionOrder: [{ dimensionId: "dim_form", dimensionName: "Form" }],
          dimensions: [
            {
              dimensionId: "dim_form",
              dimensionName: "Form",
              required: true,
              appliesWhen: [],
              allowedOptions: [
                {
                  optionId: "opt_raw",
                  code: "raw",
                  label_i18n: { defaultLocale: "en", values: { en: "Raw" } },
                  label: "Raw",
                },
              ],
            },
          ],
        },
      }),
    ]);
    expect(candidates[0]?.productMeasureSnapshots).toHaveLength(1);
    expect(String(queries[0]?.[0])).toContain("JOIN catalog_resolved_product_measures measure");
    expect(String(queries[0]?.[0])).toContain("item.status = 'active'");
    expect(queries[0]?.[1]).toEqual([25]);
  });

  it("keeps representative item limits bounded", () => {
    expect(normalizeRepresentativeCatalogCandidateLimit(undefined)).toBe(50);
    expect(normalizeRepresentativeCatalogCandidateLimit(0)).toBe(50);
    expect(normalizeRepresentativeCatalogCandidateLimit(1.8)).toBe(1);
    expect(normalizeRepresentativeCatalogCandidateLimit(800)).toBe(500);
  });

  it("resolves a bounded current Catalog Item window before loading measured candidates", async () => {
    const resolvedCatalogItemIds: string[] = [];
    const queries: unknown[][] = [];
    const db: Pick<PgQueryable, "query"> = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);

        if (sql.includes("SELECT item.catalog_item_id")) {
          return {
            rows: [{ catalog_item_id: "cat_real_1" }, { catalog_item_id: "cat_real_2" }] as Row[],
            rowCount: 2,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    await prepareRepresentativeCatalogUsageCandidates({
      db,
      productMeasures: {
        resolveCatalogItemMeasures: async (catalogItemId) => {
          resolvedCatalogItemIds.push(catalogItemId);
        },
      },
    });

    expect(resolvedCatalogItemIds).toEqual(["cat_real_1", "cat_real_2"]);
    expect(queries[0]?.[1]).toEqual([50]);
    expect(String(queries[0]?.[0])).toContain("WHERE item.status = 'active'");
    expect(String(queries[0]?.[0])).toContain("NOT EXISTS");
    expect(String(queries[0]?.[0])).toContain("catalog_resolved_product_measures");
  });
});
