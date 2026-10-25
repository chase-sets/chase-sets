import type { SupportRequesterRole } from "../domain/common";
import type { SupportFlowDefinition } from "../domain/flow-catalog";
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
