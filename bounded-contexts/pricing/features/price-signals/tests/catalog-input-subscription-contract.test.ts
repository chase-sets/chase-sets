import { describe, expect, it } from "vitest";
import { contextManifest as context } from "../../../index";

describe("Pricing Catalog input subscription v8", () => {
  it("replays product-reference, category and Product Line facts into their owned tables", () => {
    const subscription = context.eventSubscriptions.find(
      (entry) => entry.projectionName === "pricing-catalog-input-projection",
    );
    const group = context.projectionGroups.find((entry) => entry.projectionName === "pricing-catalog-input-projection");
    expect(subscription?.subscriptionVersion).toBe(8);
    expect(subscription?.eventTypes).toEqual(
      expect.arrayContaining([
        "catalog.catalog-item.external-catalog-item-reference-linked",
        "catalog.catalog-item.external-catalog-item-reference-unlinked",
        "catalog.category.created",
        "catalog.category.revised",
        "catalog.category.published",
        "catalog.category.deprecated",
        "catalog.category.archived",
        "catalog.reference-record.created",
        "catalog.reference-record.revised",
        "catalog.reference-record.published",
        "catalog.reference-record.deprecated",
        "catalog.reference-record.archived",
      ]),
    );
    expect(group).toMatchObject({ resetStrategy: "replay-only", requiredDuringBootstrap: true });
    expect(group?.ownedTables).toContain("pricing_external_catalog_item_reference_inputs");
    expect(group?.ownedTables).toContain("pricing_catalog_category_inputs");
    for (const table of ["pricing_catalog_reference_inputs", "pricing_catalog_reference_records"]) {
      expect(group?.ownedTables).toContain(table);
      expect(
        context.projectionGroups.filter((entry) => entry.ownedTables.some((ownedTable) => ownedTable === table)),
      ).toHaveLength(1);
    }
  });
});
