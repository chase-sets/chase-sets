import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentCommandCenterPage } from "../../features/shipments/ui/fulfillment-command-center-page";
import {
  runShipmentCommandCenterAction,
  type ShipmentActionName,
} from "../../features/shipments/ui/command-center-route-adapter";
import { ShipmentMutationBoundary } from "../../features/shipments/ui/shipment-mutation-boundary";

const COMMAND_CENTER_PATH = "/account/sales/shipments";

type CommandCenterActionData = Readonly<{ error?: string }>;

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  // The Fulfillment API builds the command center: which shipments need the seller, their
  // buckets, order and action plans.
  const commandCenter = await createFulfillmentRequestApiClient(request).getSellerCommandCenter();

  return {
    commandCenter,
    recoveryScope: { tenantId: actor.tenantId, sellerAccountId: actor.accountId },
  };
}

// The single web transport for the command center's actions: each intent is a named shipment
// action the Fulfillment API admits or refuses against the shipment's stored state. On success
// the page reads the command center again.
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
    "cancel-shipment": (context) => runAction("cancel-shipment", context),
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
    <ShipmentMutationBoundary {...data.recoveryScope}>
      <FulfillmentCommandCenterPage
        commandCenter={data.commandCenter}
        actionBasePath={COMMAND_CENTER_PATH}
        shipmentDetailBasePath={COMMAND_CENTER_PATH}
        packingFlowBasePath={COMMAND_CENTER_PATH}
        errorMessage={actionData?.error ?? null}
      />
    </ShipmentMutationBoundary>
  );
}
