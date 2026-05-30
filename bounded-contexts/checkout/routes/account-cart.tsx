import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createIdentityRequestApiClient, type ShippingAddress } from "@chase-sets/identity/server";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { createPaymentsRequestApiClient } from "@chase-sets/payments/server";
import { createCheckoutRequestApiClient, type CheckoutCartLine } from "../support/request-support/api-client";
import { readAnonymousCartId } from "../support/request-support/guest-checkout";
import { CheckoutCartPage } from "../features/cart/ui/cart-page";

const MARKETPLACE_DESCRIPTION = t("checkout.routes.accountCart.review.cart.lines.adjust.quantity.and");

function canUseAccountCart(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

function latestWriteResult(results: readonly unknown[]): unknown {
  return [...results].reverse().find((result) => result !== undefined && result !== null) ?? null;
}

function cartLineToPreviewLine(line: CheckoutCartLine) {
  return {
    listingId: line.locked_listing_id,
    cartLineId: line.line_id,
    catalogItemId: line.catalog_catalog_item_id,
    productId: line.product_id,
    itemTitle: line.item_title,
    itemSubtitle: line.item_subtitle,
    selectedOptions: line.selected_options,
    productSummary: line.product_summary,
    quantity: line.quantity,
    fulfillmentMode: line.fulfillment_mode,
    lockedListingId: line.locked_listing_id,
    sellerPreferenceId: line.seller_preference_id,
  };
}

function shippingAddressSnapshot(address: ShippingAddress) {
  return {
    name: address.recipient_name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postal_code,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}

function normalizeShippingOption(value: string | null) {
  return value === "priority" || value === "expedited" ? value : "standard";
}

function normalizeOptimizationGoal(value: string | null) {
  return value === "fewest-shipments" ? value : "lowest-total";
}

function normalizePreviewText(value: string | null) {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function previewAddressFromSearchParams(searchParams: URLSearchParams) {
  const postalCode = normalizePreviewText(searchParams.get("previewPostalCode"));
  const country = normalizePreviewText(searchParams.get("previewCountry")) ?? "US";
  const state = normalizePreviewText(searchParams.get("previewState")) ?? "";
  const city = normalizePreviewText(searchParams.get("previewCity")) ?? "";
  if (!postalCode) {
    return null;
  }

  return {
    label: [postalCode, state, country].filter(Boolean).join(", "),
    address: {
      name: "Cart preview",
      company: null,
      line1: "Cart preview",
      line2: null,
      city,
      state,
      postalCode,
      country,
      phone: null,
      email: null,
    },
  };
}

async function loadCartLandedCostPreview(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  cart: { items: readonly CheckoutCartLine[] },
) {
  const searchParams = new URL(request.url).searchParams;
  const shippingOption = normalizeShippingOption(searchParams.get("previewShippingOption"));
  const optimizationGoal = normalizeOptimizationGoal(searchParams.get("previewOptimizationGoal"));
  const searchedAddress = previewAddressFromSearchParams(searchParams);
  let address: ReturnType<typeof shippingAddressSnapshot> | null = searchedAddress?.address ?? null;
  let addressLabel = searchedAddress?.label ?? null;

  try {
    if (
      !address &&
      actor &&
      actor.roleKey !== "guest-buyer" &&
      Array.isArray(actor.permissions) &&
      actor.permissions.includes("accounts.view")
    ) {
      const addresses = await createIdentityRequestApiClient(request).listShippingAddresses<{
        items: readonly ShippingAddress[];
      }>(actor.accountId);
      const defaultAddress = addresses.items.find((item) => item.is_default) ?? addresses.items[0] ?? null;
      if (defaultAddress) {
        address = shippingAddressSnapshot(defaultAddress);
        addressLabel = defaultAddress.label;
      }
    }

    if (!address || !addressLabel || cart.items.length === 0) {
      return null;
    }

    const preview = await createOrderingRequestApiClient(request).previewCheckoutFulfillment({
      checkoutSessionId: `cart-preview:${actor?.accountId ?? readAnonymousCartId(request) ?? "guest"}`,
      sourceType: "cart-checkout",
      shippingOption,
      shippingAddress: address,
      optimizationGoal,
      lines: cart.items.map(cartLineToPreviewLine),
    });
    const paymentPreview = await createPaymentsRequestApiClient(request)
      .previewCheckoutStatus({
        amount: preview.totals.totalAmount,
        paymentMethodCategory: "card",
      })
      .catch(() => null);

    return {
      addressLabel,
      shippingOption,
      optimizationGoal,
      previewDestination: {
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
      },
      preview,
      paymentPreview,
    };
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });

  if (!canUseAccountCart(actor)) {
    const cart = await api.getGuestCart(readAnonymousCartId(request));
    const landedCostPreview = await loadCartLandedCostPreview(request, actor, cart);
    return landedCostPreview ? { cart, landedCostPreview } : { cart };
  }

  const cart = await api.getCart();
  const landedCostPreview = await loadCartLandedCostPreview(request, actor, cart);
  return {
    cart,
    ...(landedCostPreview ? { landedCostPreview } : {}),
  };
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
      const lineIds = formData
        .getAll("lineId")
        .map((lineId) => String(lineId ?? "").trim())
        .filter(Boolean);
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

    if (intent === "remove-cart-line") {
      const lineIds = formData
        .getAll("lineId")
        .map((lineId) => String(lineId ?? "").trim())
        .filter(Boolean);

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

    if (intent === "unlock-cart-line") {
      const lineIds = formData
        .getAll("lineId")
        .map((lineId) => String(lineId ?? "").trim())
        .filter(Boolean);

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all(
          lineIds.map((lineId) =>
            api.updateGuestCartLineFulfillment(anonymousCartId, lineId, {
              fulfillmentMode: "optimize",
              lockedListingId: null,
              sellerPreferenceId: null,
              availabilityState: "available",
            }),
          ),
        );
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all(
        lineIds.map((lineId) =>
          api.updateCartLineFulfillment(lineId, {
            fulfillmentMode: "optimize",
            lockedListingId: null,
            sellerPreferenceId: null,
            availabilityState: "available",
          }),
        ),
      );
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
    }

    if (intent === "lock-cart-line") {
      const lineIds = formData
        .getAll("lineId")
        .map((lineId) => String(lineId ?? "").trim())
        .filter(Boolean);
      const lockedListingId = String(formData.get("lockedListingId") ?? "").trim();
      if (!lockedListingId) {
        throw new Error("Choose a seller option before locking fulfillment.");
      }

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all(
          lineIds.map((lineId) =>
            api.updateGuestCartLineFulfillment(anonymousCartId, lineId, {
              fulfillmentMode: "locked-listing",
              lockedListingId,
              sellerPreferenceId: null,
              availabilityState: "available",
            }),
          ),
        );
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all(
        lineIds.map((lineId) =>
          api.updateCartLineFulfillment(lineId, {
            fulfillmentMode: "locked-listing",
            lockedListingId,
            sellerPreferenceId: null,
            availabilityState: "available",
          }),
        ),
      );
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

  return (
    <CheckoutCartPage
      cartLines={data.cart.items}
      landedCostPreview={"landedCostPreview" in data ? data.landedCostPreview : null}
      errorMessage={actionData?.error ?? null}
    />
  );
}
