import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { resolveCheckoutShopifySimpleUnavailableState } from "../support/request-support/checkout-release-control";
import { SELLER_CHECKOUT_REGISTER_HREF } from "../features/sell-list/ui/registration-return";
import { SellCheckoutConfirmationPage } from "../features/sell-list/ui/sell-checkout-confirmation-page";
import { canUseSignedInSellCheckout } from "../support/route-support/sell-checkout-session/sell-checkout-loader";
import { confirmationIdForSession } from "../support/route-support/sell-checkout-session/sell-checkout-readiness";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const unavailable = await resolveCheckoutShopifySimpleUnavailableState(request, actor, "sell");
  if (unavailable) {
    throw redirect(unavailable.redirectPath);
  }

  if (!canUseSignedInSellCheckout(actor)) {
    throw redirect(SELLER_CHECKOUT_REGISTER_HREF);
  }

  if (!params.sessionId) {
    throw redirect("/account/sell-list?confirmation=missing");
  }

  const confirmationId = confirmationIdForSession(params.sessionId);
  const api = createCheckoutRequestApiClient(request);
  const confirmation = await api.getSellListConfirmation(confirmationId).catch((error) => {
    if (error instanceof CheckoutApiError && error.status === 404) {
      return null;
    }

    throw error;
  });
  if (!confirmation) {
    throw redirect("/account/sell-list?confirmation=missing");
  }

  return { confirmation };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.title"),
    description: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.description"),
  });

export default function SellCheckoutConfirmationRoute() {
  const data = useLoaderData<typeof loader>();

  return <SellCheckoutConfirmationPage confirmation={data.confirmation} />;
}
