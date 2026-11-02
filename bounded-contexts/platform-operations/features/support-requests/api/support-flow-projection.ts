import type { SupportRequesterRole } from "../domain/common";
import type { SupportFlowDefinition } from "../domain/flow-catalog";
import type { ParticipantAction } from "../domain/participant-attempt";
import type { SupportRequestDetailRow } from "../read-model/queries";

export type SupportFlowDetail = Pick<
  SupportFlowDefinition,
  | "flowType"
  | "title"
  | "automationSummary"
  | "allowedResponses"
  | "allowedResolutions"
  | "checklist"
  | "allowedEvidenceTypes"
  | "sellerResponseHours"
  | "supportReviewHours"
>;

export type SupportParticipantAction =
  | Readonly<{ kind: Extract<ParticipantAction, "submit-evidence">; checklistItemKey: string }>
  | Readonly<{
      kind: Extract<ParticipantAction, "accept-offer" | "decline-offer" | "record-response" | "escalate" | "cancel">;
    }>;

export type SupportParticipantPolicy = Readonly<{
  nextActor: SupportRequesterRole | null;
  deadlineAt: string | null;
  actions: readonly SupportParticipantAction[];
}>;

type SupportParticipant = Readonly<{ role: Exclude<SupportRequesterRole, "support">; accountId: string }>;

type SupportParticipantPolicyFacts = Pick<
  SupportRequestDetailRow,
  | "status"
  | "checklist"
  | "pending_offer"
  | "opened_by_account_id"
  | "seller_condition_attestation_due_at"
  | "seller_response_due_at"
  | "support_review_due_at"
>;

export function projectSupportFlow(
  definition: SupportFlowDefinition,
  role: SupportRequesterRole,
  request: Pick<SupportRequestDetailRow, "escalated_at">,
): SupportFlowDetail {
  return {
    flowType: definition.flowType,
    title: definition.title,
    automationSummary: definition.automationSummary,
    allowedResponses:
      role === "buyer" || (role === "seller" && request.escalated_at !== null) ? [] : definition.allowedResponses,
    allowedResolutions: role === "support" ? definition.allowedResolutions : [],
    checklist: definition.checklist,
    allowedEvidenceTypes: definition.allowedEvidenceTypes,
    sellerResponseHours: definition.sellerResponseHours,
    supportReviewHours: definition.supportReviewHours,
  };
}

function nextActorFor(request: SupportParticipantPolicyFacts): SupportRequesterRole | null {
  if (request.status === "resolved" || request.status === "closed" || request.status === "cancelled") return null;
  if (request.pending_offer) return request.pending_offer.pendingWithRole;

  const openItem = request.checklist.find(
    (item) => item.required && item.satisfiedAt === null && item.ownerRole !== "support",
  );
  if (openItem) return openItem.ownerRole;

  if (request.status === "waiting-on-buyer") return "buyer";
  if (request.status === "waiting-on-seller") return "seller";
  return "support";
}

function deadlineInEffect(request: SupportParticipantPolicyFacts, nextActor: SupportRequesterRole | null) {
  if (nextActor === "seller") return request.seller_condition_attestation_due_at ?? request.seller_response_due_at;
  if (nextActor === "support") return request.support_review_due_at;
  return request.seller_response_due_at ?? request.support_review_due_at;
}

function actingParticipantActions(
  request: SupportParticipantPolicyFacts,
  participant: SupportParticipant,
  flow: Pick<SupportFlowDetail, "allowedResponses">,
): SupportParticipantAction[] {
  const cancel: SupportParticipantAction[] =
    request.opened_by_account_id === participant.accountId ? [{ kind: "cancel" }] : [];
  if (request.pending_offer) return [{ kind: "accept-offer" }, { kind: "decline-offer" }, ...cancel];

  const prompts = request.checklist
    .filter((item) => item.ownerRole === participant.role && item.required && item.satisfiedAt === null)
    .map((item): SupportParticipantAction => ({ kind: "submit-evidence", checklistItemKey: item.key }));
  if (prompts.length > 0) return [...prompts, ...cancel];

  if (participant.role === "buyer") return [{ kind: "escalate" }, ...cancel];
  const review: SupportParticipantAction[] = flow.allowedResponses.includes("request-support-review")
    ? [{ kind: "escalate" }]
    : [];
  return [{ kind: "record-response" }, ...review, ...cancel];
}

/**
 * Who acts next on a participant's Support Request, the deadline that party
 * works against, and what the authenticated buyer or seller may do now. A
 * pending offer outranks the checklist, the first required open non-support
 * item outranks the status, and only the participant acting next gets actions.
 */
export function projectSupportParticipantPolicy(
  request: SupportParticipantPolicyFacts,
  participant: SupportParticipant,
  flow: Pick<SupportFlowDetail, "allowedResponses">,
): SupportParticipantPolicy {
  const nextActor = nextActorFor(request);
  return {
    nextActor,
    deadlineAt: deadlineInEffect(request, nextActor),
    actions: nextActor === participant.role ? actingParticipantActions(request, participant, flow) : [],
  };
}
