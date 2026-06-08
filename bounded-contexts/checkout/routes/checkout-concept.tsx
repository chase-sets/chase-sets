import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { GuestCheckoutConceptPage } from "../features/sessions/ui/guest-checkout-concept-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.checkoutConcept.guest.checkout.concept.marketplace"),
    description: t("checkout.routes.checkoutConcept.guest.checkout.concept.description"),
  });

export default function CheckoutConceptRoute() {
  return <GuestCheckoutConceptPage />;
}
