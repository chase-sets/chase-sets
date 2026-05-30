import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createSettlementRequestApiClient } from "@chase-sets/settlement/server";
import type {
  OfferMatchListItem,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingTermsPreview,
} from "@chase-sets/marketplace/server";
import type { SettlementPayoutReadinessRow } from "@chase-sets/settlement/server";
import { createCheckoutRequestApiClient, type CheckoutSellListLineRow } from "../support/request-support/api-client";
import { readAnonymousSellListId } from "../support/request-support/guest-checkout";
import { CheckoutSellListPage } from "../features/sell-list/ui/sell-list-page";

function canUseAccountSellList(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: MarketplaceListingTermsPreview | null;
  message: string | null;
}>;

type SellListProductOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  offers: readonly Readonly<{
    offer: OfferMatchListItem;
    terms: MarketplaceListingTermsPreview;
  }>[];
  message: string | null;
}>;

async function loadSellListOfferReviews(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
): Promise<readonly SellListOfferReview[]> {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const selectedOfferLines = lines.filter((line) => line.line_type === "selected-offer" && line.offer_id);

  return Promise.all(
    selectedOfferLines.map(async (line) => {
      try {
        return {
          lineId: line.line_id,
          status: "ready" as const,
          terms: await marketplaceApi.previewOfferAcceptanceTerms(line.offer_id!),
          message: null,
        };
      } catch (error) {
        return {
          lineId: line.line_id,
          status: "unavailable" as const,
          terms: null,
          message: error instanceof Error ? error.message : "Offer terms are unavailable.",
        };
      }
    }),
  );
}

async function loadSellListProductOfferReviews(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
): Promise<readonly SellListProductOfferReview[]> {
  const productLines = lines.filter((line) => line.line_type === "product");
  if (productLines.length === 0) {
    return [];
  }

  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const selectedOfferIds = new Set(
    lines.filter((line) => line.line_type === "selected-offer" && line.offer_id).map((line) => line.offer_id as string),
  );

  try {
    const matches = (await marketplaceApi.listOfferMatches("limit=100")).items.filter(
      (offer) =>
        offer.status === "submitted" &&
        offer.can_fulfill &&
        !selectedOfferIds.has(offer.offer_id) &&
        productLines.some((line) => line.product_id === offer.product_id),
    );

    return Promise.all(
      productLines.map(async (line) => {
        const lineMatches = matches
          .filter((offer) => offer.product_id === line.product_id)
          .sort(
            (left, right) =>
              right.offer_to_listing_price_bps - left.offer_to_listing_price_bps ||
              Number(right.price_amount) - Number(left.price_amount) ||
              left.offer_id.localeCompare(right.offer_id),
          );
        const offers: Array<SellListProductOfferReview["offers"][number]> = [];
        let remainingQuantity = line.quantity;

        for (const offer of lineMatches) {
          if (remainingQuantity <= 0) {
            break;
          }
          if (offer.quantity_requested > remainingQuantity) {
            continue;
          }

          try {
            offers.push({
              offer,
              terms: await marketplaceApi.previewOfferAcceptanceTerms(offer.offer_id),
            });
            remainingQuantity -= offer.quantity_requested;
          } catch {
            // A stale match should not block the rest of the Sell List review.
          }
        }

        return {
          lineId: line.line_id,
          status: offers.length > 0 ? ("ready" as const) : ("unavailable" as const),
          offers,
          message: offers.length > 0 ? null : "No matching offers are currently ready for this product.",
        };
      }),
    );
  } catch (error) {
    return productLines.map((line) => ({
      lineId: line.line_id,
      status: "unavailable" as const,
      offers: [],
      message: error instanceof Error ? error.message : "Matching offers are unavailable.",
    }));
  }
}

async function loadSellListInventory(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
): Promise<readonly MarketplaceListingInventoryItemOption[]> {
  if (!lines.some((line) => line.line_type === "product")) {
    return [];
  }

  try {
    return (await createMarketplaceRequestApiClient(request).listSellerListingInventory()).items;
  } catch {
    return [];
  }
}

async function loadPayoutReadiness(request: Request): Promise<SettlementPayoutReadinessRow | null> {
  try {
    return await createSettlementRequestApiClient(request).getPayoutReadiness();
  } catch {
    return null;
  }
}

async function assertPayoutReady(request: Request) {
  let readiness: SettlementPayoutReadinessRow;
  try {
    readiness = await createSettlementRequestApiClient(request).getPayoutReadiness();
  } catch {
    throw new Error("Payout readiness is unavailable. Refresh payout setup before committing sale checkout.");
  }

  if (readiness.status !== "ready") {
    throw new Error("Finish payout setup before committing sale checkout.");
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const api = createCheckoutRequestApiClient(request);
  const anonymousSellListId = readAnonymousSellListId(request);
  const reviewCompleted = new URL(request.url).searchParams.get("review") === "completed";

  if (!canUseAccountSellList(actor)) {
    return {
      isSignedIn: false,
      reviewCompleted: false,
      sellList: await api.getGuestSellList(anonymousSellListId),
    };
  }

  if (anonymousSellListId) {
    await api.mergeGuestSellListToAccount(anonymousSellListId);
  }

  const sellList = await api.getSellList();

  return {
    isSignedIn: true,
    reviewCompleted,
    sellList,
    offerReviews: await loadSellListOfferReviews(request, sellList.items),
    productOfferReviews: await loadSellListProductOfferReviews(request, sellList.items),
    inventoryItems: await loadSellListInventory(request, sellList.items),
    payoutReadiness: await loadPayoutReadiness(request),
  };
}

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

async function executeSellListCheckout(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
  formData: FormData,
) {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const completedLineIds: string[] = [];
  const skippedReasons: string[] = [];
  let acceptedOfferCount = 0;
  let createdListingCount = 0;

  for (const line of lines) {
    if (line.line_type === "selected-offer") {
      if (!line.offer_id) {
        skippedReasons.push(`${line.item_title}: selected offer is missing.`);
        continue;
      }

      const feeQuoteFingerprint = formValue(formData, `offerFeeQuoteFingerprint:${line.line_id}`);
      if (!feeQuoteFingerprint) {
        skippedReasons.push(`${line.item_title}: offer terms need refresh.`);
        continue;
      }

      try {
        await marketplaceApi.acceptOfferMatch(line.offer_id, { feeQuoteFingerprint });
        completedLineIds.push(line.line_id);
        acceptedOfferCount += 1;
      } catch (error) {
        skippedReasons.push(`${line.item_title}: ${error instanceof Error ? error.message : "offer accept failed"}`);
      }
      continue;
    }

    const productOfferIds = formData
      .getAll(`productOfferId:${line.line_id}`)
      .map((value) => String(value).trim())
      .filter(Boolean);
    let plannedRemainingQuantity = line.quantity;
    const productOfferTargets: Array<{ offerId: string; feeQuoteFingerprint: string; quantity: number }> = [];

    for (const offerId of productOfferIds) {
      try {
        const offer = await marketplaceApi.getOfferMatch(offerId);
        if (offer.product_id !== line.product_id) {
          skippedReasons.push(`${line.item_title}: matching offer ${offerId} no longer matches this product.`);
          continue;
        }
        if (offer.quantity_requested > plannedRemainingQuantity) {
          skippedReasons.push(`${line.item_title}: matching offer ${offerId} exceeds remaining quantity.`);
          continue;
        }
        const feeQuoteFingerprint = formValue(formData, `productOfferFeeQuoteFingerprint:${line.line_id}:${offerId}`);
        if (!feeQuoteFingerprint) {
          skippedReasons.push(`${line.item_title}: matching offer terms need refresh.`);
          continue;
        }
        productOfferTargets.push({ offerId, feeQuoteFingerprint, quantity: offer.quantity_requested });
        plannedRemainingQuantity -= offer.quantity_requested;
      } catch (error) {
        skippedReasons.push(`${line.item_title}: ${error instanceof Error ? error.message : "offer match failed"}`);
      }
    }

    const createFallbackListing = formValue(formData, `fallbackMode:${line.line_id}`) === "create-listing";
    if (plannedRemainingQuantity > 0 && !createFallbackListing) {
      skippedReasons.push(`${line.item_title}: matching offers do not cover the requested quantity.`);
      continue;
    }

    let remainingQuantity = line.quantity;
    for (const target of productOfferTargets) {
      try {
        await marketplaceApi.acceptOfferMatch(target.offerId, { feeQuoteFingerprint: target.feeQuoteFingerprint });
        acceptedOfferCount += 1;
        remainingQuantity -= target.quantity;
      } catch (error) {
        skippedReasons.push(`${line.item_title}: ${error instanceof Error ? error.message : "offer accept failed"}`);
      }
    }

    if (createFallbackListing && remainingQuantity > 0) {
      const inventoryItemId = formValue(formData, `inventoryItemId:${line.line_id}`);
      const priceAmount = formValue(formData, `priceAmount:${line.line_id}`);
      const requestedQuantityCap = Number(formValue(formData, `quantityCap:${line.line_id}`) || remainingQuantity);
      const quantityCap = Math.min(remainingQuantity, requestedQuantityCap);
      if (!inventoryItemId || !priceAmount || !Number.isFinite(quantityCap) || quantityCap < 1) {
        skippedReasons.push(`${line.item_title}: listing needs inventory, price, and quantity.`);
        continue;
      }

      try {
        await marketplaceApi.createListing({ inventoryItemId, priceAmount, quantityCap });
        createdListingCount += 1;
        remainingQuantity = 0;
      } catch (error) {
        skippedReasons.push(`${line.item_title}: ${error instanceof Error ? error.message : "listing create failed"}`);
      }
    }

    if (remainingQuantity <= 0) {
      completedLineIds.push(line.line_id);
    }
  }

  return {
    completedLineIds,
    executionSummary: {
      acceptedOfferCount,
      createdListingCount,
      skippedLineCount: Math.max(0, lines.length - completedLineIds.length),
      skippedReasons,
    },
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

    if (intent === "review-sell-list-checkout") {
      if (!useAccountSellList) {
        return redirect(`/sign-in?returnTo=${encodeURIComponent("/account/sell-list")}`);
      }

      await assertPayoutReady(request);
      const sellList = await api.getSellList();
      const result = await executeSellListCheckout(request, sellList.items, formData);
      if (result.completedLineIds.length === 0) {
        throw new Error("No Sell List lines were ready to execute. Refresh offer terms or choose listing inventory.");
      }

      await api.checkoutSellList(result);
      const query = new URLSearchParams({
        review: "completed",
        accepted: String(result.executionSummary.acceptedOfferCount),
        listings: String(result.executionSummary.createdListingCount),
        skipped: String(result.executionSummary.skippedLineCount),
      });
      return redirect(`/account/sell-list?${query.toString()}`);
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
      reviewCompleted={data.reviewCompleted}
      offerReviews={"offerReviews" in data ? data.offerReviews : []}
      productOfferReviews={"productOfferReviews" in data ? data.productOfferReviews : []}
      inventoryItems={"inventoryItems" in data ? data.inventoryItems : []}
      payoutReadiness={"payoutReadiness" in data ? data.payoutReadiness : null}
      errorMessage={actionData?.error ?? null}
    />
  );
}
