import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { parseConfirmRequest, parsePreviewRequest } from "./route";
import type { ScopeSyncBatchServices } from "./runtime";
import { ScopeSyncBatchBlockedPreviewError, ScopeSyncBatchStalePreviewError } from "../domain/batch";

export type ScopeSyncBatchMcpHandlers = Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }>;
function operator(actor: ResolvedActor | null, permission = "catalog.manage"): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
  return actor;
}
function required(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}
export function createScopeSyncBatchMcpHandlers(services: ScopeSyncBatchServices): ScopeSyncBatchMcpHandlers {
  const preview: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    const request = parsePreviewRequest(args);
    return services.preview({ ...request, context: createActorEventStoreContext(scoped) });
  };
  const confirm: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    const request = parseConfirmRequest(args);
    try {
      return await services.confirm({ ...request, context: createActorEventStoreContext(scoped) });
    } catch (error) {
      if (
        error instanceof ScopeSyncBatchStalePreviewError ||
        error instanceof ScopeSyncBatchBlockedPreviewError ||
        (error !== null &&
          typeof error === "object" &&
          ((error as { code?: unknown }).code === "scope_sync_batch_stale_preview" ||
            (error as { code?: unknown }).code === "scope_sync_batch_blocked"))
      ) {
        const stale = error as { code: string; message?: string; currentPreview?: unknown };
        throw new Error(
          JSON.stringify({
            code: stale.code,
            message: stale.message ?? "Scope Sync Batch preview is no longer current.",
            currentPreview: stale.currentPreview ?? null,
          }),
        );
      }
      throw error;
    }
  };
  const get: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor, "catalog.view");
    const batch = await services.get({
      batchId: required(args, "batchId"),
      context: createActorEventStoreContext(scoped),
    });
    if (!batch) throw new Error("Scope Sync Batch not found.");
    return batch;
  };
  const action =
    (kind: "cancel" | "resume"): McpToolHandler =>
    async ({ actor, arguments: args }) => {
      const scoped = operator(actor);
      const batch = await services[kind]({
        batchId: required(args, "batchId"),
        context: createActorEventStoreContext(scoped),
      });
      if (!batch) throw new Error("Scope Sync Batch not found.");
      return batch;
    };
  const retry: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    const batch = await services.retryUnit({
      batchId: required(args, "batchId"),
      scopeRecordId: required(args, "scopeRecordId"),
      context: createActorEventStoreContext(scoped),
    });
    if (!batch) throw new Error("Scope Sync Batch not found.");
    return batch;
  };
  return {
    toolHandlers: {
      "catalog.preview-scope-sync-batch": preview,
      "catalog.confirm-scope-sync-batch": confirm,
      "catalog.get-scope-sync-batch": get,
      "catalog.cancel-scope-sync-batch": action("cancel"),
      "catalog.resume-scope-sync-batch": action("resume"),
      "catalog.retry-scope-sync-unit": retry,
    },
  };
}
