import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { readAnonymousCartId } from "../support/request-support/guest-checkout";
import { CheckoutCartPage } from "../features/cart/ui/cart-page";

const MARKETPLACE_DESCRIPTION =
  t("checkout.routes.accountCart.review.cart.lines.adjust.quantity.and");

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });

  if (!actor) {
    return {
      cart: await api.getGuestCart(readAnonymousCartId(request)),
    };
  }

  return {
    cart: await api.getCart(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });
  const anonymousCartId = readAnonymousCartId(request);

  try {
    if (intent === "update-cart-line") {
      if (!actor && anonymousCartId) {
        await api.updateGuestCartLineQuantity(
          anonymousCartId,
          String(formData.get("lineId") ?? ""),
          {
            quantity: Number(formData.get("quantity") ?? 0),
          },
        );
        return redirect("/account/cart");
      }

      if (!actor) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      await api.updateCartLineQuantity(String(formData.get("lineId") ?? ""), {
        quantity: Number(formData.get("quantity") ?? 0),
      });
      return redirect("/account/cart");
    }

    if (intent === "remove-cart-line") {
      if (!actor && anonymousCartId) {
        await api.removeGuestCartLine(
          anonymousCartId,
          String(formData.get("lineId") ?? ""),
        );
        return redirect("/account/cart");
      }

      if (!actor) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      await api.removeCartLine(String(formData.get("lineId") ?? ""));
      return redirect("/account/cart");
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("checkout.routes.accountCart.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.accountCart.cart.marketplace"),
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
