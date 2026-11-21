import {
  identityAccountProfileReportDetailsMaxLength,
  identityAccountProfileReportReasons,
  type IdentityAccountProfileReportReason,
} from "@chase-sets/event-core/public-event-payloads";
import { parseAttemptKey } from "../../account-management/domain/contract";

export type AccountProfileReportSubmission = Readonly<{
  attemptId: string;
  reason: IdentityAccountProfileReportReason;
  details: string | null;
}>;

export function parseAccountProfileReportSubmission(value: unknown): AccountProfileReportSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const fields = ["attemptId", "reason", "details"] as const;
  if (Reflect.ownKeys(body).length !== fields.length || fields.some((field) => !Object.hasOwn(body, field)))
    return null;
  const reason = identityAccountProfileReportReasons.find((candidate) => candidate === body.reason);
  if (!reason || (body.details !== null && typeof body.details !== "string")) return null;
  const details = body.details?.trim() || null;
  // PostgreSQL JSONB cannot store NUL or unpaired surrogate code units.
  if (
    details &&
    (details.length > identityAccountProfileReportDetailsMaxLength || /[\u0000\p{Surrogate}]/u.test(details))
  )
    return null;
  try {
    return { attemptId: parseAttemptKey(body.attemptId), reason, details };
  } catch {
    return null;
  }
}
