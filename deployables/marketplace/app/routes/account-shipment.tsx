import type {
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData } from "react-router";
import {
  ApiError as FulfillmentApiError,
  FulfillmentShipmentDetailPage,
  type FulfillmentShipmentDetail,
} from "@chase-sets/fulfillment/web";
import { createMarketplaceFulfillmentApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "fulfillment.view");
  const api = createMarketplaceFulfillmentApiClient(request);

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
  buildMarketplaceMeta({ title: "Shipment | Marketplace" });

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
