import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { resolveRecentAuthenticationStatus, type ResolvedActor } from "@chase-sets/auth-context";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import { parseTypedId, type AccountId } from "@chase-sets/primitives/typed-ids";
import { decideWallet, evolveWallet, initialWalletState, type WalletEvent } from "../domain/domain";
import { walletAdjustmentControlsPolicy } from "../domain/wallet-adjustment-controls-policy";
import { walletAdjustmentLimitsPolicy } from "../domain/wallet-adjustment-limits-policy";
import {
  decodeStagingProofPolicy,
  proofCreditAmount,
  proofLedgerId,
  readProofReceipt,
  requireProof,
  STAGING_PROOF,
  STAGING_PROOF_CAP,
  STAGING_PROOF_DOCUMENT,
  STAGING_PROOF_REASON,
  STAGING_PROOF_RULING,
  stagingProofCreditPolicy,
  type StagingProofReceipt,
} from "../domain/staging-proof-credit";

export type StagingProofCreditServices = ReturnType<typeof createStagingProofCreditRuntime>;
export function createStagingProofCreditRuntime(
  deps: Readonly<{
    eventStore: EventStore;
    policies: PolicyRuntime;
    deploymentEnvironment?: DeploymentEnvironment;
  }>,
) {
  const codec = createPassthroughDomainEventCodec<WalletEvent>();
  const { repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialWalletState,
    evolve: evolveWallet,
    decide: decideWallet,
  });
  const policyStream = `platform-policy.document-${STAGING_PROOF_DOCUMENT}`;
  const requireStaging = () => requireProof(deps.deploymentEnvironment === "staging", "proof_environment_refused");
  const requireActor = (actor: ResolvedActor) =>
    requireProof(
      actor?.permissions.includes("wallet-adjustments.create") &&
        actor.permissions.includes("wallet-adjustments.approve"),
      "proof_permission_refused",
    );

  return {
    deploymentEnvironment: deps.deploymentEnvironment,
    async receipt(accountId: AccountId, actor: ResolvedActor) {
      requireActor(actor);
      return readProofReceipt((await repository.load(`settlement.wallet-${accountId}`)).state, accountId);
    },
    async post(
      input: Readonly<{ targetAccountId: AccountId; amount: string }>,
      actor: ResolvedActor,
      context: EventStoreContext,
    ): Promise<StagingProofReceipt> {
      requireStaging();
      requireActor(actor);
      requireProof(actor.sessionId && !actor.agentGrant, "proof_session_required");
      const amount = proofCreditAmount(input.amount);
      requireProof(context.audit.performedByUserId === actor.userId, "proof_actor_mismatch");
      requireProof(deps.eventStore.appendToStreams, "proof_atomic_append_unavailable");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const now = new Date();
          const { state: policy, version } = await deps.policies.readPolicyDocumentState(STAGING_PROOF_DOCUMENT);
          requireProof(
            policy.documentId === STAGING_PROOF_DOCUMENT &&
              policy.policyKey === stagingProofCreditPolicy.policyKey &&
              policy.status === "active" &&
              policy.effectiveFrom !== null &&
              Date.parse(policy.effectiveFrom) <= now.getTime() &&
              (policy.effectiveUntil === null || Date.parse(policy.effectiveUntil) > now.getTime()),
            "proof_policy_inactive",
          );
          const value = decodeStagingProofPolicy(policy.value);
          requireProof(value.enabled, "proof_policy_disabled");
          requireProof(value.proofAccountId === input.targetAccountId, "proof_account_mismatch");
          const [controls, limits] = await Promise.all([
            deps.policies.resolvePolicy(walletAdjustmentControlsPolicy),
            deps.policies.resolvePolicy(walletAdjustmentLimitsPolicy),
          ]);
          requireProof(limits.value.haltNewActions === false, "proof_actions_halted");
          const recent = resolveRecentAuthenticationStatus(actor, {
            maxAgeMinutes: controls.value.recentAuthMaxAgeMinutes,
            now,
          });
          requireProof(recent.recentlyAuthenticated && actor.authenticatedAt, "proof_recent_auth_required");
          const streamId = `settlement.wallet-${input.targetAccountId}`;
          const loaded = await repository.load(streamId);
          const receipt: StagingProofReceipt = {
            actorUserId: parseTypedId(actor.userId, "usr"),
            accountId: input.targetAccountId,
            environment: "staging",
            proof: STAGING_PROOF,
            amount,
            currencyCode: "usd",
            cap: STAGING_PROOF_CAP,
            policyDocumentId: STAGING_PROOF_DOCUMENT,
            policyVersion: version,
            recentlyAuthenticated: true,
            authenticatedAt: new Date(actor.authenticatedAt).toISOString(),
            recentAuthMaxAgeMinutes: controls.value.recentAuthMaxAgeMinutes,
            reason: STAGING_PROOF_REASON,
            ruling: STAGING_PROOF_RULING,
            postedAt: now.toISOString(),
            ledgerEntryId: proofLedgerId(input.targetAccountId),
          };
          const events = decideWallet(loaded.state, { type: "PostStagingProofCredit", receipt });
          if (events.length === 0) return readProofReceipt(loaded.state, input.targetAccountId)!;
          const targetContext = { ...context, audit: { ...context.audit, forAccountId: input.targetAccountId } };
          await deps.eventStore.appendToStreams([
            { streamId: policyStream, expectedVersion: version, events: [], context: targetContext },
            { streamId, expectedVersion: loaded.version, events: events.map(codec.encode), context: targetContext },
          ]);
          return readProofReceipt(events.reduce(evolveWallet, loaded.state), input.targetAccountId)!;
        } catch (error) {
          if (
            attempt === 4 ||
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "concurrency_conflict"
          )
            throw error;
        }
      }
      throw new Error("proof_concurrency_exhausted");
    },
  };
}
