import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatalogItemDetailPage } from "./catalog-item-detail-page";
import type { CatalogItemDetail } from "./contracts";

const catalogItem: CatalogItemDetail = {
  catalog_item_id: "cat_1",
  language_code: "ja",
  title_i18n: null,
  title: "Bulbasaur",
  subtitle_i18n: null,
  subtitle: "Japanese Base Set",
  description_i18n: null,
  description: "Japanese printed Bulbasaur",
  blueprint: null,
  status: "draft",
  field_values: [],
  categories: [],
  external_product_references: [],
  tags: [],
  image_urls: [],
  updated_at: "2026-05-13T00:00:00.000Z",
};

describe("CatalogItemDetailPage", () => {
  it("renders catalog item language codes as localized labels", () => {
    const html = renderToString(
      <CatalogItemDetailPage id="cat_1" initialData={catalogItem} />,
    );

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("renders rich reference field values with attached facts", () => {
    const html = renderToString(
      <CatalogItemDetailPage
        id="cat_1"
        initialData={{
          ...catalogItem,
          field_values: [
            {
              fieldId: "fld_set",
              fieldName: "Set",
              value: { referenceId: "ref_ascended_heroes" },
              reference: {
                referenceId: "ref_ascended_heroes",
                typeKey: "set",
                key: "ascended-heroes",
                name: "Ascended Heroes",
                attributes: {
                  "card-count": 217,
                  "release-date": "2026-01-30",
                  abbreviation: "ASC",
                  "source-id": "me02.5",
                },
                relationships: [
                  {
                    relationshipType: "part-of-series",
                    referenceId: "ref_mega_evolution",
                    reference: {
                      referenceId: "ref_mega_evolution",
                      typeKey: "series",
                      key: "mega-evolution",
                      name: "Mega Evolution",
                      status: "active",
                    },
                  },
                ],
                status: "active",
              },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Ascended Heroes (set)");
    expect(html).toContain("card-count: 217");
    expect(html).toContain("release-date: 2026-01-30");
    expect(html).toContain("part-of-series: Mega Evolution");
  });
});
