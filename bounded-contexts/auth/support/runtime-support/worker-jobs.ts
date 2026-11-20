import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import type { WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import { createActiveAgentGrantFence, type IdentityServices } from "@chase-sets/identity/server";
import type { RevokeAgentGrantPaymentInstruments } from "../../features/agent-grants/api/payment-instrument-revocation";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createAgentWebhookDispatcher } from "../../support/ucp-support/agent-webhooks";
import { createFetchAgentWebhookSender } from "../../support/ucp-support/agent-webhooks";
import { createPostgresAgentWebhookOutbox } from "../../support/ucp-support/agent-webhooks";
import { resolveAgentWebhookSigningSecret } from "../../support/ucp-support/agent-webhooks";
import { resumeAgentGrantRevocation } from "../../features/agent-grants/api/revocation";
export function createAgentWebhookDispatchRunners({
  runtime,
  ports,
  config: input,
}: Pick<WorkerJobInput<Readonly<{ workerId: string }>>, "runtime" | "config" | "ports">): readonly WorkerRunner[] {
  const authContext = runtime.mountedContexts.find((context) => context.contextName === "auth");
  if (!authContext) {
    return [];
  }

  const identityContext = runtime.mountedContexts.find((context) => context.contextName === "identity");
  const withActiveGrants = identityContext ? createActiveAgentGrantFence(identityContext.pool) : undefined;
  const outbox = createPostgresAgentWebhookOutbox({ db: authContext.pool, withActiveGrants });
  const dispatcher = createAgentWebhookDispatcher({
    outbox,
    withActiveGrants,
    resolveSigningSecret: (clientId) => resolveAgentWebhookSigningSecret(authContext.pool, clientId),
    send: createFetchAgentWebhookSender(),
    claimOwnerId: `${input.workerId}:auth-agent-webhooks`,
  });

  const runners: WorkerRunner[] = [
    {
      name: "auth.agent-webhook-dispatcher",
      kind: "job",
      runOnce: dispatcher.runOnce,
    },
  ];
  const identity = runtime.services.identity as IdentityServices | undefined;
  const revokePaymentInstruments = ports?.revokeAgentGrantPaymentInstruments as
    | RevokeAgentGrantPaymentInstruments
    | undefined;
  if (identity?.agentGrantRevocations && revokePaymentInstruments)
    runners.push({
      name: "auth.agent-grant-revocation-recovery",
      kind: "job",
      runOnce: async () => {
        const pending = await identity.agentGrantRevocations.pending();
        let failed = false;
        for (const operation of pending) {
          if ("failure" in operation) {
            failed = true;
            continue;
          }
          try {
            await resumeAgentGrantRevocation(
              {
                advance: identity.agentGrantRevocations.advance,
                cleanup: revokePaymentInstruments,
                exclude: outbox.excludeRevokedGrant,
              },
              operation.state,
              operation.context,
            );
          } catch {
            failed = true;
          }
        }
        if (failed) throw new Error("agent_grant_revocation_recovery_pending");
        return { processed: pending.length, lastGlobalPosition: ZERO_GLOBAL_POSITION };
      },
    });
  return runners;
}
