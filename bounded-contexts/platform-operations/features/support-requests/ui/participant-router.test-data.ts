import { getSupportFlowDefinition } from "../domain/flow-catalog";
import { projectSupportParticipantPolicy, type SupportFlowDetail } from "../api/support-flow-projection";

/** The account-scoped detail body: the row plus the participant policy the API projects for `accountId`. */
export function withParticipantPolicy<
  Detail extends Readonly<{ buyer_account_id: string; flow: Pick<SupportFlowDetail, "allowedResponses"> }>,
>(detail: Detail, accountId: string) {
  const role = detail.buyer_account_id === accountId ? "buyer" : "seller";
  return {
    ...detail,
    participantPolicy: projectSupportParticipantPolicy(detail as never, { role, accountId }, detail.flow),
  };
}

export function supportParticipantDetailFixture() {
  return {
    support_request_id: "sup_router",
    display_reference: "SUP-ROUTER",
    order_id: "ord_router",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    flow_type: "product-not-received",
    flow: getSupportFlowDefinition("product-not-received"),
    status: "waiting-on-buyer",
    priority: "normal",
    opened_by_account_id: "acc_buyer",
    opened_by_role: "buyer",
    opened_at: "2026-10-12T12:00:00.000Z",
    updated_at: "2026-10-12T12:00:00.000Z",
    seller_response_due_at: null,
    support_review_due_at: null,
    seller_condition_attestation_due_at: null,
    order_return_context: [],
    affected_line_items: [],
    return_investigation: null,
    checklist: [
      {
        key: "attestation",
        label: "Confirm no delivery",
        ownerRole: "buyer",
        evidenceTypes: ["buyer-attestation"],
        required: true,
        satisfiedAt: null,
      },
    ],
    evidence: [],
    responses: [],
    offers: [],
    pending_offer: null,
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
    escalated_at: null,
    escalated_by_account_id: null,
    escalated_by_role: null,
    escalation_reason: null,
    return_refund_gate_status: null,
    return_delivered_at: null,
    return_refund_release_due_at: null,
    return_condition_disputed_at: null,
    remedy: null,
    remedy_approval: null,
    contested: false,
    case_presentation: "decision-pending",
    closure_eligible: false,
    closure_blocking_reasons: [],
    next_remedy_action: null,
    remedy_repair_guidance: [],
  };
}
