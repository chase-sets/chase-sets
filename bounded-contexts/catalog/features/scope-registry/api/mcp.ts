import type { ResolvedActor } from "@chase-sets/auth-context";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { CatalogScopeRegistryRouteServices } from "./route";
import { scopeRecordDetailFromRow, scopeRecordListParamsFromRecord } from "./route";

export type ScopeRegistryMcpHandlers = Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }>;
function operator(actor: ResolvedActor | null, permission: string): void {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
}
function optional(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof args[key] === "string" && String(args[key]).trim() ? String(args[key]).trim() : undefined;
}
export function createScopeRegistryMcpHandlers(services: CatalogScopeRegistryRouteServices): ScopeRegistryMcpHandlers {
  const list: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const result = await services.listScopeRecords(scopeRecordListParamsFromRecord(args));
    const items = result.items.map(scopeRecordDetailFromRow);
    return { items, total: result.total, count: items.length };
  };
  const get: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const id = optional(args, "scopeRecordId");
    if (!id) throw new Error("scopeRecordId is required.");
    const row = await services.getScopeRecord(id);
    if (!row) throw new Error("Scope Record not found.");
    return scopeRecordDetailFromRow(row);
  };
  return { toolHandlers: { "catalog.list-scope-records": list, "catalog.get-scope-record": get } };
}
