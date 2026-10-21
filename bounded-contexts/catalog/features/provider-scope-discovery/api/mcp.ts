import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { ProviderScopeDiscoveryServices } from "./runtime";

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

function optionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer.`);
  return parsed;
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
      return services.setRefreshPaused({
        providerKey,
        paused,
        actor: `user:${scoped.userId}`,
        reason: optionalString(args, "reason") ?? null,
      });
    };
  const listScopeObservations: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const items = await services.listScopeObservations({
      providerKey: optionalString(args, "providerKey"),
      unitKey: optionalString(args, "unitKey"),
      scopeKind: optionalString(args, "scopeKind") as never,
      limit: optionalPositiveInteger(args, "limit"),
    });
    return { items, total: items.length, count: items.length };
  };
  const listProposals: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const items = await services.listCanonicalScopeRecordProposals({
      reviewStatus: optionalString(args, "reviewStatus") as never,
      productDomain: optionalString(args, "productDomain") as never,
      limit: optionalPositiveInteger(args, "limit"),
    });
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
