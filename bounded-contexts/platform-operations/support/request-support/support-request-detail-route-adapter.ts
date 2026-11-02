import type { SupportRequestParticipantDetailResponse } from "../../features/support-requests/ui/contracts";

export function supportRequestParticipantDetail(request: SupportRequestParticipantDetailResponse, accountId: string) {
  const viewerRole =
    request.buyer_account_id === accountId ? "buyer" : request.seller_account_id === accountId ? "seller" : null;
  if (!viewerRole) return null;

  return {
    flow: request.flow,
    viewerRole,
    participantPolicy: request.participantPolicy,
  } as const;
}
