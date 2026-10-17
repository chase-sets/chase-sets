import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity-seed";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, marketplaceListingEvidencePolicy } from "../domain/policy";

const seedContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: identitySeedIds.demo.userId,
    forAccountId: identitySeedIds.demo.accountId,
  },
};

export async function seedListingEvidencePolicy(deps: Readonly<{ db: PgQueryable; policies: PolicyRuntime }>) {
  let existing;
  try {
    existing = await deps.db.query(
      "SELECT 1 FROM platform_policy_documents WHERE policy_key = $1 AND status = 'active' LIMIT 1",
      [marketplaceListingEvidencePolicy.policyKey],
    );
  } catch (error) {
    console.log(
      `Listing Evidence Policy seed skipped until its policy projection is mounted: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (existing.rows.length > 0) return;

  try {
    await deps.policies.createPolicyDocument(
      marketplaceListingEvidencePolicy,
      {
        value: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
        status: "active",
        effectiveFrom: "2026-07-13T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: identitySeedIds.demo.userId,
      },
      seedContext,
    );
  } catch (error) {
    console.log(
      `Listing Evidence Policy seed skipped for this pass: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
