import { describe, expect, it } from "vitest";
import { readInitialSelectedOptions } from "../routes/item-detail";

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
});
