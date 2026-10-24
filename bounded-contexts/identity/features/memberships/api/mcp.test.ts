import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import type { MembershipServices } from "./runtime";
import { createMembershipMcpHandlers } from "./mcp";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_admin",
  roleKey: "owner",
  permissions: ["memberships.manage"],
} satisfies ResolvedActor;

const membership: Record<string, unknown> = {
  membership_id: "mbr_1",
  user_id: "usr_2",
  user_display_name: "Member",
  user_primary_email: "member@example.test",
  account_id: "acc_1",
  account_display_name: "Seller",
  account_name: "seller",
  role_key: "manager",
  role_permissions: [],
  status: "active",
  updated_at: "2026-10-01T00:00:00.000Z",
} as const;

function request(arguments_: Record<string, unknown>, requestActor: ResolvedActor | null = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: null as never,
  };
}

function services(overrides: Record<string, unknown> = {}) {
  const commandHandler = vi.fn(async () => ({ version: 2, state: { status: "active" } }));
  const getMembership = vi.fn(async () => membership);
  const countActiveOwnersForAccount = vi.fn(async () => 2);
  return {
    services: {
      commandHandler,
      getMembership,
      countActiveOwnersForAccount,
      ...overrides,
    } as unknown as MembershipServices,
    accounts: { getAccountState: vi.fn(async () => ({ status: "active" })) },
    commandHandler,
    getMembership,
    countActiveOwnersForAccount,
  };
}

describe("identity membership MCP handlers", () => {
  it("publishes exact schemas and operator boundaries", () => {
    for (const [name, risk] of [
      ["identity.change-membership-role", "sensitive"],
      ["identity.revoke-membership", "destructive"],
      ["identity.reinstate-membership", "sensitive"],
    ] as const) {
      const tool = findMcpTool(name)!;
      expect(tool.availability).toBe("available");
      expect(tool.risk).toBe(risk);
      expect(tool.permissionBoundary).toMatchObject({
        scope: "operator",
        accountScoped: false,
        requiredPermissions: ["memberships.manage"],
      });
    }
  });

  it("executes role, revoke, and reinstate commands with the operator actor context", async () => {
    const f = services();
    const handlers = createMembershipMcpHandlers(f.services, f.accounts as never).toolHandlers;
    await handlers["identity.change-membership-role"]!(request({ membershipId: "mbr_1", roleKey: "viewer" }));
    expect(f.commandHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "ChangeMembershipRole", roleKey: "viewer" }),
      }),
    );
    await handlers["identity.revoke-membership"]!(request({ membershipId: "mbr_1" }));
    await handlers["identity.reinstate-membership"]!(request({ membershipId: "mbr_1" }));
    expect(f.commandHandler).toHaveBeenCalledTimes(3);
  });

  it("rejects wrong accounts, privileged targets, and last-owner removal before effects", async () => {
    const f = services();
    const handlers = createMembershipMcpHandlers(f.services, f.accounts as never).toolHandlers;
    await expect(
      handlers["identity.revoke-membership"]!(request({ membershipId: "mbr_1" }, { ...actor, accountId: "acc_other" })),
    ).rejects.toThrow("cannot manage");
    f.getMembership.mockResolvedValueOnce({ ...membership, role_key: "platform-admin" });
    await expect(handlers["identity.revoke-membership"]!(request({ membershipId: "mbr_1" }))).rejects.toThrow(
      "human presence",
    );
    f.getMembership.mockResolvedValueOnce({ ...membership, role_key: "owner" });
    f.countActiveOwnersForAccount.mockResolvedValueOnce(1);
    await expect(handlers["identity.revoke-membership"]!(request({ membershipId: "mbr_1" }))).rejects.toThrow(
      "last owner",
    );
    expect(f.commandHandler).not.toHaveBeenCalled();
  });
});
