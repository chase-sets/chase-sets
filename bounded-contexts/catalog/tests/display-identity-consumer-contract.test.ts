import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("display identity consumer subscription contract", () => {
  it("keeps display-only downstream projections subscribed to resolved identity facts instead of metadata revisions", () => {
    expect(catalogEventTypes("../../marketplace/context.json", "marketplace-catalog-item-projection")).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../marketplace/context.json", "marketplace-catalog-item-projection")).not.toContain(
      "catalog.catalog-item.metadata-revised",
    );

    expect(catalogEventTypes("../../inventory/context.json", "inventory-catalog-item-projection")).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../inventory/context.json", "inventory-catalog-item-projection")).not.toContain(
      "catalog.catalog-item.metadata-revised",
    );

    // Version 4 added category-assigned/category-removed for repricing-policy
    // catalog-filter scope resolution; still display-identity-resolved, never
    // metadata-revised.
    expect(catalogEventTypes("../../pricing/context.json", "pricing-catalog-input-projection", 4)).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(catalogEventTypes("../../pricing/context.json", "pricing-catalog-input-projection", 4)).not.toContain(
      "catalog.catalog-item.metadata-revised",
    );
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
