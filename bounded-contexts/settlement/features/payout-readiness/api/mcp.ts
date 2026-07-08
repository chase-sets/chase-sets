import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { ensureMcpActorAccount, readMcpStringArgument, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PayoutReadinessServices } from "./runtime";

export type SettlementPayoutReadinessMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
}>;

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for settlement payout setup MCP writes yet.");
  }
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function readHostedUrl(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readRequiredString(args, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${key} must be an absolute HTTPS URL.`);
  }

  return url.toString();
}

export function createSettlementPayoutReadinessMcpHandlers(
  services: PayoutReadinessServices,
): SettlementPayoutReadinessMcpHandlers {
  const refreshReadiness: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.setup");
    const readiness = await services.refreshProviderReadiness(
      {
        accountId: scopedActor.accountId as AccountId,
        contactEmail: readMcpStringArgument(args, "contactEmail"),
        providerReference: readMcpStringArgument(args, "providerReference"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return {
      accountId: scopedActor.accountId,
      id: scopedActor.accountId,
      status: readiness.status,
      readiness,
      resourceUri: `chase-sets://settlement/${encodeURIComponent(scopedActor.accountId)}/wallet`,
    };
  };

  const createOnboardingLink: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.setup");
    const result = await services.createHostedPayoutSetupLink(
      {
        accountId: scopedActor.accountId as AccountId,
        contactEmail: readMcpStringArgument(args, "contactEmail"),
        returnUrl: readHostedUrl(args, "returnUrl"),
        refreshUrl: readHostedUrl(args, "refreshUrl"),
        idempotencyKey: readRequiredString(args, "idempotencyKey"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return {
      accountId: scopedActor.accountId,
      id: result.providerReference,
      providerReference: result.providerReference,
      status: result.readiness.status,
      url: result.url,
      expiresAt: result.expiresAt,
      readiness: result.readiness,
    };
  };

  return {
    toolHandlers: {
      "settlement.refresh-readiness": refreshReadiness,
      "settlement.create-payout-onboarding-link": createOnboardingLink,
    },
  };
}
