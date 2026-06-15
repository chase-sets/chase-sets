import type { SupportFlowDefinition } from "../domain/flow-catalog";
import type { SupportRequestDetailRow, SupportRequestListRow } from "../read-model/queries";

export type SupportFlowSummary = SupportFlowDefinition;
export type SupportRequestListItem = SupportRequestListRow;
export type SupportRequestDetail = SupportRequestDetailRow;

export type SupportRequestCommandSnapshot = Readonly<{
  id: string;
  version: number;
  status: "opened" | "evidence-submitted" | "response-recorded" | "escalated" | "resolved" | "closed" | "cancelled";
}>;

export type SupportRequestEscalationSnapshot = Readonly<{
  escalated: number;
  skipped: number;
}>;
