import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../../../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("channel-reconciliation-real-composition-contract", () => {
  it("binds the imported Inventory recorder and real Channels service without a decoupled cast", () => {
    const contracts = source("bounded-contexts/channels/features/reconciliation/domain/contracts.ts");
    const inventory = source("bounded-contexts/inventory/support/runtime-support/services.ts");
    const worker = source("deployables/platform-worker/src/channels-reconciliation-runners.ts");
    expect(contracts).toContain('import type { RecordExternalChannelSale } from "@chase-sets/inventory/server"');
    expect(inventory).toContain("createInventoryExternalChannelSaleRuntime(deps, holdCollisions).bind(context)");
    expect(worker).toContain("createInventoryExternalChannelSaleRecorderForPool");
    expect(worker).toContain("ReturnType<typeof channelsModule.createServices>");
    expect(worker).not.toMatch(/runtime\.services\.inventory\s+as\s+\{/);
    expect(worker).not.toMatch(/channelSaleRecorder[\s\S]{0,120}\bthrow\b/);
  });

  it("keeps the queue-owned hold interface required and checks both actual admission paths", () => {
    const contracts = source("bounded-contexts/channels/features/outbound-sync/domain/contracts.ts");
    const inline = source("bounded-contexts/channels/features/outbound-sync/api/runtime.ts");
    const claimed = source("bounded-contexts/channels/features/outbound-sync/api/store.ts");
    expect(contracts).toContain("readAdditionalOutboundHold:");
    expect(contracts).not.toContain("readAdditionalOutboundHold?:");
    expect(inline).toContain("await dependencies.readAdditionalOutboundHold");
    expect(claimed).toContain("await dependencies.readAdditionalOutboundHold");
  });

  it("keeps claimed publication memberless while inline carries exactly the two reconciliation reads", () => {
    const contracts = source("bounded-contexts/channels/features/publication-port/domain/contracts.ts");
    expect(contracts).toContain('| { execution: "claimed" }');
    expect(contracts).toContain("fetchChannelState(");
    expect(contracts).toContain("fetchSales(");
    expect(contracts).not.toMatch(/execution:\s*"claimed"[\s\S]{0,120}fetchChannelState/);
  });
});
