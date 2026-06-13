import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { readAnonymousCartId } from "../support/request-support/guest-checkout";
import { CheckoutCartPage } from "../features/cart/ui/cart-page";

const MARKETPLACE_DESCRIPTION = t("checkout.routes.accountCart.review.cart.lines.adjust.quantity.and");

function canUseAccountCart(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

function latestWriteResult(results: readonly unknown[]): unknown {
  return [...results].reverse().find((result) => result !== undefined && result !== null) ?? null;
}

function cartLineIdsFromForm(formData: FormData) {
  return formData
    .getAll("lineId")
    .map((lineId) => String(lineId ?? "").trim())
    .filter(Boolean);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });

  if (!canUseAccountCart(actor)) {
    const cart = await api.getGuestCart(readAnonymousCartId(request));
    return { cart };
  }

  const cart = await api.getCart();
  return { cart };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intentValues = formData.getAll("intent");
  const intent = String(intentValues.at(-1) ?? "");
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });
  const anonymousCartId = readAnonymousCartId(request);
  const useAccountCart = canUseAccountCart(actor);

  try {
    if (intent === "update-cart-line") {
      const lineIds = cartLineIdsFromForm(formData);
      const [primaryLineId, ...duplicateLineIds] = lineIds;

      const enteredQuantity = Number(formData.get("quantity") ?? 1);
      const quantityDelta = Number(formData.get("quantityDelta") ?? 0);
      const safeEnteredQuantity = Number.isFinite(enteredQuantity) ? enteredQuantity : 1;
      const nextQuantity = Math.max(1, safeEnteredQuantity + (Number.isFinite(quantityDelta) ? quantityDelta : 0));

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all([
          api.updateGuestCartLineQuantity(anonymousCartId, primaryLineId ?? "", {
            quantity: nextQuantity,
          }),
          ...duplicateLineIds.map((lineId) => api.removeGuestCartLine(anonymousCartId, lineId)),
        ]);
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all([
        api.updateCartLineQuantity(primaryLineId ?? "", {
          quantity: nextQuantity,
        }),
        ...duplicateLineIds.map((lineId) => api.removeCartLine(lineId)),
      ]);
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
    }

    if (intent === "lock-preferred-listing") {
      const lineIds = cartLineIdsFromForm(formData);
      const sellerPreferenceId = String(formData.get("sellerPreferenceId") ?? "").trim();
      if (!sellerPreferenceId || lineIds.length === 0) {
        throw new Error(t("checkout.routes.accountCart.preferred.listing.missing"));
      }

      const fulfillment = {
        fulfillmentMode: "locked-listing" as const,
        lockedListingId: sellerPreferenceId,
        sellerPreferenceId,
        availabilityState: "available" as const,
      };

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all(
          lineIds.map((lineId) => api.updateGuestCartLineFulfillment(anonymousCartId, lineId, fulfillment)),
        );
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all(lineIds.map((lineId) => api.updateCartLineFulfillment(lineId, fulfillment)));
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
    }

    if (intent === "remove-cart-line") {
      const lineIds = cartLineIdsFromForm(formData);

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all(lineIds.map((lineId) => api.removeGuestCartLine(anonymousCartId, lineId)));
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all(lineIds.map((lineId) => api.removeCartLine(lineId)));
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
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

  return <CheckoutCartPage cartLines={data.cart.items} errorMessage={actionData?.error ?? null} />;
}
