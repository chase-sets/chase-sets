import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  evaluatePostWriteHandoff,
  loadFreshlyWrittenResource,
  postWriteRecoveryKindForFreshWriteReadError,
  postWriteRecoveryKindForHandoffState,
  readPostWriteHandoffState,
  recoverFreshWriteReadError,
  type PostWriteRecoveryKind,
  type PostWriteHandoffState,
} from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  recordPlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyOutcome,
} from "@chase-sets/platform-runtime/post-write-consistency";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createSettlementRequestApiClient } from "@chase-sets/settlement/server";
import type {
  OfferMatchListItem,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
  PublicOfferDetail,
} from "@chase-sets/marketplace/server";
import type { SettlementPayoutReadinessRow } from "@chase-sets/settlement/server";
import {
  createCheckoutRequestApiClient,
  type AddCheckoutSellListLineRequest,
  type CheckoutSellListConfirmationRow,
  type CheckoutSellListLineRow,
  type SellListReadinessDecisionInput,
} from "../support/request-support/api-client";
import {
  appendAnonymousSellListCookie,
  ensureAnonymousSellListId,
  readAnonymousSellListId,
} from "../support/request-support/guest-checkout";
import {
  ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
  ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND,
  isAccountSellListAddLineHandoff,
  isPendingAccountSellListAddLineHandoff,
} from "../support/request-support/account-sell-list-handoffs";
import {
  SELLER_CHECKOUT_REGISTER_HREF,
  SELLER_CHECKOUT_SIGN_IN_HREF,
  sellerCheckoutRegisterHref,
  sellerCheckoutSignInHref,
} from "../features/sell-list/ui/registration-return";
import { CheckoutSellListPage } from "../features/sell-list/ui/sell-list-page";
import { usePendingFreshWriteRevalidation } from "../support/route-support/pending-fresh-write-revalidation";

function canUseAccountSellList(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: MarketplaceListingTermsPreview | MarketplacePublicStandardTermsPreview | null;
  comparison: SellListOfferTermsComparison | null;
  message: string | null;
}>;

type SellListOfferTermsComparisonField = "seller-net" | "marketplace-fee" | "shipping-allowance" | "terms-source";

type SellListOfferTermsComparison = Readonly<{
  status: "same" | "changed" | "standard-preview-unavailable" | "final-unavailable";
  standardPreview: MarketplacePublicStandardTermsPreview | null;
  changedFields: readonly SellListOfferTermsComparisonField[];
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

type AccountSellList = Readonly<{
  items: readonly CheckoutSellListLineRow[];
  count: number;
  latestConfirmation?: CheckoutSellListConfirmationRow | null;
}>;

type AccountSellListActorMode = "guest" | "account";

function checkoutApiErrorStatus(error: unknown) {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : null;
}

function checkoutApiErrorBody(error: unknown) {
  return typeof error === "object" && error !== null && "body" in error ? (error as { body: unknown }).body : null;
}

function checkoutApiErrorCode(error: unknown) {
  const body = checkoutApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return code === null || code === undefined ? null : String(code);
}

function freshnessOutcomeForHandoffState(state: PostWriteHandoffState) {
  switch (state.kind) {
    case "missing":
      return "missing-after-write";
    case "malformed":
      return "malformed-handoff";
    case "not-fresh-write":
      switch (state.freshWrite.kind) {
        case "expired":
          return "expired-after-write";
        case "future":
          return "future-after-write";
        default:
          return "missing-after-write";
      }
    case "valid":
      return "valid-after-write";
  }
}

function recordAccountSellListPostWriteConsistencyOutcome(
  actorMode: AccountSellListActorMode,
  outcome: PlatformPostWriteConsistencyOutcome,
  freshnessOutcome: string,
  recoveryAction: string,
  correctionSource: string,
) {
  recordPlatformPostWriteConsistencyEvent({
    boundedContextName: "checkout",
    surface: "account-sell-list",
    strategy: "fresh-read",
    outcome,
    routeId: "account-sell-list",
    routeTemplate: "/account/sell-list",
    correctionSource,
    actorMode,
    recoveryAction,
    freshnessOutcome,
  });
}

function recordPayoutReadinessPostWriteConsistencyOutcome(
  outcome: PlatformPostWriteConsistencyOutcome,
  freshnessOutcome: string,
  recoveryAction: string,
) {
  recordPlatformPostWriteConsistencyEvent({
    boundedContextName: "settlement",
    surface: "payout-readiness",
    strategy: "fresh-read",
    outcome,
    routeId: "account-sell-list",
    routeTemplate: "/account/sell-list",
    correctionSource: "settlement-payout-readiness",
    actorMode: "account",
    recoveryAction,
    freshnessOutcome,
    sourceContextName: "settlement",
    projectionName: "settlement-payout-readiness-projection",
    readModelTable: "settlement_payout_readiness_pages",
  });
}

function recordNotApplicableAccountSellListHandoffState(
  actorMode: AccountSellListActorMode,
  state: PostWriteHandoffState,
) {
  if (state.kind === "missing") {
    return;
  }

  const outcome =
    state.kind === "malformed"
      ? "handoff_malformed"
      : state.freshWrite.kind === "expired"
        ? "handoff_expired"
        : "handoff_invalid";
  recordAccountSellListPostWriteConsistencyOutcome(
    actorMode,
    outcome,
    freshnessOutcomeForHandoffState(state),
    "none",
    `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
  );
}

function isExpiredAccountSellListAddLineHandoff(
  state: PostWriteHandoffState,
): state is Extract<PostWriteHandoffState, { kind: "not-fresh-write" }> {
  return (
    state.kind === "not-fresh-write" &&
    state.freshWrite.kind === "expired" &&
    isAccountSellListAddLineHandoff(state.handoff)
  );
}

function isTransientSellListReadError(error: unknown) {
  const status = checkoutApiErrorStatus(error);
  const code = checkoutApiErrorCode(error);

  return (
    status === 404 ||
    (status === 503 && code === "projection_freshness_timeout") ||
    ((status === 502 || status === 503 || status === 504) && !code)
  );
}

function pendingSellListRecovery(
  actorMode: AccountSellListActorMode,
  state: PostWriteHandoffState,
  correctionSource: string,
  recoveryKind = postWriteRecoveryKindForHandoffState(state),
) {
  return {
    kind: "pending-fresh-write" as const,
    recoveryKind,
    message: t("checkout.routes.accountSellList.sell.list.pending.fresh.write"),
    actorMode,
    freshnessOutcome: freshnessOutcomeForHandoffState(state),
    correctionSource,
  };
}

function missingAddLineRecovery(actorMode: AccountSellListActorMode, state: PostWriteHandoffState) {
  return {
    kind: "missing-after-fresh-write" as const,
    recoveryKind: postWriteRecoveryKindForHandoffState(state),
    message: t("checkout.routes.accountSellList.sell.list.missing.after.fresh.write"),
    actorMode,
    freshnessOutcome: freshnessOutcomeForHandoffState(state),
    correctionSource: `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
  };
}

type PendingSellerConfirmation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "legacy" }>
  | Readonly<{ kind: "specific"; confirmationId: string }>;

function pendingSellerConfirmationFromUrl(requestUrl: URL): PendingSellerConfirmation {
  if (requestUrl.searchParams.get("confirmation") !== "preparing") {
    return { kind: "none" };
  }

  const confirmationId = requestUrl.searchParams.get("pendingConfirmationId")?.trim();
  return confirmationId ? { kind: "specific", confirmationId: confirmationId.slice(0, 200) } : { kind: "legacy" };
}

function freshWriteOutcomeForRequest(request: Request) {
  const state = readPostWriteHandoffState(request);
  switch (state.freshWrite.kind) {
    case "valid":
      return "valid-after-write";
    case "expired":
      return "expired-after-write";
    case "future":
      return "future-after-write";
    case "malformed":
      return "malformed-after-write";
    case "missing":
      return "missing-after-write";
  }
}

function requestHasFreshWriteSource(request: Request, sourceContextName: string) {
  const state = readPostWriteHandoffState(request);
  return (
    state.freshWrite.kind === "valid" &&
    state.freshWrite.receipt.sources.some((source) => source.sourceContextName === sourceContextName)
  );
}

function pendingSellerConfirmationRecovery(actorMode: AccountSellListActorMode, request: Request) {
  return {
    kind: "pending-fresh-write" as const,
    recoveryKind: "pending-projection" satisfies PostWriteRecoveryKind,
    message: t("checkout.routes.accountSellList.seller.confirmation.pending.fresh.write"),
    actorMode,
    freshnessOutcome: freshWriteOutcomeForRequest(request),
    correctionSource: "sell-checkout-confirmation",
  };
}

function pendingSellerConfirmationMatches(pendingConfirmation: PendingSellerConfirmation, sellList: AccountSellList) {
  return (
    pendingConfirmation.kind === "specific" &&
    sellList.latestConfirmation?.confirmation_id === pendingConfirmation.confirmationId
  );
}

function currentPathWithSearch(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function requestForPath(request: Request, path: string) {
  return new Request(new URL(path, request.url), request);
}

function sellerCheckoutReturnToFromSellListRequest(requestUrl: URL) {
  const params = new URLSearchParams({ registrationReturn: "seller-checkout" });
  for (const key of ["afterWrite", "postWriteHandoff"]) {
    const value = requestUrl.searchParams.get(key);
    if (value) {
      params.set(key, value);
    }
  }
  return `/account/sell-list?${params.toString()}`;
}

function requestWithMergeFreshness(request: Request, mergeResult: unknown, mergedLineCount: number) {
  if (mergedLineCount <= 0) {
    return request;
  }

  const currentPath = currentPathWithSearch(request);
  const freshPath = navigateAfterWrite(mergeResult, currentPath, { handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF });
  return freshPath === currentPath ? request : requestForPath(request, freshPath);
}

async function loadSellListWithPostWriteRecovery(
  request: Request,
  load: () => Promise<AccountSellList>,
  actorMode: AccountSellListActorMode,
) {
  try {
    const sellList = await loadFreshlyWrittenResource({
      request,
      load,
      isNotFound: (error) => checkoutApiErrorStatus(error) === 404,
    });
    const handoffDecisionAtMs = Date.now();
    const handoffState = readPostWriteHandoffState(request, handoffDecisionAtMs);
    const handoff = evaluatePostWriteHandoff({
      request,
      data: sellList,
      nowMs: handoffDecisionAtMs,
      isSatisfied: (candidate, postWriteHandoff) =>
        isAccountSellListAddLineHandoff(postWriteHandoff) &&
        !isPendingAccountSellListAddLineHandoff(candidate, postWriteHandoff),
    });

    if (handoff.kind === "pending" && isAccountSellListAddLineHandoff(handoff.handoff)) {
      recordAccountSellListPostWriteConsistencyOutcome(
        actorMode,
        "handoff_pending",
        freshnessOutcomeForHandoffState(handoffState),
        "pending_empty_state",
        `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
      );
      return {
        sellList,
        freshnessError: t("checkout.routes.accountSellList.sell.list.request.failed"),
        sellListRecovery: pendingSellListRecovery(
          actorMode,
          handoffState,
          `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
        ),
      };
    }

    if (
      handoff.kind === "not-applicable" &&
      isExpiredAccountSellListAddLineHandoff(handoff.state) &&
      isPendingAccountSellListAddLineHandoff(sellList, handoff.state.handoff)
    ) {
      recordAccountSellListPostWriteConsistencyOutcome(
        actorMode,
        "handoff_expired",
        freshnessOutcomeForHandoffState(handoffState),
        "action_required",
        `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
      );
      return {
        sellList,
        freshnessError: t("checkout.routes.accountSellList.sell.list.request.failed"),
        sellListRecovery: missingAddLineRecovery(actorMode, handoffState),
      };
    }

    if (handoff.kind === "not-applicable") {
      recordNotApplicableAccountSellListHandoffState(actorMode, handoff.state);
    } else if (!isAccountSellListAddLineHandoff(handoff.handoff)) {
      recordAccountSellListPostWriteConsistencyOutcome(
        actorMode,
        "handoff_invalid",
        "valid-after-write",
        "none",
        `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
      );
    } else {
      recordAccountSellListPostWriteConsistencyOutcome(
        actorMode,
        "handoff_satisfied",
        freshnessOutcomeForHandoffState(handoffState),
        "none",
        `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
      );
    }

    return { sellList, freshnessError: null, sellListRecovery: null };
  } catch (error) {
    const recovery = recoverFreshWriteReadError({
      request,
      error,
      getStatus: checkoutApiErrorStatus,
      getErrorCode: checkoutApiErrorCode,
      getBody: checkoutApiErrorBody,
      recoverTransient: (classification) => {
        recordAccountSellListPostWriteConsistencyOutcome(
          actorMode,
          classification.kind === "transient-projection-timeout" ? "freshness_timeout" : "fallback_used",
          freshWriteOutcomeForRequest(request),
          "reload_prompt",
          "fresh-read",
        );
        return {
          sellList: { items: [], count: 0, latestConfirmation: null },
          freshnessError: t("checkout.routes.accountSellList.sell.list.request.failed"),
          sellListRecovery: pendingSellListRecovery(
            actorMode,
            readPostWriteHandoffState(request),
            "fresh-read",
            postWriteRecoveryKindForFreshWriteReadError(classification),
          ),
        };
      },
    });
    if (recovery) {
      return recovery;
    }

    const handoffState = readPostWriteHandoffState(request);
    if (isExpiredAccountSellListAddLineHandoff(handoffState) && isTransientSellListReadError(error)) {
      recordAccountSellListPostWriteConsistencyOutcome(
        actorMode,
        "handoff_expired",
        freshnessOutcomeForHandoffState(handoffState),
        "action_required",
        `semantic-handoff:${ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND}`,
      );
      return {
        sellList: { items: [], count: 0, latestConfirmation: null },
        freshnessError: t("checkout.routes.accountSellList.sell.list.request.failed"),
        sellListRecovery: missingAddLineRecovery(actorMode, handoffState),
      };
    }

    throw error;
  }
}

function moneyValue(value: string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function moneyCents(value: string | null | undefined) {
  return Math.round(moneyValue(value) * 100);
}

function buyerTrustScore(offer: OfferMatchListItem) {
  const rating = Number(offer.buyer_average_rating ?? 0);
  const reviews = Number(offer.buyer_review_count ?? 0);
  return (Number.isFinite(rating) ? rating : 0) * 100 + Math.min(50, Number.isFinite(reviews) ? reviews : 0);
}

function compareRegisteredTermsWithStandard(
  finalTerms: MarketplaceListingTermsPreview,
  standardPreview: MarketplacePublicStandardTermsPreview | null,
): SellListOfferTermsComparison {
  if (!standardPreview) {
    return {
      status: "standard-preview-unavailable",
      standardPreview: null,
      changedFields: [],
    };
  }

  const changedFields: SellListOfferTermsComparisonField[] = [];
  if (moneyCents(finalTerms.seller_net_unit_amount) !== moneyCents(standardPreview.seller_net_unit_amount)) {
    changedFields.push("seller-net");
  }
  if (
    moneyCents(finalTerms.marketplace_sales_fee_unit_amount) !==
    moneyCents(standardPreview.marketplace_sales_fee_unit_amount)
  ) {
    changedFields.push("marketplace-fee");
  }
  if (finalTerms.shipping_allowance_percentage_bps !== standardPreview.shipping_allowance_percentage_bps) {
    changedFields.push("shipping-allowance");
  }
  if (finalTerms.account_type !== standardPreview.account_type || Boolean(finalTerms.agreement_id)) {
    changedFields.push("terms-source");
  }

  return {
    status: changedFields.length > 0 ? "changed" : "same",
    standardPreview,
    changedFields,
  };
}

function selectedOfferProductMatchesLine(offer: PublicOfferDetail, line: CheckoutSellListLineRow) {
  return (
    offer.catalog_catalog_item_id === line.catalog_catalog_item_id &&
    (!line.product_id || offer.product_id === line.product_id)
  );
}

function selectedOfferUnavailableMessage(offer: PublicOfferDetail | null | undefined, error: unknown) {
  if (offer === null) {
    return error instanceof Error ? error.message : "Offer not found.";
  }

  if (offer === undefined) {
    return error instanceof Error ? error.message : "Offer terms are unavailable.";
  }

  if (offer.status !== "submitted") {
    return offer.status === "accepted"
      ? "Offer has already been accepted."
      : `Offer is no longer submitted (${offer.status}).`;
  }

  const message = error instanceof Error ? error.message : "";
  if (message === "Offer not found.") {
    return "Create a matching listing before accepting this offer.";
  }

  return message || "Offer terms are unavailable.";
}

async function loadSellListOfferReviews(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
  options: Readonly<{ includeStandardComparison?: boolean }> = {},
): Promise<readonly SellListOfferReview[]> {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const previewPublicStandardListingTerms = marketplaceApi.previewPublicStandardListingTerms?.bind(marketplaceApi);
  const getPublicOffer = marketplaceApi.getPublicOffer?.bind(marketplaceApi);
  const selectedOfferLines = lines.filter((line) => line.line_type === "selected-offer" && line.offer_id);
  const includeStandardComparison =
    options.includeStandardComparison && typeof previewPublicStandardListingTerms === "function";
  const previewByPrice = new Map<string, Promise<MarketplacePublicStandardTermsPreview | null>>();
  const previewForPrice = (priceAmount: string | null | undefined) => {
    if (!includeStandardComparison || !priceAmount || typeof previewPublicStandardListingTerms !== "function") {
      return Promise.resolve(null);
    }
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
      const standardPreviewPromise = previewForPrice(line.offer_price_amount);
      const publicOfferPromise =
        typeof getPublicOffer === "function"
          ? getPublicOffer(line.offer_id!).catch(() => null)
          : Promise.resolve(undefined);
      try {
        const publicOffer = await publicOfferPromise;
        if (publicOffer === null) {
          throw new Error("Offer not found.");
        }
        if (publicOffer && !selectedOfferProductMatchesLine(publicOffer, line)) {
          throw new Error("Selected offer no longer matches this Sell List line.");
        }
        if (publicOffer && publicOffer.status !== "submitted") {
          throw new Error("Offer is no longer submitted.");
        }

        const [terms, standardPreview] = await Promise.all([
          marketplaceApi.previewOfferAcceptanceTerms(line.offer_id!),
          standardPreviewPromise,
        ]);
        return {
          lineId: line.line_id,
          status: "ready" as const,
          terms,
          comparison: options.includeStandardComparison
            ? compareRegisteredTermsWithStandard(terms, standardPreview)
            : null,
          message: null,
        };
      } catch (error) {
        const [standardPreview, publicOffer] = await Promise.all([standardPreviewPromise, publicOfferPromise]);
        return {
          lineId: line.line_id,
          status: "unavailable" as const,
          terms: null,
          comparison: options.includeStandardComparison
            ? { status: "final-unavailable" as const, standardPreview, changedFields: [] }
            : null,
          message: selectedOfferUnavailableMessage(publicOffer, error),
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
        comparison: null,
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
  const shouldRecordPayoutReadinessHandoff = requestHasFreshWriteSource(request, "settlement");
  try {
    const payoutReadiness = await createSettlementRequestApiClient(request).getPayoutReadiness();
    if (shouldRecordPayoutReadinessHandoff) {
      recordPayoutReadinessPostWriteConsistencyOutcome("projection_hit", freshWriteOutcomeForRequest(request), "none");
    }
    return payoutReadiness;
  } catch {
    if (shouldRecordPayoutReadinessHandoff) {
      recordPayoutReadinessPostWriteConsistencyOutcome(
        "freshness_timeout",
        freshWriteOutcomeForRequest(request),
        "reload_prompt",
      );
    }
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const api = createCheckoutRequestApiClient(request);
  const anonymousSellListId = readAnonymousSellListId(request);
  const requestUrl = new URL(request.url);
  const registrationReturn: "seller-checkout" | null =
    requestUrl.searchParams.get("registrationReturn") === "seller-checkout" ? "seller-checkout" : null;
  const sellerCheckoutReturnTo = sellerCheckoutReturnToFromSellListRequest(requestUrl);

  if (!canUseAccountSellList(actor)) {
    const { sellList, freshnessError, sellListRecovery } = await loadSellListWithPostWriteRecovery(
      request,
      () => api.getGuestSellList(anonymousSellListId),
      "guest",
    );

    return {
      isSignedIn: false,
      registrationReturn: null,
      mergedLineCount: 0,
      mergeError: null,
      sellerCheckoutRegisterHref: sellerCheckoutRegisterHref(sellerCheckoutReturnTo),
      sellerCheckoutSignInHref: sellerCheckoutSignInHref(sellerCheckoutReturnTo),
      freshnessError,
      sellListRecovery,
      sellList,
      offerReviews: await loadGuestSellListOfferReviews(request, sellList.items),
    };
  }

  let mergedLineCount = 0;
  let mergeError: string | null = null;
  let accountSellListRequest = request;
  let accountSellListApi = api;
  if (anonymousSellListId) {
    try {
      const guestSource = await loadSellListWithPostWriteRecovery(
        request,
        () => api.getGuestSellList(anonymousSellListId),
        "account",
      );
      if (guestSource.sellListRecovery) {
        return {
          isSignedIn: true,
          registrationReturn,
          mergedLineCount,
          mergeError,
          sellerCheckoutRegisterHref: sellerCheckoutRegisterHref(sellerCheckoutReturnTo),
          sellerCheckoutSignInHref: sellerCheckoutSignInHref(sellerCheckoutReturnTo),
          freshnessError: guestSource.freshnessError,
          sellListRecovery: guestSource.sellListRecovery,
          sellList: guestSource.sellList,
          offerReviews: await loadSellListOfferReviews(request, guestSource.sellList.items, {
            includeStandardComparison: registrationReturn === "seller-checkout",
          }),
          productOfferReviews: await loadSellListProductOfferReviews(request, guestSource.sellList.items),
          inventoryItems: await loadSellListInventory(request, guestSource.sellList.items),
          payoutReadiness: await loadPayoutReadiness(request),
        };
      }

      const mergeResult = await api.mergeGuestSellListToAccount(anonymousSellListId);
      const count = Number((mergeResult as { mergedLineCount?: unknown }).mergedLineCount ?? 0);
      mergedLineCount = Number.isFinite(count) ? count : 0;
      accountSellListRequest = requestWithMergeFreshness(request, mergeResult, mergedLineCount);
      if (accountSellListRequest !== request) {
        accountSellListApi = createCheckoutRequestApiClient(accountSellListRequest);
      }
    } catch {
      mergeError = t("checkout.routes.accountSellList.sell.list.request.failed");
    }
  }

  const { sellList, freshnessError, sellListRecovery } = await loadSellListWithPostWriteRecovery(
    accountSellListRequest,
    () => accountSellListApi.getSellList(),
    "account",
  );
  const pendingConfirmation = pendingSellerConfirmationFromUrl(new URL(accountSellListRequest.url));
  const confirmationStillPreparing =
    pendingConfirmation.kind !== "none" && !pendingSellerConfirmationMatches(pendingConfirmation, sellList);
  const accountSellList = confirmationStillPreparing ? { ...sellList, latestConfirmation: null } : sellList;
  const effectiveSellListRecovery =
    confirmationStillPreparing && !sellListRecovery
      ? pendingSellerConfirmationRecovery("account", accountSellListRequest)
      : sellListRecovery;
  if (confirmationStillPreparing && !sellListRecovery) {
    recordAccountSellListPostWriteConsistencyOutcome(
      "account",
      "handoff_pending",
      freshWriteOutcomeForRequest(accountSellListRequest),
      "pending_empty_state",
      "sell-checkout-confirmation",
    );
  }

  return {
    isSignedIn: true,
    registrationReturn,
    mergedLineCount,
    mergeError,
    sellerCheckoutRegisterHref: sellerCheckoutRegisterHref(sellerCheckoutReturnTo),
    sellerCheckoutSignInHref: sellerCheckoutSignInHref(sellerCheckoutReturnTo),
    freshnessError,
    sellListRecovery: effectiveSellListRecovery,
    sellList: accountSellList,
    offerReviews: await loadSellListOfferReviews(request, accountSellList.items, {
      includeStandardComparison: registrationReturn === "seller-checkout",
    }),
    productOfferReviews: await loadSellListProductOfferReviews(request, accountSellList.items),
    inventoryItems: await loadSellListInventory(request, accountSellList.items),
    payoutReadiness: await loadPayoutReadiness(request),
  };
}

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function limitedFormValue(formData: FormData, name: string, maxLength: number) {
  const value = formValue(formData, name);
  return value ? value.slice(0, maxLength) : "";
}

function parsePostedSelectedOptions(formData: FormData) {
  try {
    const parsed = JSON.parse(formValue(formData, "selectedOptions"));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((selection) => ({
        dimensionId: String(selection?.dimensionId ?? "")
          .trim()
          .slice(0, 80),
        optionId: String(selection?.optionId ?? "")
          .trim()
          .slice(0, 80),
      }))
      .filter((selection) => selection.dimensionId && selection.optionId);
  } catch {
    return [];
  }
}

function parsePostedQuantity(formData: FormData) {
  const quantity = Number(formValue(formData, "quantity"));
  return Number.isInteger(quantity) && quantity > 0 ? Math.min(quantity, 999) : 1;
}

function selectedOfferLineFromOffer(offer: OfferMatchListItem): AddCheckoutSellListLineRequest {
  return {
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
  };
}

function selectedOfferLineFromPostedSnapshot(formData: FormData): AddCheckoutSellListLineRequest {
  const offerId = limitedFormValue(formData, "offerId", 160);
  const catalogItemId = limitedFormValue(formData, "catalogItemId", 160);
  const productId = limitedFormValue(formData, "productId", 240);
  const itemTitle = limitedFormValue(formData, "itemTitle", 240);
  const offerPriceAmount = limitedFormValue(formData, "offerPriceAmount", 40);

  if (!offerId || !catalogItemId || !productId || !itemTitle || !offerPriceAmount) {
    throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
  }

  return {
    lineType: "selected-offer",
    offerId,
    buyerAccountId: null,
    buyerDisplayName: limitedFormValue(formData, "buyerDisplayName", 160) || null,
    offerPriceAmount,
    catalogItemId,
    productId,
    itemTitle,
    itemSubtitle: limitedFormValue(formData, "itemSubtitle", 240) || null,
    selectedOptions: parsePostedSelectedOptions(formData),
    productSummary: limitedFormValue(formData, "productSummary", 320) || null,
    quantity: parsePostedQuantity(formData),
    fallbackMode: "none",
    minimumListingPriceAmount: null,
  };
}

type SellListReviewPlan = Readonly<{
  version: 1;
  lines: readonly SellListReviewPlanLine[];
}>;

type SellListReviewPlanLine = Readonly<{
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

async function buildSellListReviewPlan(
  request: Request,
  lines: readonly CheckoutSellListLineRow[],
  formData: FormData,
): Promise<SellListReviewPlan> {
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const reviewLines: SellListReviewPlanLine[] = [];

  for (const line of lines) {
    if (line.line_type === "selected-offer") {
      const skippedReasons: string[] = [];
      const feeQuoteFingerprint = formValue(formData, `offerFeeQuoteFingerprint:${line.line_id}`);
      let selectedOffer: SellListReviewPlanLine["selectedOffer"] = null;

      if (!line.offer_id) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.selected.offer.missing.detail", { itemTitle: line.item_title }),
        );
      } else if (!feeQuoteFingerprint) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle: line.item_title }),
        );
      } else {
        try {
          const currentTerms = await marketplaceApi.previewOfferAcceptanceTerms(line.offer_id);
          if (currentTerms.fee_quote_fingerprint === feeQuoteFingerprint) {
            selectedOffer = { offerId: line.offer_id, feeQuoteFingerprint };
          } else {
            skippedReasons.push(
              t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle: line.item_title }),
            );
          }
        } catch (error) {
          skippedReasons.push(
            t("checkout.routes.accountSellList.offer.accept.failed.detail", {
              itemTitle: line.item_title,
              message:
                error instanceof Error ? error.message : t("checkout.routes.accountSellList.offer.accept.failed"),
            }),
          );
        }
      }

      reviewLines.push({
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
    let fallbackListing: SellListReviewPlanLine["fallbackListing"] = null;
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

    reviewLines.push({
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

  return { version: 1, lines: reviewLines };
}

function readinessDecisionsFromReviewPlan(plan: SellListReviewPlan): SellListReadinessDecisionInput {
  const lineActions: Array<NonNullable<SellListReadinessDecisionInput["lineActions"]>[number]> = [];
  const lineOutcomes: Array<NonNullable<SellListReadinessDecisionInput["lineOutcomes"]>[number]> = [];

  for (const line of plan.lines) {
    if (line.skippedReasons.length > 0) {
      lineOutcomes.push({ lineId: line.lineId, outcome: "keep-in-list" });
      continue;
    }

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

function encodeReadinessDecisions(decisions: SellListReadinessDecisionInput) {
  return JSON.stringify({
    lineActions: decisions.lineActions ?? [],
    lineOutcomes: decisions.lineOutcomes ?? [],
  });
}

function encodeSellListReviewPlan(plan: SellListReviewPlan) {
  return JSON.stringify(plan);
}

function sellCheckoutRedirectUrl(
  readiness: Readonly<{ readiness: Readonly<{ snapshotId: string; sourceRevision: string }> }>,
  decisions: SellListReadinessDecisionInput,
  reviewPlan: SellListReviewPlan,
) {
  const query = new URLSearchParams({
    readinessSnapshotId: readiness.readiness.snapshotId,
    readinessSourceRevision: readiness.readiness.sourceRevision,
    readinessDecisions: encodeReadinessDecisions(decisions),
    sellListReviewPlan: encodeSellListReviewPlan(reviewPlan),
  });
  return `/checkout/sell/session/${createId("chk")}?${query.toString()}`;
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
        const anonymousOwnerId = ensureAnonymousSellListId(request);
        const result = await api.addGuestSellListLine(anonymousOwnerId, selectedOfferLineFromPostedSnapshot(formData));
        const response = redirect(
          navigateAfterWrite(result, "/account/sell-list", { handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF }),
        );
        appendAnonymousSellListCookie(response.headers, anonymousOwnerId, request);
        return response;
      }

      const offerId = String(formData.get("offerId") ?? "");
      const offer = await marketplaceApi.getOfferMatch(offerId);

      const result = await api.addSellListLine(selectedOfferLineFromOffer(offer));

      return redirect(
        navigateAfterWrite(result, "/account/sell-list", { handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF }),
      );
    }

    if (intent === "remove-sell-list-line") {
      if (!useAccountSellList && anonymousSellListId) {
        return redirect(
          navigateAfterWrite(
            await api.removeGuestSellListLine(anonymousSellListId, String(formData.get("lineId") ?? "")),
            "/account/sell-list",
          ),
        );
      }

      if (!useAccountSellList) {
        throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
      }

      return redirect(
        navigateAfterWrite(await api.removeSellListLine(String(formData.get("lineId") ?? "")), "/account/sell-list"),
      );
    }

    if (intent === "review-sell-list-checkout") {
      if (!useAccountSellList) {
        if (!anonymousSellListId) {
          return redirect(SELLER_CHECKOUT_SIGN_IN_HREF);
        }

        await api.getGuestSellList(anonymousSellListId);
        const readiness = await api.createGuestSellListReadiness(anonymousSellListId);
        if (readiness.readiness.status !== "ready" || readiness.readiness.unresolvedLineIds.length > 0) {
          throw new Error(t("checkout.routes.accountSellList.sell.list.readiness.must.be.resolved"));
        }

        return redirect(SELLER_CHECKOUT_REGISTER_HREF);
      }

      const sellList = await api.getSellList();
      const reviewPlan = await buildSellListReviewPlan(request, sellList.items, formData);
      const readinessDecisions = readinessDecisionsFromReviewPlan(reviewPlan);
      const readiness = await api.createSellListReadiness(readinessDecisions);
      if (readiness.readiness.status !== "ready" || readiness.readiness.unresolvedLineIds.length > 0) {
        throw new Error("Sell List readiness must be resolved before seller checkout starts.");
      }

      return redirect(
        navigateAfterWrite(readiness, sellCheckoutRedirectUrl(readiness, readinessDecisions, reviewPlan)),
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
  const sellListRecovery = "sellListRecovery" in data ? data.sellListRecovery : null;
  const { currentPath, isAutoRevalidating } = usePendingFreshWriteRevalidation(
    sellListRecovery?.kind === "pending-fresh-write",
  );

  return (
    <CheckoutSellListPage
      sellListLines={data.sellList.items}
      isSignedIn={data.isSignedIn}
      offerReviews={"offerReviews" in data ? data.offerReviews : []}
      productOfferReviews={"productOfferReviews" in data ? data.productOfferReviews : []}
      inventoryItems={"inventoryItems" in data ? data.inventoryItems : []}
      payoutReadiness={"payoutReadiness" in data ? data.payoutReadiness : null}
      latestConfirmation={"latestConfirmation" in data.sellList ? (data.sellList.latestConfirmation ?? null) : null}
      registrationReturn={data.registrationReturn}
      mergedLineCount={data.mergedLineCount}
      mergeError={data.mergeError}
      sellerCheckoutRegisterHref={data.sellerCheckoutRegisterHref}
      sellerCheckoutSignInHref={data.sellerCheckoutSignInHref}
      errorMessage={actionData?.error ?? ("freshnessError" in data && !sellListRecovery ? data.freshnessError : null)}
      recoveryMessage={sellListRecovery?.message ?? null}
      recoveryState={
        sellListRecovery
          ? sellListRecovery.kind === "pending-fresh-write"
            ? {
                kind: sellListRecovery.kind,
                message: sellListRecovery.message,
                refreshHref: currentPath,
                isAutoRevalidating,
              }
            : {
                kind: sellListRecovery.kind,
                message: sellListRecovery.message,
                refreshHref: "/account/sell-list",
              }
          : null
      }
    />
  );
}
