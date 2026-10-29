import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import { createId } from "@chase-sets/primitives/typed-ids";
import { requestInvitationAcceptanceLink } from "../integrations/request-invitation-acceptance-link";
import {
  canAssignRole,
  parseGrantableRoleKey,
  parseRoleKey,
  PLATFORM_ADMIN_ROLE_KEY,
  type RoleAssignmentAuthority,
} from "../../../support/runtime-support/common";
import type { AccountServices } from "../../accounts/api/runtime";
import type { InvitationServices } from "./runtime";

export type InvitationMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function requireOperator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor) throw new Error("An authenticated operator is required.");
  if (!actor.permissions.includes("memberships.manage")) {
    throw new Error("Missing required permission: memberships.manage.");
  }
  return actor;
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string) {
  return readMcpStringArgument(args, key) || undefined;
}

function optionalInteger(args: Readonly<Record<string, unknown>>, key: string) {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative integer.`);
  return parsed;
}

function requiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function canManageInvitation(actor: ResolvedActor, accountId: string) {
  return actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.accountId === accountId;
}

function requireInvitationAccess(actor: ResolvedActor, accountId: string) {
  if (!canManageInvitation(actor, accountId)) {
    throw new Error("The authenticated actor cannot manage this invitation.");
  }
}

function assignmentAuthority(actor: ResolvedActor): RoleAssignmentAuthority {
  const roleKey = parseRoleKey(actor.roleKey);
  if (!roleKey) throw new Error("The authenticated actor has an invalid role.");
  return { type: "actor", roleKey };
}

function readExpiry(args: Readonly<Record<string, unknown>>) {
  const expiresAt = requiredString(args, "expiresAt");
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error("expiresAt must be a valid timestamp.");
  return expiresAt;
}

function mutationResult(id: string, result: { version: number; state: Readonly<{ status: string }> }) {
  return { id, version: result.version, status: result.state.status };
}

export function createInvitationMcpHandlers(
  services: InvitationServices,
  accounts: Pick<AccountServices, "getAccountForRead">,
): InvitationMcpHandlers {
  const createInvitation: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    requireInvitationAccess(scopedActor, accountId);
    const account = await accounts.getAccountForRead(accountId);
    if (!account) throw new Error("Account not found.");

    const roleKey = parseGrantableRoleKey(requiredString(args, "roleKey"));
    if (!roleKey) throw new Error("roleKey is invalid.");
    const actorRoleKey = parseRoleKey(scopedActor.roleKey);
    if (!actorRoleKey || !canAssignRole(actorRoleKey, roleKey)) {
      throw new Error("The authenticated actor cannot assign this role.");
    }

    const invitationId = createId("ivt");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: {
        type: "CreateInvitation",
        invitationId,
        accountId,
        email: requiredString(args, "email"),
        roleKey,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        assignmentAuthority: assignmentAuthority(scopedActor),
      },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(invitationId, result);
  };

  const createAndSendInvitation: McpToolHandler = async ({ actor, arguments: args, request }) => {
    const scopedActor = requireOperator(actor);
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    requireInvitationAccess(scopedActor, accountId);
    const account = await accounts.getAccountForRead(accountId);
    if (!account) throw new Error("Account not found.");
    const roleKey = parseGrantableRoleKey(requiredString(args, "roleKey"));
    if (!roleKey) throw new Error("roleKey is invalid.");
    const actorRoleKey = parseRoleKey(scopedActor.roleKey);
    if (!actorRoleKey || !canAssignRole(actorRoleKey, roleKey)) {
      throw new Error("The authenticated actor cannot assign this role.");
    }
    const invitationId = createId("ivt");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: {
        type: "CreateInvitation",
        invitationId,
        accountId,
        email: requiredString(args, "email"),
        roleKey,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        assignmentAuthority: assignmentAuthority(scopedActor),
      },
      context: createActorEventStoreContext(scopedActor),
    });
    await requestInvitationAcceptanceLink(request, invitationId, result);
    return mutationResult(invitationId, result);
  };

  const loadInvitation = async (actor: ResolvedActor | null, args: Readonly<Record<string, unknown>>) => {
    const scopedActor = requireOperator(actor);
    const invitationId = readMcpTypedIdArgument(args, "invitationId", "ivt");
    const invitation = await services.getInvitationForRead(invitationId);
    if (!invitation) throw new Error("Invitation not found.");
    requireInvitationAccess(scopedActor, invitation.account_id);
    return { actor: scopedActor, invitation, invitationId };
  };

  const resendInvitation: McpToolHandler = async ({ actor, arguments: args }) => {
    const { actor: scopedActor, invitationId, invitation } = await loadInvitation(actor, args);
    if (invitation.status !== "pending") throw new Error("Only pending invitations can change.");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "ResendInvitation", expiresAt: readExpiry(args) },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(invitationId, result);
  };

  const resendAndSendInvitation: McpToolHandler = async ({ actor, arguments: args, request }) => {
    const { actor: scopedActor, invitationId, invitation } = await loadInvitation(actor, args);
    if (invitation.status !== "pending") throw new Error("Only pending invitations can change.");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "ResendInvitation", expiresAt: readExpiry(args) },
      context: createActorEventStoreContext(scopedActor),
    });
    await requestInvitationAcceptanceLink(request, invitationId, result);
    return mutationResult(invitationId, result);
  };

  const getInvitation: McpToolHandler = async ({ actor, arguments: args }) => {
    const { invitation } = await loadInvitation(actor, args);
    return invitation;
  };

  const listInvitationItems: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const result = await services.listInvitations({
      search: scopedActor.roleKey === PLATFORM_ADMIN_ROLE_KEY ? optionalString(args, "search") : scopedActor.accountId,
      status: optionalString(args, "status"),
      limit: optionalInteger(args, "limit"),
      offset: optionalInteger(args, "offset"),
    });
    return { items: result.items, total: result.total, count: result.items.length };
  };

  const cancelInvitation: McpToolHandler = async ({ actor, arguments: args }) => {
    const { actor: scopedActor, invitationId, invitation } = await loadInvitation(actor, args);
    if (invitation.status !== "pending") throw new Error("Only pending invitations can change.");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "CancelInvitation" },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(invitationId, result);
  };

  const declineInvitation: McpToolHandler = async ({ actor, arguments: args }) => {
    const { actor: scopedActor, invitationId, invitation } = await loadInvitation(actor, args);
    if (invitation.status !== "pending") throw new Error("Only pending invitations can change.");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "DeclineInvitation" },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(invitationId, result);
  };

  return {
    toolHandlers: {
      "identity.cancel-invitation": cancelInvitation,
      "identity.create-and-send-invitation": createAndSendInvitation,
      "identity.create-invitation": createInvitation,
      "identity.decline-invitation": declineInvitation,
      "identity.get-invitation": getInvitation,
      "identity.list-invitations": listInvitationItems,
      "identity.resend-and-send-invitation": resendAndSendInvitation,
      "identity.resend-invitation": resendInvitation,
    },
    resourceHandlers: {},
  };
}
