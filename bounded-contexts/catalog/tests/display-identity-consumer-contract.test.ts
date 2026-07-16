import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("display identity consumer subscription contract", () => {
  it("keeps display-only downstream projections subscribed to resolved identity facts instead of metadata revisions", () => {
    expect(catalogEventTypes("../../marketplace/context.json", "marketplace-catalog-item-projection", 4)).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../marketplace/context.json", "marketplace-catalog-item-projection", 4)).not.toContain(
      "catalog.catalog-item.metadata-revised",
    );
    expect(catalogEventTypes("../../marketplace/context.json", "marketplace-catalog-item-projection", 4)).toEqual(
      expect.arrayContaining([
        "catalog.catalog-item.category-assigned",
        "catalog.catalog-item.category-removed",
        "catalog.category.created",
        "catalog.category.revised",
        "catalog.category.published",
        "catalog.category.deprecated",
        "catalog.category.archived",
      ]),
    );

    expect(catalogEventTypes("../../inventory/context.json", "inventory-catalog-item-projection", 4)).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../inventory/context.json", "inventory-catalog-item-projection", 4)).not.toContain(
      "catalog.catalog-item.metadata-revised",
    );

    // Version 4 added category-assigned/category-removed for repricing-policy
    // catalog-filter scope resolution; still display-identity-resolved, never
    // metadata-revised.
    expect(catalogEventTypes("../../pricing/context.json", "pricing-catalog-input-projection", 5)).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../pricing/context.json", "pricing-catalog-input-projection", 5)).not.toContain(
      "catalog.catalog-item.metadata-revised",
    );
  });

  it("replays structured display identity facts into Discovery search and item detail projections", () => {
    // Version 8 replays Catalog facts to refold Product Contents text into each
    // container item's tsvector (weight D); still display-identity-resolved.
    expect(catalogEventTypes("../../discovery/context.json", "discovery-search-item-projection", 8)).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../discovery/context.json", "discovery-item-detail-projection", 3)).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
  });

  it("gates the Marketplace Catalog projection on Catalog seed mounting", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../marketplace/context.json", import.meta.url), "utf8")) as {
      seedRequirements: string[];
    };

    expect(manifest.seedRequirements).toContain("catalog");
  });
});

function catalogEventTypes(contextPath: string, projectionName: string, expectedSubscriptionVersion = 3): string[] {
  const manifest = JSON.parse(readFileSync(new URL(contextPath, import.meta.url), "utf8")) as {
    eventSubscriptions: Array<{
      sourceContextName: string;
      projectionName: string;
      eventTypes: string[];
      subscriptionVersion: number;
    }>;
  };
  const subscription = manifest.eventSubscriptions.find(
    (entry) => entry.sourceContextName === "catalog" && entry.projectionName === projectionName,
  );

  expect(subscription?.subscriptionVersion).toBe(expectedSubscriptionVersion);
  return subscription?.eventTypes ?? [];
}
