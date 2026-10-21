import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
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
});
