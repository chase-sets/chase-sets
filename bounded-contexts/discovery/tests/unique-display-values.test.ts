import { describe, expect, it } from "vitest";
import { uniqueDisplayValues } from "../support/item-support/unique-display-values";
import { uniqueStrings } from "../support/item-support/unique-strings";

describe("uniqueDisplayValues", () => {
  it("removes duplicate and blank labels while preserving order", () => {
    expect(
      uniqueDisplayValues([
        "Pokemon TCG",
        "Singles",
        "Pokemon TCG",
        "  ",
        " Near Mint ",
        "Near Mint",
      ]),
    ).toEqual(["Pokemon TCG", "Singles", "Near Mint"]);
  });

  it("removes duplicate strings while preserving order", () => {
    expect(
      uniqueStrings([
        "ctg_seed_pokemon_tcg",
        "ctg_seed_singles",
        "ctg_seed_pokemon_tcg",
      ]),
    ).toEqual(["ctg_seed_pokemon_tcg", "ctg_seed_singles"]);
  });
});
