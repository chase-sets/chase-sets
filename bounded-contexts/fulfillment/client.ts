import { createFulfillmentClientTransport, type FulfillmentApiClientOptions } from "./support/request-support/client";
import { createSellerShippingSetupClient } from "./features/seller-checkout-readiness/api/client";
import { createShipmentClient } from "./features/shipments/api/client";
import { createReturnIntakeClient } from "./features/return-shipments/api/client";

export { FulfillmentApiError } from "./support/request-support/client";
export type { FulfillmentApiClientOptions } from "./support/request-support/client";
export type {
  SellerShippingSetupInput,
  SellerShippingSetupMode,
  SellerShippingSetupResult,
} from "./features/seller-checkout-readiness/api/client";
export type {
  FulfillmentReturnIntakeQueue,
  FulfillmentReturnIntakeResolution,
} from "./features/return-shipments/api/client";
export type {
  FulfillmentShipmentDetail,
  FulfillmentShipmentException,
  FulfillmentLabelAddressOverrideAudit,
  FulfillmentPackingSlip,
  FulfillmentPackingSlipBatch,
  FulfillmentPackingSlipFormat,
  FulfillmentShipmentLine,
  FulfillmentShipmentListItem,
} from "./features/shipments/api/contracts";

export type { FulfillmentCommandCenter } from "./features/shipments/read-model/command-center";

export function createFulfillmentApiClient(options?: FulfillmentApiClientOptions) {
  const transport = createFulfillmentClientTransport(options);
  return {
    ...createSellerShippingSetupClient(transport),
    ...createShipmentClient(transport),
    ...createReturnIntakeClient(transport),
  };
}

export const fulfillmentApi = createFulfillmentApiClient();
