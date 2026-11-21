import { createHash } from "node:crypto";
import { parseIdentityAccountProfileReportSubmittedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId, parseStrictTypedUlid, type AccountId } from "@chase-sets/primitives/typed-ids";
import { eligibilityScopeKeys, type IdentityMutationPersistence } from "../../account-management/api/fences";
import type { AccountProfileReportSubmission } from "../domain/submission";

const received = { status: "received" } as const;

export class AccountProfileReportAttemptConflict extends Error {
  constructor() {
    super("attempt_conflict");
  }
}

function digest(parts: readonly (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function readTargetId(target: string): AccountId | null {
  try {
    return parseStrictTypedUlid(target, "acc");
  } catch {
    return null;
  }
}

export function createAccountProfileReportRuntime(persistence: Pick<IdentityMutationPersistence, "transaction">) {
  return async function submitAccountProfileReport(
    input: AccountProfileReportSubmission & Readonly<{ target: string; reporterAccountId: AccountId }>,
    context: EventStoreContext,
  ): Promise<typeof received> {
    const { tenantId } = context;
    const { attemptId, target, reporterAccountId, reason, details } = input;
    const attemptKey = digest([tenantId, reporterAccountId, attemptId]);
    const requestDigest = digest([target, reason, details]);
    const targetId = readTargetId(target);
    const targetStream = targetId && targetId !== reporterAccountId ? `identity.account-${targetId}` : null;
    const reportStream = `identity.account-profile-report-${digest([tenantId, reporterAccountId, targetId])}`;
    return persistence.transaction(targetStream ? eligibilityScopeKeys(tenantId, targetStream, []) : [], async (tx) => {
      const inserted = await tx.db.query(
        `INSERT INTO identity_account_profile_report_attempts (attempt_key, request_digest)
         VALUES ($1, $2) ON CONFLICT (attempt_key) DO NOTHING RETURNING attempt_key`,
        [attemptKey, requestDigest],
      );
      if (!inserted.rows.length) {
        const prior = await tx.db.query<{ request_digest: string }>(
          "SELECT request_digest FROM identity_account_profile_report_attempts WHERE attempt_key = $1",
          [attemptKey],
        );
        if (prior.rows[0]?.request_digest !== requestDigest) throw new AccountProfileReportAttemptConflict();
        return received;
      }
      if (!targetStream || !targetId) return received;
      const eligibility = await tx.db.query<{ eligible: boolean }>(
        `SELECT NOT EXISTS (SELECT 1 FROM event_store_streams WHERE stream_id = $1)
            AND COALESCE((
              SELECT event_type IN ('identity.account.created', 'identity.account.reactivated')
              FROM event_store_events
              WHERE stream_id = $2 AND tenant_id = $3
                AND event_type IN ('identity.account.created', 'identity.account.suspended',
                                   'identity.account.reactivated', 'identity.account.closed')
              ORDER BY stream_version DESC LIMIT 1
            ), false) AS eligible`,
        [reportStream, targetStream, tenantId],
      );
      if (eligibility.rows[0]?.eligible !== true) return received;

      const payload = parseIdentityAccountProfileReportSubmittedPayload({
        version: 1,
        reportId: createId("rpt"),
        targetType: "account-profile",
        targetId,
        reporterAccountId,
        reason,
        details,
        submittedAt: new Date().toISOString(),
      });
      await tx.append([
        {
          streamId: reportStream,
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "identity.account-profile.report-submitted", payload }],
        },
      ]);
      return received;
    });
  };
}

export type SubmitAccountProfileReport = ReturnType<typeof createAccountProfileReportRuntime>;
