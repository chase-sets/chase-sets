import type { DomainEvent } from "@chase-sets/event-core";
import {
  normalizeSupportRequestRemedyAuthorizedV1,
  type LiabilityAllocationFactV1,
  type SupportRequestPlatformCoverageRequestedV1Payload,
  type SupportRequestRefundReleasedV1Payload,
  type SupportRequestRemedyAuthorizedV1Payload,
  type SupportRequestRemedyCompletedV1Payload,
} from "@chase-sets/event-core/platform-coverage-facts";
import type { BuyerRemedyKind, RefundTrigger, ReturnDirective } from "@chase-sets/primitives/platform-coverage";
import type { AccountId, CoverageId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import type { PlatformRemedyCapability } from "./platform-remedy-policy";

export const remedyEffectKinds = [
  "coverage-reservation",
  "return-label-available",
  "carrier-accepted",
  "return-delivered",
  "facility-intake",
  "operator-release",
  "refund-completion",
  "settlement-reconciliation",
] as const;

export type RemedyEffectKind = (typeof remedyEffectKinds)[number];
export type RemedyEffectFactOutcome = "satisfied" | "failed-retryable" | "failed-terminal";
export type RemedyEffectStatus = "pending" | RemedyEffectFactOutcome | "waived";
export type RemedyExecutionStatus = "in-progress" | "action-required" | "completed";
export type RemedyCasePresentation =
  | "decision-pending"
  | "decision-made"
  | "remedy-in-progress"
  | "action-required"
  | "remedy-completed"
  | "closed";

export type RemedyEffectFact = Readonly<{
  effect: RemedyEffectKind;
  outcome: RemedyEffectFactOutcome;
  sourceFactType: string;
  sourceFactId: string;
  idempotencyKey: string;
  occurredAt: string;
  reasonCode: string;
  refundId: string | null;
  amount: string | null;
  currencyCode: string | null;
  allocation: LiabilityAllocationFactV1 | null;
}>;

export type RemedyEffectWaiver = Readonly<{
  idempotencyKey: string;
  actorAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  reasonCode: string;
  rationale: string;
  evidenceReferences: readonly string[];
  waivedAt: string;
}>;

export type RemedyEffect = Readonly<{
  effect: RemedyEffectKind;
  required: true;
  status: RemedyEffectStatus;
  facts: readonly RemedyEffectFact[];
  waiver: RemedyEffectWaiver | null;
}>;

export type RemedyExecution = Readonly<{
  remedyId: RemedyId;
  coverageId: CoverageId | null;
  supportRequestId: SupportRequestId;
  remedy: SupportRequestRemedyAuthorizedV1Payload["remedy"];
  allocation: LiabilityAllocationFactV1;
  returnDirective: ReturnDirective;
  refundTrigger: RefundTrigger;
  policyVersion: string;
  authorizationReasonCode: string;
  authorizationIdempotencyKey: string;
  authorizedAt: string;
  status: RemedyExecutionStatus;
  effects: readonly RemedyEffect[];
  refundReleasedAt: string | null;
  refundId: string | null;
  completedAt: string | null;
}>;

export type AuthorizeSupportRemedyCommand = Readonly<{
  type: "AuthorizeSupportRemedy";
  remedyId: RemedyId;
  coverageId: CoverageId | null;
  remedy: Readonly<{ kind: BuyerRemedyKind; amount: string; currencyCode: string }>;
  allocation: LiabilityAllocationFactV1;
  returnDirective: ReturnDirective | string;
  refundTrigger: RefundTrigger | string;
  policyVersion: string;
  reasonCode: string;
  idempotencyKey: string;
  authorizedAt: string;
}>;

export type RecordSupportRemedyEffectCommand = Readonly<{
  type: "RecordSupportRemedyEffect";
  remedyId: RemedyId;
  coverageId?: CoverageId | null;
  effect: RemedyEffectKind | string;
  outcome: RemedyEffectFactOutcome | string;
  sourceFactType: string;
  sourceFactId: string;
  idempotencyKey: string;
  occurredAt: string;
  reasonCode: string;
  refundId?: string | null;
  amount?: string | null;
  currencyCode?: string | null;
  allocation?: LiabilityAllocationFactV1 | null;
}>;

export type OverrideSupportRemedyEffectCommand = Readonly<{
  type: "OverrideSupportRemedyEffect";
  remedyId: RemedyId;
  effect: RemedyEffectKind | string;
  actorAccountId: AccountId;
  permissionUsed: PlatformRemedyCapability;
  reasonCode: string;
  rationale: string;
  evidenceReferences: readonly string[];
  idempotencyKey: string;
  overriddenAt: string;
}>;

export type SupportRequestRemedyAuthorizedEvent = DomainEvent<
  "support.support-request.remedy-authorized.v1",
  SupportRequestRemedyAuthorizedV1Payload
>;

export type SupportRequestPlatformCoverageRequestedEvent = DomainEvent<
  "support.support-request.platform-coverage-requested.v1",
  SupportRequestPlatformCoverageRequestedV1Payload
>;

export type SupportRequestRemedyEffectRecordedEvent = DomainEvent<
  "support.support-request.remedy-effect-recorded",
  Readonly<{
    supportRequestId: SupportRequestId;
    remedyId: RemedyId;
    coverageId: CoverageId | null;
    fact: RemedyEffectFact;
  }>
>;

export type SupportRequestRemedyEffectWaivedEvent = DomainEvent<
  "support.support-request.remedy-effect-waived",
  Readonly<{
    supportRequestId: SupportRequestId;
    remedyId: RemedyId;
    effect: RemedyEffectKind;
    waiver: RemedyEffectWaiver;
  }>
>;

export type SupportRequestRefundReleasedEvent = DomainEvent<
  "support.support-request.refund-released.v1",
  SupportRequestRefundReleasedV1Payload
>;

export type SupportRequestRemedyCompletedEvent = DomainEvent<
  "support.support-request.remedy-completed.v1",
  SupportRequestRemedyCompletedV1Payload
>;

export type SupportRequestRemedyEvent =
  | SupportRequestRemedyAuthorizedEvent
  | SupportRequestPlatformCoverageRequestedEvent
  | SupportRequestRemedyEffectRecordedEvent
  | SupportRequestRemedyEffectWaivedEvent
  | SupportRequestRefundReleasedEvent
  | SupportRequestRemedyCompletedEvent;

const financialEffectKinds = new Set<RemedyEffectKind>([
  "coverage-reservation",
  "refund-completion",
  "settlement-reconciliation",
]);

function requiredText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function isoTimestamp(value: string, message: string): string {
  const normalized = requiredText(value, message);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(message);
  }
  return normalized;
}

export function isRemedyEffectKind(value: string): value is RemedyEffectKind {
  return (remedyEffectKinds as readonly string[]).includes(value);
}

export function normalizeRemedyEffectKind(value: string): RemedyEffectKind {
  if (!isRemedyEffectKind(value)) {
    throw new Error(`Unknown remedy effect: ${value}`);
  }
  return value;
}

function normalizeEffectOutcome(value: string): RemedyEffectFactOutcome {
  if (value !== "satisfied" && value !== "failed-retryable" && value !== "failed-terminal") {
    throw new Error(`Unknown remedy effect outcome: ${value}`);
  }
  return value;
}

function requiredEffectKinds(
  allocation: LiabilityAllocationFactV1,
  returnDirective: ReturnDirective,
  refundTrigger: RefundTrigger,
): readonly RemedyEffectKind[] {
  const effects = new Set<RemedyEffectKind>(["refund-completion", "settlement-reconciliation"]);
  if (allocation.fundingKind !== "seller-funded") {
    effects.add("coverage-reservation");
  }
  if (returnDirective !== "no-return") {
    effects.add("return-label-available");
  }
  if (refundTrigger === "carrier-accepted") {
    effects.add("carrier-accepted");
  } else if (refundTrigger === "delivered") {
    effects.add("return-delivered");
  } else if (refundTrigger === "facility-intake") {
    effects.add("facility-intake");
  } else if (refundTrigger === "operator-release") {
    effects.add("operator-release");
  }
  if (returnDirective === "return-to-platform") {
    effects.add("facility-intake");
  }
  return remedyEffectKinds.filter((effect) => effects.has(effect));
}

function effectStatus(facts: readonly RemedyEffectFact[], waiver: RemedyEffectWaiver | null): RemedyEffectStatus {
  const latest = [...facts]
    .sort((left, right) =>
      left.occurredAt === right.occurredAt
        ? left.sourceFactId.localeCompare(right.sourceFactId)
        : left.occurredAt.localeCompare(right.occurredAt),
    )
    .at(-1);
  if (latest?.outcome === "satisfied") {
    return "satisfied";
  }
  if (waiver) {
    return "waived";
  }
  return latest?.outcome ?? "pending";
}

function executionStatus(effects: readonly RemedyEffect[], completedAt: string | null): RemedyExecutionStatus {
  if (completedAt) {
    return "completed";
  }
  if (effects.some((effect) => effect.status === "failed-retryable" || effect.status === "failed-terminal")) {
    return "action-required";
  }
  return "in-progress";
}

function latestRefundId(effects: readonly RemedyEffect[]): string | null {
  const ids = effects.flatMap((effect) => effect.facts.map((fact) => fact.refundId)).filter((id): id is string => !!id);
  return ids.at(-1) ?? null;
}

export function createRemedyExecution(
  authorization: SupportRequestRemedyAuthorizedV1Payload,
  deferredFacts: readonly RemedyEffectFact[] = [],
): RemedyExecution {
  const effects = requiredEffectKinds(
    authorization.allocation,
    authorization.returnDirective,
    authorization.refundTrigger,
  ).map((effect): RemedyEffect => {
    const facts = deferredFacts.filter((fact) => fact.effect === effect);
    return { effect, required: true, status: effectStatus(facts, null), facts, waiver: null };
  });
  return {
    remedyId: authorization.remedyId as RemedyId,
    coverageId: authorization.coverageId as CoverageId | null,
    supportRequestId: authorization.supportRequestId as SupportRequestId,
    remedy: authorization.remedy,
    allocation: authorization.allocation,
    returnDirective: authorization.returnDirective,
    refundTrigger: authorization.refundTrigger,
    policyVersion: authorization.policyVersion,
    authorizationReasonCode: authorization.reasonCode,
    authorizationIdempotencyKey: authorization.idempotencyKey,
    authorizedAt: authorization.occurredAt,
    status: executionStatus(effects, null),
    effects,
    refundReleasedAt: null,
    refundId: latestRefundId(effects),
    completedAt: null,
  };
}

export function applyRemedyEffectFact(remedy: RemedyExecution, fact: RemedyEffectFact): RemedyExecution {
  const effects = remedy.effects.map((effect) => {
    if (
      effect.effect !== fact.effect ||
      effect.facts.some((candidate) => candidate.idempotencyKey === fact.idempotencyKey)
    ) {
      return effect;
    }
    const facts = [...effect.facts, fact].sort((left, right) =>
      left.occurredAt === right.occurredAt
        ? left.sourceFactId.localeCompare(right.sourceFactId)
        : left.occurredAt.localeCompare(right.occurredAt),
    );
    return { ...effect, facts, status: effectStatus(facts, effect.waiver) };
  });
  return {
    ...remedy,
    effects,
    status: executionStatus(effects, remedy.completedAt),
    refundId: latestRefundId(effects),
  };
}

export function applyRemedyEffectWaiver(
  remedy: RemedyExecution,
  effectKind: RemedyEffectKind,
  waiver: RemedyEffectWaiver,
): RemedyExecution {
  const effects = remedy.effects.map((effect) =>
    effect.effect === effectKind ? { ...effect, waiver, status: effectStatus(effect.facts, waiver) } : effect,
  );
  return { ...remedy, effects, status: executionStatus(effects, remedy.completedAt) };
}

export function remedyHasProcessedFact(remedy: RemedyExecution | null, idempotencyKey: string): boolean {
  return !!remedy?.effects.some((effect) => effect.facts.some((fact) => fact.idempotencyKey === idempotencyKey));
}

export function normalizeRemedyEffectFact(command: RecordSupportRemedyEffectCommand): RemedyEffectFact {
  return {
    effect: normalizeRemedyEffectKind(String(command.effect)),
    outcome: normalizeEffectOutcome(String(command.outcome)),
    sourceFactType: requiredText(command.sourceFactType, "Remedy effect source fact type is required."),
    sourceFactId: requiredText(command.sourceFactId, "Remedy effect source fact id is required."),
    idempotencyKey: requiredText(command.idempotencyKey, "Remedy effect idempotency key is required."),
    occurredAt: isoTimestamp(command.occurredAt, "Remedy effect must record a timestamp."),
    reasonCode: requiredText(command.reasonCode, "Remedy effect reason code is required."),
    refundId: command.refundId == null ? null : requiredText(command.refundId, "Refund id cannot be empty."),
    amount: command.amount == null ? null : requiredText(command.amount, "Remedy effect amount cannot be empty."),
    currencyCode:
      command.currencyCode == null
        ? null
        : requiredText(command.currencyCode, "Remedy effect currency cannot be empty.").toLowerCase(),
    allocation: command.allocation ?? null,
  };
}

export function normalizeRemedyAuthorization(
  supportRequestId: SupportRequestId,
  command: AuthorizeSupportRemedyCommand,
): SupportRequestRemedyAuthorizedV1Payload {
  return normalizeSupportRequestRemedyAuthorizedV1({
    factSchemaVersion: 1,
    supportRequestId,
    remedyId: command.remedyId,
    coverageId: command.coverageId,
    remedy: command.remedy,
    allocation: command.allocation,
    returnDirective: command.returnDirective,
    refundTrigger: command.refundTrigger,
    reasonCode: command.reasonCode,
    idempotencyKey: command.idempotencyKey,
    causationId: null,
    policyVersion: command.policyVersion,
    occurredAt: command.authorizedAt,
  });
}

export function createCoverageRequestedEvent(
  authorization: SupportRequestRemedyAuthorizedV1Payload,
): SupportRequestPlatformCoverageRequestedEvent | null {
  if (!authorization.coverageId) {
    return null;
  }
  return {
    type: "support.support-request.platform-coverage-requested.v1",
    data: {
      factSchemaVersion: 1,
      supportRequestId: authorization.supportRequestId,
      remedyId: authorization.remedyId,
      coverageId: authorization.coverageId,
      requestedAmount: authorization.allocation.platformFundedAmount,
      currencyCode: authorization.allocation.currencyCode,
      reasonCode: authorization.reasonCode,
      idempotencyKey: `${authorization.idempotencyKey}:coverage-requested`,
      causationId: authorization.idempotencyKey,
      policyVersion: authorization.policyVersion,
      occurredAt: authorization.occurredAt,
    },
  };
}

function effectSatisfied(remedy: RemedyExecution, effect: RemedyEffectKind): boolean {
  const state = remedy.effects.find((candidate) => candidate.effect === effect);
  return !state || state.status === "satisfied" || state.status === "waived";
}

function refundTriggerSatisfied(remedy: RemedyExecution): boolean {
  if (remedy.refundTrigger === "immediate") {
    return true;
  }
  const effectByTrigger: Record<Exclude<RefundTrigger, "immediate">, RemedyEffectKind> = {
    "carrier-accepted": "carrier-accepted",
    delivered: "return-delivered",
    "facility-intake": "facility-intake",
    "operator-release": "operator-release",
  };
  return effectSatisfied(remedy, effectByTrigger[remedy.refundTrigger]);
}

export function canReleaseRemedyRefund(remedy: RemedyExecution): boolean {
  return (
    remedy.refundReleasedAt === null &&
    effectSatisfied(remedy, "coverage-reservation") &&
    refundTriggerSatisfied(remedy)
  );
}

export function canCompleteRemedy(remedy: RemedyExecution): boolean {
  return (
    remedy.refundReleasedAt !== null &&
    remedy.completedAt === null &&
    remedy.effects.every((effect) => effect.status === "satisfied" || effect.status === "waived")
  );
}

export function createRefundReleasedEvent(
  remedy: RemedyExecution,
  occurredAt: string,
  causationId: string,
): SupportRequestRefundReleasedEvent {
  return {
    type: "support.support-request.refund-released.v1",
    data: {
      factSchemaVersion: 1,
      supportRequestId: remedy.supportRequestId,
      remedyId: remedy.remedyId,
      coverageId: remedy.coverageId,
      refundAmount: remedy.remedy.amount,
      currencyCode: remedy.remedy.currencyCode,
      allocation: remedy.allocation,
      refundTrigger: remedy.refundTrigger,
      idempotencyKey: `${remedy.authorizationIdempotencyKey}:refund-released`,
      causationId,
      policyVersion: remedy.policyVersion,
      occurredAt,
    },
  };
}

export function createRemedyCompletedEvent(
  remedy: RemedyExecution,
  completedAt: string,
  causationId: string,
): SupportRequestRemedyCompletedEvent {
  return {
    type: "support.support-request.remedy-completed.v1",
    data: {
      factSchemaVersion: 1,
      supportRequestId: remedy.supportRequestId,
      remedyId: remedy.remedyId,
      coverageId: remedy.coverageId,
      refundId: remedy.refundId,
      allocation: remedy.allocation,
      returnDirective: remedy.returnDirective,
      completedAt,
      idempotencyKey: `${remedy.authorizationIdempotencyKey}:remedy-completed`,
      causationId,
      policyVersion: remedy.policyVersion,
      occurredAt: completedAt,
    },
  };
}

export function applyRemedyLifecycleEvent(
  remedy: RemedyExecution | null,
  event: SupportRequestRemedyEvent,
  deferredFacts: readonly RemedyEffectFact[],
): RemedyExecution | null {
  switch (event.type) {
    case "support.support-request.remedy-authorized.v1":
      return createRemedyExecution(event.data, deferredFacts);
    case "support.support-request.remedy-effect-recorded":
      return remedy && remedy.remedyId === event.data.remedyId
        ? applyRemedyEffectFact(remedy, event.data.fact)
        : remedy;
    case "support.support-request.remedy-effect-waived":
      return remedy && remedy.remedyId === event.data.remedyId
        ? applyRemedyEffectWaiver(remedy, event.data.effect, event.data.waiver)
        : remedy;
    case "support.support-request.refund-released.v1":
      return remedy && remedy.remedyId === event.data.remedyId
        ? { ...remedy, refundReleasedAt: event.data.occurredAt }
        : remedy;
    case "support.support-request.remedy-completed.v1":
      return remedy && remedy.remedyId === event.data.remedyId
        ? { ...remedy, status: "completed", completedAt: event.data.completedAt, refundId: event.data.refundId }
        : remedy;
    case "support.support-request.platform-coverage-requested.v1":
      return remedy;
  }
}

export function createRemedyEffectWaiver(command: OverrideSupportRemedyEffectCommand): {
  effect: RemedyEffectKind;
  waiver: RemedyEffectWaiver;
} {
  const effect = normalizeRemedyEffectKind(String(command.effect));
  if (financialEffectKinds.has(effect)) {
    throw new Error(`The ${effect} effect requires an owning-context fact and cannot be waived.`);
  }
  const evidenceReferences = command.evidenceReferences.map((reference) =>
    requiredText(reference, "Evidence reference cannot be empty."),
  );
  if (evidenceReferences.length === 0) {
    throw new Error("Remedy override requires an evidence reference.");
  }
  return {
    effect,
    waiver: {
      idempotencyKey: requiredText(command.idempotencyKey, "Remedy override idempotency key is required."),
      actorAccountId: command.actorAccountId,
      permissionUsed: command.permissionUsed,
      reasonCode: requiredText(command.reasonCode, "Remedy override requires a structured reason."),
      rationale: requiredText(command.rationale, "Remedy override requires a rationale."),
      evidenceReferences,
      waivedAt: isoTimestamp(command.overriddenAt, "Remedy override must record a timestamp."),
    },
  };
}

export function remedyClosureBlockingReasons(remedy: RemedyExecution | null): readonly string[] {
  if (!remedy || remedy.completedAt) {
    return [];
  }
  return remedy.effects
    .filter((effect) => effect.status !== "satisfied" && effect.status !== "waived")
    .map((effect) => `${effect.effect}:${effect.status}`);
}

export function remedyCasePresentation(
  requestStatus: string | null,
  hasDecision: boolean,
  remedy: RemedyExecution | null,
): RemedyCasePresentation {
  if (requestStatus === "closed") {
    return "closed";
  }
  if (!hasDecision) {
    return "decision-pending";
  }
  if (!remedy) {
    return "decision-made";
  }
  if (remedy.status === "completed") {
    return "remedy-completed";
  }
  return remedy.status === "action-required" ? "action-required" : "remedy-in-progress";
}

export function remedyNextAction(remedy: RemedyExecution | null): string | null {
  if (!remedy || remedy.completedAt) {
    return null;
  }
  const blocked = remedy.effects.find((effect) => effect.status === "failed-terminal");
  if (blocked) {
    return `repair-or-authorized-override:${blocked.effect}`;
  }
  const retryable = remedy.effects.find((effect) => effect.status === "failed-retryable");
  if (retryable) {
    return `retry:${retryable.effect}`;
  }
  const pending = remedy.effects.find((effect) => effect.status === "pending");
  return pending ? `await:${pending.effect}` : null;
}
