import { createFulfillmentClientTransport } from "../../../support/request-support/client";
import { fulfillmentRequestOptions } from "../../../support/request-support/request-options";
import { createReturnIntakeClient } from "./client";
export { FulfillmentApiError } from "../../../support/request-support/client";

export function createReturnIntakeRequestClient(request: Request) {
  return createReturnIntakeClient(createFulfillmentClientTransport(fulfillmentRequestOptions(request)));
}
