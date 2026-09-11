import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryAdjustmentReasons, inventoryOfflineSaleChannels } from "@chase-sets/event-core/public-event-payloads";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const source = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");

describe("channel-allocation-preserved-contracts", () => {
  it("preserves the closed adjustment and offline-sale registries", () => {
    expect(inventoryAdjustmentReasons).toEqual([
      "sold-offline",
      "sold-external-channel",
      "damaged",
      "lost",
      "found",
      "correction",
      "intake",
      "return-restocked",
    ]);
    expect(inventoryOfflineSaleChannels).toEqual(["in-store", "card-show", "other"]);
  });

  it("keeps the five quantity consumers and four caller-selectable MCP artifacts unchanged in role", () => {
    const quantityConsumers = [
      "bounded-contexts/checkout/features/cart/integrations/inventory/inventory-projection.ts",
      "bounded-contexts/marketplace/features/listings/integrations/supply/supply-projection.ts",
      "bounded-contexts/ordering/features/orders/integrations/supply/supply-projection.ts",
      "bounded-contexts/pricing/features/recommendations/integrations/source/source-projection.ts",
      "bounded-contexts/discovery/support/market-support/projection.ts",
    ];
    for (const file of quantityConsumers) expect(source(file), file).toContain("inventory.item.adjusted");
    const materializedMcpArtifacts = [
      "bounded-contexts/public-presence/features/developer-portal/domain/generated/mcp-tool-catalog.ts",
      "docs/api/agent-connectors/native-mcp-registration.json",
      "bounded-contexts/public-presence/features/developer-portal/integrations/compile-developer-articles.test.ts",
      "infrastructure/platform-runtime/mcp-contracts.test.ts",
    ];
    for (const file of materializedMcpArtifacts) expect(source(file), file).not.toContain("sold-external-channel");
  });

  it("keeps Inventory facts off the pricing market trades tape", () => {
    const pricingManifest = JSON.parse(source("bounded-contexts/pricing/context.json")) as {
      eventSubscriptions: readonly { projectionName: string; sourceContextName: string }[];
    };
    expect(
      pricingManifest.eventSubscriptions
        .filter(({ projectionName }) => projectionName === "pricing-market-trades-projection")
        .map(({ sourceContextName }) => sourceContextName),
    ).not.toContain("inventory");
    expect(
      source("bounded-contexts/pricing/features/market-trades/integrations/source/source-projection.ts"),
    ).not.toContain('"inventory.');
  });
});
