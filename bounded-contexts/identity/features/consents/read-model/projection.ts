import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildConsentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.consent.recorded": async (event) => {
      const { consentId, subjectType, userId, accountId, policyKey, policyVersion, recordedAt } = event.data as {
        consentId: string;
        subjectType: string;
        userId: string | null;
        accountId: string | null;
        policyKey: string;
        policyVersion: string;
        recordedAt: string;
      };
      await db.query(
        `INSERT INTO identity_consents (
           consent_id,
           subject_type,
           user_id,
           account_id,
           policy_key,
           policy_version,
           recorded_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (consent_id) DO UPDATE
         SET subject_type = $2,
             user_id = $3,
             account_id = $4,
             policy_key = $5,
             policy_version = $6,
             recorded_at = $7,
             updated_at = $8`,
        [consentId, subjectType, userId, accountId, policyKey, policyVersion, recordedAt, event.timing.recordedAt],
      );
    },
  };
}
