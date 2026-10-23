import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createUserMcpHandlers } from "./mcp";
import type { UserServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["security.manage", "accounts.view"],
} satisfies ResolvedActor;

const legacyProtocol = {
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
    protocol: legacyProtocol,
  };
}

function userServices() {
  const commandHandler = vi.fn(async ({ streamId }: { streamId: string }) => ({
    version: 2,
    state: { status: "active" },
    streamId,
  }));
  return {
    commandHandler,
    listUsers: vi.fn(async () => ({ items: [{ user_id: "usr_1" }], total: 1 })),
    getUser: vi.fn(async () => ({ user_id: "usr_1" })),
  } as unknown as UserServices & { commandHandler: typeof commandHandler };
}

describe("identity users MCP handlers", () => {
  it("MCP source-call contract coverage exercises every mapped tool", async () => {
    const users = userServices();
    const handlers = createUserMcpHandlers(users).toolHandlers;
    const writeEnvelope = { idempotencyKey: "key-1", confirmed: true, confirmationText: "confirmed" };

    await handlers["identity.list-users"]?.(request({}));
    await handlers["identity.update-user-profile"]?.(
      request({ userId: "usr_1", displayName: "Updated", givenName: "Updated", familyName: "User", ...writeEnvelope }),
    );
    await handlers["identity.add-user-contact-method"]?.(
      request({ userId: "usr_1", contactMethodType: "email", value: "new@example.test", ...writeEnvelope }),
    );
    await handlers["identity.verify-user-contact-method"]?.(
      request({ userId: "usr_1", contactMethodId: "ctm_01ARZ3NDEKTSV4RRFFQ69G5FAV", ...writeEnvelope }),
    );
    await handlers["identity.enable-user-auth-method"]?.(
      request({ userId: "usr_1", authMethod: "passkey", ...writeEnvelope }),
    );
    await handlers["identity.disable-user-auth-method"]?.(
      request({ userId: "usr_1", authMethod: "passkey", ...writeEnvelope }),
    );
    await handlers["identity.suspend-user"]?.(request({ userId: "usr_1", ...writeEnvelope }));
    await handlers["identity.reactivate-user"]?.(request({ userId: "usr_1", ...writeEnvelope }));

    expect(users.commandHandler).toHaveBeenCalledTimes(7);
    expect(users.commandHandler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        streamId: "identity.user-usr_1",
        command: { type: "UpdateUserProfile", displayName: "Updated", givenName: "Updated", familyName: "User" },
      }),
    );
  });

  it("rejects a target outside the operator's user policy before effects", async () => {
    const users = userServices();
    const handlers = createUserMcpHandlers(users).toolHandlers;
    const selfOnly = { ...actor, roleKey: "manager" as const, permissions: ["security.manage", "accounts.view"] };

    await expect(
      handlers["identity.suspend-user"]?.(
        request(
          { userId: "usr_other", idempotencyKey: "key-1", confirmed: true, confirmationText: "confirmed" },
          selfOnly,
        ),
      ),
    ).rejects.toThrow("cannot manage this user");
    expect(users.commandHandler).not.toHaveBeenCalled();
  });

  it("preserves source validation and server-generated contact ids", async () => {
    const users = userServices();
    const handlers = createUserMcpHandlers(users).toolHandlers;

    await expect(
      handlers["identity.enable-user-auth-method"]?.(
        request({
          userId: "usr_1",
          authMethod: "invalid",
          idempotencyKey: "key-1",
          confirmed: true,
          confirmationText: "confirmed",
        }),
      ),
    ).rejects.toThrow("authMethod must be one of");
    await handlers["identity.add-user-contact-method"]?.(
      request({
        userId: "usr_1",
        contactMethodType: "email",
        value: "user@example.test",
        idempotencyKey: "key-2",
        confirmed: true,
        confirmationText: "confirmed",
      }),
    );
    expect(users.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "AddContactMethod", contactMethodId: expect.stringMatching(/^ctm_/) }),
      }),
    );
  });
});
