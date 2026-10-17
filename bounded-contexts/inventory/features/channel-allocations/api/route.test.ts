import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { InventoryApiEnv } from "../../../api";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { inventoryChannelStockAllocationRoutes } from "./route";
import type { InventoryChannelStockAllocationServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic_allocation_route" as never,
  audit: {
    performedByUserId: "usr_synthetic_allocation_route" as never,
    forAccountId: "account-synthetic" as never,
  },
};

function app(services: InventoryChannelStockAllocationServices) {
  const root = new Hono<InventoryApiEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", { accountId: "account-synthetic", permissions: ["inventory.view", "inventory.manage"] });
    c.set("context", context);
    await next();
  });
  root.route("/items", inventoryChannelStockAllocationRoutes(services));
  return root;
}

describe("Channel Stock Allocation HTTP route", () => {
  it("reads and replaces one item's declared per-connection allocation", async () => {
    const allocation = {
      accountId: "account-synthetic",
      inventoryItemId: "item-synthetic",
      mode: "partitioned" as const,
      partitions: [{ channelConnectionId: "connection-synthetic", units: 3 }],
      revision: 1,
      setAt: "2026-09-11T18:00:00.000Z",
    };
    const read = vi.fn(async () => allocation);
    const set = vi.fn(async () => ({ kind: "applied" as const, allocation }));
    const services = {
      read,
      set,
      bind: vi.fn(),
      readAuthoritative: vi.fn(),
      projectors: [],
    } satisfies InventoryChannelStockAllocationServices;
    const routes = app(services);

    const get = await routes.request("/items/item-synthetic/channel-stock-allocation");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ allocation });
    expect(read).toHaveBeenCalledWith({ accountId: "account-synthetic", inventoryItemId: "item-synthetic" });

    const put = await routes.request("/items/item-synthetic/channel-stock-allocation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "partitioned",
        partitions: [{ channelConnectionId: "connection-synthetic", units: 3 }],
        expectedRevision: 0,
      }),
    });
    expect(put.status).toBe(200);
    expect(set).toHaveBeenCalledWith(
      {
        accountId: "account-synthetic",
        inventoryItemId: "item-synthetic",
        mode: "partitioned",
        partitions: [{ channelConnectionId: "connection-synthetic", units: 3 }],
        expectedRevision: 0,
      },
      context,
    );
  });

  it("returns a revision refusal without rewriting the response as success", async () => {
    const services = {
      read: vi.fn(),
      set: vi.fn(async () => ({
        kind: "refused" as const,
        code: "channel-stock-allocation-revision-conflict" as const,
        expectedRevision: 1,
        actualRevision: 2,
      })),
      bind: vi.fn(),
      readAuthoritative: vi.fn(),
      projectors: [],
    } satisfies InventoryChannelStockAllocationServices;
    const response = await app(services).request("/items/item-synthetic/channel-stock-allocation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "shared-pool", partitions: [], expectedRevision: 1 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "channel-stock-allocation-revision-conflict", actualRevision: 2 },
    });
  });
});
