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

const operatorActor = {
  ...actor,
  roleKey: "platform-admin",
  permissions: ["accounts.view", "accounts.manage"],
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
  const commandHandler = vi.fn(async ({ command }: { command: { type: string } }) => ({
    version: 2,
    state: { status: command.type === "CloseAccount" ? "closed" : "active", badges: ["trusted-seller"] },
  }));
  return {
    commandHandler,
    listAccounts: vi.fn(async () => ({ items: [{ account_id: "acc_1" }], total: 1 })),
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
  it("covers every operator account tool and preserves actor attribution", async () => {
    const fakeServices = services();
    const handlers = createAccountMcpHandlers(fakeServices).toolHandlers;
    const writeEnvelope = { idempotencyKey: "key-1", confirmed: true, confirmationText: "confirmed" };
    const reference = { kind: "support-request", supportRequestId: "sup_01ARYZ6S41TSV4RRFFQ69G5FAV" };

    await handlers["identity.list-accounts"]?.(mcpRequest({}, operatorActor));
    await handlers["identity.update-account-profile"]?.(
      mcpRequest({ accountId: "acc_1", name: "Updated LLC", displayName: "Updated", ...writeEnvelope }, operatorActor),
    );
    await handlers["identity.suspend-account"]?.(
      mcpRequest({ accountId: "acc_1", reason: "policy-violation", reference, ...writeEnvelope }, operatorActor),
    );
    await handlers["identity.reactivate-account"]?.(
      mcpRequest({ accountId: "acc_1", reason: "appeal-upheld", reference: null, ...writeEnvelope }, operatorActor),
    );
    await handlers["identity.close-account"]?.(
      mcpRequest({ accountId: "acc_1", reason: "seller-requested", reference, ...writeEnvelope }, operatorActor),
    );
    await handlers["identity.assign-account-badge"]?.(
      mcpRequest({ accountId: "acc_1", badgeKey: "trusted-seller", ...writeEnvelope }, operatorActor),
    );
    await handlers["identity.remove-account-badge"]?.(
      mcpRequest({ accountId: "acc_1", badgeKey: "trusted-seller", ...writeEnvelope }, operatorActor),
    );

    expect(fakeServices.commandHandler).toHaveBeenCalledTimes(6);
    expect(fakeServices.commandHandler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.objectContaining({
          type: "SuspendAccount",
          enforcement: expect.objectContaining({ reason: "policy-violation", reference }),
        }),
        context: expect.objectContaining({ audit: expect.objectContaining({ performedByUserId: "usr_1" }) }),
      }),
    );
  });

  it("rejects malformed and unauthorized enforcement input before effects", async () => {
    const fakeServices = services();
    const handler = createAccountMcpHandlers(fakeServices).toolHandlers["identity.suspend-account"];
    const envelope = {
      accountId: "acc_1",
      reason: "policy-violation",
      idempotencyKey: "key-1",
      confirmed: true,
      confirmationText: "confirmed",
    };

    await expect(
      handler?.(mcpRequest({ ...envelope, reference: { kind: "wrong", supportRequestId: "sup_bad" } }, operatorActor)),
    ).rejects.toThrow("Account enforcement reference is invalid.");
    await expect(handler?.(mcpRequest({ ...envelope, reference: null }, actor))).rejects.toThrow(
      "Missing required permission: accounts.manage.",
    );
    expect(fakeServices.commandHandler).not.toHaveBeenCalled();
  });

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
