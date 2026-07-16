import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// Pre-policy-key consent facts were recorded before consent policies were
// named. Keep them auditable under an explicit legacy bucket instead of
// dropping the fact or poisoning replay.
const LEGACY_CONSENT_POLICY_KEY = "legacy-consent";
const LEGACY_CONSENT_POLICY_VERSION = "legacy";
const LEGACY_CONSENT_RECORDED_AT = "1970-01-01T00:00:00.000Z";

type ConsentProjectionFact = Readonly<{
  consentId: string;
  subjectType: "user" | "account";
  subjectId: string;
  userId: string | null;
  accountId: string | null;
  policyKey: string;
  policyVersion: string;
}>;

export function buildConsentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.consent.recorded": async (event) => {
      const fact = normalizeConsentProjectionFact(event.data);
      const recordedAt = consentEventTime(event, "recordedAt", LEGACY_CONSENT_RECORDED_AT);
      const updatedAt = normalizeConsentProjectionOptionalString(event.timing.recordedAt) ?? recordedAt;

      await db.query(
        `INSERT INTO identity_consents (
           consent_id,
           subject_type,
           user_id,
           account_id,
           policy_key,
           policy_version,
           status,
           recorded_at,
           withdrawn_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'recorded', $7, NULL, $8)
         ON CONFLICT (consent_id) DO UPDATE
         SET subject_type = $2,
             user_id = $3,
             account_id = $4,
             policy_key = $5,
             policy_version = $6,
             status = 'recorded',
             recorded_at = $7,
             withdrawn_at = NULL,
             updated_at = $8`,
        [
          fact.consentId,
          fact.subjectType,
          fact.userId,
          fact.accountId,
          fact.policyKey,
          fact.policyVersion,
          recordedAt,
          updatedAt,
        ],
      );
    },
    "identity.consent.withdrawn": async (event) => {
      const data = event.data as Readonly<{ consentId?: unknown; withdrawnAt?: unknown }>;
      const consentId = requireConsentProjectionString(data.consentId, "Consent withdrawal requires a consent id.");
      const withdrawnAt = consentEventTime(event, "withdrawnAt", LEGACY_CONSENT_RECORDED_AT);
      const updatedAt = normalizeConsentProjectionOptionalString(event.timing.recordedAt) ?? withdrawnAt;

      await db.query(
        `UPDATE identity_consents
         SET status = 'withdrawn',
             withdrawn_at = $2,
             updated_at = $3
         WHERE consent_id = $1`,
        [consentId, withdrawnAt, updatedAt],
      );
    },
  };
}

export function buildConsentCurrentStateProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.consent.recorded": async (event) => {
      const fact = normalizeConsentProjectionFact(event.data);
      const recordedAt = consentEventTime(event, "recordedAt", LEGACY_CONSENT_RECORDED_AT);
      const updatedAt = normalizeConsentProjectionOptionalString(event.timing.recordedAt) ?? recordedAt;

      await upsertConsentCurrentState(db, {
        ...fact,
        status: "recorded",
        recordedAt,
        withdrawnAt: null,
        globalPosition: event.globalPosition,
        updatedAt,
      });
    },
    "identity.consent.withdrawn": async (event) => {
      const fact = normalizeConsentProjectionFact(event.data);
      const withdrawnAt = consentEventTime(event, "withdrawnAt", LEGACY_CONSENT_RECORDED_AT);
      const updatedAt = normalizeConsentProjectionOptionalString(event.timing.recordedAt) ?? withdrawnAt;

      await db.query(
        `UPDATE identity_consent_current_states
         SET status = 'withdrawn',
             withdrawn_at = $5,
             last_event_global_position = $6,
             updated_at = $7
         WHERE subject_type = $1
           AND subject_id = $2
           AND policy_key = $3
           AND consent_id = $4
           AND last_event_global_position <= $6`,
        [
          fact.subjectType,
          fact.subjectId,
          fact.policyKey,
          fact.consentId,
          withdrawnAt,
          event.globalPosition,
          updatedAt,
        ],
      );
    },
  };
}

async function upsertConsentCurrentState(
  db: PgQueryable,
  state: ConsentProjectionFact &
    Readonly<{
      status: "recorded" | "withdrawn";
      recordedAt: string;
      withdrawnAt: string | null;
      globalPosition: string;
      updatedAt: string;
    }>,
) {
  await db.query(
    `INSERT INTO identity_consent_current_states (
       subject_type,
       subject_id,
       user_id,
       account_id,
       policy_key,
       consent_id,
       policy_version,
       status,
       recorded_at,
       withdrawn_at,
       last_event_global_position,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (subject_type, subject_id, policy_key) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         account_id = EXCLUDED.account_id,
         consent_id = EXCLUDED.consent_id,
         policy_version = EXCLUDED.policy_version,
         status = EXCLUDED.status,
         recorded_at = EXCLUDED.recorded_at,
         withdrawn_at = EXCLUDED.withdrawn_at,
         last_event_global_position = EXCLUDED.last_event_global_position,
         updated_at = EXCLUDED.updated_at
     WHERE EXCLUDED.last_event_global_position >= identity_consent_current_states.last_event_global_position`,
    [
      state.subjectType,
      state.subjectId,
      state.userId,
      state.accountId,
      state.policyKey,
      state.consentId,
      state.policyVersion,
      state.status,
      state.recordedAt,
      state.withdrawnAt,
      state.globalPosition,
      state.updatedAt,
    ],
  );
}

function normalizeConsentProjectionFact(dataValue: unknown): ConsentProjectionFact {
  const data = dataValue as {
    consentId?: unknown;
    subjectType?: unknown;
    userId?: unknown;
    accountId?: unknown;
    policyKey?: unknown;
    policyVersion?: unknown;
  };
  const consentId = requireConsentProjectionString(data.consentId, "Consent projection requires a consent id.");
  const userId = normalizeConsentProjectionOptionalString(data.userId);
  const accountId = normalizeConsentProjectionOptionalString(data.accountId);
  const subjectType = normalizeConsentSubjectType(data.subjectType, { userId, accountId });
  const subjectId = requireConsentProjectionString(
    subjectType === "user" ? userId : accountId,
    "Consent projection requires a subject id.",
  );

  return {
    consentId,
    subjectType,
    subjectId,
    userId,
    accountId,
    policyKey: normalizeConsentProjectionOptionalString(data.policyKey) ?? LEGACY_CONSENT_POLICY_KEY,
    policyVersion: normalizeConsentProjectionOptionalString(data.policyVersion) ?? LEGACY_CONSENT_POLICY_VERSION,
  };
}

function consentEventTime(
  event: Readonly<{ data: unknown; timing: Readonly<{ recordedAt: unknown; occurredAt?: unknown }> }>,
  dataField: "recordedAt" | "withdrawnAt",
  fallback: string,
) {
  const data = event.data as Record<string, unknown>;
  return (
    normalizeConsentProjectionOptionalString(data[dataField]) ??
    normalizeConsentProjectionOptionalString(event.timing.recordedAt) ??
    normalizeConsentProjectionOptionalString(event.timing.occurredAt) ??
    fallback
  );
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
