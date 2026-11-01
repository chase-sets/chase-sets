import {
  normalizeEvidenceType,
  normalizeFlowType,
  normalizeResponseType,
  normalizeResolutionType,
  SupportDomainError,
} from "./common";
import { parseSupportEvidenceAttachmentReference } from "./attachment-reference";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";

export const participantActions = {
  "open-support-request": { path: "/", fact: "support.support-request.opened", status: "opened" },
  "submit-evidence": {
    path: "/:id/evidence",
    fact: "support.support-request.evidence-submitted",
    status: "evidence-submitted",
  },
  "record-response": {
    path: "/:id/responses",
    fact: "support.support-request.response-recorded",
    status: "response-recorded",
  },
  "accept-offer": {
    path: "/:id/offers/:offerId/accept",
    fact: "support.support-request.offer-accepted",
    status: "offer-accepted",
  },
  "decline-offer": {
    path: "/:id/offers/:offerId/decline",
    fact: "support.support-request.offer-declined",
    status: "offer-declined",
  },
  escalate: { path: "/:id/escalate", fact: "support.support-request.escalated", status: "escalated" },
  cancel: { path: "/:id/cancel", fact: "support.support-request.cancelled", status: "cancelled" },
  close: { path: "/:id/close", fact: "support.support-request.closed", status: "closed" },
  "return-condition-dispute": {
    path: "/:id/return-condition-dispute",
    fact: "support.support-request.return-condition-disputed",
    status: "return-condition-disputed",
  },
} as const;
export type ParticipantAction = keyof typeof participantActions;
export type ParticipantAttempt = Readonly<{ attemptId: string; requestHash: string }>;
export type SupportParticipantDescriptor = ParticipantAttempt &
  Readonly<{ actionKind: ParticipantAction; targetId: string | null }>;
export type ParticipantResult = Readonly<{
  id: string;
  version: number;
  status: (typeof participantActions)[ParticipantAction]["status"];
  evidenceId: string | null;
  responseId: string | null;
  offerId: string | null;
}>;
export type ParticipantReceipt = Readonly<{
  tenantId: string;
  accountId: string;
  targetId: string;
  attemptId: string;
  requestHash: string;
  actionKind: ParticipantAction;
  firstVersion: number;
  factsHash: string;
  result: ParticipantResult;
}>;
export type ParticipantLookup =
  | Readonly<{ outcome: "committed" | "confirming"; actionKind: ParticipantAction; result: ParticipantResult }>
  | Readonly<{ outcome: "not-recorded" }>
  | Readonly<{ outcome: "unknown"; reason: "authority-unavailable" | "history-invalid" }>;
export class ParticipantAttemptError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new ParticipantAttemptError(400, "invalid-participant-attempt");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new ParticipantAttemptError(400, "unknown-participant-field");
  return object;
}
export function participantAction(value: string): ParticipantAction {
  if (!Object.hasOwn(participantActions, value)) throw new ParticipantAttemptError(400, "invalid-participant-action");
  return value as ParticipantAction;
}
export function parseParticipantAttempt(value: unknown): ParticipantAttempt {
  const object = closedObject(value, ["attemptId", "requestHash"]);
  if (
    typeof object.attemptId !== "string" ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(object.attemptId) ||
    typeof object.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.requestHash)
  )
    throw new ParticipantAttemptError(400, "invalid-participant-attempt");
  return { attemptId: object.attemptId, requestHash: object.requestHash };
}
function text(value: unknown, limit = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new ParticipantAttemptError(400, "invalid-participant-text");
  return value.trim();
}
function optionalText(value: unknown, limit = 4000): string | null {
  return value == null || value === "" ? null : text(value, limit);
}
function ids(value: unknown, attachment = false): readonly string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length)
    throw new ParticipantAttemptError(400, "invalid-participant-list");
  return value.map((entry) => {
    const id = text(entry, 256);
    if (attachment && !parseSupportEvidenceAttachmentReference(id))
      throw new SupportDomainError("attachment_reference_unknown");
    if (!attachment && !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new ParticipantAttemptError(400, "invalid-participant-reference");
    return id;
  });
}

// The same versioned normalization runs before hashing at both dispatch boundaries.
export function canonicalParticipantRequest(actionKind: ParticipantAction, input: unknown): string {
  participantAction(actionKind);
  let payload: Record<string, unknown>;
  switch (actionKind) {
    case "open-support-request": {
      const b = closedObject(input, [
        "orderId",
        "flowType",
        "affectedLineIds",
        "intakePhotoReferences",
        "attachmentOperationId",
        "photoRequired",
        "openedByRole",
        "role",
      ]);
      const orderId = text(b.orderId, 128);
      if (!/^ord_[A-Za-z0-9_-]+$/.test(orderId)) throw new ParticipantAttemptError(400, "invalid-order-id");
      const affectedLineIds = ids(b.affectedLineIds);
      const intakePhotoReferences = ids(b.intakePhotoReferences, true);
      const attachmentOperationId =
        b.attachmentOperationId == null || b.attachmentOperationId === "" ? null : text(b.attachmentOperationId, 80);
      const legacyEmptyIntake = !intakePhotoReferences?.length && attachmentOperationId === null;
      payload = legacyEmptyIntake
        ? { orderId, flowType: normalizeFlowType(text(b.flowType, 80)), affectedLineIds }
        : {
            orderId,
            flowType: normalizeFlowType(text(b.flowType, 80)),
            affectedLineIds,
            intakePhotoReferences: intakePhotoReferences ?? [],
            ...(attachmentOperationId === null ? {} : { attachmentOperationId }),
          };
      break;
    }
    case "submit-evidence": {
      const b = closedObject(input, [
        "submittedByRole",
        "evidenceType",
        "summary",
        "occurredAt",
        "attachments",
        "attachmentOperationId",
      ]);
      const occurredAt = optionalText(b.occurredAt, 30);
      if (occurredAt && (!Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt))
        throw new ParticipantAttemptError(400, "invalid-participant-instant");
      payload = {
        submittedByRole: optionalText(b.submittedByRole, 10),
        evidenceType: normalizeEvidenceType(text(b.evidenceType, 80)),
        summary: text(b.summary),
        occurredAt,
        attachments: ids(b.attachments, true) ?? [],
        ...(b.attachmentOperationId == null ? {} : { attachmentOperationId: text(b.attachmentOperationId, 80) }),
      };
      break;
    }
    case "record-response": {
      const b = closedObject(input, [
        "submittedByRole",
        "responseType",
        "summary",
        "offerResolutionType",
        "refundAmount",
        "affectedLineIds",
        "refundCurrencyCode",
      ]);
      let refundAmount = optionalText(b.refundAmount, 20);
      if (refundAmount) {
        try {
          refundAmount = normalizeMoneyAmount(refundAmount);
        } catch {
          throw new ParticipantAttemptError(400, "invalid-participant-amount");
        }
      }
      const refundCurrencyCode = optionalText(b.refundCurrencyCode, 3);
      if (refundCurrencyCode && !/^[A-Z]{3}$/.test(refundCurrencyCode))
        throw new ParticipantAttemptError(400, "invalid-participant-currency");
      payload = {
        submittedByRole: optionalText(b.submittedByRole, 10),
        responseType: normalizeResponseType(text(b.responseType, 80)),
        summary: text(b.summary),
        offerResolutionType:
          b.offerResolutionType == null || b.offerResolutionType === ""
            ? null
            : normalizeResolutionType(text(b.offerResolutionType, 80)),
        refundAmount,
        affectedLineIds: ids(b.affectedLineIds),
        refundCurrencyCode,
      };
      break;
    }
    case "accept-offer": {
      const b = closedObject(input, ["offerId"]);
      payload = { offerId: text(b.offerId, 128) };
      break;
    }
    case "decline-offer": {
      const b = closedObject(input, ["offerId", "summary"]);
      payload = { offerId: text(b.offerId, 128), summary: optionalText(b.summary) };
      break;
    }
    case "close":
      closedObject(input, []);
      payload = {};
      break;
    default: {
      const b = closedObject(input, ["reason"]);
      payload = { reason: text(b.reason) };
    }
  }
  if (payload.submittedByRole && payload.submittedByRole !== "buyer" && payload.submittedByRole !== "seller")
    throw new ParticipantAttemptError(400, "invalid-participant-role");
  return JSON.stringify({ version: 1, actionKind, payload });
}

export async function hashParticipantRequest(action: ParticipantAction, input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalParticipantRequest(action, input)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function parseParticipantLookup(value: unknown): ParticipantLookup {
  const b = closedObject(value, ["outcome", "actionKind", "result", "reason"]);
  if (b.outcome === "not-recorded" && Object.keys(b).length === 1) return { outcome: "not-recorded" };
  if (
    b.outcome === "unknown" &&
    Object.keys(b).length === 2 &&
    (b.reason === "authority-unavailable" || b.reason === "history-invalid")
  )
    return { outcome: "unknown", reason: b.reason };
  if ((b.outcome === "committed" || b.outcome === "confirming") && Object.keys(b).length === 3) {
    const actionKind = participantAction(text(b.actionKind, 80));
    const r = closedObject(b.result, ["id", "version", "status", "evidenceId", "responseId", "offerId"]);
    if (
      Object.keys(r).length !== 6 ||
      typeof r.version !== "number" ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1 ||
      r.status !== participantActions[actionKind].status ||
      typeof r.id !== "string" ||
      !/^sup_[A-Za-z0-9_-]{1,80}$/.test(r.id) ||
      ["evidenceId", "responseId", "offerId"].some((key, index) => {
        const id = r[key];
        return (
          id !== null &&
          (typeof id !== "string" || !new RegExp(`^${["sev", "srp", "sof"][index]}_[A-Za-z0-9_-]{1,80}$`).test(id))
        );
      })
    )
      throw new ParticipantAttemptError(400, "invalid-participant-result");
    return { outcome: b.outcome, actionKind, result: r as ParticipantResult };
  }
  throw new ParticipantAttemptError(400, "invalid-participant-outcome");
}
