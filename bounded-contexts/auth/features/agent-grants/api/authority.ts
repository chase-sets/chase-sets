import type { AgentGrantRevocations } from "@chase-sets/identity/server";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { AgentGrantSpendPolicy } from "@chase-sets/platform-runtime/agent-guardrails";

export function fenceAgentGrantActor(
  resolveActor: (request: Request) => Promise<ResolvedActor | null>,
  owner: AgentGrantRevocations | undefined,
) {
  return async (request: Request): Promise<ResolvedActor | null> => {
    const actor = await resolveActor(request);
    if (!actor?.agentGrant) return actor;
    return (await owner?.isActiveGrant(actor.accountId, actor.agentGrant.grantId)) ? actor : null;
  };
}

export function fenceAgentGrantSpendPolicy(
  policy: AgentGrantSpendPolicy | undefined,
  owner: AgentGrantRevocations | undefined,
): AgentGrantSpendPolicy {
  return {
    authorize: async (input) => {
      if (input.grantId && (!input.accountId || !(await owner?.isActiveGrant(input.accountId, input.grantId)))) {
        return {
          allowed: false,
          limitKind: "rail-not-allowed",
          reason: "agent_grant_revoked",
          remainingCents: 0,
          capCents: 0,
        };
      }
      const result = (await policy?.authorize(input)) ?? { allowed: true as const };
      if (input.grantId && (!input.accountId || !(await owner?.isActiveGrant(input.accountId, input.grantId)))) {
        return {
          allowed: false,
          limitKind: "rail-not-allowed",
          reason: "agent_grant_revoked",
          remainingCents: 0,
          capCents: 0,
        };
      }
      return result;
    },
  };
}
