import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createSupportRequestMcpHandlers } from "./mcp";
import type { SupportRequestServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["support.view"],
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

function supportRequest(overrides: Record<string, unknown> = {}) {
  return {
    support_request_id: "sup_1",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    flow_type: "product-not-received",
    status: "resolved",
    priority: "normal",
    pending_offer: null,
    resolution: { kind: "partial-refund", amount: "5.00" },
    closed_at: null,
    cancellation_reason: null,
    ...overrides,
  };
}

function services(): Pick<
  SupportRequestServices,
  "listBuyerSupportRequests" | "listSellerSupportRequests" | "getAccountSupportRequest"
> {
  return {
    listBuyerSupportRequests: vi.fn(async () => ({ items: [supportRequest()], total: 1 })),
    listSellerSupportRequests: vi.fn(async () => ({
      items: [supportRequest({ seller_account_id: "acc_seller" })],
      total: 1,
    })),
    getAccountSupportRequest: vi.fn(async (supportRequestId, accountId) =>
      accountId === "acc_buyer"
        ? { ...supportRequest({ support_request_id: supportRequestId }), evidence: [], responses: [], offers: [] }
        : null,
    ),
  } as unknown as Pick<
    SupportRequestServices,
    "listBuyerSupportRequests" | "listSellerSupportRequests" | "getAccountSupportRequest"
  >;
}

describe("support request MCP handlers", () => {
  it("lists buyer support requests using account scope", async () => {
    const fakeServices = services();
    const handlers = createSupportRequestMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["platform-operations.list-support-requests"]?.(
      mcpRequest({ accountId: "acc_buyer", side: "buyer", limit: 10, offset: 1 }),
    );

    expect(result).toMatchObject({ accountId: "acc_buyer", side: "buyer", total: 1, count: 1 });
    expect(fakeServices.listBuyerSupportRequests).toHaveBeenCalledWith({
      buyerAccountId: "acc_buyer",
      limit: 10,
      offset: 1,
    });
  });

  it("reads support status through tool and resource handlers", async () => {
    const fakeServices = services();
    const handlers = createSupportRequestMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["platform-operations.get-support-request"]?.(
        mcpRequest({ accountId: "acc_buyer", supportRequestId: "sup_1" }),
      ),
    ).resolves.toMatchObject({
      status: { supportRequestId: "sup_1", status: "resolved", resolution: { kind: "partial-refund" } },
    });

    await expect(
      handlers.resourceHandlers["chase-sets://platform-operations/{accountId}/support-requests/{supportRequestId}"]?.({
        actor,
        resource: null as never,
        uri: "chase-sets://platform-operations/acc_buyer/support-requests/sup_1",
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ supportRequest: { support_request_id: "sup_1" } });
  });
});
