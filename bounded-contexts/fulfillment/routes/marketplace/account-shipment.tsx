import type {
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime/web";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  FulfillmentApiError,
  type FulfillmentShipmentDetail,
} from "../../request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../request-support/api-client";
import { FulfillmentShipmentDetailPage } from "../../shipments/ui/shipment-detail-page";

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
