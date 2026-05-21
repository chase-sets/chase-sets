import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type FulfillmentShipmentListItem } from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentShipmentListPage } from "../../features/shipments/ui/shipment-list-page";

const DEFAULT_SHIPMENT_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  const api = createFulfillmentRequestApiClient(request);

  return {
    shipments: await api.listBuyerShipments(DEFAULT_SHIPMENT_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("fulfillment.routes.marketplace.accountShipments.shipments.marketplace") });

export default function MarketplaceAccountShipmentsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <FulfillmentShipmentListPage
      title={t("fulfillment.routes.marketplace.accountShipments.shipments")}
      eyebrow={t("fulfillment.routes.marketplace.accountShipments.buyer")}
      emptyTitle={t("fulfillment.routes.marketplace.accountShipments.no.shipments.yet")}
      emptyDescription={t("fulfillment.routes.marketplace.accountShipments.shipments.appear.here.once.a.paid")}
      shipmentDetailBasePath="/account/shipments"
      shipments={(data.shipments as ListResponse<FulfillmentShipmentListItem>).items}
    />
  );
}
