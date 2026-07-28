import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  tcgplayerAutomationCatalogRequiredFixturePaths,
  tcgplayerAutomationResponseAuditFindings,
  tcgplayerCatalogHashFieldPaths,
  tcgplayerFindFieldDecision,
  tcgplayerSourcePayloadOnlyFieldPaths,
  type TcgplayerAutomationCatalogEndpoint,
} from "./tcgplayer-automation-response-contract";
import { tcgplayerAutomationResponseFixtures } from "./tcgplayer-automation-response-fixtures.test-data";

describe("TCGplayer automation response contract", () => {
  it("keeps sanitized fixtures for every Catalog-relevant automation endpoint", () => {
    expect(Object.keys(tcgplayerAutomationResponseFixtures).sort()).toEqual([
      "catalogSetNames",
      "productDetail",
      "productLines",
      "productSearch",
    ]);
  });

  it("covers every required Catalog-relevant fixture path with observed sample data", () => {
    for (const [endpoint, paths] of Object.entries(tcgplayerAutomationCatalogRequiredFixturePaths) as Array<
      [TcgplayerAutomationCatalogEndpoint, readonly string[]]
    >) {
      const fixture = fixtureForEndpoint(endpoint);
      for (const path of paths) {
        expect(readPath(fixture, path), `${endpoint}:${path}`).not.toBeUndefined();
      }
    }
  });

  it("documents an ownership decision for every required fixture field", () => {
    for (const [endpoint, paths] of Object.entries(tcgplayerAutomationCatalogRequiredFixturePaths) as Array<
      [TcgplayerAutomationCatalogEndpoint, readonly string[]]
    >) {
      for (const path of paths) {
        const decisionPath = toDecisionPath(path);
        expect(tcgplayerFindFieldDecision(endpoint, decisionPath), `${endpoint}:${decisionPath}`).not.toBeNull();
      }
    }
  });

  it("keeps price, listing, seller, and quantity fields out of Catalog observation hashes", () => {
    const searchHashFields = tcgplayerCatalogHashFieldPaths("product-search");
    const detailHashFields = tcgplayerCatalogHashFieldPaths("product-detail");

    expect(searchHashFields).toEqual(
      expect.arrayContaining(["productId", "productName", "setId", "setName", "customAttributes.number"]),
    );
    expect(detailHashFields).toEqual(
      expect.arrayContaining(["productId", "productName", "setId", "setName", "skus.sku"]),
    );
    expect([...searchHashFields, ...detailHashFields]).not.toEqual(
      expect.arrayContaining([
        "marketPrice",
        "lowestPrice",
        "lowestPriceWithShipping",
        "medianPrice",
        "totalListings",
        "listings",
        "listings.price",
        "listings.quantity",
        "listings.sellerId",
        "listings.sellerKey",
        "listings.sellerName",
      ]),
    );
    expect(tcgplayerSourcePayloadOnlyFieldPaths("product-search")).toEqual(
      expect.arrayContaining(["marketPrice", "lowestPrice", "listings.price", "listings.sellerId"]),
    );
  });

  it("captures the productConditionId gap between product-detail SKUs and listing search evidence", () => {
    expect(readPath(tcgplayerAutomationResponseFixtures.productDetail, "skus.0.productConditionId")).toBeUndefined();
    expect(
      readPath(tcgplayerAutomationResponseFixtures.productSearch, "results.0.results.0.listings.0.productConditionId"),
    ).toBe(9001001);
    expect(tcgplayerAutomationResponseAuditFindings).toContainEqual(
      expect.objectContaining({
        finding: expect.stringContaining("product-detail SKU shape contains sku, condition, variant, and language"),
        followUpIssue: 616,
      }),
    );
  });
});

function fixtureForEndpoint(endpoint: TcgplayerAutomationCatalogEndpoint): JsonValue {
  switch (endpoint) {
    case "product-lines":
      return tcgplayerAutomationResponseFixtures.productLines;
    case "catalog-set-names":
      return tcgplayerAutomationResponseFixtures.catalogSetNames;
    case "product-search":
      return tcgplayerAutomationResponseFixtures.productSearch;
    case "product-detail":
      return tcgplayerAutomationResponseFixtures.productDetail;
  }
}

function toDecisionPath(path: string): string {
  return path
    .replace(/^0\./, "")
    .replace(/^results\.0\.results\.0\./, "")
    .replace(/^results\.0\./, "")
    .replace(/\.0\./g, ".")
    .replace(/\.0$/g, "");
}

function readPath(value: JsonValue, path: string): JsonValue {
  return path.split(".").reduce<JsonValue>((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === "object" && !Array.isArray(current)) {
      return (current as Readonly<Record<string, JsonValue>>)[segment];
    }
    return undefined;
  }, value);
}
