import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CsatInvitationPublicReference } from "../domain/invitation";
import type { CsatWorkflowOutcomeCode } from "../domain/workflow-outcomes";
import type { CsatAdminQueueItem, CsatAdminQueuePage, CsatAdminQueueQuery } from "../api/analytics-contract";

export type CsatInvitationPageRow = Readonly<{
  invitation_id: string;
  public_reference: string | null;
  state: string;
  survey_kind: string;
  survey_version: string;
  question_version: string;
  outcome_code: string;
  subject_account_id: string;
  subject_kind: string;
  sampling_decision: unknown;
  sampling_policy_schema_version: number | null;
  eligible_at: string;
  issued_at: string | null;
  expires_at: string | null;
  presented_at: string | null;
  submitted_at: string | null;
  dismissed_at: string | null;
  expired_at: string | null;
  suppressed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}>;

const publicInvitationColumns = `
  invitation_id,
  public_reference,
  state,
  survey_kind,
  survey_version,
  question_version,
  outcome_code,
  subject_account_id,
  subject_kind,
  sampling_decision,
  sampling_policy_schema_version,
  eligible_at,
  issued_at,
  expires_at,
  presented_at,
  submitted_at,
  dismissed_at,
  expired_at,
  suppressed_at,
  revoked_at,
  revocation_reason
`;

/** Account-scoped lookup prevents a valid public reference from crossing account boundaries. */
export async function getCsatInvitationByPublicReference(
  db: PgQueryable,
  publicReference: CsatInvitationPublicReference,
  subjectAccountId: string,
): Promise<CsatInvitationPageRow | null> {
  const result = await db.query<CsatInvitationPageRow>(
    `SELECT ${publicInvitationColumns}
     FROM customer_feedback_csat_invitations
     WHERE public_reference = $1
       AND subject_account_id = $2`,
    [publicReference, subjectAccountId],
  );
  return result.rows[0] ?? null;
}

/** Internal command-routing lookup; the stream id never enters the public page shape. */
export async function getCsatInvitationStreamIdByPublicReference(
  db: PgQueryable,
  publicReference: CsatInvitationPublicReference,
  subjectAccountId: string,
): Promise<string | null> {
  const result = await db.query<{ stream_id: string }>(
    `SELECT stream_id
     FROM customer_feedback_csat_invitations
     WHERE public_reference = $1
       AND subject_account_id = $2`,
    [publicReference, subjectAccountId],
  );
  return result.rows[0]?.stream_id ?? null;
}

export async function getLatestCsatInvitationIssuedAt(
  db: PgQueryable,
  subjectAccountId: string,
  outcomeCode: CsatWorkflowOutcomeCode,
): Promise<string | null> {
  const result = await db.query<{ issued_at: string }>(
    `SELECT issued_at
     FROM customer_feedback_csat_invitations
     WHERE subject_account_id = $1
       AND outcome_code = $2
       AND issued_at IS NOT NULL
     ORDER BY issued_at DESC
     LIMIT 1`,
    [subjectAccountId, outcomeCode],
  );
  return result.rows[0]?.issued_at ?? null;
}

const adminQueuePageSize = 50;
const adminQueueMaximumPageSize = 100;

type QueueCursor = Readonly<{ version: 1; eligibleAt: string; invitationId: string }>;

type AdminQueueRow = Readonly<{
  invitation_id: string;
  state: string;
  survey_kind: string;
  survey_version: string;
  question_version: string;
  outcome_code: string;
  subject_kind: string;
  eligible_at: string;
  issued_at: string | null;
  presented_at: string | null;
  submitted_at: string | null;
  dismissed_at: string | null;
  expired_at: string | null;
  rating: 1 | 2 | 3 | 4 | 5 | null;
  follow_up_consent: boolean | null;
}>;

export async function listCsatAdminQueue(db: PgQueryable, params: CsatAdminQueueQuery): Promise<CsatAdminQueuePage> {
  const limit = Math.max(1, Math.min(params.limit ?? adminQueuePageSize, adminQueueMaximumPageSize));
  const direction = params.direction ?? "next";
  const cursor = params.cursor ? decodeQueueCursor(params.cursor) : null;
  const values: unknown[] = [];
  const predicates: string[] = [];

  if (params.from) {
    values.push(new Date(Date.parse(params.from)).toISOString());
    predicates.push(`i.eligible_at >= $${values.length}`);
  }
  if (params.to) {
    values.push(new Date(Date.parse(params.to)).toISOString());
    predicates.push(`i.eligible_at < $${values.length}`);
  }
  if (params.surveyVersion) {
    values.push(
      params.surveyVersion.surveyKind,
      params.surveyVersion.surveyVersion,
      params.surveyVersion.questionVersion,
    );
    predicates.push(`i.survey_kind = $${values.length - 2}`);
    predicates.push(`i.survey_version = $${values.length - 1}`);
    predicates.push(`i.question_version = $${values.length}`);
  }
  appendArrayFilter(predicates, values, "i.outcome_code", params.outcomeCodes);
  appendArrayFilter(predicates, values, "i.subject_kind", params.customerRoles);
  appendArrayFilter(predicates, values, "i.state", params.states);
  appendArrayFilter(predicates, values, "f.rating", params.ratings);
  if (params.followUpConsent === "granted") predicates.push("i.follow_up_consent IS TRUE");
  if (params.followUpConsent === "not-granted") predicates.push("i.follow_up_consent IS NOT TRUE");
  if (cursor) {
    values.push(cursor.eligibleAt, cursor.invitationId);
    const operator = direction === "previous" ? ">" : "<";
    predicates.push(`(i.eligible_at, i.invitation_id) ${operator} ($${values.length - 1}, $${values.length})`);
  }

  const order = direction === "previous" ? "ASC" : "DESC";
  const result = await db.query<AdminQueueRow>(
    `SELECT i.invitation_id, i.state, i.survey_kind, i.survey_version, i.question_version,
            i.outcome_code, i.subject_kind, i.eligible_at::text AS eligible_at,
            i.issued_at::text AS issued_at, i.presented_at::text AS presented_at,
            i.submitted_at::text AS submitted_at, i.dismissed_at::text AS dismissed_at,
            i.expired_at::text AS expired_at, i.follow_up_consent, f.rating
     FROM customer_feedback_csat_invitations i
     LEFT JOIN customer_feedback_csat_analytics_facts f ON f.invitation_id = i.invitation_id
     ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
     ORDER BY i.eligible_at ${order}, i.invitation_id ${order}
     LIMIT $${values.length + 1}`,
    [...values, limit + 1],
  );
  const pageRows = result.rows.slice(0, limit);
  if (direction === "previous") pageRows.reverse();
  const first = pageRows[0];
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toAdminQueueItem),
    nextCursor: result.rows.length > limit && last ? encodeQueueCursor(last) : null,
    previousCursor: cursor && first ? encodeQueueCursor(first) : null,
    limit,
  };
}

function appendArrayFilter(
  predicates: string[],
  values: unknown[],
  column: string,
  filter?: readonly (string | number)[],
) {
  if (!filter || filter.length === 0) return;
  values.push([...new Set(filter)]);
  predicates.push(`${column} = ANY($${values.length}::text[])`);
}

function toAdminQueueItem(row: AdminQueueRow): CsatAdminQueueItem {
  return {
    invitationId: row.invitation_id,
    state: row.state,
    surveyVersion: {
      surveyKind: row.survey_kind as CsatAdminQueueItem["surveyVersion"]["surveyKind"],
      surveyVersion: row.survey_version,
      questionVersion: row.question_version,
    },
    outcomeCode: row.outcome_code,
    customerRole: row.subject_kind as CsatAdminQueueItem["customerRole"],
    eligibleAt: row.eligible_at,
    issuedAt: row.issued_at,
    presentedAt: row.presented_at,
    submittedAt: row.submitted_at,
    dismissedAt: row.dismissed_at,
    expiredAt: row.expired_at,
    rating: row.rating,
    followUpConsent: row.follow_up_consent,
  };
}

function encodeQueueCursor(row: Pick<AdminQueueRow, "eligible_at" | "invitation_id">): string {
  return Buffer.from(
    JSON.stringify({ version: 1, eligibleAt: row.eligible_at, invitationId: row.invitation_id }),
    "utf8",
  ).toString("base64url");
}

function decodeQueueCursor(value: string): QueueCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<QueueCursor>;
    if (decoded.version !== 1 || typeof decoded.eligibleAt !== "string" || typeof decoded.invitationId !== "string") {
      throw new Error("invalid");
    }
    return decoded as QueueCursor;
  } catch {
    throw new Error("Invalid CSAT queue cursor.");
  }
}
