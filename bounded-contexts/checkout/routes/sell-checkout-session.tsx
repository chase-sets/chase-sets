import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { SellListAttemptBoundary } from "../features/sell-list/ui/sell-list-attempt-boundary";
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
  const navigation = useNavigation();

  if (loaderData.mode === "signed-in") {
    const signedInState = actionState as SignedInSellCheckoutActionState;
    return (
      <SellListAttemptBoundary
        attempt={signedInState.status === "error" ? signedInState.attempt : null}
        pending={navigation.state !== "idle"}
      >
        <SignedInSellCheckoutPage {...loaderData} actionState={signedInState} />
      </SellListAttemptBoundary>
    );
  }

  return <GuestSellCheckoutPage {...loaderData} actionState={actionState as GuestSellCheckoutActionState} />;
}
