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

function hasAddressInput(formData: FormData, prefix: string) {
  return ["Name", "Company", "Street1", "Street2", "City", "State", "PostalCode", "Country", "Phone", "Email"].some(
    (field) => formData.has(`${prefix}${field}`),
  );
}

function packageBody(formData: FormData) {
  const fields = ["packageLengthInches", "packageWidthInches", "packageHeightInches", "packageWeightOunces"];
  if (!fields.some((field) => formData.has(field))) {
    return {};
  }

  return {
    packageLengthInches: Number(formValue(formData, "packageLengthInches") || 7),
    packageWidthInches: Number(formValue(formData, "packageWidthInches") || 5),
    packageHeightInches: Number(formValue(formData, "packageHeightInches") || 1),
    packageWeightOunces: Number(formValue(formData, "packageWeightOunces") || 4),
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
          t("fulfillment.routes.marketplace.accountSaleShipment.update.pending.description"),
        ),
      }),
    });
    if (recovery) {
      return recovery;
    }

    if (error instanceof FulfillmentApiError && error.status === 404) {
      throw new Response(t("fulfillment.routes.marketplace.accountSaleShipment.shipment.not.found"), { status: 404 });
    }

    throw error;
  }
}

async function handleAction(intent: string, { request, params, formData }: FormActionContext) {
  const api = createFulfillmentRequestApiClient(request);
  const shipmentId = params.shipmentId!;

  try {
    let result: unknown = null;
    if (intent === "prepare-package") {
      result = await api.packShipment(shipmentId, {
        packageCount: Number(formValue(formData, "packageCount") || 1),
      });
    }
    if (intent === "purchase-label") {
      result = await api.purchaseUspsLabel(shipmentId, {
        serviceLevel: formValue(formData, "serviceLevel"),
        ...(hasAddressInput(formData, "sender") ? addressBody(formData, "sender") : {}),
        ...(hasAddressInput(formData, "recipient") ? addressBody(formData, "recipient") : {}),
        overrideReason: formValue(formData, "overrideReason"),
        ...packageBody(formData),
      });
    }
    if (intent === "void-label") {
      result = await api.voidLabel(shipmentId);
    }
    if (intent === "dispatch-shipment") {
      result = await api.dispatchShipment(shipmentId);
    }
    if (intent === "deliver-shipment") {
      result = await api.deliverShipment(shipmentId);
    }
    if (intent === "return-shipment") {
      result = await api.returnShipment(shipmentId, {
        reason: formValue(formData, "reason"),
      });
    }
    if (intent === "raise-exception") {
      result = await api.raiseShipmentException(shipmentId, {
        exceptionType: formValue(formData, "exceptionType"),
        notes: formValue(formData, "notes"),
      });
    }

    return redirect(navigateAfterWrite(result, `/account/sales/shipments/${shipmentId}`));
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : t("fulfillment.routes.marketplace.accountSaleShipment.request.failed"),
    };
  }
}

export const action = defineFormAction({
  authorization: { permission: "fulfillment.manage" },
  intents: {
    "prepare-package": (context) => handleAction("prepare-package", context),
    "purchase-label": (context) => handleAction("purchase-label", context),
    "void-label": (context) => handleAction("void-label", context),
    "dispatch-shipment": (context) => handleAction("dispatch-shipment", context),
    "deliver-shipment": (context) => handleAction("deliver-shipment", context),
    "return-shipment": (context) => handleAction("return-shipment", context),
    "raise-exception": (context) => handleAction("raise-exception", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("fulfillment.routes.marketplace.accountSaleShipment.sale.shipment.marketplace") });

export default function MarketplaceAccountSaleShipmentRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  if (!data.shipment) {
    return (
      <Page>
        <PageHeader
          eyebrow={t("fulfillment.features.shipments.ui.shipmentDetailPage.seller")}
          title={t("fulfillment.routes.marketplace.accountSaleShipment.update.pending.title")}
          description={t("fulfillment.routes.marketplace.accountSaleShipment.update.pending.description")}
          actions={
            <LinkButton href="/account/sales/shipments" tone="secondary">
              {t("fulfillment.features.shipments.ui.shipmentDetailPage.back")}
            </LinkButton>
          }
        />
        <MarketplaceNotice
          tone="info"
          title={t("fulfillment.routes.marketplace.accountSaleShipment.update.pending.title")}
          description={data.freshnessError}
        />
      </Page>
    );
  }

  return (
    <FulfillmentShipmentDetailPage
      role="seller"
      backHref="/account/sales/shipments"
      shipment={data.shipment as FulfillmentShipmentDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
