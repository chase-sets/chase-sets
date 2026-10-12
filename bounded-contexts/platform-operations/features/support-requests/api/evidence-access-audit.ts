import { randomUUID } from "node:crypto";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type {
  EvidenceAccessAction,
  EvidenceAccessDecision,
  EvidenceAccessReason,
  EvidenceParticipation,
} from "../domain/evidence-access-policy";

export const EVIDENCE_ACCESS_EVENT = "support.evidence-access-attempt-recorded";
export type EvidenceAccessAttempt = Readonly<{
  attemptId: string;
  action: EvidenceAccessAction;
  decision: "allowed" | "denied";
  reason: EvidenceAccessReason;
  tenantId: string | null;
  userId: string | null;
  accountId: string | null;
  membershipId: string | null;
  participation: EvidenceParticipation;
  assignmentId: string | null;
  assignmentVersion: number | null;
  correlationId: string;
  at: string;
}>;
export type EvidenceAccessAuditPage = Readonly<{
  items: readonly (EvidenceAccessAttempt & Readonly<{ cursor: string }>)[];
  nextCursor: string | null;
}>;

export class EvidenceAccessError extends Error {
  constructor(public readonly status: 401 | 403 | 404 | 503) {
    super("Evidence access could not be authorized.");
  }
}

const fields = [
  "attemptId",
  "action",
  "decision",
  "reason",
  "tenantId",
  "userId",
  "accountId",
  "membershipId",
  "participation",
  "assignmentId",
  "assignmentVersion",
  "correlationId",
  "at",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actions = ["upload", "download", "audit-read", "submit-participant", "submit-operations"];
const reasons = [
  "participant",
  "any-case-grant",
  "authentication-required",
  "base-permission-required",
  "case-not-found",
  "any-case-grant-required",
  "authority-unavailable",
];
const participations = ["buyer", "seller", "unrelated", "missing", "anonymous"];

export function parseEvidenceAccessAttempt(value: unknown): EvidenceAccessAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvidenceAccessError(503);
  const record = value as Record<string, unknown>;
  const id = (field: string, prefix: string) =>
    record[field] === null ||
    (typeof record[field] === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,80}$`).test(record[field]));
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    typeof record.attemptId !== "string" ||
    !uuid.test(record.attemptId) ||
    typeof record.correlationId !== "string" ||
    !uuid.test(record.correlationId) ||
    typeof record.action !== "string" ||
    !actions.includes(record.action) ||
    typeof record.reason !== "string" ||
    !reasons.includes(record.reason) ||
    typeof record.participation !== "string" ||
    !participations.includes(record.participation) ||
    typeof record.decision !== "string" ||
    !["allowed", "denied"].includes(record.decision) ||
    !id("tenantId", "tnt") ||
    !id("userId", "usr") ||
    !id("accountId", "acc") ||
    !id("membershipId", "mbr") ||
    !id("assignmentId", "acap") ||
    (record.assignmentId === null
      ? record.assignmentVersion !== null
      : !Number.isSafeInteger(record.assignmentVersion) || Number(record.assignmentVersion) < 1) ||
    typeof record.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at) ||
    !Number.isFinite(Date.parse(record.at)) ||
    new Date(record.at).toISOString() !== record.at ||
    Buffer.byteLength(JSON.stringify(record), "utf8") >= 1024
  )
    throw new EvidenceAccessError(503);
  return record as EvidenceAccessAttempt;
}

export function createEvidenceAccessAudit(eventStore: EventStore, now: () => string) {
  return {
    record: async (
      supportRequestId: string,
      action: EvidenceAccessAction,
      actor: ResolvedActor | null,
      access: EvidenceAccessDecision,
    ) => {
      const attempt = parseEvidenceAccessAttempt({
        attemptId: randomUUID(),
        action,
        decision: access.decision,
        reason: access.reason,
        tenantId: actor?.tenantId ?? null,
        userId: actor?.userId ?? null,
        accountId: actor?.accountId ?? null,
        membershipId: actor?.membershipId ?? null,
        participation: access.participation,
        assignmentId: access.assignment?.assignmentId ?? null,
        assignmentVersion: access.assignment?.version ?? null,
        correlationId: randomUUID(),
        at: now(),
      });
      // Signed-out envelopes use the same platform tenant as Auth-resolved actors and guest checkout envelopes.
      // Event-store envelopes require an audit principal even for signed-out attempts.
      // The closed payload remains explicitly anonymous, never a synthetic actor.
      const context: EventStoreContext = {
        tenantId: parseTypedId(attempt.tenantId ?? "tnt_identity", "tnt"),
        audit: {
          performedByUserId: parseTypedId(attempt.userId ?? "usr_support_evidence_anonymous", "usr"),
          forAccountId: parseTypedId(attempt.accountId ?? "acc_support_evidence_anonymous", "acc"),
        },
      };
      await eventStore.appendToStream({
        streamId: `support.evidence-access-${supportRequestId}`,
        expectedVersion: "any",
        context,
        events: [{ eventType: EVIDENCE_ACCESS_EVENT, payload: attempt }],
      });
    },
    page: async (supportRequestId: string, cursor?: string): Promise<EvidenceAccessAuditPage> => {
      if (cursor !== undefined && (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
        throw new EvidenceAccessError(404);
      const fromVersion = cursor === undefined ? 1 : Number(cursor);
      const events = await eventStore.readStream({
        streamId: `support.evidence-access-${supportRequestId}`,
        fromVersion,
        limit: 51,
      });
      if (
        events.length > 51 ||
        events.some(
          (event, index) => event.streamVersion !== fromVersion + index || event.eventType !== EVIDENCE_ACCESS_EVENT,
        )
      )
        throw new EvidenceAccessError(503);
      return {
        items: events
          .slice(0, 50)
          .map((event) => ({ ...parseEvidenceAccessAttempt(event.payload), cursor: String(event.streamVersion) })),
        nextCursor: events.length > 50 ? String(events[50].streamVersion) : null,
      };
    },
  };
}
