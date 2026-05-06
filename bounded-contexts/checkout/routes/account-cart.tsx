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
  const canUseAccountCart = actor?.permissions.includes("orders.view") ?? false;

  if (!actor || !canUseAccountCart) {
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
  const intentValues = formData.getAll("intent");
  const intent = String(intentValues.at(-1) ?? "");
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });
  const anonymousCartId = readAnonymousCartId(request);
  const canManageAccountCart = actor?.permissions.includes("orders.manage") ?? false;

  try {
    if (intent === "update-cart-line") {
      const lineIds = formData.getAll("lineId").map((lineId) => String(lineId ?? "").trim()).filter(Boolean);
      const [primaryLineId, ...duplicateLineIds] = lineIds;

      if ((!actor || !canManageAccountCart) && anonymousCartId) {
        await api.updateGuestCartLineQuantity(
          anonymousCartId,
          primaryLineId ?? "",
          {
            quantity: Number(formData.get("quantity") ?? 0),
          },
        );
        await Promise.all(
          duplicateLineIds.map((lineId) =>
            api.removeGuestCartLine(anonymousCartId, lineId),
          ),
        );
        return redirect("/account/cart");
      }

      if (!actor || !canManageAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      await api.updateCartLineQuantity(primaryLineId ?? "", {
        quantity: Number(formData.get("quantity") ?? 0),
      });
      await Promise.all(
        duplicateLineIds.map((lineId) => api.removeCartLine(lineId)),
      );
      return redirect("/account/cart");
    }

    if (intent === "remove-cart-line") {
      const lineIds = formData.getAll("lineId").map((lineId) => String(lineId ?? "").trim()).filter(Boolean);

      if ((!actor || !canManageAccountCart) && anonymousCartId) {
        await Promise.all(
          lineIds.map((lineId) => api.removeGuestCartLine(anonymousCartId, lineId)),
        );
        return redirect("/account/cart");
      }

      if (!actor || !canManageAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      await Promise.all(lineIds.map((lineId) => api.removeCartLine(lineId)));
      return redirect("/account/cart");
    }

    if (intent === "unlock-cart-line") {
      const lineIds = formData.getAll("lineId").map((lineId) => String(lineId ?? "").trim()).filter(Boolean);

      if ((!actor || !canManageAccountCart) && anonymousCartId) {
        await Promise.all(
          lineIds.map((lineId) =>
            api.updateGuestCartLineFulfillment(anonymousCartId, lineId, {
              fulfillmentMode: "optimize",
              lockedListingId: null,
              sellerPreferenceId: null,
              availabilityState: "available",
            }),
          ),
        );
        return redirect("/account/cart");
      }

      if (!actor || !canManageAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      await Promise.all(
        lineIds.map((lineId) =>
          api.updateCartLineFulfillment(lineId, {
            fulfillmentMode: "optimize",
            lockedListingId: null,
            sellerPreferenceId: null,
            availabilityState: "available",
          }),
        ),
      );
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
