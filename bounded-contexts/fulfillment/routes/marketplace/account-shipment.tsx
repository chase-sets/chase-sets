import type {
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "@chase-sets/identity/server";
import {
  ApiError as FulfillmentApiError,
  FulfillmentShipmentDetailPage,
  type FulfillmentShipmentDetail,
} from "../../web";
import { createFulfillmentRequestApiClient } from "../../client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromIdentityApi({
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
