import { describe, expect, it } from "vitest";
import context from "../../../context.json" with { type: "json" };

describe("Pricing Catalog input subscription v6", () => {
  it("replays both product-reference facts into the new owned table", () => {
    const subscription = context.eventSubscriptions.find(
      (entry) => entry.projectionName === "pricing-catalog-input-projection",
    );
    const group = context.projectionGroups.find((entry) => entry.projectionName === "pricing-catalog-input-projection");
    expect(subscription?.subscriptionVersion).toBe(6);
    expect(subscription?.eventTypes).toEqual(
      expect.arrayContaining([
        "catalog.catalog-item.external-catalog-item-reference-linked",
        "catalog.catalog-item.external-catalog-item-reference-unlinked",
      ]),
    );
    expect(group).toMatchObject({ resetStrategy: "replay-only", requiredDuringBootstrap: true });
    expect(group?.ownedTables).toContain("pricing_external_catalog_item_reference_inputs");
  });
});
