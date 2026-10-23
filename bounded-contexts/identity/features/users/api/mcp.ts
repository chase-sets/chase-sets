import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import {
  PLATFORM_ADMIN_ROLE_KEY,
  type AuthMethodKey,
  type ContactMethodType,
} from "../../../support/runtime-support/common";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { UserServices } from "./runtime";

export type UserMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

const AUTH_METHODS: readonly AuthMethodKey[] = ["password", "magic-link", "passkey", "sms-code", "social-login"];
const CONTACT_METHOD_TYPES: readonly ContactMethodType[] = ["email", "phone"];

function requireOperator(actor: ResolvedActor | null, permission: string): ResolvedActor {
  if (!actor) throw new Error("An authenticated operator is required.");
  if (!actor.permissions.includes(permission)) throw new Error(`Missing required permission: ${permission}.`);
  return actor;
}

function requiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

function enumString<T extends string>(args: Readonly<Record<string, unknown>>, key: string, values: readonly T[]): T {
  const value = requiredString(args, key);
  if (!values.includes(value as T)) throw new Error(`${key} must be one of: ${values.join(", ")}.`);
  return value as T;
}

function canManageUser(actor: ResolvedActor, userId: string) {
  return actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.userId === userId;
}

function requireUserAccess(actor: ResolvedActor, userId: string) {
  if (!canManageUser(actor, userId)) throw new Error("The authenticated actor cannot manage this user.");
}

function mutationResult(userId: string, result: Awaited<ReturnType<UserServices["commandHandler"]>>) {
  return { id: userId, version: result.version, status: result.state.status };
}

export function createUserMcpHandlers(services: UserServices): UserMcpHandlers {
  const listUsers: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    if (scopedActor.roleKey !== PLATFORM_ADMIN_ROLE_KEY) {
      const user = await services.getUser(scopedActor.userId);
      const items = user ? [user] : [];
      return { items, total: items.length, count: items.length };
    }

    const result = await services.listUsers({
      search: optionalString(args, "search"),
      status: optionalString(args, "status"),
      limit: args.limit,
      offset: args.offset,
    });
    return { items: result.items, total: result.total, count: result.items.length };
  };

  const updateUserProfile: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "UpdateUserProfile",
        displayName: requiredString(args, "displayName"),
        givenName: requiredString(args, "givenName"),
        familyName: requiredString(args, "familyName"),
      },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  const addUserContactMethod: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "AddContactMethod",
        contactMethodId: createId("ctm"),
        contactMethodType: enumString(args, "contactMethodType", CONTACT_METHOD_TYPES),
        value: requiredString(args, "value"),
      },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  const verifyUserContactMethod: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "VerifyContactMethod",
        contactMethodId: readMcpTypedIdArgument(args, "contactMethodId", "ctm"),
        verifiedAt: new Date().toISOString(),
      },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  const enableUserAuthMethod: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "EnableAuthMethod", authMethod: enumString(args, "authMethod", AUTH_METHODS) },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  const disableUserAuthMethod: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "DisableAuthMethod", authMethod: enumString(args, "authMethod", AUTH_METHODS) },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  const suspendUser: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "SuspendUser" },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  const reactivateUser: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "security.manage");
    const userId = readMcpTypedIdArgument(args, "userId", "usr");
    requireUserAccess(scopedActor, userId);
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "ReactivateUser" },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(userId, result);
  };

  return {
    toolHandlers: {
      "identity.add-user-contact-method": addUserContactMethod,
      "identity.disable-user-auth-method": disableUserAuthMethod,
      "identity.enable-user-auth-method": enableUserAuthMethod,
      "identity.list-users": listUsers,
      "identity.reactivate-user": reactivateUser,
      "identity.suspend-user": suspendUser,
      "identity.update-user-profile": updateUserProfile,
      "identity.verify-user-contact-method": verifyUserContactMethod,
    },
    resourceHandlers: {},
  };
}
