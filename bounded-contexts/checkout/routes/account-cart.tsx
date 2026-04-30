import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { CheckoutCartPage } from "../features/cart/ui/cart-page";

const MARKETPLACE_DESCRIPTION =
  "Review cart lines, adjust quantity, and start checkout.";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.view" });
  const api = createCheckoutRequestApiClient(request);

  return {
    cart: await api.getCart(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createCheckoutRequestApiClient(request);

  try {
    if (intent === "update-cart-line") {
      await api.updateCartLineQuantity(String(formData.get("lineId") ?? ""), {
        quantity: Number(formData.get("quantity") ?? 0),
      });
      return redirect("/account/cart");
    }

    if (intent === "remove-cart-line") {
      await api.removeCartLine(String(formData.get("lineId") ?? ""));
      return redirect("/account/cart");
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Cart | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function CheckoutAccountCartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <CheckoutCartPage
      cartLines={data.cart.items}
      errorMessage={actionData?.error ?? null}
    />
  );
}
