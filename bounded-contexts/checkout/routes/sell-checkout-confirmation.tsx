import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  loadFreshlyWrittenResource,
  preserveFreshWriteMetadata,
  recoverFreshWriteReadError,
} from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { SELLER_CHECKOUT_REGISTER_HREF } from "../features/sell-list/ui/registration-return";
import { SellCheckoutConfirmationPage } from "../features/sell-list/ui/sell-checkout-confirmation-page";
import { canUseSignedInSellCheckout } from "../support/route-support/sell-checkout-session/sell-checkout-loader";
import { confirmationIdForSession } from "../support/route-support/sell-checkout-session/sell-checkout-readiness";

function checkoutApiErrorStatus(error: unknown) {
  return error instanceof CheckoutApiError ? error.status : null;
}

function checkoutApiErrorBody(error: unknown) {
  return error instanceof CheckoutApiError ? error.body : null;
}

function checkoutApiErrorCode(error: unknown) {
  const body = checkoutApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return code === null || code === undefined ? null : String(code);
}

function accountSellListPreparingPath(request: Request, confirmationId: string) {
  const requestUrl = new URL(request.url);
  const search = new URLSearchParams({ confirmation: "preparing", pendingConfirmationId: confirmationId });
  return preserveFreshWriteMetadata(`/account/sell-list?${search.toString()}`, requestUrl);
}

function pathWithFreshWrite(request: Request, path: string) {
  return preserveFreshWriteMetadata(path, request);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  const actor = await resolveActorFromAuthApi({ request: resolvedRequest });
  if (!canUseSignedInSellCheckout(actor)) {
    throw redirect(SELLER_CHECKOUT_REGISTER_HREF);
  }

  if (!params.sessionId) {
    throw redirect("/account/sell-list?confirmation=missing");
  }

  const confirmationId = confirmationIdForSession(params.sessionId);
  const api = createCheckoutRequestApiClient(resolvedRequest);
  const confirmation = await loadFreshlyWrittenResource({
    request: resolvedRequest,
    isNotFound: (error) => error instanceof CheckoutApiError && error.status === 404,
    load: () => api.getSellListConfirmation(confirmationId),
  }).catch((error) => {
    const recovery = recoverFreshWriteReadError({
      request: resolvedRequest,
      error,
      getStatus: checkoutApiErrorStatus,
      getErrorCode: checkoutApiErrorCode,
      getBody: checkoutApiErrorBody,
      recoverTransient: () => redirect(accountSellListPreparingPath(request, confirmationId)),
    });
    if (recovery) {
      throw recovery;
    }

    if (error instanceof CheckoutApiError && error.status === 404) {
      return null;
    }

    throw error;
  });
  if (!confirmation) {
    throw redirect("/account/sell-list?confirmation=missing");
  }

  return {
    confirmation,
    sellerActivityPath: pathWithFreshWrite(request, "/account/sell-list"),
    committedSalesPath: pathWithFreshWrite(request, "/account/sales"),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.title"),
    description: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.description"),
  });

export default function SellCheckoutConfirmationRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SellCheckoutConfirmationPage
      confirmation={data.confirmation}
      sellerActivityPath={data.sellerActivityPath}
      committedSalesPath={data.committedSalesPath}
    />
  );
}
