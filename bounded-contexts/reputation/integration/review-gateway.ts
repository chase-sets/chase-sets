import { createReputationRequestApiClient } from "../request-support/api-client";
export type { ReputationReviewOpportunity } from "../reviews/client/contracts";

export function createReputationReviewGateway(request: Request) {
  const api = createReputationRequestApiClient(request);

  return {
    getOrderReviewOpportunity(orderId: string) {
      return api.getOrderReviewOpportunity(orderId);
    },
  };
}
