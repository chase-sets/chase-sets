import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  FulfillmentShipmentListPage,
  type FulfillmentShipmentListItem,
} from "@chase-sets/fulfillment/web";
import { createMarketplaceFulfillmentApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_SHIPMENT_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "fulfillment.view");
  const api = createMarketplaceFulfillmentApiClient(request);

  return {
    shipments: await api.listSellerShipments(DEFAULT_SHIPMENT_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Fulfillment | Marketplace" });

export default function MarketplaceAccountFulfillmentRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <FulfillmentShipmentListPage
      title="Fulfillment"
      eyebrow="Seller"
      emptyTitle="No shipments to fulfill"
      emptyDescription="Paid seller orders create shipment work here as soon as they are ready for fulfillment."
      shipmentDetailBasePath="/account/fulfillment"
      shipments={(data.shipments as ListResponse<FulfillmentShipmentListItem>).items}
    />
  );
}
