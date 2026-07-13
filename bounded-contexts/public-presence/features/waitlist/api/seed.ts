import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { BETA_WAVE_LAUNCH_POLICY_VALUE, betaWavePolicy } from "../domain/wave-policy";
import type { PublicPresenceServices } from "../../../support/runtime-support/services";

const seedContext: EventStoreContext = {
  tenantId: "tnt_public_presence" as TenantId,
  audit: {
    performedByUserId: "usr_public_presence" as UserId,
    forAccountId: "acc_public_presence" as AccountId,
  },
};

export async function seedBetaWavePolicyIfMissing(services: PublicPresenceServices) {
  try {
    const existing = await services.db.query(
      "SELECT 1 FROM platform_policy_documents WHERE policy_key = $1 AND status = 'active' LIMIT 1",
      [betaWavePolicy.policyKey],
    );
    if (existing.rows.length > 0) return;
  } catch {
    // Fresh bootstrap: the policy projection table may not exist until this pass.
  }

  await services.policies.createPolicyDocument(
    betaWavePolicy,
    {
      value: BETA_WAVE_LAUNCH_POLICY_VALUE,
      status: "active",
      effectiveFrom: "2026-07-12T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_public_presence",
    },
    seedContext,
  );
}
