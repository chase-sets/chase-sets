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
    shipments: await api.listSellerShipments(DEFAULT_SHIPMENT_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("fulfillment.routes.marketplace.accountSaleShipments.sale.shipments.marketplace") });

export default function MarketplaceAccountSaleShipmentsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <FulfillmentShipmentListPage
      title={t("fulfillment.routes.marketplace.accountSaleShipments.sale.shipments")}
      eyebrow={t("fulfillment.routes.marketplace.accountSaleShipments.seller")}
      emptyTitle={t("fulfillment.routes.marketplace.accountSaleShipments.no.sale.shipments.yet")}
      emptyDescription={t("fulfillment.routes.marketplace.accountSaleShipments.shipments.appear.here.once.a.paid")}
      shipmentDetailBasePath="/account/sales/shipments"
      batchPrintActionPath="/account/sales/shipments/packing-slips"
      shipments={(data.shipments as ListResponse<FulfillmentShipmentListItem>).items}
    />
  );
}
