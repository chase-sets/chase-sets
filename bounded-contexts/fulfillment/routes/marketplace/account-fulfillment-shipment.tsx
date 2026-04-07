import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime/web";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  FulfillmentApiError,
  type FulfillmentShipmentDetail,
} from "../../request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../request-support/api-client";
import { FulfillmentShipmentDetailPage } from "../../shipments/ui/shipment-detail-page";

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
      throw new Response("Shipment not found.", { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createFulfillmentRequestApiClient(request);

  try {
    if (intent === "prepare-package") {
      await api.packShipment(params.shipmentId!, {
        packageCount: Number(formData.get("packageCount") ?? 1),
      });
    }

    if (intent === "attach-label") {
      await api.attachLabel(params.shipmentId!, {
        shippingMethod: String(formData.get("shippingMethod") ?? "standard"),
        carrierName: String(formData.get("carrierName") ?? ""),
        labelReference: String(formData.get("labelReference") ?? ""),
        trackingIdentifier: String(formData.get("trackingIdentifier") ?? ""),
      });
    }

    if (intent === "dispatch-shipment") {
      await api.dispatchShipment(params.shipmentId!);
    }

    if (intent === "deliver-shipment") {
      await api.deliverShipment(params.shipmentId!);
    }

    if (intent === "return-shipment") {
      await api.returnShipment(params.shipmentId!, {
        reason: String(formData.get("reason") ?? ""),
      });
    }

    if (intent === "raise-exception") {
      await api.raiseShipmentException(params.shipmentId!, {
        exceptionType: String(formData.get("exceptionType") ?? "other"),
        notes: String(formData.get("notes") ?? ""),
      });
    }

    if (intent) {
      return redirect(`/account/fulfillment/${params.shipmentId!}`);
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Shipment Fulfillment | Marketplace" });

export default function MarketplaceAccountFulfillmentShipmentRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <FulfillmentShipmentDetailPage
      role="seller"
      backHref="/account/fulfillment"
      shipment={data.shipment as FulfillmentShipmentDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
