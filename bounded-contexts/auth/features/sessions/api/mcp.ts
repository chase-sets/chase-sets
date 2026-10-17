import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpResourceHandler, McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { toSessionStreamId } from "../domain/auth-flow";
import type { SessionServices } from "./runtime";

export type AuthSessionMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type SessionRecord = NonNullable<Awaited<ReturnType<SessionServices["getSession"]>>>;

function requirePermission(actor: ResolvedActor | null, permission: string) {
  if (!actor || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }

  return actor;
}

function readOptionalString(args: Readonly<Record<string, unknown>>, key: string) {
  return typeof args[key] === "string" ? args[key] : undefined;
}

function readOptionalPaginationInteger(args: Readonly<Record<string, unknown>>, key: string) {
  const value = args[key];
  return value === undefined || value === null ? undefined : Number(value) || undefined;
}

function canManageSession(actor: ResolvedActor, session: SessionRecord) {
  return (
    actor.roleKey === "platform-admin" || actor.sessionId === session.session_id || actor.userId === session.user_id
  );
}

function requireSessionAccess(actor: ResolvedActor, session: SessionRecord) {
  if (!canManageSession(actor, session)) {
    throw new Error("The authenticated actor cannot manage this session.");
  }
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readOptionalString(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

async function loadManagedSession(services: SessionServices, actor: ResolvedActor | null, sessionId: string) {
  const scopedActor = requirePermission(actor, "security.manage");
  const session = await services.getSession(sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }
  requireSessionAccess(scopedActor, session);
  return { actor: scopedActor, session };
}

export function createAuthSessionMcpHandlers(services: SessionServices): AuthSessionMcpHandlers {
  const listSessions: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requirePermission(actor, "security.manage");
    const result = await services.listSessions({
      search: scopedActor.roleKey === "platform-admin" ? readOptionalString(args, "search") : scopedActor.userId,
      status: readOptionalString(args, "status"),
      limit: readOptionalPaginationInteger(args, "limit"),
      offset: readOptionalPaginationInteger(args, "offset"),
    });

    return { items: result.items, total: result.total, count: result.items.length };
  };

  const getSession: McpToolHandler = async ({ actor, arguments: args }) => {
    const sessionId = readRequiredString(args, "sessionId");
    const { session } = await loadManagedSession(services, actor, sessionId);
    return session;
  };

  const revokeSession: McpToolHandler = async ({ actor, arguments: args }) => {
    const sessionId = readRequiredString(args, "sessionId");
    const { actor: scopedActor } = await loadManagedSession(services, actor, sessionId);
    const result = await services.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: { type: "RevokeSession" },
      context: createActorEventStoreContext(scopedActor),
    });

    return { id: sessionId, version: result.version, status: result.state.status };
  };

  const switchSessionAccount: McpToolHandler = async ({ actor, arguments: args }) => {
    const sessionId = readRequiredString(args, "sessionId");
    const accountId = readRequiredString(args, "accountId");

    const { actor: scopedActor } = await loadManagedSession(services, actor, sessionId);
    const result = await services.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: { type: "SwitchSessionAccount", accountId: accountId as AccountId },
      context: createActorEventStoreContext(scopedActor),
    });

    return { id: sessionId, version: result.version, status: result.state.status };
  };

  return {
    toolHandlers: {
      "auth.list-sessions": listSessions,
      "auth.get-session": getSession,
      "auth.revoke-session": revokeSession,
      "auth.switch-session-account": switchSessionAccount,
    },
    resourceHandlers: {},
  };
}
