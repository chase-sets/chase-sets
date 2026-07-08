import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createAccountMcpHandlers } from "./mcp";
import type { AccountServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["accounts.view"],
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

function services(): AccountServices {
  return {
    getAccountForRead: vi.fn(async (accountId) => ({
      account_id: accountId,
      account_type: "personal",
      badges: ["founding-account"],
      display_name: "Seller Account",
      name: "Seller Account LLC",
      status: "active",
      updated_at: "2026-07-08T00:00:00.000Z",
    })),
  } as unknown as AccountServices;
}

describe("identity account MCP handlers", () => {
  it("reads the authenticated account profile", async () => {
    const fakeServices = services();
    const handlers = createAccountMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["identity.get-account"]?.(mcpRequest({ accountId: "acc_1" }));

    expect(result).toMatchObject({
      account_id: "acc_1",
      display_name: "Seller Account",
      status: "active",
      badges: ["founding-account"],
    });
    expect(fakeServices.getAccountForRead).toHaveBeenCalledWith("acc_1");
  });

  it("rejects account mismatches before reading account data", async () => {
    const fakeServices = services();
    const handlers = createAccountMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["identity.get-account"]?.(mcpRequest({ accountId: "acc_other" })),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.getAccountForRead).not.toHaveBeenCalled();
  });

  it("reads account resources by URI", async () => {
    const handlers = createAccountMcpHandlers(services());

    const result = await handlers.resourceHandlers["chase-sets://identity/{accountId}/account"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://identity/acc_1/account",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({ account_id: "acc_1", status: "active" });
  });
});
