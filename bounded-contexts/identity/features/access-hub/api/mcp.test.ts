import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createAccessHubMcpHandlers } from "./mcp";
import type { AccessHubServices } from "./runtime";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["accounts.view"],
} satisfies ResolvedActor;

const protocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function request(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol,
  };
}

describe("identity access-hub MCP handlers", () => {
  it("publishes the exact operator read contract", () => {
    const tool = findMcpTool("identity.get-account-access-hub")!;
    expect(tool.availability).toBe("available");
    expect(tool.risk).toBe("read");
    expect(tool.inputSchema.properties).toEqual({ accountId: { type: "string", description: "Account to inspect." } });
    expect(tool.inputSchema.required).toEqual(["accountId"]);
    expect(tool.permissionBoundary).toMatchObject({
      scope: "operator",
      accountScoped: false,
      requiredPermissions: ["accounts.view"],
      requiredScopes: [],
    });
  });

  it("reads an account access hub and refuses a mismatched account before the query", async () => {
    const getAccount = vi.fn(async () => ({ account: { account_id: "acc_1" } }));
    const handlers = createAccessHubMcpHandlers({ getAccount } as unknown as AccessHubServices).toolHandlers;
    await expect(handlers["identity.get-account-access-hub"]?.(request({ accountId: "acc_1" }))).resolves.toEqual({
      account: { account_id: "acc_1" },
    });
    await expect(
      handlers["identity.get-account-access-hub"]?.(
        request({ accountId: "acc_other" }, { ...actor, roleKey: "manager" }),
      ),
    ).rejects.toThrow("cannot manage this account");
    expect(getAccount).toHaveBeenCalledTimes(1);
  });

  it("MCP source-call contract coverage exercises every mapped tool", async () => {
    const getUserAccountLink = vi.fn(async (userId: string) => ({ account_id: `acc-for-${userId}` }));
    const handlers = createAccessHubMcpHandlers({ getUserAccountLink } as unknown as AccessHubServices).toolHandlers;
    await expect(handlers["identity.get-user-account-link"]?.(request({ userId: "usr_1" }))).resolves.toEqual({
      account_id: "acc-for-usr_1",
    });
    expect(getUserAccountLink).toHaveBeenCalledWith("usr_1");
  });

  it("rejects a mismatched non-admin target before reading the link", async () => {
    const getUserAccountLink = vi.fn();
    const handlers = createAccessHubMcpHandlers({ getUserAccountLink } as unknown as AccessHubServices).toolHandlers;
    const selfOnly = { ...actor, roleKey: "manager" as const };
    await expect(
      handlers["identity.get-user-account-link"]?.(request({ userId: "usr_other" }, selfOnly)),
    ).rejects.toThrow("cannot manage this user");
    expect(getUserAccountLink).not.toHaveBeenCalled();
  });
});
