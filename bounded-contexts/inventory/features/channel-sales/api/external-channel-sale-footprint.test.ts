import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const source = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const directReasonBearers = [
  "contracts/event-core/public-event-payloads/inventory.ts",
  "contracts/event-core/inventory-adjustment-reason.test.ts",
  "infrastructure/platform-runtime/mcp-contracts/catalog/inventory.ts",
  "bounded-contexts/inventory/features/inventory-items/api/route.ts",
  "bounded-contexts/inventory/features/inventory-items/api/mcp.ts",
  "bounded-contexts/inventory/features/inventory-items/api/runtime.ts",
  "bounded-contexts/inventory/features/inventory-items/domain/domain.ts",
  "bounded-contexts/inventory/features/inventory-items/read-model/ledger-projection.ts",
  "bounded-contexts/inventory/features/inventory-items/read-model/queries.ts",
  "bounded-contexts/inventory/features/inventory-items/ui/contracts.ts",
  "bounded-contexts/inventory/features/hold-collisions/api/runtime.ts",
  "bounded-contexts/inventory/support/runtime-support/inventory-adjustment-idempotency.ts",
] as const;

const quantityConsumers = [
  "bounded-contexts/checkout/features/cart/integrations/inventory/inventory-projection.ts",
  "bounded-contexts/marketplace/features/listings/integrations/supply/supply-projection.ts",
  "bounded-contexts/ordering/features/orders/integrations/supply/supply-projection.ts",
  "bounded-contexts/pricing/features/recommendations/integrations/source/source-projection.ts",
  "bounded-contexts/discovery/support/market-support/projection.ts",
] as const;

const materializedMcpArtifacts = [
  "bounded-contexts/public-presence/features/developer-portal/domain/generated/mcp-tool-catalog.ts",
  "docs/api/agent-connectors/native-mcp-registration.json",
  "bounded-contexts/public-presence/features/developer-portal/integrations/compile-developer-articles.test.ts",
  "infrastructure/platform-runtime/mcp-contracts.test.ts",
] as const;

const fingerprintCallers = [
  "bounded-contexts/inventory/features/channel-sales/api/runtime.ts",
  "bounded-contexts/inventory/features/hold-collisions/api/runtime.ts",
  "bounded-contexts/inventory/features/inventory-items/api/runtime.ts",
] as const;

describe("external channel sale caller and generated-surface inventory", () => {
  it("retains all twelve direct adjustment-reason bearers and the transitive item-detail bearer", () => {
    expect(directReasonBearers).toHaveLength(12);
    for (const file of directReasonBearers) {
      expect(source(file), file).toMatch(
        /Inventory(?:CallerSelectable)?AdjustmentReason|inventory(?:CallerSelectable)?AdjustmentReasons/,
      );
    }
    const transitive = source("bounded-contexts/inventory/features/inventory-items/ui/inventory-item-detail-page.tsx");
    expect(transitive).toContain('NonNullable<InventoryItemDetail["ledger"][number]["reason_code"]>');
    expect(transitive).toContain(
      "inventory.features.inventoryItems.ui.inventoryItemDetailPage.adjustment.reason.${reason}",
    );
  });

  it("keeps all five downstream quantity consumers on inventory.item.adjusted", () => {
    expect(quantityConsumers).toHaveLength(5);
    for (const file of quantityConsumers) {
      expect(source(file), file).toContain("inventory.item.adjusted");
    }
  });

  it("keeps sold-external-channel out of all four materialized caller-selectable MCP artifacts", () => {
    expect(materializedMcpArtifacts).toHaveLength(4);
    for (const file of materializedMcpArtifacts) {
      expect(source(file), file).not.toContain("sold-external-channel");
    }
    expect(source("infrastructure/platform-runtime/mcp-contracts/catalog/inventory.ts")).toContain(
      "inventoryCallerSelectableAdjustmentReasons",
    );
  });

  it("wires the real server contract, runtime registry, and DB profile without an approximation cast", () => {
    const server = source("bounded-contexts/inventory/server.ts");
    const registry = source("bounded-contexts/inventory/support/runtime-support/services.ts");
    expect(server).toContain("RecordExternalChannelSale");
    expect(registry).toContain("InventoryExternalChannelSaleServices");
    expect(registry).not.toMatch(/RecordExternalChannelSale[\s\S]{0,80}\bas\s*\{/);

    const packageManifest = JSON.parse(source("bounded-contexts/inventory/package.json")) as {
      scripts: Record<string, string>;
    };
    const dbTest = "features/channel-sales/api/external-channel-sale-runtime.db.test.ts";
    expect(packageManifest.scripts["test:db"]).toContain(dbTest);
    expect(packageManifest.scripts["test:unit"]).toContain(`--exclude ${dbTest}`);
    expect(source("bounded-contexts/inventory/support/runtime-support/schema.ts")).not.toMatch(
      /external[_-]channel[_-]sale/i,
    );
    expect(source("bounded-contexts/inventory/features/inventory-items/read-model/schema.ts")).not.toMatch(
      /CREATE TABLE[^;]*external[_-]channel[_-]sale/is,
    );
  });

  it("enumerates all three production callers of the shared adjustment fingerprint", () => {
    expect(fingerprintCallers).toHaveLength(3);
    for (const file of fingerprintCallers) {
      expect(source(file), file).toContain("inventoryAdjustmentCommandFingerprint(");
    }
  });
});
