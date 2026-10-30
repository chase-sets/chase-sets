import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { readMcpTypedIdArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { deleteApiKeySecret } from "./secret-store";
import type { ApiKeyServices } from "./runtime";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ApiKeyMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function requireOperator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor) throw new Error("An authenticated operator is required.");
  if (!actor.permissions.includes("security.manage")) {
    throw new Error("Missing required permission: security.manage.");
  }
  return actor;
}

export function createApiKeyMcpHandlers(services: ApiKeyServices, db: PgQueryable): ApiKeyMcpHandlers {
  const revokeApiKey: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const apiKeyId = readMcpTypedIdArgument(args, "apiKeyId", "key");
    const apiKey = await services.getApiKey(apiKeyId);
    if (!apiKey) throw new Error("API key not found.");
    if (scopedActor.roleKey !== "platform-admin" && scopedActor.userId !== apiKey.user_id) {
      throw new Error("The authenticated actor cannot manage this API key.");
    }
    const result = await services.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: { type: "RevokeApiKey" },
      context: createActorEventStoreContext(scopedActor),
    });
    await deleteApiKeySecret(db, apiKeyId);
    return { id: apiKeyId, version: result.version, status: result.state.status };
  };

  return {
    toolHandlers: { "identity.revoke-api-key": revokeApiKey },
    resourceHandlers: {},
  };
}
