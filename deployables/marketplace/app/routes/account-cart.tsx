import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { OrderingCartPage } from "@chase-sets/ordering/web";
import { createMarketplaceOrderingApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "orders.view");
  const api = createMarketplaceOrderingApiClient(request);

  return {
    cart: await api.getCart(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireMarketplaceActor(request, "orders.manage");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceOrderingApiClient(request);

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

    if (intent === "checkout-cart") {
      await api.checkoutCart({
        shippingOption: String(formData.get("shippingOption") ?? "standard"),
      });
      return redirect("/account/orders");
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Cart | Marketplace" });

export default function MarketplaceAccountCartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <OrderingCartPage
      cartLines={data.cart.items}
      errorMessage={actionData?.error ?? null}
    />
  );
}
