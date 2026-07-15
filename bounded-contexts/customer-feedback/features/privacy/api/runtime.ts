import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { createCsatInvitationRuntime } from "../../csat/api/runtime";
import {
  customerFeedbackPrivacyPolicyVersion,
  customerFeedbackRetentionPolicy,
  type CustomerFeedbackRedactionScope,
} from "../domain/policy";

type InvitationsRuntime = ReturnType<typeof createCsatInvitationRuntime>;

export type CustomerFeedbackRetentionMode = "preview" | "execute";
export type CustomerFeedbackRetentionBatchInput = Readonly<{
  runId?: string;
  mode: CustomerFeedbackRetentionMode;
  batchLimit?: number;
  now?: string;
}>;

export type CustomerFeedbackRetentionBatchResult = Readonly<{
  runId: string;
  mode: CustomerFeedbackRetentionMode;
  scannedCount: number;
  eligibleCount: number;
  redactedCount: number;
  heldCount: number;
  errorCount: number;
  cursorInvitationId: string | null;
  state: "running" | "completed";
}>;

export type CustomerFeedbackPrivacyAuditQuery = Readonly<{
  invitationId?: string;
  action?: string;
  limit?: number;
}>;

export function createCustomerFeedbackPrivacyRuntime(input: {
  pool: PgTransactionalPool;
  db: PgQueryable;
  invitations: InvitationsRuntime;
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
}) {
  return {
    redact: (
      invitationId: string,
      command: Readonly<{
        scope: CustomerFeedbackRedactionScope;
        reason: string;
        actorId: string;
        idempotencyKey: string;
        redactedAt: string;
      }>,
      context: EventStoreContext,
    ) =>
      input.invitations.executePrivacyByInvitationId(invitationId, { type: "RedactCsatResponse", ...command }, context),
    placeHold: (
      invitationId: string,
      command: Readonly<{ holdId: string; reason: string; actorId: string; placedAt: string }>,
      context: EventStoreContext,
    ) =>
      input.invitations.executePrivacyByInvitationId(
        invitationId,
        { type: "PlaceCsatResponsePrivacyHold", ...command },
        context,
      ),
    releaseHold: (
      invitationId: string,
      command: Readonly<{ holdId: string; reason: string; actorId: string; releasedAt: string }>,
      context: EventStoreContext,
    ) =>
      input.invitations.executePrivacyByInvitationId(
        invitationId,
        { type: "ReleaseCsatResponsePrivacyHold", ...command },
        context,
      ),
    readSensitiveResponse: async (invitationId: string, actorId: string, readAt: string) => {
      const authoritativePrivacy = await input.invitations.readAuthoritativePrivacyByInvitationId(invitationId);
      const result = await input.db.query<{
        invitation_id: string;
        comment: string | null;
        follow_up_consent: boolean | null;
        follow_up_consent_version: string | null;
        follow_up_consent_statement: string | null;
        follow_up_consent_at: string | null;
        follow_up_consent_subject_account_id: string | null;
        follow_up_consent_purpose: string | null;
        follow_up_consent_applicability: string | null;
      }>(
        `SELECT invitation_id, comment, follow_up_consent, follow_up_consent_version,
                follow_up_consent_statement, follow_up_consent_at::text,
                follow_up_consent_subject_account_id, follow_up_consent_purpose,
                follow_up_consent_applicability
         FROM customer_feedback_csat_invitations
         WHERE invitation_id = $1`,
        [invitationId],
      );
      const projected = result.rows[0] ?? null;
      const row = projected
        ? maskLaggingSensitiveResponse(projected, authoritativePrivacy?.redactedScopes ?? [])
        : null;
      await recordAudit(input.db, {
        invitationId,
        action: "sensitive-response-viewed",
        actorId,
        capability: "view-comments",
        outcome: row ? "succeeded" : "failed",
        occurredAt: readAt,
      });
      return row;
    },
    queryAudit: async (query: CustomerFeedbackPrivacyAuditQuery) => {
      const values: unknown[] = [];
      const predicates: string[] = [];
      if (query.invitationId) {
        values.push(query.invitationId);
        predicates.push(`invitation_id = $${values.length}`);
      }
      if (query.action) {
        values.push(query.action);
        predicates.push(`action = $${values.length}`);
      }
      values.push(Math.max(1, Math.min(query.limit ?? 100, 500)));
      return (
        await input.db.query(
          `WITH privacy_audit AS (
             SELECT audit_id, invitation_id, action, actor_id, capability, scope, reason,
                    outcome, metadata, occurred_at
             FROM customer_feedback_privacy_audit
             UNION ALL
             SELECT audit_id, invitation_id, action, actor_id, capability, scope, reason,
                    outcome, metadata, occurred_at
             FROM customer_feedback_response_privacy_audit
             UNION ALL
             SELECT export_id AS audit_id, NULL AS invitation_id, 'sensitive-export' AS action,
                    actor_id, capability, NULL AS scope, reason,
                    CASE WHEN result = 'completed' THEN 'succeeded' ELSE 'failed' END AS outcome,
                    jsonb_build_object(
                      'normalizedFilters', filters,
                      'rowCount', row_count,
                      'artifactExpiresAt', artifact_expires_at,
                      'failureCode', failure_code
                    ) AS metadata,
                    started_at AS occurred_at
             FROM customer_feedback_csat_export_audits
           )
           SELECT audit_id, invitation_id, action, actor_id, capability, scope, reason,
                  outcome, metadata, occurred_at::text
           FROM privacy_audit
           ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
           ORDER BY occurred_at DESC, audit_id DESC
           LIMIT $${values.length}`,
          values,
        )
      ).rows;
    },
    runRetentionBatch: (batch: CustomerFeedbackRetentionBatchInput, context: EventStoreContext) =>
      runRetentionBatch(input.pool, input.invitations, input.policies, batch, context),
  };
}

function maskLaggingSensitiveResponse<
  T extends Readonly<{
    comment: string | null;
    follow_up_consent: boolean | null;
    follow_up_consent_at: string | null;
    follow_up_consent_subject_account_id: string | null;
  }>,
>(row: T, redactedScopes: readonly CustomerFeedbackRedactionScope[]): T {
  const redactContent = redactedScopes.includes("all-sensitive") || redactedScopes.includes("response-content");
  const redactIdentifiers = redactedScopes.includes("all-sensitive") || redactedScopes.includes("direct-identifiers");
  if (!redactContent && !redactIdentifiers) return row;
  return {
    ...row,
    comment: redactContent ? null : row.comment,
    follow_up_consent: redactIdentifiers ? false : row.follow_up_consent,
    follow_up_consent_at: redactIdentifiers ? null : row.follow_up_consent_at,
    follow_up_consent_subject_account_id: redactIdentifiers ? null : row.follow_up_consent_subject_account_id,
  } as T;
}

async function runRetentionBatch(
  pool: PgTransactionalPool,
  invitations: InvitationsRuntime,
  policies: Pick<PolicyRuntime, "resolvePolicy"> | undefined,
  batch: CustomerFeedbackRetentionBatchInput,
  context: EventStoreContext,
): Promise<CustomerFeedbackRetentionBatchResult> {
  const runId = batch.runId ?? createId("cfrun");
  const mode = batch.mode;
  const now = batch.now ?? new Date().toISOString();
  const batchLimit = Math.max(1, Math.min(batch.batchLimit ?? 100, 500));
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended('customer-feedback:response-retention', 0)) AS acquired`,
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) throw new Error("Customer Feedback response retention is already running.");

    await client.query(
      `INSERT INTO customer_feedback_retention_runs
         (run_id, policy_version, data_class, mode, state, started_at, updated_at)
       VALUES ($1, $2, 'response-content', $3, 'running', $4, $4)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, customerFeedbackPrivacyPolicyVersion, mode, now],
    );
    const run = await client.query<{ cursor_invitation_id: string | null }>(
      `SELECT cursor_invitation_id FROM customer_feedback_retention_runs
       WHERE run_id = $1 AND policy_version = $2 AND mode = $3`,
      [runId, customerFeedbackPrivacyPolicyVersion, mode],
    );
    if (!run.rows[0]) throw new Error("Retention run id belongs to a different policy version or mode.");

    const retention = policies
      ? (await policies.resolvePolicy(customerFeedbackRetentionPolicy, { at: now })).value
      : customerFeedbackRetentionPolicy.defaultValue;
    const responseCutoff = new Date(
      Date.parse(now) - retention.responseContentDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const candidates = await client.query<{
      invitation_id: string;
      privacy_hold: { releasedAt?: string | null } | null;
    }>(
      `SELECT invitation_id, privacy_hold
       FROM customer_feedback_csat_invitations
       WHERE submitted_at < $1::timestamptz
         AND response_content_redacted_at IS NULL
         AND direct_identifiers_redacted_at IS NULL
         AND ($2::text IS NULL OR invitation_id > $2)
       ORDER BY invitation_id ASC
       LIMIT $3`,
      [responseCutoff, run.rows[0].cursor_invitation_id, batchLimit],
    );

    let redactedCount = 0;
    let heldCount = 0;
    let errorCount = 0;
    for (const candidate of candidates.rows) {
      if (candidate.privacy_hold && candidate.privacy_hold.releasedAt == null) {
        heldCount += 1;
        continue;
      }
      if (mode === "preview") continue;
      try {
        await invitations.executePrivacyByInvitationId(
          candidate.invitation_id,
          {
            type: "RedactCsatResponse",
            scope: "all-sensitive",
            reason: "retention-schedule-elapsed",
            actorId: "customer-feedback-retention",
            idempotencyKey: `${customerFeedbackPrivacyPolicyVersion}:${candidate.invitation_id}`,
            redactedAt: now,
          },
          context,
        );
        redactedCount += 1;
      } catch {
        errorCount += 1;
      }
    }

    const cursorInvitationId = candidates.rows.at(-1)?.invitation_id ?? run.rows[0].cursor_invitation_id;
    const state = candidates.rows.length < batchLimit ? "completed" : "running";
    await client.query(
      `UPDATE customer_feedback_retention_runs
       SET cursor_invitation_id = $2,
           scanned_count = scanned_count + $3,
           eligible_count = eligible_count + $4,
           redacted_count = redacted_count + $5,
           held_count = held_count + $6,
           error_count = error_count + $7,
           state = $8,
           updated_at = $9,
           completed_at = CASE WHEN $8 = 'completed' THEN $9 ELSE NULL END
       WHERE run_id = $1`,
      [
        runId,
        cursorInvitationId,
        candidates.rows.length,
        candidates.rows.length - heldCount,
        redactedCount,
        heldCount,
        errorCount,
        state,
        now,
      ],
    );
    return {
      runId,
      mode,
      scannedCount: candidates.rows.length,
      eligibleCount: candidates.rows.length - heldCount,
      redactedCount,
      heldCount,
      errorCount,
      cursorInvitationId,
      state,
    };
  } finally {
    try {
      if (lockAcquired) {
        await client.query(`SELECT pg_advisory_unlock(hashtextextended('customer-feedback:response-retention', 0))`);
      }
    } finally {
      client.release();
    }
  }
}

async function recordAudit(
  db: PgQueryable,
  input: Readonly<{
    invitationId: string | null;
    action: string;
    actorId: string;
    capability: string;
    outcome: "succeeded" | "failed" | "blocked";
    occurredAt: string;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO customer_feedback_privacy_audit
       (audit_id, invitation_id, action, actor_id, capability, outcome, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      createId("cfpa"),
      input.invitationId,
      input.action,
      input.actorId,
      input.capability,
      input.outcome,
      input.occurredAt,
    ],
  );
}
