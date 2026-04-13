import type {
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  FulfillmentApiError,
  type FulfillmentShipmentDetail,
} from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentShipmentDetailPage } from "../../features/shipments/ui/shipment-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  const api = createFulfillmentRequestApiClient(request);

  try {
    return {
      shipment: await api.getBuyerShipment(params.shipmentId!),
    };
  } catch (error) {
    if (error instanceof FulfillmentApiError && error.status === 404) {
      throw new Response("Shipment not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Shipment | Marketplace" });

export default function MarketplaceAccountShipmentRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <FulfillmentShipmentDetailPage
      role="buyer"
      backHref="/account/shipments"
      shipment={data.shipment as FulfillmentShipmentDetail}
    />
  );
}
