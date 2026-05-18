import { describe, expect, it } from "vitest";
import {
  dimensionFacetValueOrderSql,
  fieldFacetSortMetadata,
  fieldFacetValueOrderSql,
} from "./facet-ordering";

describe("Discovery facet ordering policy", () => {
  it("orders year field values newest to oldest", () => {
    expect(
      fieldFacetSortMetadata({
        fieldId: "fld_seed_release_year",
        label: "Release Year",
        value: 2025,
        valueType: "number",
      }),
    ).toEqual({ sortKind: "number-desc", sortValue: "2025" });
  });

  it("orders expansion reference values by release date newest to oldest", () => {
    expect(
      fieldFacetSortMetadata({
        fieldId: "fld_seed_expansion",
        label: "Expansion",
        value: "ref_seed_expansion_prismatic_evolutions",
        valueType: "reference",
        reference: {
          referenceId: "ref_seed_expansion_prismatic_evolutions",
          typeKey: "expansion",
          key: "prismatic-evolutions",
          name: "Prismatic Evolutions",
          attributes: { "release-date": "2025-01-17" },
          relationships: [],
          status: "active",
        },
      }),
    ).toEqual({ sortKind: "date-desc", sortValue: "2025-01-17" });
  });

  it("keeps unordered text field values on fallback ordering", () => {
    expect(
      fieldFacetSortMetadata({
        fieldId: "fld_seed_rarity",
        label: "Rarity",
        value: "Holo Rare",
        valueType: "string",
      }),
    ).toEqual({ sortKind: null, sortValue: null });
  });

  it("builds numeric and date field ordering before count fallback", () => {
    expect(
      fieldFacetValueOrderSql({
        sortKind: "sort_kind",
        sortValue: "sort_value",
        sortNumber: "sort_number",
        count: "count",
        label: "label",
        id: "value",
      }),
    ).toBe(
      "CASE WHEN sort_kind = 'date-desc' THEN sort_value END DESC NULLS LAST, CASE WHEN sort_kind = 'number-desc' THEN sort_number END DESC NULLS LAST, count DESC, label ASC, value ASC",
    );
  });

  it("builds dimension ordering for numeric grades and ordered conditions", () => {
    expect(
      dimensionFacetValueOrderSql({
        valueKind: "value_kind",
        numericValue: "numeric_value",
        displayOrder: "display_order",
        count: "count",
        label: "label",
        id: "option_id",
      }),
    ).toBe(
      "CASE WHEN value_kind = 'numeric' THEN numeric_value END DESC NULLS LAST, CASE WHEN value_kind IN ('ordered', 'numeric') THEN display_order END ASC NULLS LAST, count DESC, label ASC, option_id ASC",
    );
  });
});
