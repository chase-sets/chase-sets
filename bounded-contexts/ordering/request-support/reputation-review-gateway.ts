import {
  createReputationRequestApiClient,
  type ReputationReviewOpportunity,
} from "@chase-sets/reputation/server";

export type { ReputationReviewOpportunity };

export function createOrderingReputationReviewGateway(request: Request) {
  const api = createReputationRequestApiClient(request);

  return {
    getOrderReviewOpportunity(orderId: string) {
      return api.getOrderReviewOpportunity(orderId);
    },
  };
}
