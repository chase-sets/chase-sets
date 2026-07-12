import type { ChaseSetsEventPayloads } from "@chase-sets/event-core";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPayoutReadinessProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<ChaseSetsEventPayloads, "settlement.payout-readiness.recorded">>({
    "settlement.payout-readiness.recorded": async (event) => {
      const data = event.data;

      await db.query(
        `INSERT INTO settlement_payout_readiness_pages (
           account_id,
           status,
           missing_requirements,
           advisory_requirements,
           disabled_reason,
           requirements_deadline,
           provider_reference,
           contact_email,
           onboarding_status,
           transfer_capability_status,
           payout_capability_status,
           payout_destination_status,
           payout_destination_fingerprint,
           payout_destination_changed_at,
           payout_account_dashboard,
           losses_collector,
           fees_collector,
           requirements_collector,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (account_id) DO UPDATE
         SET status = EXCLUDED.status,
             missing_requirements = EXCLUDED.missing_requirements,
             advisory_requirements = EXCLUDED.advisory_requirements,
             disabled_reason = EXCLUDED.disabled_reason,
             requirements_deadline = EXCLUDED.requirements_deadline,
             provider_reference = EXCLUDED.provider_reference,
             contact_email = EXCLUDED.contact_email,
             onboarding_status = EXCLUDED.onboarding_status,
             transfer_capability_status = EXCLUDED.transfer_capability_status,
             payout_capability_status = EXCLUDED.payout_capability_status,
             payout_destination_status = EXCLUDED.payout_destination_status,
             payout_destination_fingerprint = EXCLUDED.payout_destination_fingerprint,
             payout_destination_changed_at = EXCLUDED.payout_destination_changed_at,
             payout_account_dashboard = EXCLUDED.payout_account_dashboard,
             losses_collector = EXCLUDED.losses_collector,
             fees_collector = EXCLUDED.fees_collector,
             requirements_collector = EXCLUDED.requirements_collector,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_payout_readiness_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.accountId,
          data.status,
          JSON.stringify(Array.isArray(data.missingRequirements) ? data.missingRequirements : []),
          JSON.stringify(Array.isArray(data.advisoryRequirements) ? data.advisoryRequirements : []),
          data.disabledReason ?? null,
          data.requirementsDeadline ?? null,
          data.providerReference,
          data.contactEmail,
          data.onboardingStatus ?? "not-started",
          data.transferCapabilityStatus ?? "inactive",
          data.payoutCapabilityStatus ?? "inactive",
          data.payoutDestinationStatus ?? "missing",
          data.payoutDestinationFingerprint,
          data.payoutDestinationChangedAt,
          data.payoutAccountDashboard ?? "unknown",
          data.lossesCollector ?? "unknown",
          data.feesCollector ?? "unknown",
          data.requirementsCollector ?? "unknown",
          data.recordedAt,
          event.streamVersion,
        ],
      );
    },
  });
}
