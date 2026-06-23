import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { loadFreshlyWrittenResource, recoverFreshWriteReadError } from "@chase-sets/http/responses";
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
  const afterWrite = new URL(request.url).searchParams.get("afterWrite");
  const search = new URLSearchParams({ confirmation: "preparing", pendingConfirmationId: confirmationId });
  if (afterWrite) {
    search.set("afterWrite", afterWrite);
  }

  return `/account/sell-list?${search.toString()}`;
}

function pathWithFreshWrite(request: Request, path: string) {
  const afterWrite = new URL(request.url).searchParams.get("afterWrite");
  if (!afterWrite) {
    return path;
  }

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.set("afterWrite", afterWrite);
  return `${url.pathname}${url.search}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  if (!canUseSignedInSellCheckout(actor)) {
    throw redirect(SELLER_CHECKOUT_REGISTER_HREF);
  }

  if (!params.sessionId) {
    throw redirect("/account/sell-list?confirmation=missing");
  }

  const confirmationId = confirmationIdForSession(params.sessionId);
  const api = createCheckoutRequestApiClient(request);
  const confirmation = await loadFreshlyWrittenResource({
    request,
    isNotFound: (error) => error instanceof CheckoutApiError && error.status === 404,
    load: () => api.getSellListConfirmation(confirmationId),
  }).catch((error) => {
    const recovery = recoverFreshWriteReadError({
      request,
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
