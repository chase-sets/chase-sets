import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import type { ApiKeyServices } from "./runtime";
import { createApiKeyMcpHandlers } from "./mcp";

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

describe("identity API-key MCP handlers", () => {
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
