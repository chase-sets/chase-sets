import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "@chase-sets/identity/server";
import {
  FulfillmentShipmentListPage,
  type FulfillmentShipmentListItem,
} from "../../web";
import { createFulfillmentRequestApiClient } from "../../client";

const DEFAULT_SHIPMENT_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromIdentityApi({
    request,
    permission: "fulfillment.view",
  });
  const api = createFulfillmentRequestApiClient(request);

  return {
    shipments: await api.listBuyerShipments(DEFAULT_SHIPMENT_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Shipments | Marketplace" });

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
