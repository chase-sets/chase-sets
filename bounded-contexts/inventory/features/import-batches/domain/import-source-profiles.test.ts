import { describe, expect, it } from "vitest";
import { getInventoryImportSourceProfile, inventoryImportSourceProfiles } from "./import-source-profiles";

describe("AC-03 deterministic source candidate authority", () => {
  it.each([
    { source: "native-csv", order: ["gtin::gtin-reference", "account:sku::account-sku"] },
    {
      source: "tcgplayer-csv",
      order: [
        "tcgplayer:sku::product-reference",
        "tcgplayer:product::catalog-item-reference",
        "account:sku::account-sku",
      ],
    },
    {
      source: "ebay-csv",
      order: [
        "ebay:listing::product-reference",
        "ebay:variation::product-reference",
        "ebay:sku::account-sku",
        "ebay:epid::catalog-item-reference",
        "gtin::gtin-reference",
        "gtin::gtin-reference",
      ],
    },
    {
      source: "shopify-csv",
      order: [
        "shopify:variant::product-reference",
        "shopify:product::catalog-item-reference",
        "shopify:sku::account-sku",
        "gtin::gtin-reference",
        "shopify:handle::catalog-item-reference",
      ],
    },
    {
      source: "whatnot-csv",
      order: [
        "whatnot:product::catalog-item-reference",
        "whatnot:listing::product-reference",
        "whatnot:inventory::product-reference",
        "whatnot:sku::account-sku",
      ],
    },
    {
      source: "cardtrader-csv",
      order: [
        "cardtrader:product::catalog-item-reference",
        "cardtrader:blueprint::catalog-item-reference",
        "cardtrader:article::product-reference",
        "cardtrader:sku::account-sku",
        "tcgplayer:product::catalog-item-reference",
        "cardmarket:product::catalog-item-reference",
      ],
    },
  ])("$source preserves order and explicit target intent", ({ source, order }) => {
    const profile = getInventoryImportSourceProfile(source)!;
    expect(
      profile.externalReferenceCandidates.map(
        (candidate) => `${candidate.providerKey}:${candidate.externalKeyPrefix}:${candidate.targetIntent}`,
      ),
    ).toEqual(order);
    expect(
      profile.externalReferenceCandidates.every((candidate) =>
        ["gtin-reference", "account-sku", "catalog-item-reference", "product-reference"].includes(
          candidate.targetIntent,
        ),
      ),
    ).toBe(true);
  });
  it("Saved List identity is authoritative, not descriptive lookup evidence", () => {
    expect(getInventoryImportSourceProfile("saved-list")?.externalReferenceCandidates).toEqual([]);
    expect(inventoryImportSourceProfiles).toHaveLength(7);
  });
});
