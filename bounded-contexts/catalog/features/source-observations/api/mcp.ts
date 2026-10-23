import type { ResolvedActor } from "@chase-sets/auth-context";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { SourceObservationReadServices } from "./runtime";
import { sourceObservationListParamsFromRecord } from "./route-modules/source-observation-review-routes";

export type SourceObservationsMcpHandlers = Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }>;
function operator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes("catalog.view")) {
    throw new Error("Missing required operator permission: catalog.view.");
  }
  return actor;
}
export function createSourceObservationsMcpHandlers(
  services: SourceObservationReadServices,
): SourceObservationsMcpHandlers {
  const list: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor);
    const result = await services.listSourceObservations(sourceObservationListParamsFromRecord(args));
    const items = result.items.map((item) => ({ ...item, syncRunId: item.sync_run_id }));
    return { items, total: result.total, count: items.length };
  };
  return { toolHandlers: { "catalog.list-source-observations": list } };
}
