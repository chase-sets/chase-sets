import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { readAnonymousSellListId } from "../support/request-support/guest-checkout";
import { CheckoutSellListPage } from "../features/sell-list/ui/sell-list-page";

function canUseAccountSellList(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const api = createCheckoutRequestApiClient(request);
  const anonymousSellListId = readAnonymousSellListId(request);

  if (!canUseAccountSellList(actor)) {
    return {
      isSignedIn: false,
      sellList: await api.getGuestSellList(anonymousSellListId),
    };
  }

  if (anonymousSellListId) {
    await api.mergeGuestSellListToAccount(anonymousSellListId);
  }

  return {
    isSignedIn: true,
    sellList: await api.getSellList(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createCheckoutRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });
  const useAccountSellList = canUseAccountSellList(actor);
  const anonymousSellListId = readAnonymousSellListId(request);

  try {
    if (intent === "add-selected-offer") {
      if (!useAccountSellList) {
        return redirect(`/sign-in?returnTo=${encodeURIComponent("/account/sell-list")}`);
      }

      const offerId = String(formData.get("offerId") ?? "");
      const offer = await marketplaceApi.getOfferMatch(offerId);

      const result = await api.addSellListLine({
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

      return redirect(appendFreshWriteToken("/account/sell-list", result));
    }

    if (intent === "remove-sell-list-line") {
      if (!useAccountSellList && anonymousSellListId) {
        return redirect(
          appendFreshWriteToken(
            "/account/sell-list",
            await api.removeGuestSellListLine(anonymousSellListId, String(formData.get("lineId") ?? "")),
          ),
        );
      }

      if (!useAccountSellList) {
        throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
      }

      return redirect(
        appendFreshWriteToken("/account/sell-list", await api.removeSellListLine(String(formData.get("lineId") ?? ""))),
      );
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
      isSignedIn={data.isSignedIn}
      errorMessage={actionData?.error ?? null}
    />
  );
}
