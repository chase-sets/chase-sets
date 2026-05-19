import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { CheckoutSellListPage } from "../features/sell-list/ui/sell-list-page";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  if (!actor || actor.permissions.includes("guest-checkout.manage")) {
    throw redirect(`/sign-in?returnTo=${encodeURIComponent("/account/sell-list")}`);
  }

  const api = createCheckoutRequestApiClient(request);
  return {
    sellList: await api.getSellList(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createCheckoutRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);

  try {
    if (intent === "add-selected-offer") {
      const offerId = String(formData.get("offerId") ?? "");
      const offer = await marketplaceApi.getOfferMatch(offerId);

      await api.addSellListLine({
        lineType: "selected-offer",
        offerId: offer.offer_id,
        buyerAccountId: offer.buyer_account_id,
        buyerDisplayName: offer.buyer_display_name,
        offerPriceAmount: offer.price_amount,
        catalogItemId: offer.catalog_catalog_item_id,
        productId: offer.product_id,
        itemTitle: offer.item_title,
        itemSubtitle: offer.item_subtitle,
        selectedOptions: offer.selected_options,
        productSummary: offer.product_summary,
        quantity: offer.quantity_requested,
        fallbackMode: "none",
        minimumListingPriceAmount: null,
      });

      return redirect("/account/sell-list");
    }

    if (intent === "remove-sell-list-line") {
      await api.removeSellListLine(String(formData.get("lineId") ?? ""));
      return redirect("/account/sell-list");
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("checkout.routes.accountSellList.sell.list.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.accountSellList.sell.list.chase.sets"),
    description: t("checkout.routes.accountSellList.review.selected.offers.and.product.level"),
  });

export default function CheckoutAccountSellListRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <CheckoutSellListPage
      sellListLines={data.sellList.items}
      errorMessage={actionData?.error ?? null}
    />
  );
}
