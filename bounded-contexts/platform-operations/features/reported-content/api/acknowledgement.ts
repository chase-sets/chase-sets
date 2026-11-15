import { isPlatformOperationsReportedContentTargetType } from "@chase-sets/event-core/public-event-payloads";
import { ReportedContentActionRejectedError } from "./contracts";

export type ReportedContentAcknowledgement = Readonly<{
  targetType: string;
  targetId: string;
  startedAt: string;
  acknowledgedAt: string;
  operatorUserId: string | null;
}>;
export function parseReportedContentAcknowledgement(value: unknown): ReportedContentAcknowledgement {
  const data = value as Partial<ReportedContentAcknowledgement> | null;
  if (
    !data ||
    !isPlatformOperationsReportedContentTargetType(data.targetType) ||
    typeof data.targetId !== "string" ||
    !data.targetId.trim() ||
    typeof data.startedAt !== "string" ||
    !Number.isFinite(Date.parse(data.startedAt)) ||
    typeof data.acknowledgedAt !== "string" ||
    !Number.isFinite(Date.parse(data.acknowledgedAt)) ||
    (data.operatorUserId !== null && typeof data.operatorUserId !== "string")
  ) {
    throw new ReportedContentActionRejectedError("invalid-request");
  }
  return data as ReportedContentAcknowledgement;
}
