import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { readMcpTypedIdArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import type { AccessHubServices } from "./runtime";

export type AccessHubMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function requireOperator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor) throw new Error("An authenticated operator is required.");
  if (!actor.permissions.includes("accounts.view")) throw new Error("Missing required permission: accounts.view.");
  return actor;
}

export function createAccessHubMcpHandlers(services: AccessHubServices): AccessHubMcpHandlers {
  const getUserAccountLink: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    if (scopedActor.roleKey !== PLATFORM_ADMIN_ROLE_KEY && scopedActor.userId !== userId) {
      throw new Error("The authenticated actor cannot manage this user.");
    }
    return services.getUserAccountLink(userId);
  };

  return {
    toolHandlers: { "identity.get-user-account-link": getUserAccountLink },
    resourceHandlers: {},
  };
}
