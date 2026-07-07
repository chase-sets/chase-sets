import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createCheckoutCartMcpHandlers } from "./mcp";
import type { CheckoutCartServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["orders.view"],
} satisfies ResolvedActor;

function services(): Pick<CheckoutCartServices, "listCartLines"> {
  return {
    listCartLines: vi.fn(async (accountId) => [
      {
        line_id: "cli_1",
        buyer_account_id: accountId,
        catalog_item_id: "cat_1",
        product_id: "cat_1::condition:near-mint",
        item_title: "Charizard",
        quantity: 1,
        updated_at: "2026-07-07T00:00:00.000Z",
      },
    ]),
  } as unknown as Pick<CheckoutCartServices, "listCartLines">;
}

describe("checkout cart MCP handlers", () => {
  it("reads the actor account cart for native MCP tools", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["checkout.get-cart"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_1" },
      request: new Request("https://api.test/mcp"),
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      total: 1,
      items: [expect.objectContaining({ line_id: "cli_1", item_title: "Charizard" })],
    });
    expect(fakeServices.listCartLines).toHaveBeenCalledWith("acc_1");
  });

  it("rejects account id mismatches before reading cart state", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["checkout.get-cart"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_other" },
        request: new Request("https://api.test/mcp"),
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.listCartLines).not.toHaveBeenCalled();
  });

  it("reads cart resources by URI", async () => {
    const handlers = createCheckoutCartMcpHandlers(services());
    const result = await handlers.resourceHandlers["chase-sets://checkout/{accountId}/cart"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://checkout/acc_1/cart",
      request: new Request("https://api.test/mcp"),
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      total: 1,
    });
  });
});
