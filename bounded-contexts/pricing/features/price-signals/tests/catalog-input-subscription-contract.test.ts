import { describe, expect, it } from "vitest";
import { contextManifest as context } from "../../../index";

describe("Pricing Catalog input subscription v7", () => {
  it("replays product-reference and category facts into their owned tables", () => {
    const subscription = context.eventSubscriptions.find(
      (entry) => entry.projectionName === "pricing-catalog-input-projection",
    );
    const group = context.projectionGroups.find((entry) => entry.projectionName === "pricing-catalog-input-projection");
    expect(subscription?.subscriptionVersion).toBe(7);
    expect(subscription?.eventTypes).toEqual(
      expect.arrayContaining([
        "catalog.catalog-item.external-catalog-item-reference-linked",
        "catalog.catalog-item.external-catalog-item-reference-unlinked",
        "catalog.category.created",
        "catalog.category.revised",
        "catalog.category.published",
        "catalog.category.deprecated",
        "catalog.category.archived",
      ]),
    );
    expect(group).toMatchObject({ resetStrategy: "replay-only", requiredDuringBootstrap: true });
    expect(group?.ownedTables).toContain("pricing_external_catalog_item_reference_inputs");
    expect(group?.ownedTables).toContain("pricing_catalog_category_inputs");
  });
});
