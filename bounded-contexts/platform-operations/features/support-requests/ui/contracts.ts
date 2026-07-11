import type { SupportFlowDefinition } from "../domain/flow-catalog";
import type { SupportRequestDetailRow, SupportRequestListRow } from "../read-model/queries";

export type SupportFlowSummary = SupportFlowDefinition;
export type SupportOrderLookup = Readonly<{
  orderId: string;
  openedByRole: "buyer" | "seller";
  status: string;
  totalAmount: string;
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

export type SupportOperationsQueueFilters = Readonly<{ status: string; priority: string; search: string }>;
