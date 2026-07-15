import type { SupportFlowDefinition } from "../domain/flow-catalog";
import type { SupportRequestDetailRow, SupportRequestListRow } from "../read-model/queries";

export type SupportFlowSummary = SupportFlowDefinition;
export type SupportOrderLookup = Readonly<{
  orderId: string;
  openedByRole: "buyer" | "seller";
  status: string;
  totalAmount: string;
  lines: readonly Readonly<{
    lineId: string;
    itemTitle: string;
    productSummary: string | null;
    quantity: number;
    amount: string;
    currencyCode: string;
  }>[];
  existingOpenRequest?: Readonly<{
    supportRequestId: string;
    displayReference: string;
    flowType: string;
    status: string;
  }>;
}>;
export type SupportRequestListItem = SupportRequestListRow;
export type SupportRequestDetail = SupportRequestDetailRow;

export type SupportRequestCommandSnapshot = Readonly<{
  id: string;
  version: number;
  status:
    | "opened"
    | "evidence-submitted"
    | "response-recorded"
    | "offer-accepted"
    | "offer-declined"
    | "escalated"
    | "resolved"
    | "closed"
    | "cancelled";
}>;

export type SupportRequestEscalationSnapshot = Readonly<{
  escalated: number;
  skipped: number;
  capped: boolean;
  total: number;
}>;

export type SupportOperationsQueueFilters = Readonly<{
  status: string;
  priority: string;
  search: string;
  flowType: string;
  contested: boolean;
  overdue: boolean;
}>;

export type PlatformRemedyProposalPreview = Readonly<{
  customerOutcome: string;
  sellerImpact: string;
  protectionReserveImpact: string;
  returnLabelCostPayer: string;
  refundTrigger: string;
  reservationExpiresAt: string | null;
  requiredApprovalCount: number;
  requiresElevatedApproval: boolean;
  returnOverrideRequired: boolean;
  policyVersion: string;
}>;

export type PlatformRemedyProposalInput = Readonly<Record<string, unknown>>;
