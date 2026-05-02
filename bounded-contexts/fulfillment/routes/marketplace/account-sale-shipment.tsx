import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  FulfillmentApiError,
  type FulfillmentShipmentDetail,
} from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentShipmentDetailPage } from "../../features/shipments/ui/shipment-detail-page";

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function addressBody(formData: FormData, prefix: string) {
  return {
    [`${prefix}Name`]: formValue(formData, `${prefix}Name`),
    [`${prefix}Company`]: formValue(formData, `${prefix}Company`),
    [`${prefix}Street1`]: formValue(formData, `${prefix}Street1`),
    [`${prefix}Street2`]: formValue(formData, `${prefix}Street2`),
    [`${prefix}City`]: formValue(formData, `${prefix}City`),
    [`${prefix}State`]: formValue(formData, `${prefix}State`),
    [`${prefix}PostalCode`]: formValue(formData, `${prefix}PostalCode`),
    [`${prefix}Country`]: formValue(formData, `${prefix}Country`) || "US",
    [`${prefix}Phone`]: formValue(formData, `${prefix}Phone`),
    [`${prefix}Email`]: formValue(formData, `${prefix}Email`),
  };
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
  const api = createFulfillmentRequestApiClient(request);
  const formData = await request.formData();
  const intent = formValue(formData, "intent");
  const shipmentId = params.shipmentId!;

  try {
    if (intent === "prepare-package") {
      await api.packShipment(shipmentId, {
        packageCount: Number(formValue(formData, "packageCount") || 1),
      });
    }
    if (intent === "purchase-label") {
      await api.purchaseUspsLabel(shipmentId, {
        serviceLevel: formValue(formData, "serviceLevel"),
        ...addressBody(formData, "sender"),
        ...addressBody(formData, "recipient"),
        packageLengthInches: Number(formValue(formData, "packageLengthInches") || 7),
        packageWidthInches: Number(formValue(formData, "packageWidthInches") || 5),
        packageHeightInches: Number(formValue(formData, "packageHeightInches") || 1),
        packageWeightOunces: Number(formValue(formData, "packageWeightOunces") || 4),
      });
    }
    if (intent === "void-label") {
      await api.voidLabel(shipmentId);
    }
    if (intent === "dispatch-shipment") {
      await api.dispatchShipment(shipmentId);
    }
    if (intent === "deliver-shipment") {
      await api.deliverShipment(shipmentId);
    }
    if (intent === "return-shipment") {
      await api.returnShipment(shipmentId, {
        reason: formValue(formData, "reason"),
      });
    }
    if (intent === "raise-exception") {
      await api.raiseShipmentException(shipmentId, {
        exceptionType: formValue(formData, "exceptionType"),
        notes: formValue(formData, "notes"),
      });
    }

    return redirect(`/account/sales/shipments/${shipmentId}`);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Sale Shipment | Marketplace" });

export default function MarketplaceAccountSaleShipmentRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <FulfillmentShipmentDetailPage
      role="seller"
      backHref="/account/sales/shipments"
      shipment={data.shipment as FulfillmentShipmentDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
