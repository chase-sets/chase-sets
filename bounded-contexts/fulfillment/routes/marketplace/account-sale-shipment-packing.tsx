import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { FulfillmentApiError, type FulfillmentShipmentDetail } from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentShipmentPackingPage } from "../../features/shipments/ui/shipment-packing-page";

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

async function waitForPackingProjection(api: ReturnType<typeof createFulfillmentRequestApiClient>, shipmentId: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const shipment = await api.getSellerShipment(shipmentId);
    if (shipment.status === "packing") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  const api = createFulfillmentRequestApiClient(request);

  try {
    return {
      shipment: await api.getSellerShipment(params.shipmentId!),
    };
  } catch (error) {
    if (error instanceof FulfillmentApiError && error.status === 404) {
      throw new Response(t("fulfillment.routes.marketplace.accountSaleShipmentPacking.shipment.not.found"), {
        status: 404,
      });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.manage",
  });
  const api = createFulfillmentRequestApiClient(request);
  const formData = await request.formData();
  const intent = formValue(formData, "intent");
  const shipmentId = params.shipmentId!;

  try {
    if (intent === "start-packing") {
      await api.startPackingShipment(shipmentId);
      await waitForPackingProjection(api, shipmentId);
      return redirect(`/account/sales/shipments/${shipmentId}/packing`);
    }

    if (intent === "complete-packing") {
      await api.packShipment(shipmentId, {
        packageCount: Number(formValue(formData, "packageCount") || 1),
      });
      return redirect(`/account/sales/shipments/${shipmentId}`);
    }

    return {
      error: t("fulfillment.routes.marketplace.accountSaleShipmentPacking.unknown.intent"),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : t("fulfillment.routes.marketplace.accountSaleShipmentPacking.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("fulfillment.routes.marketplace.accountSaleShipmentPacking.pack.shipment.marketplace"),
  });

export default function MarketplaceAccountSaleShipmentPackingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <FulfillmentShipmentPackingPage
      backHref="/account/sales/shipments"
      shipment={data.shipment as FulfillmentShipmentDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
