import { createReputationRequestApiClient } from "./server";

export type { ReputationReviewOpportunity } from "./reviews/ui/contracts";

export function createReputationReviewGateway(request: Request) {
  const api = createReputationRequestApiClient(request);

  return {
    getOrderReviewOpportunity(orderId: string) {
      return api.getOrderReviewOpportunity(orderId);
    },
  };
}
