import type { SupportRequestDetailResponse } from "../../features/support-requests/ui/contracts";

export function supportRequestParticipantDetail(request: SupportRequestDetailResponse, accountId: string) {
  const viewerRole =
    request.buyer_account_id === accountId ? "buyer" : request.seller_account_id === accountId ? "seller" : null;
  if (!viewerRole) return null;

  return {
    flow: request.flow,
    viewerRole,
    canCancel: request.opened_by_account_id === accountId,
  } as const;
}
