import { describe, expect, it } from "vitest";
import { readExplicitMarketSelectionId, readInitialSelectedOptions } from "../routes/item-detail";

describe("item detail URL selection", () => {
  it("reads unambiguous Dimension filters and ignores Field filters", () => {
    const params = new URLSearchParams();
    params.append("dimension.dim_condition", "opt_near_mint");
    params.append("field.fld_seed_card_number", "44/102");

    expect(readInitialSelectedOptions(params)).toEqual([{ dimensionId: "dim_condition", optionId: "opt_near_mint" }]);
  });

  it("leaves repeated Dimension selections unset instead of guessing", () => {
    const params = new URLSearchParams();
    params.append("dimension.dim_condition", "opt_near_mint");
    params.append("dimension.dim_condition", "opt_excellent");
    params.append("dimension.dim_finish", "opt_holo");

    expect(readInitialSelectedOptions(params)).toEqual([{ dimensionId: "dim_finish", optionId: "opt_holo" }]);
  });

  it("reads an unambiguous explicit listing or offer selection", () => {
    const params = new URLSearchParams();
    params.append("listing", " listing_123 ");
    params.append("offer", "offer_456");

    expect(readExplicitMarketSelectionId(params, "listing")).toBe("listing_123");
    expect(readExplicitMarketSelectionId(params, "offer")).toBe("offer_456");
  });

  it("leaves repeated explicit selections unset instead of guessing", () => {
    const params = new URLSearchParams();
    params.append("listing", "listing_123");
    params.append("listing", "listing_789");

    expect(readExplicitMarketSelectionId(params, "listing")).toBeNull();
  });
});
