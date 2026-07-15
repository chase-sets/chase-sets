import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { navigateAfterWrite, readApiErrorMessage, recoverFreshWriteReadError } from "@chase-sets/http/responses";
import { LinkButton, MarketplaceNotice, Page, PageHeader } from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import { FulfillmentApiError, type FulfillmentShipmentDetail } from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentShipmentPackingPage } from "../../features/shipments/ui/shipment-packing-page";

type ShipmentPackingActionData = Readonly<{ error?: string }>;

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
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
      freshnessError: null,
    };
  } catch (error) {
    const recovery = recoverFreshWriteReadError({
      request,
      error,
      recoverTransient: () => ({
        shipment: null,
        freshnessError: readApiErrorMessage(
          error instanceof FulfillmentApiError ? error.body : null,
          t("fulfillment.routes.marketplace.accountSaleShipmentPacking.update.pending.description"),
        ),
      }),
    });
    if (recovery) {
      return recovery;
    }

    if (error instanceof FulfillmentApiError && error.status === 404) {
      throw new Response(t("fulfillment.routes.marketplace.accountSaleShipmentPacking.shipment.not.found"), {
        status: 404,
      });
    }

    throw error;
  }
}

async function handleAction(intent: string, { request, params, formData }: FormActionContext) {
  const api = createFulfillmentRequestApiClient(request);
  const shipmentId = params.shipmentId!;

  try {
    if (intent === "start-packing") {
      const result = await api.startPackingShipment(shipmentId);
      return redirect(navigateAfterWrite(result, `/account/sales/shipments/${shipmentId}/packing`));
    }

    if (intent === "complete-packing") {
      const result = await api.packShipment(shipmentId, {
        packageCount: Number(formValue(formData, "packageCount") || 1),
      });
      return redirect(navigateAfterWrite(result, `/account/sales/shipments/${shipmentId}`));
    }

    if (intent === "set-line-confirmed") {
      const lineId = formValue(formData, "lineId");
      const confirmedQuantity = Number(formValue(formData, "confirmedQuantity"));
      const result = await api.updatePackingLineQuantity(shipmentId, lineId, confirmedQuantity);
      return result;
    }

    return {
      error: t("fulfillment.routes.marketplace.accountSaleShipmentPacking.unknown.intent"),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : t("fulfillment.routes.marketplace.accountSaleShipmentPacking.request.failed");
    if (intent === "set-line-confirmed") {
      return new Response(JSON.stringify({ error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return {
      error: message,
    };
  }
}

export const action = defineFormAction({
  authorization: { permission: "fulfillment.manage" },
  intents: {
    "start-packing": (context) => handleAction("start-packing", context),
    "complete-packing": (context) => handleAction("complete-packing", context),
    "set-line-confirmed": (context) => handleAction("set-line-confirmed", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("fulfillment.routes.marketplace.accountSaleShipmentPacking.pack.shipment.marketplace"),
  });

export default function MarketplaceAccountSaleShipmentPackingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as ShipmentPackingActionData | undefined;

  if (!data.shipment) {
    return (
      <Page>
        <PageHeader
          eyebrow={t("fulfillment.features.shipments.ui.shipmentPackingPage.seller")}
          title={t("fulfillment.routes.marketplace.accountSaleShipmentPacking.update.pending.title")}
          description={t("fulfillment.routes.marketplace.accountSaleShipmentPacking.update.pending.description")}
          actions={
            <LinkButton href="/account/sales/shipments" tone="secondary">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.back")}
            </LinkButton>
          }
        />
        <MarketplaceNotice
          tone="info"
          title={t("fulfillment.routes.marketplace.accountSaleShipmentPacking.update.pending.title")}
          description={data.freshnessError}
        />
      </Page>
    );
  }

  return (
    <FulfillmentShipmentPackingPage
      backHref="/account/sales/shipments"
      shipment={data.shipment as FulfillmentShipmentDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
