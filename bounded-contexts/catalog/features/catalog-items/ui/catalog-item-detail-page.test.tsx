// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogItemDetailPage } from "./catalog-item-detail-page";
import type { CatalogItemDetail, CatalogReferenceRecordRef } from "./contracts";

afterEach(() => cleanup());

const catalogItem: CatalogItemDetail = {
  catalog_item_id: "cat_1",
  language_code: "ja",
  title_i18n: null,
  title: "Bulbasaur",
  subtitle_i18n: null,
  subtitle: "Japanese Base Set",
  display_template_key: null,
  display_identity_hash: null,
  display_identity_resolved_at: null,
  description_i18n: null,
  description: "Japanese printed Bulbasaur",
  blueprint: null,
  status: "draft",
  field_values: [],
  categories: [],
  external_catalog_item_references: [],
  external_product_references: [],
  tags: [],
  image_urls: [],
  product_asset_sets: [],
  image_fallback: null,
  updated_at: "2026-05-13T00:00:00.000Z",
};

describe("CatalogItemDetailPage", () => {
  it("renders catalog item language codes as localized labels", () => {
    const html = renderToString(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("does not expose manual title or subtitle controls in metadata editing", () => {
    render(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Description" }));

    const dialog = screen.getByRole("dialog", { name: "Edit Description" });
    expect(within(dialog).queryByLabelText("Title")).toBeNull();
    expect(within(dialog).queryByLabelText("Subtitle")).toBeNull();
    expect(within(dialog).getByLabelText("Description")).toBeTruthy();
  });

  it("renders reference field values as flattened clickable detail rows", () => {
    const html = renderToString(
      <CatalogItemDetailPage
        id="cat_1"
        initialData={{
          ...catalogItem,
          field_values: [
            {
              fieldId: "fld_seed_expansion",
              fieldName: "fld_seed_expansion",
              value: { referenceId: "ref_ascended_heroes" },
              reference: {
                referenceId: "ref_ascended_heroes",
                typeKey: "expansion",
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
                    relationshipType: "part-of",
                    referenceId: "ref_mega_evolution",
                    reference: {
                      referenceId: "ref_mega_evolution",
                      typeKey: "series",
                      key: "mega-evolution",
                      name: "Mega Evolution",
                      attributes: { "tcgdex-series-id": "mega-evolution" },
                      relationships: [],
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

    expect(html).toContain("Expansion");
    expect(html).toContain("Ascended Heroes");
    expect(html).toContain("Series");
    expect(html).toContain("Mega Evolution");
    expect(html).not.toContain("fld_seed_expansion");
    expect(html).not.toContain("card-count: 217");
  });

  it("opens reference details from catalog field values", () => {
    render(
      <CatalogItemDetailPage
        id="cat_1"
        initialData={{
          ...catalogItem,
          field_values: [
            {
              fieldId: "fld_seed_expansion",
              fieldName: "fld_seed_expansion",
              value: { referenceId: "ref_expansion" },
              reference: expansionReference(),
            },
          ],
        }}
      />,
    );

    const referenceValueTrigger = screen.getAllByRole("link", {
      name: "View Expansion reference details for Perfect Order",
    })[0];

    expect(referenceValueTrigger.getAttribute("href")).toBe("/catalog/reference-records/ref_expansion");
    expect(referenceValueTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(referenceValueTrigger.className).toContain("text-accent");
    expect(referenceValueTrigger.className).toContain("hover:underline");
    expect(referenceValueTrigger.className).not.toContain("min-h-8");
    expect(referenceValueTrigger.className).not.toContain("text-xs");

    fireEvent.click(referenceValueTrigger);

    const dialog = screen.getByRole("dialog", { name: "Perfect Order" });
    expect(within(dialog).getByText("Reference type")).toBeTruthy();
    expect(within(dialog).getAllByText("Expansion")[0]).toBeTruthy();
    expect(within(dialog).getByText("tcgdex-set-id")).toBeTruthy();
    expect(within(dialog).getByText("me03")).toBeTruthy();
    expect(within(dialog).getByText("Part Of")).toBeTruthy();
    expect(within(dialog).getByText("Mega Evolution")).toBeTruthy();
  });
});

function expansionReference(): CatalogReferenceRecordRef {
  const series: CatalogReferenceRecordRef = {
    referenceId: "ref_series",
    typeKey: "series",
    key: "mega-evolution",
    name: "Mega Evolution",
    attributes: { "tcgdex-series-id": "mega-evolution" },
    relationships: [],
    status: "active",
  };

  return {
    referenceId: "ref_expansion",
    typeKey: "expansion",
    key: "perfect-order",
    name: "Perfect Order",
    attributes: { "tcgdex-set-id": "me03", "card-count": 88 },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: series.referenceId,
        reference: series,
      },
    ],
    status: "active",
  };
}
