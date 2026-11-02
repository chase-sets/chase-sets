import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { createCheckoutCartMcpHandlers, type CheckoutCartMcpServices } from "./mcp";
import type { CheckoutCartLineRow } from "../read-model/queries";
import { createCheckoutCartRuntime, type CheckoutCartServices } from "./runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import type { CheckoutCartLineOutcome } from "../../command-attempts/api/contracts";

/**
 * A complete internal Cart line row, derived from the real read-model type
 * rather than hand-shaped. It carries `buyer_account_id` because the internal
 * row does; whether that survives the MCP boundary is what these tests decide.
 */
function internalCartLineRow(overrides: Partial<CheckoutCartLineRow> = {}): CheckoutCartLineRow {
  return {
    buyer_account_id: "anon_raw_marker",
    line_id: "cli_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::condition:near-mint",
    item_language_code: "en",
    item_title: "Charizard",
    item_subtitle: null,
    item_image_url: null,
    item_image_srcset: null,
    item_image_loading_url: null,
    item_image_loading_alt: null,
    item_image_loading_srcset: null,
    selected_options: [],
    product_summary: null,
    quantity: 1,
    fulfillment_mode: "locked-listing",
    locked_listing_id: "lst_1",
    selected_listing_id: null,
    selected_listing_seller_account_id: null,
    selected_listing_seller_display_name: null,
    selected_listing_seller_slug: null,
    selected_listing_price_amount: null,
    selected_listing_snapshot_source: null,
    selected_listing_snapshot_captured_at: null,
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [],
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

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

/** Canonical lowercase UUIDv4 keys, as the owner-authoritative tools require. */
const KEYS = {
  add: "2f1b7c4e-8a3d-4f6b-9c2e-1d5a7b9e3c41",
  update: "6a9d2e1f-3b7c-4d8e-a1f2-9c3b5d7e1a02",
  remove: "9e4c1a7b-2d5f-4a3c-8b6e-7f1d3c5a9b13",
  address: "3c7e9a1b-5d2f-4b8c-9e1a-2f4d6b8c0e24",
  cancel: "7b1d3f5a-9c2e-4d6b-a8f1-3e5c7a9b1d35",
  foreign: "1a3c5e7f-9b2d-4f6a-8c1e-5b7d9f1a3c46",
} as const;

function reservationsOnlySession(sessionId: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    session_id: sessionId,
    buyer_account_id: "acc_1",
    source_type: "buy-now",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: null,
    fulfillment_preview_snapshot: null,
    shipping_option: "standard",
    shipping_address_id: null,
    shipping_address: null,
    lines: [],
    checkout_reservations: [
      {
        holdId: "hld_1",
        lineKey: "line_1",
        sellerAccountId: "acc_seller",
        inventoryItemId: "inv_1",
        quantity: 1,
        expiresAt: "2026-07-08T00:15:00.000Z",
        extensionCount: 0,
        status: "active",
      },
    ],
    order_ids: [],
    order_write_commit_positions: [],
    payment_id: null,
    submitted_offer_id: null,
    cancelled_at: null,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Per-command doubles behind the one cart entry point the MCP boundary
 * consumes. The adapter turns one attempt into these calls, forwarding the
 * attempt's event-store context, and folds their answers into a committed
 * vector; a thrown ownership refusal propagates as the real decider's would.
 */
function cartCommandDoubles() {
  return {
    addLine: vi.fn(
      async (_params: Readonly<Record<string, unknown> & { accountId: string }>, _context: EventStoreContext) => ({
        lineId: "cli_2",
        version: 2,
        status: "added" as const,
      }),
    ),
    setLineQuantity: vi.fn(
      async (
        { lineId }: Readonly<{ accountId: string; lineId: string; quantity: number }>,
        _context: EventStoreContext,
      ) => ({ lineId, version: 3 }),
    ),
    setLineFulfillment: vi.fn(
      async (
        { lineId }: Readonly<Record<string, unknown> & { accountId: string; lineId: string }>,
        _context: EventStoreContext,
      ) => ({ lineId, version: 4 }),
    ),
    removeLine: vi.fn(
      async ({ lineId }: Readonly<{ accountId: string; lineId: string }>, _context: EventStoreContext) => ({
        lineId,
        version: 5,
      }),
    ),
  };
}

function services() {
  const commands = cartCommandDoubles();
  const executeCartAttempt = vi.fn<CheckoutCartServices["executeCartAttempt"]>(async (request, context) => {
    const vector: CheckoutCartLineOutcome[] = [];
    for (const [index, command] of request.commands.entries()) {
      const { type, ...fields } = command;
      const owner = { accountId: request.ownerKey };
      const answer =
        type === "add"
          ? await commands.addLine({ ...owner, ...fields }, context)
          : type === "quantity"
            ? await commands.setLineQuantity({ ...owner, ...(fields as { lineId: string; quantity: number }) }, context)
            : type === "fulfillment"
              ? await commands.setLineFulfillment({ ...owner, ...(fields as { lineId: string }) }, context)
              : await commands.removeLine({ ...owner, ...(fields as { lineId: string }) }, context);
      vector.push({
        index,
        command: type,
        outcome: "succeeded",
        lineId: answer.lineId,
        status:
          type === "add"
            ? "added"
            : type === "quantity"
              ? "quantity-updated"
              : type === "fulfillment"
                ? "fulfillment-updated"
                : "removed",
        version: answer.version,
        message: null,
      });
    }
    return {
      replayed: false,
      result: {
        schemaVersion: 1,
        kind: request.kind,
        fingerprint: "0".repeat(64),
        actorBinding: { kind: "account", digest: "0".repeat(64) },
        target: request.target,
        requestHash: request.requestHash,
        ownerStatus: "committed",
        vector,
      },
    };
  });
  return {
    // Typed against the real Cart interface rather than cast through `unknown`:
    // a signature change on any member the MCP boundary consumes must fail this
    // double to compile before it can fail a handler at runtime.
    cart: Object.assign(
      {
        listAuthorizedCartLines: vi.fn<CheckoutCartServices["listAuthorizedCartLines"]>(async () => [
          internalCartLineRow(),
        ]),
        executeCartAttempt,
      } satisfies CheckoutCartMcpServices["cart"],
      commands,
    ),
    sessions: {
      cancelSession: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: {
          session_id: sessionId,
          cancelled_at: "2026-07-08T00:00:00.000Z",
        },
        commitPosition: "43",
        commitEventIds: ["evt_cancelled"],
        commitPositions: [{ sourceContextName: "checkout", maxGlobalPosition: "43", eventIds: ["evt_cancelled"] }],
      })),
      getSession: vi.fn(async (sessionId) => reservationsOnlySession(sessionId)),
      readSessionForCancellation: vi.fn(async ({ sessionId }) => ({
        status: "cancellable",
        session: reservationsOnlySession(sessionId),
      })),
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
    expect(fakeServices.cart.listAuthorizedCartLines).toHaveBeenCalledWith({ accountId: "acc_1" });
  });

  it("publishes Account-scoped cart lines with no owner provenance in the MCP payload", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["checkout.get-cart"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_1" },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    // The row the service returned carries `anon_raw_marker` as its owner. If
    // the boundary forwarded rows unmapped -- as it did before this slice --
    // the marker would appear verbatim in the serialized tool output.
    const [item] = (result as { items: readonly Record<string, unknown>[] }).items;
    expect(Object.keys(item ?? {})).not.toContain("buyer_account_id");
    expect(JSON.stringify(result)).not.toContain("anon_raw_marker");
    expect(JSON.stringify(result)).not.toContain("buyer_account_id");
    expect(JSON.stringify(result)).not.toContain("clearRetainedAnonymousCartCookie");
    expect(JSON.stringify(result)).not.toContain("acceptedVia");
    // Non-owner line detail still reaches the agent, so this is a targeted
    // omission rather than a blanket redaction that would pass vacuously.
    expect(item).toMatchObject({ line_id: "cli_1", item_title: "Charizard", quantity: 1 });
  });

  it("keeps checkout.get-cart Account-scoped when anonymous-looking arguments and headers are presented", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["checkout.get-cart"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        anonymousCartId: "anon_raw_marker",
        presentedAnonymousCartId: "anon_raw_marker",
        ownerKey: "anon_raw_marker",
      },
      request: new Request("https://api.test/mcp", {
        headers: { "x-checkout-anonymous-cart-id": "anon_raw_marker" },
      }),
      protocol: legacyMcpProtocol,
    });

    // MCP has no anonymous transport to guard: scope comes only from the
    // resolved actor account, so no argument or header reaches Cart at all.
    expect(fakeServices.cart.listAuthorizedCartLines).toHaveBeenCalledTimes(1);
    expect(fakeServices.cart.listAuthorizedCartLines).toHaveBeenCalledWith({ accountId: "acc_1" });
    expect(JSON.stringify(result)).not.toContain("anon_raw_marker");
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
    expect(fakeServices.cart.listAuthorizedCartLines).not.toHaveBeenCalled();
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
        idempotencyKey: KEYS.add,
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
        selectedListingSnapshot: {
          listingId: "lst_1",
          sellerAccountId: "acc_seller",
          priceAmount: "20.00",
          priceCurrencyCode: "EUR",
          listingStreamVersion: 11,
        },
        idempotencyKey: KEYS.update,
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
        selectedListingSnapshot: {
          listingId: "lst_1",
          sellerAccountId: "acc_seller",
          sellerDisplayName: null,
          sellerSlug: null,
          priceAmount: "20.00",
          priceCurrencyCode: "EUR",
          listingStreamVersion: 11,
          source: null,
        },
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
        idempotencyKey: KEYS.remove,
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
        idempotencyKey: KEYS.address,
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

  it("propagates a serviceability rejection without creating an MCP receipt", async () => {
    const fakeServices = services();
    vi.spyOn(fakeServices.sessions, "setShippingAddress").mockRejectedValue(
      new CheckoutDomainError(
        "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
        "shipping_address_restricted",
      ),
    );
    const handlers = createCheckoutCartMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["checkout.select-saved-address"]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "acc_1",
          sessionId: "chk_1",
          shippingAddressId: "adr_home",
          idempotencyKey: KEYS.address,
          confirmationText: "Select Saved Address.",
        },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toMatchObject({ code: "shipping_address_restricted" });
  });

  it("cancels checkout sessions and releases active checkout reservations", async () => {
    const fakeServices = services();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            holdId: "hld_1",
            sellerAccountId: "acc_seller",
            inventoryItemId: "inv_1",
            lineKey: "line_1",
            quantity: 1,
            expiresAt: "2026-07-08T00:15:00.000Z",
            extensionCount: 0,
            status: "released",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    try {
      const result = await handlers.toolHandlers["checkout.cancel-session"]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "acc_1",
          sessionId: "chk_1",
          idempotencyKey: KEYS.cancel,
          confirmationText: "Cancel Checkout Session.",
        },
        request: new Request("https://api.test/mcp", {
          headers: { cookie: "session=1" },
        }),
        protocol: legacyMcpProtocol,
      });

      expect(result).toMatchObject({
        accountId: "acc_1",
        id: "chk_1",
        sessionId: "chk_1",
        status: "cancelled",
        cancelledAt: "2026-07-08T00:00:00.000Z",
        releasedReservationIds: ["hld_1"],
        commitPosition: "43",
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/inventory/checkout-reservations/hld_1/release"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(fakeServices.sessions.cancelSession).toHaveBeenCalledWith(
        { sessionId: "chk_1", accountId: "acc_1" },
        expect.objectContaining({ audit: expect.objectContaining({ forAccountId: "acc_1" }) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a repeat cancel as already cancelled without a second release or command", async () => {
    const fakeServices = services();
    vi.mocked(fakeServices.sessions.readSessionForCancellation).mockResolvedValueOnce({
      status: "already-cancelled",
      session: reservationsOnlySession("chk_1", {
        cancelled_at: "2026-07-08T00:00:00.000Z",
        checkout_reservations: [],
      }) as never,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    try {
      const result = await handlers.toolHandlers["checkout.cancel-session"]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "acc_1",
          sessionId: "chk_1",
          idempotencyKey: KEYS.cancel,
          confirmationText: "Cancel Checkout Session.",
        },
        request: new Request("https://api.test/mcp", { headers: { cookie: "session=1" } }),
        protocol: legacyMcpProtocol,
      });

      expect(result).toMatchObject({
        accountId: "acc_1",
        id: "chk_1",
        sessionId: "chk_1",
        status: "already-cancelled",
        cancelledAt: "2026-07-08T00:00:00.000Z",
        releasedReservationIds: [],
        resourceUri: "chase-sets://checkout/acc_1/sessions/chk_1",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(fakeServices.sessions.cancelSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to cancel a session with orders before releasing any hold", async () => {
    const fakeServices = services();
    vi.mocked(fakeServices.sessions.readSessionForCancellation).mockRejectedValueOnce(
      new CheckoutDomainError("This checkout already created orders.", "checkout_session_not_cancellable"),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handlers = createCheckoutCartMcpHandlers(fakeServices);
    try {
      await expect(
        handlers.toolHandlers["checkout.cancel-session"]!({
          actor,
          tool: null as never,
          arguments: {
            accountId: "acc_1",
            sessionId: "chk_1",
            idempotencyKey: KEYS.cancel,
            confirmationText: "Cancel Checkout Session.",
          },
          request: new Request("https://api.test/mcp", { headers: { cookie: "session=1" } }),
          protocol: legacyMcpProtocol,
        }),
      ).rejects.toMatchObject({ code: "checkout_session_not_cancellable" });
      expect(fetch).not.toHaveBeenCalled();
      expect(fakeServices.sessions.cancelSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("checkout cart agent surface on claimed streams", () => {
  const REFUSAL = "Cart is owned by a different account.";

  function refusingServices() {
    const fakeServices = services();
    for (const method of ["addLine", "setLineQuantity", "setLineFulfillment", "removeLine"] as const) {
      vi.mocked(fakeServices.cart[method]).mockRejectedValue(new CheckoutDomainError(REFUSAL));
    }
    return fakeServices;
  }

  const invocations = [
    [
      "checkout.add-cart-line",
      {
        catalogItemId: "cat_1",
        productId: "cat_1::condition:near-mint",
        itemTitle: "Charizard",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        quantity: 1,
      },
    ],
    ["checkout.update-cart-line", { cartLineId: "cli_claimed", quantity: 3 }],
    ["checkout.remove-cart-line", { cartLineId: "cli_claimed" }],
  ] as const;

  it.each(invocations)("propagates the claimed-stream refusal from %s", async (tool, args) => {
    // The agent surface calls the same authorized service the HTTP routes do,
    // so a route-only guard would have left this path open.
    const fakeServices = refusingServices();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers[tool]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "acc_1",
          idempotencyKey: KEYS.foreign,
          confirmationText: "Confirm.",
          ...args,
        },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow(REFUSAL);
  });

  it("acts only as the agent's own Account, never an arbitrary owner key", async () => {
    const fakeServices = services();
    const handlers = createCheckoutCartMcpHandlers(fakeServices);

    // Routing resolves the source stream from the acting owner key, so an agent
    // naming a different owner must be refused before that key is used.
    await expect(
      handlers.toolHandlers["checkout.remove-cart-line"]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "anon_synthetic_claimed",
          cartLineId: "cli_claimed",
          idempotencyKey: KEYS.foreign,
          confirmationText: "Remove Cart Line.",
        },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow();
    expect(fakeServices.cart.removeLine).not.toHaveBeenCalled();
  });
});

describe("checkout cart line tools as owner-authoritative attempts", () => {
  const OTHER_ACTOR = { ...actor, accountId: "acc_2", userId: "usr_2", sessionId: "sess_2" } satisfies ResolvedActor;
  const addArgs = (accountId: string, idempotencyKey: unknown) => ({
    accountId,
    catalogItemId: "cat_1",
    productId: "cat_1::",
    itemTitle: "Charizard",
    quantity: 1,
    idempotencyKey,
    confirmationText: "Add Cart Line.",
  });

  function realCartHandlers() {
    const memory = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM checkout_catalog_items")
          ? [{ catalog_item_id: "cat_1", language_code: "en", status: "active", product_schema: null }]
          : [],
      })),
    };
    const cart = createCheckoutCartRuntime({
      eventStore: memory.eventStore,
      checkpointStore: {} as never,
      db: db as never,
    });
    const handlers = createCheckoutCartMcpHandlers({ ...services(), cart });
    const call = (tool: string, toolActor: ResolvedActor, args: Readonly<Record<string, unknown>>) =>
      handlers.toolHandlers[tool]!({
        actor: toolActor,
        tool: null as never,
        arguments: args,
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      });
    return { memory, db, call };
  }

  it("declares owner idempotency for the add, update and remove line tools", () => {
    for (const name of ["checkout.add-cart-line", "checkout.update-cart-line", "checkout.remove-cart-line"]) {
      expect(findMcpTool(name)?.guardrails).toMatchObject({
        idempotencyKey: "required",
        idempotencyAuthority: "owner",
      });
    }
  });

  it.each([
    ["missing", undefined],
    ["non-UUIDv4", "idem_add"],
    ["uppercase UUIDv4", KEYS.add.toUpperCase()],
    ["UUIDv1", "2f1b7c4e-8a3d-1f6b-9c2e-1d5a7b9e3c41"],
  ])("refuses a %s key before any read", async (_label, key) => {
    for (const tool of ["checkout.add-cart-line", "checkout.update-cart-line", "checkout.remove-cart-line"]) {
      const h = realCartHandlers();
      await expect(h.call(tool, actor, { ...addArgs("acc_1", key), cartLineId: "cli_1", quantity: 2 })).rejects.toThrow(
        "canonical UUIDv4 idempotency key",
      );
      expect(h.db.query).not.toHaveBeenCalled();
      expect(h.memory.readAllEvents()).toEqual([]);
    }
  });

  it("replays an exact retry and never replays a foreign actor's key", async () => {
    const h = realCartHandlers();

    const first = await h.call("checkout.add-cart-line", actor, addArgs("acc_1", KEYS.add));
    const eventsAfterFirst = h.memory.readAllEvents().length;
    const retry = await h.call("checkout.add-cart-line", actor, addArgs("acc_1", KEYS.add));
    await expect(
      h.call("checkout.add-cart-line", actor, { ...addArgs("acc_1", KEYS.add), quantity: 5 }),
    ).rejects.toThrow("checkout_attempt_conflict");
    const foreign = await h.call("checkout.add-cart-line", OTHER_ACTOR, addArgs("acc_2", KEYS.add));

    expect(retry).toEqual(first);
    expect(h.memory.readAllEvents().filter((event) => event.streamId === "checkout.cart-acc_1")).toHaveLength(1);
    expect(eventsAfterFirst).toBe(2);
    // The foreign actor's identical key started its own attempt on its own cart.
    expect((foreign as { cartLineId: string }).cartLineId).not.toBe((first as { cartLineId: string }).cartLineId);
    expect(h.memory.readAllEvents().filter((event) => event.streamId === "checkout.cart-acc_2")).toHaveLength(1);
  });
});
