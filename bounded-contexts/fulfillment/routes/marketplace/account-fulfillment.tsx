import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  type FulfillmentShipmentListItem,
} from "../../client";
import { createFulfillmentRequestApiClient } from "../../server";
import { FulfillmentShipmentListPage } from "../../shipments/ui/shipment-list-page";

const DEFAULT_SHIPMENT_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  const api = createFulfillmentRequestApiClient(request);

  return {
    shipments: await api.listSellerShipments(DEFAULT_SHIPMENT_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Fulfillment | Marketplace" });

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
