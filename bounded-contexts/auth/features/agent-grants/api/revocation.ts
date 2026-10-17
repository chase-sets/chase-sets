import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AgentGrantRevocations, RevocationState, PaymentServices } from "./api";
import type { AgentWebhookOutbox } from "../../../support/ucp-support/agent-webhooks/agent-webhook-outbox";

export type AgentGrantRevocationEffects = Readonly<{
  advance: AgentGrantRevocations["advance"];
  cleanup?: PaymentServices["revokeSavedCheckoutInstrumentsForAgentGrant"];
  exclude?: AgentWebhookOutbox["excludeRevokedGrant"];
}>;

export async function resumeAgentGrantRevocation(
  effects: AgentGrantRevocationEffects,
  initial: RevocationState,
  _context: EventStoreContext,
): Promise<RevocationState> {
  const effectContext = initial.effectContext;
  let state = initial;
  for (let boundary = 0; boundary < 5 && state.phase !== "completed"; boundary += 1) {
    if (state.phase === "identity-terminal") {
      if (!effects.cleanup) throw new Error("revocation_effect_unavailable");
      const result = await effects.cleanup(
        {
          accountId: state.accountId as EventStoreContext["audit"]["forAccountId"],
          agentGrantId: state.grantId,
          revokedAt: state.revokedAt,
          operationId: state.operationId,
        },
        effectContext,
      );
      if (result.detached !== 0) throw new Error("revocation_effect_contradiction");
    }
    if (state.phase === "payments-terminal") {
      if (!effects.exclude || !(await effects.exclude({ accountId: state.accountId, grantId: state.grantId })))
        throw new Error("revocation_effect_unavailable");
    }
    const next = await effects.advance(state, effectContext);
    if (next.version <= state.version && next.phase !== "completed") throw new Error("revocation_ambiguous");
    state = next;
  }
  if (state.phase !== "completed") throw new Error("revocation_ambiguous");
  return state;
}
