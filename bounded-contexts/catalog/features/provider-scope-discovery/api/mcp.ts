import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { ProviderScopeDiscoveryServices } from "./runtime";
import { scopeObservationListParams, scopeRecordProposalListParams } from "./route";

export type ProviderScopeDiscoveryMcpHandlers = Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }>;

function operator(actor: ResolvedActor | null, permission: string): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
  return actor;
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createProviderScopeDiscoveryMcpHandlers(
  services: ProviderScopeDiscoveryServices,
): ProviderScopeDiscoveryMcpHandlers {
  const listRefreshSchedules: McpToolHandler = async ({ actor }) => {
    operator(actor, "catalog.view");
    const items = await services.listRefreshSchedules();
    return { items, total: items.length, count: items.length };
  };
  const runProviderRefresh: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor, "catalog.manage");
    const providerKey = optionalString(args, "providerKey");
    if (!providerKey) throw new Error("providerKey is required.");
    return services.runProviderRefreshNow({
      providerKey,
      context: createActorEventStoreContext(scoped),
      triggeredBy: `user:${scoped.userId}`,
    });
  };
  const setPaused =
    (paused: boolean): McpToolHandler =>
    async ({ actor, arguments: args }) => {
      const scoped = operator(actor, "catalog.manage");
      const providerKey = optionalString(args, "providerKey");
      if (!providerKey) throw new Error("providerKey is required.");
      const schedule = await services.setRefreshPaused({
        providerKey,
        paused,
        actor: `user:${scoped.userId}`,
        reason: optionalString(args, "reason") ?? null,
      });
      if (!schedule) throw new Error("provider_refresh_schedule_not_found");
      return schedule;
    };
  const listScopeObservations: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const items = await services.listScopeObservations(scopeObservationListParams(args));
    return { items, total: items.length, count: items.length };
  };
  const listProposals: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const items = await services.listCanonicalScopeRecordProposals(scopeRecordProposalListParams(args));
    return { items, total: items.length, count: items.length };
  };
  return {
    toolHandlers: {
      "catalog.list-provider-refresh-schedules": listRefreshSchedules,
      "catalog.run-provider-refresh": runProviderRefresh,
      "catalog.pause-provider-refresh": setPaused(true),
      "catalog.resume-provider-refresh": setPaused(false),
      "catalog.list-scope-observations": listScopeObservations,
      "catalog.list-scope-record-proposals": listProposals,
    },
  };
}
