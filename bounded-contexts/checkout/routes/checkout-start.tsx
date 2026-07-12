import { useActionData, useLoaderData } from "react-router";
import { CheckoutStartPage } from "../features/sessions/ui/checkout-start-page";
import type { CheckoutStartActionData } from "../features/sessions/ui/checkout-start-page-types";
import { action } from "../support/route-support/buy-checkout-readiness/checkout-start-action";
import { loader } from "../support/route-support/buy-checkout-readiness/checkout-start-loader";

export { action, loader };
export {
  checkoutStartBuyerProtectionItems,
  checkoutStartHeaderCopy,
} from "../features/sessions/ui/checkout-start-copy";

export default function CheckoutStartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as CheckoutStartActionData | undefined;

  return <CheckoutStartPage data={data} actionData={actionData} />;
}
