import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createCheckoutCartMcpHandlers, type CheckoutCartMcpServices } from "./mcp";
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

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function services(): CheckoutCartMcpServices {
  return {
    cart: {
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
      addLine: vi.fn(async () => ({ lineId: "cli_2", version: 2, status: "added" })),
      setLineQuantity: vi.fn(async ({ lineId }) => ({ lineId, version: 3 })),
      setLineFulfillment: vi.fn(async ({ lineId }) => ({ lineId, version: 4 })),
      removeLine: vi.fn(async ({ lineId }) => ({ lineId, version: 5 })),
    } as unknown as CheckoutCartMcpServices["cart"],
    sessions: {
      setShippingAddress: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: null,
        commitPosition: "42",
        commitEventIds: ["evt_address"],
        commitPositions: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_address"] }],
      })),
    } as unknown as CheckoutCartMcpServices["sessions"],
    listSavedShippingAddresses: vi.fn(async (accountId) => [
      {
        shipping_address_id: "adr_home",
        account_id: accountId,
        label: "Home",
        recipient_name: "Jane Smith",
        company: null,
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postal_code: "60601",
        country: "US",
        phone: "312-555-0100",
        email: "jane@example.com",
        is_default: true,
        updated_at: "2026-07-07T00:00:00.000Z",
      },
    ]),
  };
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
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      total: 1,
      items: [expect.objectContaining({ line_id: "cli_1", item_title: "Charizard" })],
    });
    expect(fakeServices.cart.listCartLines).toHaveBeenCalledWith("acc_1");
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
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.cart.listCartLines).not.toHaveBeenCalled();
  });

  it("adds cart lines through Checkout and returns an MCP write receipt", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["checkout.add-cart-line"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        catalogItemId: "cat_1",
        productId: "cat_1::condition:near-mint",
        itemTitle: "Charizard",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        quantity: 2,
        idempotencyKey: "idem_add",
        confirmationText: "Add Cart Line.",
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "cli_2",
      cartLineId: "cli_2",
      version: 2,
      status: "added",
      resourceUri: "chase-sets://checkout/acc_1/cart",
    });
    expect(fakeServices.cart.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        catalogItemId: "cat_1",
        quantity: 2,
      }),
      expect.objectContaining({ audit: expect.objectContaining({ forAccountId: "acc_1" }) }),
    );
  });

  it("updates cart line quantity and fulfillment through Checkout", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["checkout.update-cart-line"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        cartLineId: "cli_1",
        quantity: 3,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        selectedListingSnapshot: { listingId: "lst_1", sellerAccountId: "acc_seller" },
        idempotencyKey: "idem_update",
        confirmationText: "Update Cart Line.",
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "cli_1",
      cartLineId: "cli_1",
      version: 4,
      status: "updated",
      quantity: 3,
    });
    expect(fakeServices.cart.setLineQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_1", lineId: "cli_1", quantity: 3 }),
      expect.anything(),
    );
    expect(fakeServices.cart.setLineFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        lineId: "cli_1",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
      }),
      expect.anything(),
    );
  });

  it("removes cart lines through Checkout", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["checkout.remove-cart-line"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        cartLineId: "cli_1",
        idempotencyKey: "idem_remove",
        confirmationText: "Remove Cart Line.",
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "cli_1",
      cartLineId: "cli_1",
      version: 5,
      status: "removed",
    });
  });

  it("selects saved shipping addresses on checkout sessions", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["checkout.select-saved-address"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        sessionId: "chk_1",
        shippingAddressId: "adr_home",
        idempotencyKey: "idem_address",
        confirmationText: "Select Saved Address.",
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "chk_1",
      sessionId: "chk_1",
      shippingAddressId: "adr_home",
      status: "shipping-address-selected",
      commitPosition: "42",
    });
    expect(fakeServices.sessions.setShippingAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        accountId: "acc_1",
        shippingAddress: expect.objectContaining({
          shippingAddressId: "adr_home",
          postalCode: "60601",
        }),
      }),
      expect.objectContaining({ audit: expect.objectContaining({ forAccountId: "acc_1" }) }),
    );
  });

  it("reads cart resources by URI", async () => {
    const handlers = createCheckoutCartMcpHandlers(services());
    const result = await handlers.resourceHandlers["chase-sets://checkout/{accountId}/cart"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://checkout/acc_1/cart",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      total: 1,
    });
  });
});
