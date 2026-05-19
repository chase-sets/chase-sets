import { describe, expect, it } from "vitest";
import type { CatalogReferenceRecordRef } from "./contracts";
import { buildReferenceDetailRows, formatReferenceTypeLabel } from "./reference-detail-rows";

describe("buildReferenceDetailRows", () => {
  it("flattens nested references into natural detail rows", () => {
    const rows = buildReferenceDetailRows([
      {
        fieldId: "fld_seed_expansion",
        fieldName: "fld_seed_expansion",
        value: { referenceId: "ref_expansion" },
        reference: expansionReference(),
      },
    ]);

    expect(rows.map((row) => ({
      label: row.label,
      value: row.value,
    }))).toEqual([
      { label: "Expansion", value: "Perfect Order" },
      { label: "Series", value: "Mega Evolution" },
      { label: "Product Line", value: "Pokemon Trading Card Game" },
      { label: "Manufacturer", value: "The Pokemon Company International" },
    ]);
  });

  it("does not repeat direct references or follow circular relationships", () => {
    const expansion = expansionReference();
    const series = expansion.relationships[0].reference!;
    series.relationships = [
      ...series.relationships,
      {
        relationshipType: "contains",
        referenceId: expansion.referenceId,
        reference: expansion,
      },
    ];

    const rows = buildReferenceDetailRows([
      {
        fieldId: "fld_seed_expansion",
        fieldName: "Expansion",
        value: { referenceId: expansion.referenceId },
        reference: expansion,
      },
      {
        fieldId: "fld_seed_series",
        fieldName: "Series",
        value: { referenceId: series.referenceId },
        reference: series,
      },
    ]);

    expect(rows.map((row) => row.value)).toEqual([
      "Perfect Order",
      "Mega Evolution",
      "Pokemon Trading Card Game",
      "The Pokemon Company International",
    ]);
  });

  it("formats reference type keys as user-facing labels", () => {
    expect(formatReferenceTypeLabel("product-line")).toBe("Product Line");
    expect(formatReferenceTypeLabel("tcg-product")).toBe("TCG Product");
  });
});

function expansionReference(): CatalogReferenceRecordRef {
  const manufacturer: CatalogReferenceRecordRef = {
    referenceId: "ref_manufacturer",
    typeKey: "manufacturer",
    key: "the-pokemon-company-international",
    name: "The Pokemon Company International",
    attributes: { "homepage-url": "https://www.pokemon.com/us" },
    relationships: [],
    status: "active",
  };
  const productLine: CatalogReferenceRecordRef = {
    referenceId: "ref_product_line",
    typeKey: "product-line",
    key: "pokemon-trading-card-game",
    name: "Pokemon Trading Card Game",
    attributes: { "short-name": "Pokemon TCG" },
    relationships: [
      {
        relationshipType: "published-by",
        referenceId: manufacturer.referenceId,
        reference: manufacturer,
      },
    ],
    status: "active",
  };
  const series: CatalogReferenceRecordRef = {
    referenceId: "ref_series",
    typeKey: "series",
    key: "mega-evolution",
    name: "Mega Evolution",
    attributes: { "tcgdex-series-id": "mega-evolution" },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: productLine.referenceId,
        reference: productLine,
      },
    ],
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
