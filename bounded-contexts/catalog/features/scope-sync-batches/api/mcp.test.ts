import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OperatorAuthorityDecision } from "@chase-sets/auth-context";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createMcpRoutes, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { flattenAvailableMcpTools } from "@chase-sets/platform-runtime/mcp-contracts";
import type { ScopeSyncBatchServices } from "./runtime";
import { createScopeSyncBatchMcpHandlers } from "./mcp";

const operator = {
  sessionId: "sess_operator",
  tenantId: "tenant",
  userId: "user_operator",
  accountId: "account_operator",
  membershipId: "membership",
  roleKey: "platform-admin",
  permissions: ["catalog.manage"],
} satisfies ResolvedActor;
const owner = { ...operator, roleKey: "owner" } satisfies ResolvedActor;

const granted: OperatorAuthorityDecision = {
  kind: "granted",
  membershipId: operator.membershipId,
  roleKey: "platform-admin",
  rolePermissions: operator.permissions,
};
const denied: OperatorAuthorityDecision = { kind: "denied", reason: "not-platform-admin" };

function services() {
  return {
    preview: vi.fn().mockResolvedValue({ status: "ready" }),
    confirm: vi.fn().mockResolvedValue({ batchId: "job_1" }),
    get: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    retryUnit: vi.fn(),
  } as unknown as ScopeSyncBatchServices;
}

describe("Scope Sync Batch MCP handlers", () => {
  function harness(runtime = services()) {
    let currentActor: ResolvedActor | null = operator;
    let authority: OperatorAuthorityDecision = granted;
    const handlers = createScopeSyncBatchMcpHandlers(runtime).toolHandlers;
    const seen = vi.fn((input: Parameters<McpToolHandler>[0]) => handlers[input.tool.name]!(input));
    const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
    app.use("*", async (c, next) => {
      c.set("actor", currentActor);
      await next();
    });
    app.route(
      "/",
      createMcpRoutes({
        toolHandlers: Object.fromEntries(Object.keys(handlers).map((name) => [name, seen])),
        operatorAuthority: async () => authority,
        allowInMemoryIdempotencyStoreForTests: true,
      }),
    );
    return {
      runtime,
      seen,
      setActor: (actor: ResolvedActor | null) => (currentActor = actor),
      setAuthority: (value: OperatorAuthorityDecision) => (authority = value),
      async request(
        method: string,
        name?: string,
        args: Record<string, unknown> = {},
        confirmation?: Record<string, unknown>,
      ) {
        const response = await app.request("/", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "request_1",
            method,
            params: name ? { name, arguments: args, ...(confirmation ? { confirmation } : {}) } : {},
          }),
        });
        return response.json() as Promise<{
          result: {
            isError?: boolean;
            content: readonly { text: string }[];
            tools: readonly { name: string }[];
          };
          error?: unknown;
        }>;
      },
    };
  }

  it("rejects a confirmation whose text does not match planFingerprint before the service", async () => {
    const h = harness();
    const result = await h.request("tools/call", "catalog.confirm-scope-sync-batch", {
      selection: { mode: "ids", scopeRecordIds: ["scope_1"] },
      planFingerprint: "a".repeat(64),
      idempotencyKey: "replay-1",
      confirmationText: "wrong",
    });
    expect(result.result.isError).toBe(true);
    expect(h.runtime.confirm).not.toHaveBeenCalled();
  });

  it("returns the current preview for a stale confirmation", async () => {
    const h = harness();
    (h.runtime.confirm as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: "scope_sync_batch_stale_preview",
      message: "Preview changed.",
      currentPreview: { planFingerprint: "current" },
    });
    const result = await h.request(
      "tools/call",
      "catalog.confirm-scope-sync-batch",
      {
        selection: { mode: "ids", scopeRecordIds: ["scope_1"] },
        planFingerprint: "a".repeat(64),
        idempotencyKey: "stale-1",
        confirmationText: "a".repeat(64),
      },
      { confirmed: true, text: "a".repeat(64) },
    );
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('"currentPreview":{"planFingerprint":"current"}');
  });

  it("replays a platform idempotency key without a second confirmation", async () => {
    const h = harness();
    const args = {
      selection: { mode: "ids", scopeRecordIds: ["scope_1"] },
      planFingerprint: "a".repeat(64),
      idempotencyKey: "replay-2",
      confirmationText: "a".repeat(64),
    };
    const first = await h.request("tools/call", "catalog.confirm-scope-sync-batch", args, {
      confirmed: true,
      text: "a".repeat(64),
    });
    const second = await h.request("tools/call", "catalog.confirm-scope-sync-batch", args, {
      confirmed: true,
      text: "a".repeat(64),
    });
    expect(first.result).toEqual(second.result);
    expect(h.runtime.confirm).toHaveBeenCalledTimes(1);
  });

  it("operator only: owner sessions neither list nor call Catalog operator tools", async () => {
    const h = harness();
    h.setActor(owner);
    h.setAuthority(denied);
    const listed = await h.request("tools/list");
    const operatorNames = flattenAvailableMcpTools()
      .filter((tool) => tool.name.startsWith("catalog.") && tool.permissionBoundary.scope === "operator")
      .map((tool) => tool.name);
    expect(listed.result.tools.some((tool: { name: string }) => operatorNames.includes(tool.name))).toBe(false);
    for (const name of operatorNames) {
      const result = await h.request("tools/call", name, {});
      expect(result.result.isError).toBe(true);
    }
    expect(h.seen).not.toHaveBeenCalled();
  });

  it("binds confirmation input to the plan fingerprint before the service call", async () => {
    const runtime = services();
    const handlers = createScopeSyncBatchMcpHandlers(runtime).toolHandlers;
    await handlers["catalog.confirm-scope-sync-batch"]!({
      actor: operator,
      arguments: {
        selection: { mode: "ids", scopeRecordIds: ["scope_1"] },
        planFingerprint: "a".repeat(64),
      },
    } as never);
    expect(runtime.confirm).toHaveBeenCalledWith(expect.objectContaining({ planFingerprint: "a".repeat(64) }));
  });

  it("does not expose batch actions to an owner actor", async () => {
    const handlers = createScopeSyncBatchMcpHandlers(services()).toolHandlers;
    await expect(
      handlers["catalog.preview-scope-sync-batch"]!({
        actor: owner,
        arguments: { selection: { mode: "ids", scopeRecordIds: [] } },
      } as never),
    ).rejects.toThrow("catalog.manage");
  });

  it("preserves the stale preview code and current preview over MCP", async () => {
    const runtime = services();
    runtime.confirm = vi.fn().mockRejectedValue({
      code: "scope_sync_batch_stale_preview",
      message: "Preview changed.",
      currentPreview: { planFingerprint: "current" },
    });
    const handlers = createScopeSyncBatchMcpHandlers(runtime).toolHandlers;
    await expect(
      handlers["catalog.confirm-scope-sync-batch"]!({
        actor: operator,
        arguments: { selection: { mode: "ids", scopeRecordIds: ["scope_1"] }, planFingerprint: "old" },
      } as never),
    ).rejects.toThrow(/scope_sync_batch_stale_preview/);
  });

  it.each([
    ["catalog.cancel-scope-sync-batch", "cancel", { batchId: "batch_1" }],
    ["catalog.resume-scope-sync-batch", "resume", { batchId: "batch_1" }],
    ["catalog.retry-scope-sync-unit", "retryUnit", { batchId: "batch_1", scopeRecordId: "scope_1" }],
  ])("covers %s success, missing argument, and not-found paths", async (name, serviceKey, args) => {
    const runtime = services();
    const service = runtime[serviceKey as "cancel" | "resume" | "retryUnit"] as ReturnType<typeof vi.fn>;
    service.mockResolvedValue({ batchId: "batch_1" });
    const handler = createScopeSyncBatchMcpHandlers(runtime).toolHandlers[name]!;
    await expect(handler({ actor: operator, arguments: args } as never)).resolves.toEqual({ batchId: "batch_1" });
    await expect(handler({ actor: operator, arguments: {} } as never)).rejects.toThrow(/required/);
    service.mockResolvedValue(null);
    await expect(handler({ actor: operator, arguments: args } as never)).rejects.toThrow("not found");
  });
});
