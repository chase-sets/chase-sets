import type { DomainEvent } from "@chase-sets/event-core";
import type { SupportRequestRemedyAuthorizedV1Payload } from "@chase-sets/event-core/platform-coverage-facts";
import type { AccountId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { SupportDomainError } from "./common";
import { platformRemedyCapabilities, type PlatformRemedyCapability } from "./platform-remedy-policy";
import type { RemedyEffectFact, RemedyEffectKind, RemedyEffectWaiver } from "./remedy";

export type RemedyApprovalStatus =
  | "reservation-pending"
  | "reservation-rejected"
  | "expired"
  | "approval-pending"
  | "approved"
  | "authorized"
  | "correction-requested";

export type RemedyReservationStatus = "not-required" | "pending" | "reserved" | "rejected" | "expired";

export type RemedyApprovalRecord = Readonly<{
  approvedByAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  reasonCode: string;
  rationale: string;
  evidenceReferences: readonly string[];
  idempotencyKey: string;
  approvedAt: string;
}>;

export type RemedyWorkflowAuditEntry = Readonly<{
  action:
    | "proposal"
    | "reservation-requested"
    | "reservation-reserved"
    | "reservation-rejected"
    | "approval"
    | "authorization"
    | "return-override"
    | "retry-requested"
    | "effect-waived"
    | "correction-requested";
  actorType: "human" | "system";
  actorAccountId: AccountId | null;
  permissionUsed: PlatformRemedyCapability | null;
  reasonCode: string;
  rationale: string | null;
  evidenceReferences: readonly string[];
  occurredAt: string;
  correlationId: string;
}>;

export type RemedyApprovalWorkflow = Readonly<{
  terms: SupportRequestRemedyAuthorizedV1Payload;
  proposedByAccountId: AccountId;
  proposalPermissionUsed: PlatformRemedyCapability;
  proposalRationale: string;
  evidenceReferences: readonly string[];
  proposedAt: string;
  reservationExpiresAt: string | null;
  reservationStatus: RemedyReservationStatus;
  reservationReasonCode: string | null;
  requiredApprovalCount: number;
  requiresElevatedApproval: boolean;
  returnOverrideUsed: boolean;
  returnExceptionReasonCode: string | null;
  approvals: readonly RemedyApprovalRecord[];
  status: RemedyApprovalStatus;
  correctionReasonCode: string | null;
  auditTrail: readonly RemedyWorkflowAuditEntry[];
}>;

export type ProposeSupportRemedyCommand = Readonly<{
  type: "ProposeSupportRemedy";
  terms: SupportRequestRemedyAuthorizedV1Payload;
  proposedByAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  rationale: string;
  evidenceReferences: readonly string[];
  reservationExpiresAt: string | null;
  requiredApprovalCount: number;
  requiresElevatedApproval: boolean;
  returnOverrideUsed: boolean;
  returnExceptionReasonCode: string | null;
}>;

export type ApproveSupportRemedyCommand = Readonly<{
  type: "ApproveSupportRemedy";
  approvedByAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  reasonCode: string;
  rationale: string;
  evidenceReferences: readonly string[];
  idempotencyKey: string;
  approvedAt: string;
}>;

export type RetrySupportRemedyEffectCommand = Readonly<{
  type: "RetrySupportRemedyEffect";
  remedyId: RemedyId;
  effect: RemedyEffectKind | string;
  requestedByAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  reasonCode: string;
  rationale: string;
  idempotencyKey: string;
  requestedAt: string;
}>;

export type RequestSupportRemedyCorrectionCommand = Readonly<{
  type: "RequestSupportRemedyCorrection";
  requestedByAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  reasonCode: string;
  rationale: string;
  evidenceReferences: readonly string[];
  idempotencyKey: string;
  requestedAt: string;
}>;

export type SupportRemedyProposedEvent = DomainEvent<
  "support.support-request.remedy-proposed",
  Readonly<{ supportRequestId: SupportRequestId; workflow: RemedyApprovalWorkflow }>
>;

export type SupportRemedyApprovedEvent = DomainEvent<
  "support.support-request.remedy-approved",
  Readonly<{ supportRequestId: SupportRequestId; remedyId: RemedyId; approval: RemedyApprovalRecord }>
>;

export type SupportRemedyEffectRetryRequestedEvent = DomainEvent<
  "support.support-request.remedy-effect-retry-requested",
  Readonly<{
    supportRequestId: SupportRequestId;
    remedyId: RemedyId;
    effect: RemedyEffectKind;
    requestedByAccountId: AccountId;
    permissionUsed: PlatformRemedyCapability;
    reasonCode: string;
    rationale: string;
    idempotencyKey: string;
    requestedAt: string;
  }>
>;

export type SupportRemedyCorrectionRequestedEvent = DomainEvent<
  "support.support-request.remedy-correction-requested",
  Readonly<{
    supportRequestId: SupportRequestId;
    remedyId: RemedyId;
    requestedByAccountId: AccountId;
    permissionUsed: PlatformRemedyCapability;
    reasonCode: string;
    rationale: string;
    evidenceReferences: readonly string[];
    idempotencyKey: string;
    requestedAt: string;
  }>
>;

export type SupportRemedyApprovalEvent =
  | SupportRemedyProposedEvent
  | SupportRemedyApprovedEvent
  | SupportRemedyEffectRetryRequestedEvent
  | SupportRemedyCorrectionRequestedEvent;

function requiredText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SupportDomainError(message);
  return normalized;
}

function evidenceReferences(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new SupportDomainError("A platform remedy requires at least one evidence reference.");
  }
  if (normalized.length > 20 || normalized.some((value) => value.length > 200)) {
    throw new SupportDomainError("A platform remedy supports at most 20 evidence references of 200 characters each.");
  }
  return [...new Set(normalized)];
}

function auditEntry(
  input: Omit<RemedyWorkflowAuditEntry, "rationale" | "evidenceReferences"> &
    Partial<Pick<RemedyWorkflowAuditEntry, "rationale" | "evidenceReferences">>,
): RemedyWorkflowAuditEntry {
  return { ...input, rationale: input.rationale ?? null, evidenceReferences: input.evidenceReferences ?? [] };
}

export function createRemedyApprovalWorkflow(command: ProposeSupportRemedyCommand): RemedyApprovalWorkflow {
  const proposedAt = command.terms.occurredAt;
  const reservationStatus = command.terms.coverageId === null ? "not-required" : "pending";
  const auditTrail: RemedyWorkflowAuditEntry[] = [
    auditEntry({
      action: "proposal",
      actorType: "human",
      actorAccountId: command.proposedByAccountId,
      permissionUsed: command.permissionUsed,
      reasonCode: command.terms.reasonCode,
      rationale: requiredText(command.rationale, "A platform remedy proposal requires a rationale."),
      evidenceReferences: evidenceReferences(command.evidenceReferences),
      occurredAt: proposedAt,
      correlationId: command.terms.idempotencyKey,
    }),
  ];
  if (command.returnOverrideUsed) {
    auditTrail.push(
      auditEntry({
        action: "return-override",
        actorType: "human",
        actorAccountId: command.proposedByAccountId,
        permissionUsed: platformRemedyCapabilities.overrideReturn,
        reasonCode: requiredText(
          command.returnExceptionReasonCode ?? "",
          "Return override requires an exception reason.",
        ),
        rationale: command.rationale,
        evidenceReferences: command.evidenceReferences,
        occurredAt: proposedAt,
        correlationId: `${command.terms.idempotencyKey}:return-override`,
      }),
    );
  }
  if (reservationStatus === "pending") {
    auditTrail.push(
      auditEntry({
        action: "reservation-requested",
        actorType: "system",
        actorAccountId: null,
        permissionUsed: null,
        reasonCode: command.terms.reasonCode,
        occurredAt: proposedAt,
        correlationId: `${command.terms.idempotencyKey}:coverage-requested`,
      }),
    );
  }
  return {
    terms: command.terms,
    proposedByAccountId: command.proposedByAccountId,
    proposalPermissionUsed: command.permissionUsed,
    proposalRationale: command.rationale.trim(),
    evidenceReferences: evidenceReferences(command.evidenceReferences),
    proposedAt,
    reservationExpiresAt: command.reservationExpiresAt,
    reservationStatus,
    reservationReasonCode: null,
    requiredApprovalCount: command.requiredApprovalCount,
    requiresElevatedApproval: command.requiresElevatedApproval,
    returnOverrideUsed: command.returnOverrideUsed,
    returnExceptionReasonCode: command.returnExceptionReasonCode,
    approvals: [],
    status: reservationStatus === "not-required" ? "approval-pending" : "reservation-pending",
    correctionReasonCode: null,
    auditTrail,
  };
}

export function applyRemedyReservationFact(
  workflow: RemedyApprovalWorkflow,
  fact: RemedyEffectFact,
): RemedyApprovalWorkflow {
  if (
    fact.effect !== "coverage-reservation" ||
    workflow.auditTrail.some((entry) => entry.correlationId === fact.idempotencyKey)
  ) {
    return workflow;
  }
  const reserved = fact.outcome === "satisfied";
  const reservationStatus: RemedyReservationStatus = reserved ? "reserved" : "rejected";
  return {
    ...workflow,
    reservationStatus,
    reservationReasonCode: fact.reasonCode,
    status: reserved ? "approval-pending" : "reservation-rejected",
    auditTrail: [
      ...workflow.auditTrail,
      auditEntry({
        action: reserved ? "reservation-reserved" : "reservation-rejected",
        actorType: "system",
        actorAccountId: null,
        permissionUsed: null,
        reasonCode: fact.reasonCode,
        occurredAt: fact.occurredAt,
        correlationId: fact.idempotencyKey,
      }),
    ],
  };
}

export function createRemedyApproval(
  workflow: RemedyApprovalWorkflow,
  command: ApproveSupportRemedyCommand,
): RemedyApprovalRecord {
  if (workflow.reservationStatus === "pending") {
    throw new SupportDomainError("Protection coverage must be reserved before approval.");
  }
  if (workflow.reservationStatus === "rejected") {
    throw new SupportDomainError(`Protection coverage was rejected: ${workflow.reservationReasonCode ?? "unknown"}.`);
  }
  if (workflow.reservationExpiresAt && Date.parse(command.approvedAt) >= Date.parse(workflow.reservationExpiresAt)) {
    throw new SupportDomainError("Protection coverage reservation expired before approval.");
  }
  if (workflow.approvals.some((approval) => approval.idempotencyKey === command.idempotencyKey)) {
    return workflow.approvals.find((approval) => approval.idempotencyKey === command.idempotencyKey)!;
  }
  if (workflow.approvals.some((approval) => approval.approvedByAccountId === command.approvedByAccountId)) {
    throw new SupportDomainError("Each required approval must come from a distinct operator.");
  }
  if (workflow.requiredApprovalCount > 1 && command.approvedByAccountId === workflow.proposedByAccountId) {
    throw new SupportDomainError("Dual control requires an approver distinct from the proposer.");
  }
  return {
    approvedByAccountId: command.approvedByAccountId,
    permissionUsed: command.permissionUsed,
    reasonCode: requiredText(command.reasonCode, "Approval requires a structured reason."),
    rationale: requiredText(command.rationale, "Approval requires a rationale."),
    evidenceReferences: evidenceReferences(command.evidenceReferences),
    idempotencyKey: requiredText(command.idempotencyKey, "Approval idempotency key is required."),
    approvedAt: command.approvedAt,
  };
}

export function applyRemedyApproval(
  workflow: RemedyApprovalWorkflow,
  approval: RemedyApprovalRecord,
): RemedyApprovalWorkflow {
  if (workflow.approvals.some((candidate) => candidate.idempotencyKey === approval.idempotencyKey)) return workflow;
  const approvals = [...workflow.approvals, approval];
  const approvalRequirementsSatisfied =
    approvals.length >= workflow.requiredApprovalCount &&
    (!workflow.requiresElevatedApproval ||
      approvals.some((candidate) => candidate.permissionUsed === "support.remedies.approve-elevated"));
  return {
    ...workflow,
    approvals,
    status: approvalRequirementsSatisfied ? "approved" : "approval-pending",
    auditTrail: [
      ...workflow.auditTrail,
      auditEntry({
        action: "approval",
        actorType: "human",
        actorAccountId: approval.approvedByAccountId,
        permissionUsed: approval.permissionUsed,
        reasonCode: approval.reasonCode,
        rationale: approval.rationale,
        evidenceReferences: approval.evidenceReferences,
        occurredAt: approval.approvedAt,
        correlationId: approval.idempotencyKey,
      }),
    ],
  };
}

export function markRemedyWorkflowAuthorized(
  workflow: RemedyApprovalWorkflow,
  occurredAt: string,
): RemedyApprovalWorkflow {
  if (workflow.status === "authorized") return workflow;
  return {
    ...workflow,
    status: "authorized",
    auditTrail: [
      ...workflow.auditTrail,
      auditEntry({
        action: "authorization",
        actorType: "system",
        actorAccountId: null,
        permissionUsed: null,
        reasonCode: workflow.terms.reasonCode,
        occurredAt,
        correlationId: workflow.terms.idempotencyKey,
      }),
    ],
  };
}

export function applyRemedyRetryRequest(
  workflow: RemedyApprovalWorkflow,
  event: SupportRemedyEffectRetryRequestedEvent,
): RemedyApprovalWorkflow {
  if (workflow.auditTrail.some((entry) => entry.correlationId === event.data.idempotencyKey)) return workflow;
  return {
    ...workflow,
    auditTrail: [
      ...workflow.auditTrail,
      auditEntry({
        action: "retry-requested",
        actorType: "human",
        actorAccountId: event.data.requestedByAccountId,
        permissionUsed: event.data.permissionUsed,
        reasonCode: event.data.reasonCode,
        rationale: event.data.rationale,
        occurredAt: event.data.requestedAt,
        correlationId: event.data.idempotencyKey,
      }),
    ],
  };
}

export function applyRemedyCorrectionRequest(
  workflow: RemedyApprovalWorkflow,
  event: SupportRemedyCorrectionRequestedEvent,
): RemedyApprovalWorkflow {
  if (workflow.auditTrail.some((entry) => entry.correlationId === event.data.idempotencyKey)) return workflow;
  return {
    ...workflow,
    status: "correction-requested",
    correctionReasonCode: event.data.reasonCode,
    auditTrail: [
      ...workflow.auditTrail,
      auditEntry({
        action: "correction-requested",
        actorType: "human",
        actorAccountId: event.data.requestedByAccountId,
        permissionUsed: event.data.permissionUsed,
        reasonCode: event.data.reasonCode,
        rationale: event.data.rationale,
        evidenceReferences: event.data.evidenceReferences,
        occurredAt: event.data.requestedAt,
        correlationId: event.data.idempotencyKey,
      }),
    ],
  };
}

export function applyRemedyWaiverAudit(
  workflow: RemedyApprovalWorkflow,
  effect: RemedyEffectKind,
  waiver: RemedyEffectWaiver,
): RemedyApprovalWorkflow {
  if (workflow.auditTrail.some((entry) => entry.correlationId === waiver.idempotencyKey)) return workflow;
  return {
    ...workflow,
    auditTrail: [
      ...workflow.auditTrail,
      auditEntry({
        action: "effect-waived",
        actorType: "human",
        actorAccountId: waiver.actorAccountId,
        permissionUsed: waiver.permissionUsed,
        reasonCode: waiver.reasonCode,
        rationale: waiver.rationale,
        evidenceReferences: waiver.evidenceReferences,
        occurredAt: waiver.waivedAt,
        correlationId: waiver.idempotencyKey,
      }),
    ],
  };
}

export function remedyApprovalExpired(workflow: RemedyApprovalWorkflow, now = new Date().toISOString()): boolean {
  return (
    workflow.status !== "authorized" &&
    workflow.reservationStatus === "reserved" &&
    workflow.reservationExpiresAt !== null &&
    Date.parse(now) >= Date.parse(workflow.reservationExpiresAt)
  );
}
