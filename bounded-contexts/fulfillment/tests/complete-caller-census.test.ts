import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fulfillmentRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function source(relative: string, root = fulfillmentRoot) {
  return readFileSync(path.join(root, relative), "utf8");
}

const context = JSON.parse(source("context.json")) as {
  mutationConsistencyInventory: readonly { surfaces: readonly string[] }[];
};

describe("Shipment mutation caller census", () => {
  it("issue-7171-complete-caller-census keeps every HTTP, MCP, source, fallback, worker, seed, and raw-fetch rail classified", () => {
    const mutationSurfaces = context.mutationConsistencyInventory.flatMap((entry) => entry.surfaces);
    expect(mutationSurfaces).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^raw-fetch:.*shipment-mutation-boundary\.tsx:GET /),
        expect.stringMatching(/^raw-fetch:.*shipment-packing-page\.tsx:POST /),
        "api-route:bounded-contexts/fulfillment/features/shipments/api/route.ts:POST /sales/shipments/:id/label",
        "api-route:bounded-contexts/fulfillment/features/shipments/api/route.ts:POST /sales/shipments/:id/label/purchase",
        "api-route:bounded-contexts/fulfillment/features/shipments/api/route.ts:POST /sales/shipments/:id/label/void",
      ]),
    );

    const mcpCatalog = source("infrastructure/platform-runtime/mcp-contracts/catalog/fulfillment.ts", repoRoot);
    expect(mcpCatalog.match(/\.\.\.writeTool\(/g)).toHaveLength(5);
    expect(mcpCatalog).toContain('idempotencyAuthority: "owner" as const');
    for (const tool of [
      "fulfillment.purchase-label",
      "fulfillment.advance-shipment",
      "fulfillment.dispatch-shipment",
      "fulfillment.raise-shipment-exception",
      "fulfillment.void-label",
    ]) {
      expect(mcpCatalog).toContain(`"${tool.split(".")[1]}"`);
    }

    const composition = source("index.ts");
    for (const callback of ["onReadyForFulfillment", "onOrderCancelled", "onFraudWarningReceived"]) {
      expect(composition.match(new RegExp(callback, "g"))).toHaveLength(1);
    }
    const runtimeCommandKinds = [...source("features/shipments/api/runtime.ts").matchAll(/commandKind:\s*"([^"]+)"/g)]
      .map((match) => match[1])
      .sort();
    expect(runtimeCommandKinds).toEqual([
      "attach-manual-label",
      "confirm-packing-line",
      "deliver-shipment",
      "dispatch-shipment",
      "prepare-package",
      "purchase-usps-label",
      "raise-shipment-exception",
      "return-shipment",
      "set-packing-line-quantity",
      "start-packing",
      "unconfirm-packing-line",
      "void-label",
    ]);
    const services = source("support/runtime-support/services.ts");
    expect(services.match(/returnTrackingFallback/g)).toHaveLength(1);
    const worker = source("deployables/platform-worker/src/scheduled-runners.ts", repoRoot);
    expect(worker.match(/listStalePostageOperationLocators/g)).toHaveLength(3);
    expect(worker.match(/reconcilePostageOperationLocator/g)).toHaveLength(3);
    const seed = source("support/runtime-support/seed.ts");
    expect(seed.match(/services\.shipments\.commandHandler/g)).toHaveLength(1);
  });
});
