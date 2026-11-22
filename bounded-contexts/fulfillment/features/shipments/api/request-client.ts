import { createFulfillmentClientTransport } from "../../../support/request-support/client";
import { fulfillmentRequestOptions } from "../../../support/request-support/request-options";
import { createShipmentClient } from "./client";
export { FulfillmentApiError } from "../../../support/request-support/client";
export type {
  FulfillmentPackingSlip,
  FulfillmentPackingSlipFormat,
  FulfillmentShipmentDetail,
  FulfillmentShipmentListItem,
} from "./contracts";

export function createShipmentRequestClient(request: Request) {
  return createShipmentClient(createFulfillmentClientTransport(fulfillmentRequestOptions(request)));
}
