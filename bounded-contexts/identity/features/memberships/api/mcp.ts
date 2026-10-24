import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import {
  canAssignRole,
  parseGrantableRoleKey,
  parseRoleKey,
  PLATFORM_ADMIN_ROLE_KEY,
  type GrantableRoleKey,
  type RoleAssignmentAuthority,
} from "../../../support/runtime-support/common";
import type { AccountServices } from "../../accounts/api/runtime";
import type { MembershipServices } from "./runtime";

export type MembershipMcpHandlers = Readonly<{
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

function requiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function assignmentAuthority(actor: ResolvedActor): RoleAssignmentAuthority {
  const roleKey = parseRoleKey(actor.roleKey);
  if (!roleKey) throw new Error("The authenticated actor has an invalid role.");
  return { type: "actor", roleKey };
}

function mutationResult(id: string, result: { version: number; state: Readonly<{ status: string }> }) {
  return { id, version: result.version, status: result.state.status };
}

function canManageMembership(actor: ResolvedActor, accountId: string) {
  return actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.accountId === accountId;
}

function requireManageableMembership(
  actor: ResolvedActor,
  membership: Readonly<{ account_id: string; role_key: string }>,
) {
  if (!canManageMembership(actor, membership.account_id)) {
    throw new Error("The authenticated actor cannot manage this membership.");
  }
  if (membership.role_key === PLATFORM_ADMIN_ROLE_KEY) {
    throw new Error("Platform-admin membership changes require human presence.");
  }
}

async function requireNotLastOwner(
  services: MembershipServices,
  accounts: Pick<AccountServices, "getAccountState">,
  membership: Readonly<{ account_id: string; role_key: string; status: string }>,
  requestedRoleKey?: GrantableRoleKey,
) {
  if (membership.status !== "active" || membership.role_key !== "owner" || requestedRoleKey === "owner") return;
  const account = await accounts.getAccountState(membership.account_id);
  if (account?.status !== "closed" && (await services.countActiveOwnersForAccount(membership.account_id)) <= 1) {
    throw new Error("Cannot remove the last owner.");
  }
}

export function createMembershipMcpHandlers(
  services: MembershipServices,
  accounts: Pick<AccountServices, "getAccountState">,
): MembershipMcpHandlers {
  const loadMembership = async (actor: ResolvedActor | null, args: Readonly<Record<string, unknown>>) => {
    const scopedActor = requireOperator(actor);
    const membershipId = readMcpTypedIdArgument(args, "membershipId", "mbr");
    const membership = await services.getMembership(membershipId);
    if (!membership) throw new Error("Membership not found.");
    requireManageableMembership(scopedActor, membership);
    return { actor: scopedActor, membership, membershipId };
  };

  const changeMembershipRole: McpToolHandler = async ({ actor, arguments: args }) => {
    const { actor: scopedActor, membership, membershipId } = await loadMembership(actor, args);
    const roleKey = parseGrantableRoleKey(requiredString(args, "roleKey"));
    if (!roleKey) throw new Error("roleKey is invalid.");
    const actorRoleKey = parseRoleKey(scopedActor.roleKey);
    if (!actorRoleKey || !canAssignRole(actorRoleKey, roleKey)) {
      throw new Error("The authenticated actor cannot assign this role.");
    }
    await requireNotLastOwner(services, accounts, membership, roleKey);
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "ChangeMembershipRole", roleKey, assignmentAuthority: assignmentAuthority(scopedActor) },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(membershipId, result);
  };

  const revokeMembership: McpToolHandler = async ({ actor, arguments: args }) => {
    const { actor: scopedActor, membership, membershipId } = await loadMembership(actor, args);
    await requireNotLastOwner(services, accounts, membership);
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "RevokeMembership" },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(membershipId, result);
  };

  const reinstateMembership: McpToolHandler = async ({ actor, arguments: args }) => {
    const { actor: scopedActor, membershipId } = await loadMembership(actor, args);
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "ReinstateMembership" },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(membershipId, result);
  };

  return {
    toolHandlers: {
      "identity.change-membership-role": changeMembershipRole,
      "identity.reinstate-membership": reinstateMembership,
      "identity.revoke-membership": revokeMembership,
    },
    resourceHandlers: {},
  };
}
