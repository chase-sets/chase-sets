import { createOrderingClientTransport } from "../../../support/request-support/client";
import { orderingRequestOptions } from "../../../support/request-support/request-options";
import { createPostagePolicyClient } from "./client";

export { OrderingApiError } from "../../../support/request-support/client";

export function createPostagePolicyRequestClient(request: Request) {
  return createPostagePolicyClient(createOrderingClientTransport(orderingRequestOptions(request)));
}
