import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createOrderingOrderMcpHandlers } from "./mcp";
import type { OrderingOrderServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["orders.view"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    status: "ready-for-fulfillment",
    lines: [],
    inventory_holds: [],
    ...overrides,
  };
}

function services(): Pick<OrderingOrderServices, "listPurchases" | "getPurchase" | "listSales" | "getSale"> {
  return {
    listPurchases: vi.fn(async () => ({ items: [orderRow()], total: 1 })),
    getPurchase: vi.fn(async (orderId, buyerAccountId) =>
      buyerAccountId === "acc_buyer" ? orderRow({ order_id: orderId, buyer_account_id: buyerAccountId }) : null,
    ),
    listSales: vi.fn(async () => ({ items: [orderRow({ seller_account_id: "acc_seller" })], total: 1 })),
    getSale: vi.fn(async () => null),
  } as unknown as Pick<OrderingOrderServices, "listPurchases" | "getPurchase" | "listSales" | "getSale">;
}

describe("ordering order MCP handlers", () => {
  it("lists purchase orders using the actor account scope", async () => {
    const fakeServices = services();
    const handlers = createOrderingOrderMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["ordering.list-orders"]?.(
      mcpRequest({ accountId: "acc_buyer", side: "purchase", limit: 10, offset: 2 }),
    );

    expect(result).toMatchObject({ accountId: "acc_buyer", side: "purchase", total: 1, count: 1 });
    expect(fakeServices.listPurchases).toHaveBeenCalledWith({ buyerAccountId: "acc_buyer", limit: 10, offset: 2 });
  });

  it("reads order details through tool and resource handlers", async () => {
    const fakeServices = services();
    const handlers = createOrderingOrderMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["ordering.get-order"]?.(mcpRequest({ accountId: "acc_buyer", orderId: "ord_1" })),
    ).resolves.toMatchObject({ accountId: "acc_buyer", side: "purchase", order: { order_id: "ord_1" } });

    await expect(
      handlers.resourceHandlers["chase-sets://ordering/{accountId}/orders/{orderId}"]?.({
        actor,
        resource: null as never,
        uri: "chase-sets://ordering/acc_buyer/orders/ord_1",
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ order: { order_id: "ord_1" } });
  });
});
