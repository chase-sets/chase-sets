import { normalizeFlowType } from "../../features/support-requests/domain/common";
import { getSupportFlowDefinition } from "../../features/support-requests/domain/flow-catalog";
import type { SupportRequestDetail } from "../../features/support-requests/ui/contracts";

export function supportRequestParticipantDetail(request: SupportRequestDetail, accountId: string) {
  const viewerRole =
    request.buyer_account_id === accountId ? "buyer" : request.seller_account_id === accountId ? "seller" : null;
  if (!viewerRole) return null;

  return {
    flow: getSupportFlowDefinition(normalizeFlowType(request.flow_type)),
    viewerRole,
    canCancel: request.opened_by_account_id === accountId,
  } as const;
}
