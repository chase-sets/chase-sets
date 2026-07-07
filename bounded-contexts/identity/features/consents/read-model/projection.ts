import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// Pre-policy-key consent facts were recorded before consent policies were
// named. Keep them auditable under an explicit legacy bucket instead of
// dropping the fact or poisoning replay.
const LEGACY_CONSENT_POLICY_KEY = "legacy-consent";
const LEGACY_CONSENT_POLICY_VERSION = "legacy";

export function buildConsentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.consent.recorded": async (event) => {
      const data = event.data as {
        consentId?: unknown;
        subjectType?: unknown;
        userId?: unknown;
        accountId?: unknown;
        policyKey?: unknown;
        policyVersion?: unknown;
        recordedAt?: unknown;
      };
      const consentId = requireConsentProjectionString(data.consentId, "Consent projection requires a consent id.");
      const userId = normalizeConsentProjectionOptionalString(data.userId);
      const accountId = normalizeConsentProjectionOptionalString(data.accountId);
      const subjectType = normalizeConsentSubjectType(data.subjectType, { userId, accountId });
      const policyKey = normalizeConsentProjectionOptionalString(data.policyKey) ?? LEGACY_CONSENT_POLICY_KEY;
      const policyVersion =
        normalizeConsentProjectionOptionalString(data.policyVersion) ?? LEGACY_CONSENT_POLICY_VERSION;
      const recordedAt = normalizeConsentProjectionOptionalString(data.recordedAt) ?? event.timing.recordedAt;

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

function normalizeConsentSubjectType(
  subjectType: unknown,
  subject: Readonly<{ userId: string | null; accountId: string | null }>,
): "user" | "account" {
  if (subjectType === "user" || subjectType === "account") {
    return subjectType;
  }
  if (subject.userId) {
    return "user";
  }
  if (subject.accountId) {
    return "account";
  }
  throw new Error("Consent projection requires a subject type.");
}

function requireConsentProjectionString(value: unknown, message: string): string {
  const normalized = normalizeConsentProjectionOptionalString(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeConsentProjectionOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
