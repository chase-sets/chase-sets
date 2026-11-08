import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import type { ApiKeyServices } from "./runtime";
import { getApiKey as queryApiKey } from "../read-model/queries";
import { createApiKeyMcpHandlers } from "./mcp";
import { buildPaginationClause } from "@chase-sets/event-core-postgres";
import { createUserMcpHandlers } from "../../users/api/mcp";
import type { UserServices } from "../../users/api/runtime";
import { createAccessHubMcpHandlers } from "../../access-hub/api/mcp";
import type { AccessHubServices } from "../../access-hub/api/runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "platform-admin",
  permissions: ["security.manage"],
} satisfies ResolvedActor;

function request(arguments_: Record<string, unknown>, requestActor: ResolvedActor | null = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: null as never,
  };
}

const publicRow = {
  api_key_id: "key_1",
  user_id: "usr_1",
  user_display_name: "Operator",
  user_primary_email: "operator@example.test",
  name: "Automation",
  key_prefix: "key_public",
  status: "active",
  last_used_at: null,
  updated_at: "2026-11-08T00:00:00Z",
};

function readFixture() {
  const poisonedRow = { ...publicRow, secret_hash: "synthetic-secret-verifier" };
  const getApiKey = vi.fn<ApiKeyServices["getApiKey"]>().mockResolvedValue(poisonedRow);
  const listApiKeys = vi.fn<ApiKeyServices["listApiKeys"]>(async () => ({ items: [poisonedRow], total: 51 }));
  const commandHandler = vi.fn();
  const query = vi.fn(async () => ({ rows: [poisonedRow] }));
  const handlers = createApiKeyMcpHandlers({ getApiKey, listApiKeys, commandHandler, projectors: [] }, {
    query,
  } as never).toolHandlers;
  return { getApiKey, listApiKeys, commandHandler, query, handlers };
}

describe("identity API-key MCP handlers", () => {
  it.each(["identity.get-api-key", "identity.list-api-keys"])("publishes the read operator contract for %s", (name) => {
    const tool = findMcpTool(name)!;
    expect(tool.availability).toBe("available");
    expect(tool.risk).toBe("read");
    expect(tool.permissionBoundary.scope).toBe("operator");
    expect(tool.permissionBoundary.requiredPermissions).toEqual(["security.manage"]);
    expect(tool.permissionBoundary.requiredScopes).toEqual([]);
    expect(tool.guardrails.confirmation.required).toBe(false);
    expect(tool.guardrails.idempotencyKey).toBe("not-applicable");
    expect(tool.inputSchema.required).toEqual(name === "identity.get-api-key" ? ["apiKeyId"] : []);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      name === "identity.get-api-key" ? ["apiKeyId"] : ["search", "status", "limit", "offset"],
    );
    expect(findMcpTool("identity.create-api-key")).toBeNull();
    expect(findMcpTool("identity.rotate-api-key")).toBeNull();
  });

  it("returns only the nine public columns without consulting the secret store", async () => {
    const { handlers, query, commandHandler } = readFixture();
    const get = await handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }));
    const list = await handlers["identity.list-api-keys"]!(request({}));
    expect(get).toEqual(publicRow);
    expect(list).toEqual({ items: [publicRow], total: 51, count: 1 });
    const rows = [get, ...(list as { items: unknown[] }).items];
    for (const row of rows) {
      expect(Object.keys(row as object).sort()).toEqual(Object.keys(publicRow).sort());
      expect(row).not.toHaveProperty("secret_hash");
    }
    expect(query).not.toHaveBeenCalled();
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it.each([null, { ...actor, permissions: [] }])(
    "rejects an unauthorized actor before service calls: %j",
    async (unauthorized) => {
      const { handlers, getApiKey, listApiKeys, query, commandHandler } = readFixture();
      await expect(handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }, unauthorized))).rejects.toThrow(
        /operator is required|security.manage/,
      );
      await expect(handlers["identity.list-api-keys"]!(request({}, unauthorized))).rejects.toThrow(
        /operator is required|security.manage/,
      );
      expect(getApiKey).not.toHaveBeenCalled();
      expect(listApiKeys).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(commandHandler).not.toHaveBeenCalled();
    },
  );

  it("preserves the non-platform-admin ownership predicate and platform-admin access", async () => {
    const { handlers, getApiKey, query, commandHandler } = readFixture();
    const owner = { ...actor, roleKey: "owner" };
    await expect(handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }, owner))).resolves.toEqual(publicRow);
    getApiKey.mockResolvedValue({ ...publicRow, user_id: "usr_other" });
    await expect(handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }, owner))).rejects.toThrow(
      "cannot manage",
    );
    await expect(handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }))).resolves.toEqual({
      ...publicRow,
      user_id: "usr_other",
    });
    expect(query).not.toHaveBeenCalled();
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it.each([undefined, "usr_1", "", 123])("rejects invalid apiKeyId %j before service calls", async (apiKeyId) => {
    const { handlers, getApiKey, query } = readFixture();
    await expect(handlers["identity.get-api-key"]!(request({ apiKeyId }))).rejects.toThrow();
    expect(getApiKey).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns not found and preserves read failures rather than degrading to empty success", async () => {
    const { handlers, getApiKey, listApiKeys, query } = readFixture();
    getApiKey.mockImplementationOnce((apiKeyId) => queryApiKey({ query: async () => ({ rows: [] }) }, apiKeyId));
    await expect(handlers["identity.get-api-key"]!(request({ apiKeyId: "key_missing" }))).rejects.toThrow(
      "API key not found",
    );
    getApiKey.mockRejectedValueOnce(new Error("read unavailable"));
    listApiKeys.mockRejectedValueOnce(new Error("list unavailable"));
    await expect(handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }))).rejects.toThrow("read unavailable");
    await expect(handlers["identity.list-api-keys"]!(request({}))).rejects.toThrow("list unavailable");
    expect(query).not.toHaveBeenCalled();
  });

  it.each([undefined, "usr_other", "", "usr_1"])(
    "forces non-platform-admin list search regardless of input %j",
    async (search) => {
      const { handlers, listApiKeys } = readFixture();
      await handlers["identity.list-api-keys"]!(
        request({ search, status: "active", limit: 20, offset: 40 }, { ...actor, roleKey: "owner" }),
      );
      expect(listApiKeys).toHaveBeenCalledExactlyOnceWith({
        search: actor.userId,
        status: "active",
        limit: 20,
        offset: 40,
      });
    },
  );

  it("preserves list filters, pagination defaults and owning query bounds", async () => {
    const { handlers, listApiKeys } = readFixture();
    await handlers["identity.list-api-keys"]!(request({}));
    expect(listApiKeys).toHaveBeenLastCalledWith({
      search: undefined,
      status: undefined,
      limit: undefined,
      offset: undefined,
    });
    expect(buildPaginationClause(listApiKeys.mock.calls[0]![0]).values).toEqual([50, 0]);
    await handlers["identity.list-api-keys"]!(
      request({ search: "prefix", status: "revoked", limit: 999, offset: 99999 }),
    );
    expect(listApiKeys).toHaveBeenLastCalledWith({ search: "prefix", status: "revoked", limit: 999, offset: 99999 });
    expect(buildPaginationClause(listApiKeys.mock.calls[1]![0]).values).toEqual([500, 10000]);
  });

  it.each([{ search: 42 }, { status: false }])(
    "rejects invalid string filters before service calls: %j",
    async (args) => {
      const { handlers, listApiKeys } = readFixture();
      await expect(handlers["identity.list-api-keys"]!(request(args))).rejects.toThrow("must be a string");
      expect(listApiKeys).not.toHaveBeenCalled();
    },
  );

  it("MCP source-call contract coverage", async () => {
    const { handlers, getApiKey, listApiKeys, commandHandler, query } = readFixture();
    const listUsers = vi.fn(async () => ({ items: [{ user_id: actor.userId }], total: 1 }));
    const userHandlers = createUserMcpHandlers({ listUsers } as unknown as UserServices).toolHandlers;
    const getUserAccountLink = vi.fn(async () => ({ account_id: actor.accountId }));
    const linkHandlers = createAccessHubMcpHandlers({
      getUserAccountLink,
    } as unknown as AccessHubServices).toolHandlers;
    const readActor = { ...actor, permissions: [...actor.permissions, "accounts.view"] };
    await handlers["identity.list-api-keys"]!(request({ limit: 50, offset: 0 }));
    await userHandlers["identity.list-users"]!(request({ limit: 500, offset: 0 }));
    // Both the ordinary and pending-recovery detail branches read the key and its account link.
    for (const accountId of [actor.accountId, null]) {
      getUserAccountLink.mockResolvedValueOnce({ account_id: accountId } as never);
      await handlers["identity.get-api-key"]!(request({ apiKeyId: "key_1" }));
      await linkHandlers["identity.get-user-account-link"]!(request({ userId: publicRow.user_id }, readActor));
    }
    commandHandler.mockResolvedValueOnce({ version: 3, state: { status: "revoked" } });
    await handlers["identity.revoke-api-key"]!(
      request({ apiKeyId: "key_1", confirmed: true, confirmationText: "Revoke API Key", idempotencyKey: "revoke-1" }),
    );
    expect(listApiKeys).toHaveBeenCalledTimes(1);
    expect(listUsers).toHaveBeenCalledExactlyOnceWith({ search: undefined, status: undefined, limit: 500, offset: 0 });
    expect(getApiKey).toHaveBeenCalledTimes(3);
    expect(getUserAccountLink).toHaveBeenCalledTimes(2);
    expect(getUserAccountLink).toHaveBeenCalledWith(publicRow.user_id);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ audit: expect.objectContaining({ performedByUserId: actor.userId }) }),
      }),
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("DELETE FROM identity_api_key_secrets"), [
      "key_1",
    ]);
  });

  it("publishes the destructive operator contract", () => {
    const tool = findMcpTool("identity.revoke-api-key")!;
    expect(tool.availability).toBe("available");
    expect(tool.risk).toBe("destructive");
    expect(Object.keys(tool.inputSchema.properties)).toEqual([
      "apiKeyId",
      "idempotencyKey",
      "confirmed",
      "confirmationText",
    ]);
    expect(tool.inputSchema.required).toEqual(["apiKeyId", "idempotencyKey", "confirmed", "confirmationText"]);
    expect(tool.audit.sensitiveInputFields).toEqual(["confirmationText", "idempotencyKey"]);
  });

  it("revokes only an owned key and removes its secret verifier", async () => {
    const commandHandler = vi.fn(async () => ({ version: 3, state: { status: "revoked" } }));
    const getApiKey = vi.fn(async () => ({ api_key_id: "key_1", user_id: "usr_2" }));
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = createApiKeyMcpHandlers(
      { commandHandler, getApiKey } as unknown as ApiKeyServices,
      { query } as never,
    ).toolHandlers;
    await expect(handlers["identity.revoke-api-key"]!(request({ apiKeyId: "key_1" }))).resolves.toEqual({
      id: "key_1",
      version: 3,
      status: "revoked",
    });
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM identity_api_key_secrets"), ["key_1"]);
    getApiKey.mockResolvedValueOnce({ api_key_id: "key_1", user_id: "usr_other" });
    await expect(
      handlers["identity.revoke-api-key"]!(request({ apiKeyId: "key_1" }, { ...actor, roleKey: "owner" })),
    ).rejects.toThrow("cannot manage");
    expect(commandHandler).toHaveBeenCalledTimes(1);
  });
});
