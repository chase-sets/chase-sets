import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { readMcpStringArgument, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { createAccountMcpHandlers, type AccountMcpHandlers } from "../../accounts/api/mcp";

function actorOf(actor: Parameters<McpToolHandler>[0]["actor"]) {
  if (!actor) throw new Error("An authenticated operator is required.");
  return actor;
}
function resultOf(result: { version: number; state: { id?: string | null; status: string } }) {
  return { id: result.state.id ?? undefined, version: result.version, status: result.state.status };
}
function argument(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
async function accountMutation(services: IdentityServices, input: Parameters<McpToolHandler>[0], action: string, target: string | null, body: Record<string, unknown>) {
  const actor = actorOf(input.actor);
  if (!services.accountManagement) throw new Error("Identity account management is unavailable.");
  return services.accountManagement.submit({ actor, context: createActorEventStoreContext(actor), key: argument(input.arguments, "idempotencyKey"), action, target, body });
}


export function createIdentityMcpHandlers(services: IdentityServices): AccountMcpHandlers {
  const accountHandlers = createAccountMcpHandlers(services.accounts);
  const toolHandlers: Record<string, McpToolHandler> = { ...accountHandlers.toolHandlers };
  const readList = (kind: "accounts" | "users"): McpToolHandler => async ({ actor, arguments: args }) => {
    actorOf(actor);
    const params = {
      search: readMcpStringArgument(args, "search") ?? undefined,
      status: readMcpStringArgument(args, "status") ?? undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      offset: typeof args.offset === "number" ? args.offset : undefined,
    };
    const result = kind === "accounts" ? await services.accounts.listAccounts(params) : await services.users.listUsers(params);
    return { items: result.items, total: result.total, count: result.items.length };
  };
  toolHandlers["identity.list-accounts"] = readList("accounts");
  toolHandlers["identity.list-users"] = readList("users");
  toolHandlers["identity.get-account-access-hub"] = async ({ actor, arguments: args }) => {
    actorOf(actor);
    return services.accessHub.getAccount(argument(args, "accountId"));
  };
  toolHandlers["identity.get-user-account-link"] = async ({ actor, arguments: args }) => {
    actorOf(actor);
    return services.accessHub.getUserAccountLink(argument(args, "userId"));
  };

  const managed = (action: string, targetKey: string | null, bodyKeys: readonly string[] = []): McpToolHandler => async (input) => {
    const args = input.arguments;
    const target = targetKey ? argument(args, targetKey) : null;
    const body = Object.fromEntries(bodyKeys.map((key) => [key, args[key]]));
    const result = await accountMutation(services, input, action, target, body);
    return result.outcome === "committed" ? result.current : result;
  };
  toolHandlers["identity.update-account-profile"] = managed("update-profile", "accountId", ["name", "displayName"]);
  toolHandlers["identity.create-invitation"] = async (input) => {
    const args = input.arguments;
    const result = await accountMutation(services, input, "create-invitation", null, {
      accountId: argument(args, "accountId"), email: argument(args, "email"), roleKey: argument(args, "roleKey"),
      invitationId: createId("ivt"), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    return result.outcome === "committed" ? result.current : result;
  };
  toolHandlers["identity.change-membership-role"] = managed("change-role", "membershipId", ["roleKey"]);
  toolHandlers["identity.revoke-membership"] = managed("revoke", "membershipId");
  toolHandlers["identity.reinstate-membership"] = managed("reinstate", "membershipId");
  toolHandlers["identity.cancel-invitation"] = managed("cancel-invitation", "invitationId");
  toolHandlers["identity.update-user-profile"] = managed("update-user", "userId", ["displayName", "givenName", "familyName"]);
  toolHandlers["identity.revoke-api-key"] = managed("revoke-api-key", "apiKeyId");

  const direct = (name: string, run: (input: Parameters<McpToolHandler>[0]) => Promise<unknown>): void => { toolHandlers[name] = run; };
  const accountCommand = (type: string, riskReason = "operator-other") => async ({ actor, arguments: args }: Parameters<McpToolHandler>[0]) => {
    const actual = actorOf(actor); const accountId = parseTypedIdBoundaryLocal(argument(args, "accountId"), "acc");
    const result = await services.accounts.commandHandler({ streamId: `identity.account-${accountId}`, command: { type, enforcement: { version: 1, enforcementActionId: createId("enf"), reason: argument(args, "reason") || riskReason, reference: null } } as never, context: createActorEventStoreContext(actual) });
    return resultOf(result);
  };
  direct("identity.suspend-account", accountCommand("SuspendAccount"));
  direct("identity.reactivate-account", accountCommand("ReactivateAccount"));
  direct("identity.close-account", accountCommand("CloseAccount"));
  direct("identity.assign-account-badge", async ({ actor, arguments: args }) => {
    const actual = actorOf(actor); const id = parseTypedIdBoundaryLocal(argument(args, "accountId"), "acc");
    const result = await services.accounts.commandHandler({ streamId: `identity.account-${id}`, command: { type: "AssignAccountBadge", badgeKey: argument(args, "badgeKey") } as never, context: createActorEventStoreContext(actual) }); return resultOf(result);
  });
  direct("identity.remove-account-badge", async ({ actor, arguments: args }) => {
    const actual = actorOf(actor); const id = parseTypedIdBoundaryLocal(argument(args, "accountId"), "acc");
    const result = await services.accounts.commandHandler({ streamId: `identity.account-${id}`, command: { type: "RemoveAccountBadge", badgeKey: argument(args, "badgeKey") } as never, context: createActorEventStoreContext(actual) }); return resultOf(result);
  });
  direct("identity.resend-invitation", async ({ actor, arguments: args }) => {
    const actual = actorOf(actor); const id = parseTypedIdBoundaryLocal(argument(args, "invitationId"), "ivt");
    const result = await services.invitations.commandHandler({ streamId: `identity.invitation-${id}`, command: { type: "ResendInvitation", expiresAt: argument(args, "expiresAt") }, context: createActorEventStoreContext(actual) }); return resultOf(result);
  });
  direct("identity.decline-invitation", async ({ actor, arguments: args }) => {
    const actual = actorOf(actor); const id = parseTypedIdBoundaryLocal(argument(args, "invitationId"), "ivt");
    const result = await services.invitations.commandHandler({ streamId: `identity.invitation-${id}`, command: { type: "DeclineInvitation" }, context: createActorEventStoreContext(actual) }); return resultOf(result);
  });
  const userCommand = (type: string, make: (args: Readonly<Record<string, unknown>>) => Record<string, unknown>) => async ({ actor, arguments: args }: Parameters<McpToolHandler>[0]) => {
    const actual = actorOf(actor); const id = parseTypedIdBoundaryLocal(argument(args, "userId"), "usr");
    const result = await services.users.commandHandler({ streamId: `identity.user-${id}`, command: { type, ...make(args) } as never, context: createActorEventStoreContext(actual) }); return resultOf(result);
  };
  direct("identity.suspend-user", userCommand("SuspendUser", () => ({})));
  direct("identity.reactivate-user", userCommand("ReactivateUser", () => ({})));
  direct("identity.add-user-contact-method", userCommand("AddContactMethod", (args) => ({ contactMethodId: createId("ctm"), contactMethodType: argument(args, "contactMethodType"), value: argument(args, "value") })));
  direct("identity.verify-user-contact-method", userCommand("VerifyContactMethod", (args) => ({ contactMethodId: argument(args, "contactMethodId"), verifiedAt: new Date().toISOString() })));
  direct("identity.enable-user-auth-method", userCommand("EnableAuthMethod", (args) => ({ authMethod: argument(args, "authMethod") })));
  direct("identity.disable-user-auth-method", userCommand("DisableAuthMethod", (args) => ({ authMethod: argument(args, "authMethod") })));
  return { toolHandlers, resourceHandlers: accountHandlers.resourceHandlers };
}

function parseTypedIdBoundaryLocal(value: string, prefix: string): string {
  return parseTypedId(value, prefix);
}
