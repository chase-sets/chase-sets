import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { readMcpTypedIdArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { deleteApiKeySecret } from "./secret-store";
import type { ApiKeyServices } from "./runtime";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ApiKeyRow } from "../read-model/queries";

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

function publicApiKey(row: ApiKeyRow): ApiKeyRow {
  return {
    api_key_id: row.api_key_id,
    user_id: row.user_id,
    user_display_name: row.user_display_name,
    user_primary_email: row.user_primary_email,
    name: row.name,
    key_prefix: row.key_prefix,
    status: row.status,
    last_used_at: row.last_used_at,
    updated_at: row.updated_at,
  };
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

export function createApiKeyMcpHandlers(services: ApiKeyServices, db: PgQueryable): ApiKeyMcpHandlers {
  const listApiKeys: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const search = optionalString(args, "search");
    const result = await services.listApiKeys({
      search: scopedActor.roleKey !== "platform-admin" ? scopedActor.userId : search,
      status: optionalString(args, "status"),
      limit: args.limit,
      offset: args.offset,
    });
    return { items: result.items.map(publicApiKey), total: result.total, count: result.items.length };
  };

  const getApiKey: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const apiKeyId = readMcpTypedIdArgument(args, "apiKeyId", "key");
    const apiKey = await services.getApiKey(apiKeyId);
    if (!apiKey) throw new Error("API key not found.");
    if (scopedActor.roleKey !== "platform-admin" && scopedActor.userId !== apiKey.user_id) {
      throw new Error("The authenticated actor cannot manage this API key.");
    }
    return publicApiKey(apiKey);
  };

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
    toolHandlers: {
      "identity.list-api-keys": listApiKeys,
      "identity.get-api-key": getApiKey,
      "identity.revoke-api-key": revokeApiKey,
    },
    resourceHandlers: {},
  };
}
