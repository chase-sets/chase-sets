import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import { type FulfillmentShipmentListItem } from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentCommandCenterPage } from "../../features/shipments/ui/fulfillment-command-center-page";
import {
  buildFulfillmentCommandCenter,
  runShipmentCommandCenterAction,
  type FulfillmentCommandCenterShipmentInput,
  type ShipmentActionName,
} from "../../features/shipments/ui/command-center-route-adapter";

const DEFAULT_SHIPMENT_QUERY = "limit=100&offset=0";
const COMMAND_CENTER_PATH = "/account/sales/shipments";

type CommandCenterActionData = Readonly<{ error?: string }>;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  const api = createFulfillmentRequestApiClient(request);
  const shipments = (await api.listSellerShipments(
    DEFAULT_SHIPMENT_QUERY,
  )) as ListResponse<FulfillmentShipmentListItem>;

  return {
    commandCenter: buildFulfillmentCommandCenter(shipments.items as readonly FulfillmentCommandCenterShipmentInput[]),
  };
}

// The single web transport for the consolidated shipment action module: each intent is a
// named shipment action dispatched through the shared state machine. On success the queue
// re-derives from the authoritative command snapshots on reload.
async function runAction(action: ShipmentActionName, { request, formData }: FormActionContext) {
  const api = createFulfillmentRequestApiClient(request);
  const outcome = await runShipmentCommandCenterAction(api, action, formData);
  if (outcome.ok) {
    return redirect(COMMAND_CENTER_PATH);
  }
  return { error: outcome.error };
}

export const action = defineFormAction({
  authorization: { permission: "fulfillment.manage" },
  intents: {
    "buy-label": (context) => runAction("buy-label", context),
    "void-label": (context) => runAction("void-label", context),
    dispatch: (context) => runAction("dispatch", context),
    "record-delivery": (context) => runAction("record-delivery", context),
    return: (context) => runAction("return", context),
    "raise-exception": (context) => runAction("raise-exception", context),
  },
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("fulfillment.routes.marketplace.accountSaleShipments.sale.shipments.marketplace") });

export default function MarketplaceAccountSaleShipmentsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as CommandCenterActionData | undefined;

  return (
    <FulfillmentCommandCenterPage
      commandCenter={data.commandCenter}
      actionBasePath={COMMAND_CENTER_PATH}
      shipmentDetailBasePath={COMMAND_CENTER_PATH}
      packingFlowBasePath={COMMAND_CENTER_PATH}
      errorMessage={actionData?.error ?? null}
    />
  );
}
