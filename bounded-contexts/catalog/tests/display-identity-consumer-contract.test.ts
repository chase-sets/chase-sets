import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("display identity consumer subscription contract", () => {
  it("keeps display-only downstream projections subscribed to resolved identity facts instead of metadata revisions", () => {
    expect(
      catalogEventTypes("bounded-contexts/marketplace/context.json", "marketplace-catalog-item-projection"),
    ).toEqual(expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]));
    expect(
      catalogEventTypes("bounded-contexts/marketplace/context.json", "marketplace-catalog-item-projection"),
    ).not.toContain("catalog.catalog-item.metadata-revised");

    expect(catalogEventTypes("bounded-contexts/inventory/context.json", "inventory-catalog-item-projection")).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(
      catalogEventTypes("bounded-contexts/inventory/context.json", "inventory-catalog-item-projection"),
    ).not.toContain("catalog.catalog-item.metadata-revised");

    expect(catalogEventTypes("bounded-contexts/pricing/context.json", "pricing-catalog-input-projection")).toEqual(
      expect.arrayContaining(["catalog.catalog-item.display-identity-resolved"]),
    );
    expect(
      catalogEventTypes("bounded-contexts/pricing/context.json", "pricing-catalog-input-projection"),
    ).not.toContain("catalog.catalog-item.metadata-revised");
  });
});

function catalogEventTypes(contextPath: string, projectionName: string): string[] {
  const manifest = JSON.parse(readFileSync(contextPath, "utf8")) as {
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

  expect(subscription?.subscriptionVersion).toBe(3);
  return subscription?.eventTypes ?? [];
}
