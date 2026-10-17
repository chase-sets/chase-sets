import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventoryAdjustmentReasons,
  inventoryCallerSelectableAdjustmentReasons,
  inventoryOfflineSaleChannels,
} from "@chase-sets/event-core/public-event-payloads";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const source = (relativePath: string) =>
  readFileSync(path.join(repositoryRoot, relativePath), "utf8").replace(/\r\n/g, "\n");

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
    expect(inventoryCallerSelectableAdjustmentReasons).toEqual([
      "sold-offline",
      "damaged",
      "lost",
      "found",
      "correction",
      "intake",
      "return-restocked",
    ]);
    expect(inventoryOfflineSaleChannels).toEqual(["in-store", "card-show", "other"]);
  });

  it("keeps the #7326 server and event payload registrations intact", () => {
    expect(source("bounded-contexts/inventory/server.ts")).toContain(`export type {
  CommittedExternalChannelSale,
  ExternalChannelSaleConflictField,
  ExternalChannelSaleHistoryFailure,
  ExternalChannelSaleHistoryFailureReason,
  ExternalChannelSaleKeyV1,
  RecordExternalChannelSale,
  RecordExternalChannelSaleCommand,
  RecordExternalChannelSaleConflict,
  RecordExternalChannelSaleOutcome,
  RecordExternalChannelSaleResult,
} from "./features/channel-sales/api/contracts";`);
    expect(source("contracts/event-core/public-event-payloads/inventory.ts")).toContain(
      '"inventory.external-channel-sale.recorded": InventoryExternalChannelSaleRecordedPayload;',
    );
  });

  it("keeps the five quantity consumers and exact four caller-selectable MCP artifacts unchanged in role", () => {
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
    const exactCallerSelectableEnum = JSON.stringify(inventoryCallerSelectableAdjustmentReasons);
    for (const file of materializedMcpArtifacts) {
      const materialized = source(file);
      expect(materialized.replace(/\s/g, ""), file).toContain(exactCallerSelectableEnum);
      expect(materialized, file).not.toContain("sold-external-channel");
    }
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
