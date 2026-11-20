import type { AddCheckoutSellListLineRequest } from "../../../client";
import type { createCheckoutRequestApiClient } from "../../../support/request-support/api-client";
import { submitCheckoutCartAttempt } from "./attempt-submission";

export function submitCheckoutSellListAdd(
  api: ReturnType<typeof createCheckoutRequestApiClient>,
  body: AddCheckoutSellListLineRequest,
  anonymousSellListId?: string,
) {
  return submitCheckoutCartAttempt({
    attemptId: body.attemptId,
    kind: "sell-list-line",
    target: "sell-list",
    body,
    send: () => (anonymousSellListId ? api.addGuestSellListLine(anonymousSellListId, body) : api.addSellListLine(body)),
    lookup: (query) => api.getSellListCommandAttempt(query, anonymousSellListId),
  });
}
