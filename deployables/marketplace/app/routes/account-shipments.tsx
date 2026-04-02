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
    shipments: await api.listBuyerShipments(DEFAULT_SHIPMENT_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Shipments | Marketplace" });

export default function MarketplaceAccountShipmentsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <FulfillmentShipmentListPage
      title="Shipments"
      eyebrow="Buyer"
      emptyTitle="No shipments yet"
      emptyDescription="Shipments appear here once a paid order moves into fulfillment."
      shipmentDetailBasePath="/account/shipments"
      shipments={(data.shipments as ListResponse<FulfillmentShipmentListItem>).items}
    />
  );
}
