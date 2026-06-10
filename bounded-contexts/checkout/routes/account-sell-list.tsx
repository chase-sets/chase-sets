import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createSettlementRequestApiClient } from "@chase-sets/settlement/server";
import type {
  OfferMatchListItem,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
} from "@chase-sets/marketplace/server";
import type { SettlementPayoutReadinessRow } from "@chase-sets/settlement/server";
import {
  createCheckoutRequestApiClient,
  type CheckoutSellListLineRow,
  type CheckoutSellListReceiptRow,
  type SellListReadinessDecisionInput,
} from "../support/request-support/api-client";
import { readAnonymousSellListId } from "../support/request-support/guest-checkout";
import { CheckoutSellListPage } from "../features/sell-list/ui/sell-list-page";

function canUseAccountSellList(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: MarketplaceListingTermsPreview | MarketplacePublicStandardTermsPreview | null;
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

function moneyValue(value: string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function buyerTrustScore(offer: OfferMatchListItem) {
  const rating = Number(offer.buyer_average_rating ?? 0);
  const reviews = Number(offer.buyer_review_count ?? 0);
  return (Number.isFinite(rating) ? rating : 0) * 100 + Math.min(50, Number.isFinite(reviews) ? reviews : 0);
}

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

async function loadGuestSellListOfferReviews(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
): Promise<readonly SellListOfferReview[]> {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const previewPublicStandardListingTerms = marketplaceApi.previewPublicStandardListingTerms?.bind(marketplaceApi);
  const selectedOfferLines = lines.filter((line) => line.line_type === "selected-offer" && line.offer_price_amount);
  if (typeof previewPublicStandardListingTerms !== "function" || selectedOfferLines.length === 0) {
    return [];
  }

  const previewByPrice = new Map<string, Promise<MarketplacePublicStandardTermsPreview | null>>();
  const previewForPrice = (priceAmount: string) => {
    if (!previewByPrice.has(priceAmount)) {
      previewByPrice.set(
        priceAmount,
        previewPublicStandardListingTerms({ priceAmount })
          .then((preview) => preview)
          .catch(() => null),
      );
    }

    return previewByPrice.get(priceAmount)!;
  };

  return Promise.all(
    selectedOfferLines.map(async (line) => {
      const terms = line.offer_price_amount ? await previewForPrice(line.offer_price_amount) : null;
      return {
        lineId: line.line_id,
        status: terms ? ("ready" as const) : ("unavailable" as const),
        terms,
        message: terms ? null : "Public standard seller terms are temporarily unavailable.",
      };
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
  const productIds = [...new Set(productLines.map((line) => line.product_id).filter(Boolean))];
  const query = new URLSearchParams({
    limit: String(Math.min(250, Math.max(50, productLines.length * 20))),
    offset: "0",
    productIds: productIds.join(","),
    status: "submitted",
    canFulfill: "true",
  });

  try {
    const matches = (await marketplaceApi.listOfferMatches(query.toString())).items.filter(
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
          offers: offers.sort(
            (left, right) =>
              moneyValue(right.terms.seller_net_unit_amount) - moneyValue(left.terms.seller_net_unit_amount) ||
              Number(right.offer.can_fulfill) - Number(left.offer.can_fulfill) ||
              buyerTrustScore(right.offer) - buyerTrustScore(left.offer) ||
              new Date(right.offer.created_at).getTime() - new Date(left.offer.created_at).getTime() ||
              right.offer.quantity_requested - left.offer.quantity_requested ||
              left.offer.offer_id.localeCompare(right.offer.offer_id),
          ),
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
    const sellList = await api.getGuestSellList(anonymousSellListId);

    return {
      isSignedIn: false,
      reviewCompleted: false,
      sellList,
      offerReviews: await loadGuestSellListOfferReviews(request, sellList.items),
    };
  }

  if (anonymousSellListId) {
    await api.mergeGuestSellListToAccount(anonymousSellListId);
  }

  const sellList = await api.getSellList();

  return {
    isSignedIn: true,
    sellListExecutionId: sellList.latestPendingExecution?.execution_id ?? createId("sle"),
    latestPendingExecution: sellList.latestPendingExecution ?? null,
    reviewCompleted,
    sellList,
    latestReceipt: sellList.latestReceipt ?? null,
    offerReviews: await loadSellListOfferReviews(request, sellList.items),
    productOfferReviews: await loadSellListProductOfferReviews(request, sellList.items),
    inventoryItems: await loadSellListInventory(request, sellList.items),
    payoutReadiness: await loadPayoutReadiness(request),
  };
}

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function deterministicSellListListingId(executionId: string, actionKey: string) {
  const compact = `${executionId}:${actionKey}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 80);
  return `lst_${compact}`;
}

type SellListExecutionPlan = Readonly<{
  version: 1;
  lines: readonly SellListExecutionPlanLine[];
}>;

type SellListExecutionPlanLine = Readonly<{
  lineId: string;
  lineType: "selected-offer" | "product";
  itemTitle: string;
  productId: string | null;
  quantity: number;
  selectedOffer: Readonly<{ offerId: string; feeQuoteFingerprint: string }> | null;
  productOfferTargets: readonly Readonly<{ offerId: string; feeQuoteFingerprint: string; quantity: number }>[];
  fallbackListing: Readonly<{ inventoryItemId: string; priceAmount: string; quantityCap: number }> | null;
  skippedReasons: readonly string[];
}>;

type SellListExecutionProgress = Readonly<{
  completedActionKeys: readonly string[];
}>;

function isSellListExecutionPlan(value: unknown): value is SellListExecutionPlan {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { lines?: unknown }).lines)
  );
}

async function buildSellListExecutionPlan(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
  formData: FormData,
): Promise<SellListExecutionPlan> {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const executionLines: SellListExecutionPlanLine[] = [];

  for (const line of lines) {
    if (line.line_type === "selected-offer") {
      const skippedReasons: string[] = [];
      const feeQuoteFingerprint = formValue(formData, `offerFeeQuoteFingerprint:${line.line_id}`);
      const selectedOffer =
        line.offer_id && feeQuoteFingerprint ? { offerId: line.offer_id, feeQuoteFingerprint } : null;

      if (!line.offer_id) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.selected.offer.missing.detail", { itemTitle: line.item_title }),
        );
      } else if (!feeQuoteFingerprint) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle: line.item_title }),
        );
      }

      executionLines.push({
        lineId: line.line_id,
        lineType: "selected-offer",
        itemTitle: line.item_title,
        productId: line.product_id,
        quantity: line.quantity,
        selectedOffer,
        productOfferTargets: [],
        fallbackListing: null,
        skippedReasons,
      });
      continue;
    }

    const skippedReasons: string[] = [];
    const productOfferTargets: Array<{ offerId: string; feeQuoteFingerprint: string; quantity: number }> = [];
    let plannedRemainingQuantity = line.quantity;

    for (const offerId of formData
      .getAll(`productOfferId:${line.line_id}`)
      .map((value) => String(value).trim())
      .filter(Boolean)) {
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
    let fallbackListing: SellListExecutionPlanLine["fallbackListing"] = null;
    if (plannedRemainingQuantity > 0 && createFallbackListing) {
      const inventoryItemId = formValue(formData, `inventoryItemId:${line.line_id}`);
      const priceAmount = formValue(formData, `priceAmount:${line.line_id}`);
      const requestedQuantityCap = Number(
        formValue(formData, `quantityCap:${line.line_id}`) || plannedRemainingQuantity,
      );
      const quantityCap = Math.min(plannedRemainingQuantity, requestedQuantityCap);
      if (!inventoryItemId || !priceAmount || !Number.isFinite(quantityCap) || quantityCap < 1) {
        skippedReasons.push(`${line.item_title}: listing needs inventory, price, and quantity.`);
      } else {
        fallbackListing = { inventoryItemId, priceAmount, quantityCap };
      }
    } else if (plannedRemainingQuantity > 0) {
      skippedReasons.push(
        t("checkout.routes.accountSellList.matching.offers.do.not.cover.quantity.detail", {
          itemTitle: line.item_title,
        }),
      );
    }

    executionLines.push({
      lineId: line.line_id,
      lineType: "product",
      itemTitle: line.item_title,
      productId: line.product_id,
      quantity: line.quantity,
      selectedOffer: null,
      productOfferTargets,
      fallbackListing,
      skippedReasons,
    });
  }

  return { version: 1, lines: executionLines };
}

function isSellListExecutionProgress(value: unknown): value is SellListExecutionProgress {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { completedActionKeys?: unknown }).completedActionKeys)
  );
}

function readinessDecisionsFromExecutionPlan(plan: SellListExecutionPlan): SellListReadinessDecisionInput {
  const lineActions: Array<NonNullable<SellListReadinessDecisionInput["lineActions"]>[number]> = [];
  const lineOutcomes: Array<NonNullable<SellListReadinessDecisionInput["lineOutcomes"]>[number]> = [];

  for (const line of plan.lines) {
    if (line.lineType === "selected-offer" && line.selectedOffer) {
      lineActions.push({ lineId: line.lineId, action: "selected-offer" });
      continue;
    }

    if (line.productOfferTargets.length > 0) {
      lineActions.push({ lineId: line.lineId, action: "smart-match" });
      continue;
    }

    if (line.fallbackListing) {
      lineActions.push({ lineId: line.lineId, action: "fallback-listing" });
      continue;
    }

    lineOutcomes.push({ lineId: line.lineId, outcome: "keep-in-list" });
  }

  return { lineActions, lineOutcomes };
}

async function executeSellListCheckout(
  request: Request,
  executionId: string,
  executionPlan: SellListExecutionPlan,
  executionProgress: SellListExecutionProgress,
) {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const checkoutApi = createCheckoutRequestApiClient(request);
  const completedActionKeys = new Set(executionProgress.completedActionKeys);
  const completedLineIds: string[] = [];
  const remainingLineQuantities: Array<{ lineId: string; quantity: number }> = [];
  const skippedReasons: string[] = [];
  const lineOutcomes: NonNullable<CheckoutSellListReceiptRow["execution_summary"]["lineOutcomes"]>[number][] = [];
  let acceptedOfferCount = 0;
  let createdListingCount = 0;

  for (const line of executionPlan.lines) {
    skippedReasons.push(...line.skippedReasons);

    if (line.lineType === "selected-offer") {
      if (!line.selectedOffer) {
        lineOutcomes.push({
          lineId: line.lineId,
          itemTitle: line.itemTitle,
          status: "skipped",
          action: "kept-in-sell-list",
          quantity: line.quantity,
          remainingQuantity: line.quantity,
          detail:
            line.skippedReasons.join(" ") ||
            t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle: line.itemTitle }),
        });
        continue;
      }

      const actionKey = `selected-offer:${line.lineId}:${line.selectedOffer.offerId}`;
      try {
        if (!completedActionKeys.has(actionKey)) {
          await marketplaceApi.acceptOfferMatch(line.selectedOffer.offerId, {
            feeQuoteFingerprint: line.selectedOffer.feeQuoteFingerprint,
            sourceActionKey: `${executionId}:${actionKey}`,
          });
          await checkoutApi.recordSellListExecutionProgress(executionId, { completedActionKey: actionKey });
          completedActionKeys.add(actionKey);
        }
        completedLineIds.push(line.lineId);
        acceptedOfferCount += 1;
        lineOutcomes.push({
          lineId: line.lineId,
          itemTitle: line.itemTitle,
          status: "completed",
          action: "accepted-offer",
          quantity: line.quantity,
          remainingQuantity: 0,
          detail: t("checkout.routes.accountSellList.selected.offer.accepted.detail", { itemTitle: line.itemTitle }),
        });
      } catch (error) {
        const detail = t("checkout.routes.accountSellList.offer.accept.failed.detail", {
          itemTitle: line.itemTitle,
          message: error instanceof Error ? error.message : t("checkout.routes.accountSellList.offer.accept.failed"),
        });
        skippedReasons.push(detail);
        lineOutcomes.push({
          lineId: line.lineId,
          itemTitle: line.itemTitle,
          status: "skipped",
          action: "kept-in-sell-list",
          quantity: line.quantity,
          remainingQuantity: line.quantity,
          detail,
        });
      }
      continue;
    }

    let remainingQuantity = line.quantity;
    let acceptedQuantity = 0;
    let listingQuantity = 0;

    for (const target of line.productOfferTargets) {
      const actionKey = `smart-match:${line.lineId}:${target.offerId}`;
      try {
        if (!completedActionKeys.has(actionKey)) {
          await marketplaceApi.acceptOfferMatch(target.offerId, {
            feeQuoteFingerprint: target.feeQuoteFingerprint,
            sourceActionKey: `${executionId}:${actionKey}`,
          });
          await checkoutApi.recordSellListExecutionProgress(executionId, { completedActionKey: actionKey });
          completedActionKeys.add(actionKey);
        }
        acceptedOfferCount += 1;
        acceptedQuantity += target.quantity;
        remainingQuantity -= target.quantity;
      } catch (error) {
        skippedReasons.push(`${line.itemTitle}: ${error instanceof Error ? error.message : "offer accept failed"}`);
      }
    }

    if (line.fallbackListing && remainingQuantity > 0) {
      const actionKey = `fallback-listing:${line.lineId}:${line.fallbackListing.inventoryItemId}:${line.fallbackListing.priceAmount}:${line.fallbackListing.quantityCap}`;
      try {
        if (!completedActionKeys.has(actionKey)) {
          await marketplaceApi.createListing({
            ...line.fallbackListing,
            listingIdOverride: deterministicSellListListingId(executionId, actionKey),
            sourceActionKey: `${executionId}:${actionKey}`,
          });
          await checkoutApi.recordSellListExecutionProgress(executionId, { completedActionKey: actionKey });
          completedActionKeys.add(actionKey);
        }
        createdListingCount += 1;
        listingQuantity = line.fallbackListing.quantityCap;
        remainingQuantity -= line.fallbackListing.quantityCap;
      } catch (error) {
        skippedReasons.push(`${line.itemTitle}: ${error instanceof Error ? error.message : "listing create failed"}`);
      }
    }

    if (remainingQuantity <= 0) {
      completedLineIds.push(line.lineId);
      const action =
        acceptedQuantity > 0 && listingQuantity > 0
          ? "mixed"
          : acceptedQuantity > 0
            ? "accepted-smart-match"
            : "created-listing";
      lineOutcomes.push({
        lineId: line.lineId,
        itemTitle: line.itemTitle,
        status: "completed",
        action,
        quantity: line.quantity,
        remainingQuantity: 0,
        detail: t("checkout.routes.accountSellList.sale.action.completed.detail", {
          itemTitle: line.itemTitle,
          acceptedQuantity,
          listingQuantity,
        }),
      });
    } else if (acceptedQuantity > 0 || listingQuantity > 0) {
      remainingLineQuantities.push({ lineId: line.lineId, quantity: remainingQuantity });
      const detail = t("checkout.routes.accountSellList.sale.action.partial.detail", {
        itemTitle: line.itemTitle,
        executedQuantity: line.quantity - remainingQuantity,
        remainingQuantity,
      });
      skippedReasons.push(detail);
      lineOutcomes.push({
        lineId: line.lineId,
        itemTitle: line.itemTitle,
        status: "partial",
        action:
          acceptedQuantity > 0 && listingQuantity > 0
            ? "mixed"
            : acceptedQuantity > 0
              ? "accepted-smart-match"
              : "created-listing",
        quantity: line.quantity,
        remainingQuantity,
        detail,
      });
    } else {
      lineOutcomes.push({
        lineId: line.lineId,
        itemTitle: line.itemTitle,
        status: "skipped",
        action: "kept-in-sell-list",
        quantity: line.quantity,
        remainingQuantity: line.quantity,
        detail:
          line.skippedReasons.join(" ") ||
          t("checkout.routes.accountSellList.no.sale.action.completed.detail", { itemTitle: line.itemTitle }),
      });
    }
  }

  return {
    completedLineIds,
    remainingLineQuantities,
    executionSummary: {
      acceptedOfferCount,
      createdListingCount,
      skippedLineCount: lineOutcomes.filter((outcome) => outcome.status !== "completed").length,
      skippedReasons,
      lineOutcomes,
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

    if (intent === "review-sell-list-checkout" || intent === "rebuild-sell-list-checkout") {
      if (!useAccountSellList) {
        return redirect(`/sign-in?returnTo=${encodeURIComponent("/account/sell-list")}`);
      }

      await assertPayoutReady(request);
      const sellList = await api.getSellList();
      const executionId =
        intent === "rebuild-sell-list-checkout"
          ? createId("sle")
          : formValue(formData, "sellListExecutionId") || createId("sle");

      const existingReceipt =
        executionId && typeof api.getSellListExecutionReceipt === "function"
          ? await api.getSellListExecutionReceipt(executionId).catch(() => null)
          : null;
      if (existingReceipt) {
        const query = new URLSearchParams({
          review: "completed",
          execution: executionId,
          accepted: String(existingReceipt.execution_summary.acceptedOfferCount ?? 0),
          listings: String(existingReceipt.execution_summary.createdListingCount ?? 0),
          skipped: String(existingReceipt.execution_summary.skippedLineCount ?? 0),
        });
        return redirect(`/account/sell-list?${query.toString()}`);
      }

      const plannedExecution = await buildSellListExecutionPlan(request, sellList.items, formData);
      const startedExecution =
        typeof api.startSellListExecution === "function"
          ? await api.startSellListExecution({ executionId, executionPlan: plannedExecution })
          : {
              status: "pending" as const,
              executionPlan: plannedExecution,
              executionProgress: { completedActionKeys: [] },
              executionSummary: null,
            };
      if (startedExecution.status === "finalized") {
        const summary = startedExecution.executionSummary ?? {};
        const query = new URLSearchParams({
          review: "completed",
          execution: executionId,
          accepted: String(summary.acceptedOfferCount ?? 0),
          listings: String(summary.createdListingCount ?? 0),
          skipped: String(summary.skippedLineCount ?? 0),
        });
        return redirect(`/account/sell-list?${query.toString()}`);
      }

      const executionPlan = isSellListExecutionPlan(startedExecution.executionPlan)
        ? startedExecution.executionPlan
        : plannedExecution;
      const executionProgress = isSellListExecutionProgress(startedExecution.executionProgress)
        ? startedExecution.executionProgress
        : { completedActionKeys: [] };
      const readinessDecisions = readinessDecisionsFromExecutionPlan(executionPlan);
      const readiness = await api.createSellListReadiness(readinessDecisions);
      if (readiness.readiness.status !== "ready" || readiness.readiness.unresolvedLineIds.length > 0) {
        throw new Error("Sell List readiness must be resolved before seller checkout starts.");
      }

      const result = await executeSellListCheckout(request, executionId, executionPlan, executionProgress);
      if (result.completedLineIds.length === 0 && result.remainingLineQuantities.length === 0) {
        throw new Error("No Sell List lines were ready to execute. Refresh offer terms or choose listing inventory.");
      }

      await api.checkoutSellList({
        executionId,
        readinessSnapshotId: readiness.readiness.snapshotId,
        readinessSourceRevision: readiness.readiness.sourceRevision,
        readinessDecisions,
        ...result,
      });
      const query = new URLSearchParams({
        review: "completed",
        accepted: String(result.executionSummary.acceptedOfferCount),
        listings: String(result.executionSummary.createdListingCount),
        skipped: String(result.executionSummary.skippedLineCount),
      });
      query.set("execution", executionId);
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
      sellListExecutionId={"sellListExecutionId" in data ? data.sellListExecutionId : null}
      latestReceipt={"latestReceipt" in data ? data.latestReceipt : null}
      offerReviews={"offerReviews" in data ? data.offerReviews : []}
      productOfferReviews={"productOfferReviews" in data ? data.productOfferReviews : []}
      inventoryItems={"inventoryItems" in data ? data.inventoryItems : []}
      payoutReadiness={"payoutReadiness" in data ? data.payoutReadiness : null}
      errorMessage={actionData?.error ?? null}
    />
  );
}
