import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createMcpRoutes } from "@chase-sets/platform-runtime/mcp";
import { identityService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/identity";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { createIdentityMcpHandlers } from "./mcp";

const actor: ResolvedActor = {
  sessionId: "sess_synthetic9674",
  tenantId: "tnt_synthetic9674",
  userId: "usr_synthetic9674",
  accountId: "acc_operator9674",
  membershipId: "mbr_synthetic9674",
  roleKey: "platform-admin",
  permissions: ["accounts.manage"],
};

function harness() {
  const submit = vi.fn(async () => ({ outcome: "indeterminate", code: "INDETERMINATE" }));
  const commandHandler = vi.fn(async () => ({ version: 2, state: { id: "acc_target9674", status: "active" } }));
  const services = { accounts: { commandHandler }, accountManagement: { submit } } as unknown as IdentityServices;
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      services: [identityService],
      toolHandlers: createIdentityMcpHandlers(services).toolHandlers,
      operatorAuthority: async () => ({
        kind: "granted",
        membershipId: actor.membershipId,
        roleKey: "platform-admin",
        rolePermissions: actor.permissions,
      }),
    }),
  );
  const call = async (name: string, fields: Record<string, unknown>) => {
    const title = identityService.tools.find((tool) => tool.name === name)!.title;
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: { ...fields, idempotencyKey: "synthetic9674-key", confirmed: true, confirmationText: `${title}.` },
        },
      }),
    });
    return response.json();
  };
  return { call, submit, commandHandler };
}

describe("identity MCP account-management boundaries", () => {
  it("MCP source-call contract coverage: never forwards platform idempotency to the account-only command path", async () => {
    const { call, submit, commandHandler } = harness();
    await call("identity.update-account-profile", {
      accountId: "acc_target9674",
      name: "Target",
      displayName: "Target",
    });
    expect(submit).not.toHaveBeenCalled();
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "identity.account-acc_target9674",
        context: expect.objectContaining({ audit: { performedByUserId: actor.userId, forAccountId: actor.accountId } }),
      }),
    );
  });

  it("accepts the source account-enforcement contract's explicit null reference", async () => {
    const { call, commandHandler } = harness();
    const response = await call("identity.suspend-account", {
      accountId: "acc_target9674",
      reason: "operator-other",
      reference: null,
    });
    expect(response.result.isError).not.toBe(true);
    expect(commandHandler).toHaveBeenCalledOnce();
  });
});
