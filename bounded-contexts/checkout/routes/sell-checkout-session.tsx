import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  GuestSellCheckoutPage,
  type GuestSellCheckoutActionState,
} from "../features/sell-list/ui/guest-sell-checkout-page";
import {
  SignedInSellCheckoutPage,
  type SignedInSellCheckoutActionState,
} from "../features/sell-list/ui/signed-in-sell-checkout-page";
import { action } from "../support/route-support/sell-checkout-session/sell-checkout-action";
import { loader } from "../support/route-support/sell-checkout-session/sell-checkout-loader";

export { action, loader };

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.sellCheckoutSession.meta.title"),
    description: t("checkout.routes.sellCheckoutSession.meta.description"),
  });

export default function GuestSellCheckoutRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const actionState = useActionData<typeof action>() ?? { status: "idle" as const };

  if (loaderData.mode === "signed-in") {
    return <SignedInSellCheckoutPage {...loaderData} actionState={actionState as SignedInSellCheckoutActionState} />;
  }

  return <GuestSellCheckoutPage {...loaderData} actionState={actionState as GuestSellCheckoutActionState} />;
}
