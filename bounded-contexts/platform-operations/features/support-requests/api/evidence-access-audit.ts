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
/** The cleanup binding a service attempt ran under; service attempts never name a human, account or membership. */
export type EvidenceAccessServiceBinding = Readonly<{ bindingId: string; revision: number }>;
export type EvidenceAccessAttempt = Readonly<{
  attemptId: string;
  action: EvidenceAccessAction | "cleanup-audit-read";
  decision: "allowed" | "denied";
  reason: EvidenceAccessReason | "cleanup-binding" | "cleanup-binding-stale";
  tenantId: string | null;
  userId: string | null;
  accountId: string | null;
  membershipId: string | null;
  participation: EvidenceParticipation | "service";
  assignmentId: string | null;
  assignmentVersion: number | null;
  correlationId: string;
  at: string;
  serviceBinding?: EvidenceAccessServiceBinding;
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
const actions = ["upload", "download", "audit-read", "submit-participant", "submit-operations", "cleanup-request"];
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

function parseServiceBinding(record: Record<string, unknown>): boolean {
  const binding = record.serviceBinding;
  return (
    !!binding &&
    typeof binding === "object" &&
    !Array.isArray(binding) &&
    Object.keys(binding).length === 2 &&
    "bindingId" in binding &&
    "revision" in binding &&
    typeof binding.bindingId === "string" &&
    /^[a-z0-9-]{1,64}$/.test(binding.bindingId) &&
    typeof binding.revision === "number" &&
    Number.isInteger(binding.revision) &&
    binding.revision >= 1 &&
    binding.revision <= 2147483647 &&
    record.action === "cleanup-audit-read" &&
    record.participation === "service" &&
    (record.decision === "allowed" ? record.reason === "cleanup-binding" : record.reason === "cleanup-binding-stale") &&
    typeof record.tenantId === "string" &&
    record.userId === null &&
    record.accountId === null &&
    record.membershipId === null &&
    record.assignmentId === null
  );
}

export function parseEvidenceAccessAttempt(value: unknown): EvidenceAccessAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvidenceAccessError(503);
  const record = value as Record<string, unknown>;
  const id = (field: string, prefix: string) =>
    record[field] === null ||
    (typeof record[field] === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,80}$`).test(record[field]));
  // Service attempts are the human shape plus exactly one service binding; neither shape admits the other's values.
  const service = Object.hasOwn(record, "serviceBinding");
  if (
    Object.keys(record).length !== fields.length + (service ? 1 : 0) ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    (service && !parseServiceBinding(record)) ||
    typeof record.attemptId !== "string" ||
    !uuid.test(record.attemptId) ||
    typeof record.correlationId !== "string" ||
    !uuid.test(record.correlationId) ||
    (!service &&
      (typeof record.action !== "string" ||
        !actions.includes(record.action) ||
        typeof record.reason !== "string" ||
        !reasons.includes(record.reason) ||
        typeof record.participation !== "string" ||
        !participations.includes(record.participation))) ||
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
        // Auth's guest-checkout actor carries its `guest:` session handle, not an Identity Membership.
        membershipId: actor && !actor.membershipId.startsWith("guest:") ? actor.membershipId : null,
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
    /**
     * One durable, nonrecursive attempt for the cleanup runner's operational audit read. It is the only
     * service principal on this stream and is written before any provider work.
     */
    recordService: async (
      supportRequestId: string,
      tenantId: string,
      binding: EvidenceAccessServiceBinding,
      decision: "allowed" | "denied",
    ) => {
      const attempt = parseEvidenceAccessAttempt({
        attemptId: randomUUID(),
        action: "cleanup-audit-read",
        decision,
        reason: decision === "allowed" ? "cleanup-binding" : "cleanup-binding-stale",
        tenantId,
        userId: null,
        accountId: null,
        membershipId: null,
        participation: "service",
        assignmentId: null,
        assignmentVersion: null,
        correlationId: randomUUID(),
        at: now(),
        serviceBinding: { bindingId: binding.bindingId, revision: binding.revision },
      });
      await eventStore.appendToStream({
        streamId: `support.evidence-access-${supportRequestId}`,
        expectedVersion: "any",
        context: {
          tenantId: parseTypedId(tenantId, "tnt"),
          audit: {
            performedByUserId: parseTypedId("usr_support_evidence_cleanup", "usr"),
            forAccountId: parseTypedId("acc_support_evidence_cleanup", "acc"),
          },
        },
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
