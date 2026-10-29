import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { contextManifest } from "@chase-sets/identity";
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
  permissions: ["memberships.manage", "memberships.view"],
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

const sourceCalls = [
  { route: "memberships", method: "listMemberships", tool: "identity.list-memberships" },
  { route: "memberships-detail", method: "getMembership", tool: "identity.get-membership" },
  { route: "memberships-detail", method: "changeMembershipRole", tool: "identity.change-membership-role" },
  { route: "memberships-detail", method: "revokeMembership", tool: "identity.revoke-membership" },
  { route: "memberships-detail", method: "reinstateMembership", tool: "identity.reinstate-membership" },
] as const;

function assertSourceCallCoverage(handlers: Readonly<Record<string, unknown>>) {
  for (const route of ["memberships", "memberships-detail"] as const) {
    const source = readFileSync(new URL(`../../../routes/admin/${route}.tsx`, import.meta.url), "utf8");
    const traced = [
      ...new Set([
        ...[...source.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]),
        ...[...source.matchAll(/\bcreateIdentityRequestApiClient\([\s\S]*?\)\s*\.\s*(\w+)/g)].map((match) => match[1]),
      ]),
    ];
    const mapped = sourceCalls.filter((call) => call.route === route);
    expect(mapped.map((call) => call.method).sort()).toEqual(traced.sort());
    expect([...new Set(contextManifest.agentCoverage[route].tools)].sort()).toEqual(
      [...new Set(mapped.map((call) => call.tool))].sort(),
    );
    for (const call of mapped) {
      expect(handlers[call.tool], call.tool).toBeTypeOf("function");
      expect(findMcpTool(call.tool)?.availability, call.tool).toBe("available");
    }
  }
}

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
    expect(findMcpTool("identity.get-membership")?.inputSchema.required).toEqual(["membershipId"]);
    expect(findMcpTool("identity.list-memberships")?.inputSchema.required).toEqual([]);
  });

  it("MCP source-call contract coverage: memberships preserve read predicates", async () => {
    const f = services();
    const listMemberships = vi.fn(async () => ({ items: [membership], total: 1 }));
    const handlers = createMembershipMcpHandlers(
      { ...f.services, listMemberships } as never,
      f.accounts as never,
    ).toolHandlers;
    assertSourceCallCoverage(handlers);
    await expect(
      handlers["identity.list-memberships"]!(request({ search: "platform-admin", limit: 3 })),
    ).resolves.toMatchObject({
      total: 1,
    });
    expect(listMemberships).toHaveBeenCalledWith({ search: "acc_1", status: undefined, limit: 3, offset: undefined });
    f.getMembership.mockResolvedValueOnce({ ...membership, account_id: "acc_other", role_key: "platform-admin" });
    await expect(handlers["identity.get-membership"]!(request({ membershipId: "mbr_1" }))).rejects.toThrow(
      "cannot view",
    );
    const platformActor = {
      ...actor,
      roleKey: "platform-admin",
      permissions: ["memberships.view", "memberships.manage"],
    } as ResolvedActor;
    f.getMembership.mockResolvedValueOnce({ ...membership, account_id: "acc_other", role_key: "platform-admin" });
    await expect(
      handlers["identity.get-membership"]!(request({ membershipId: "mbr_1" }, platformActor)),
    ).resolves.toMatchObject({
      role_key: "platform-admin",
    });
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
