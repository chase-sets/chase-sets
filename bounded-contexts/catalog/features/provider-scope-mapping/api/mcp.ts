import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { proposeProviderScopeMapping, reviewProviderScopeMappings } from "./route";
import type { ProviderScopeMappingServices } from "./runtime";

export type ProviderScopeMappingMcpHandlers = Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }>;
function operator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes("catalog.manage")) {
    throw new Error("Missing required operator permission: catalog.manage.");
  }
  return actor;
}
function stringArg(args: Readonly<Record<string, unknown>>, key: string, required = false): string | undefined {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error(`${key} is required.`);
    return undefined;
  }
  return value.trim();
}
export function createProviderScopeMappingMcpHandlers(
  services: ProviderScopeMappingServices,
): ProviderScopeMappingMcpHandlers {
  const inbox: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    return services.getUnmappedScopeInbox({
      limit: args.limit === undefined ? undefined : Number(args.limit),
      productDomain: stringArg(args, "productDomain") as never,
    });
  };
  const coverage: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor);
    const id = stringArg(args, "scopeRecordId", true)!;
    const result = await services.getScopeCoverageMatrix(id);
    if (!result) throw new Error("Scope Record not found.");
    return result;
  };
  const propose: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    return proposeProviderScopeMapping(services, args, createActorEventStoreContext(scoped));
  };
  const review: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    const raw = args.mappingIds;
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("mappingIds must be an array of strings.");
    }
    const intent = stringArg(args, "intent", true);
    if (intent !== "accept" && intent !== "reject" && intent !== "revoke") throw new Error("Invalid review intent.");
    return reviewProviderScopeMappings(
      services,
      { intent, mappingIds: raw.map((value) => value.trim()), reason: stringArg(args, "reason") },
      createActorEventStoreContext(scoped),
    );
  };
  return {
    toolHandlers: {
      "catalog.get-scope-mapping-inbox": inbox,
      "catalog.get-scope-coverage": coverage,
      "catalog.propose-scope-mapping": propose,
      "catalog.review-scope-mappings": review,
    },
  };
}
