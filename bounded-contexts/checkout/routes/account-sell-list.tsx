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
import {
  navigateAfterWriteWithPlatformPostWriteToken,
  resolvePlatformPostWriteRequest,
} from "@chase-sets/platform-runtime/post-write-tokens";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  recordPlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyOutcome,
} from "@chase-sets/platform-runtime/post-write-consistency";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  createCheckoutRequestApiClient,
  type AddCheckoutSellListLineRequest,
  type CheckoutSellListConfirmationRow,
  type CheckoutSellListCompositeReview,
  type CheckoutSellListLineRow,
  type CheckoutSellOfferMatch,
  type CheckoutSellPayoutReadinessRow,
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
  terms: CheckoutSellListCompositeReview["offerReviews"][number]["terms"];
  comparison: SellListOfferTermsComparison | null;
  message: string | null;
}>;

type SellListOfferTermsComparisonField = "seller-net" | "marketplace-fee" | "shipping-allowance" | "terms-source";

type SellListOfferTermsComparison = Readonly<{
  status: "same" | "changed" | "standard-preview-unavailable" | "final-unavailable";
  standardPreview: NonNullable<
    CheckoutSellListCompositeReview["offerReviews"][number]["comparison"]
  >["standardPreview"];
  changedFields: readonly SellListOfferTermsComparisonField[];
}>;

type SellListProductOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  offers: CheckoutSellListCompositeReview["productOfferReviews"][number]["offers"];
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
  for (const key of ["postWriteToken", "afterWrite", "postWriteHandoff"]) {
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

async function loadPayoutReadiness(
  request: Request,
  api: ReturnType<typeof createCheckoutRequestApiClient>,
): Promise<CheckoutSellPayoutReadinessRow | null> {
  const shouldRecordPayoutReadinessHandoff = requestHasFreshWriteSource(request, "settlement");
  try {
    const payoutReadiness = await api.getSellListPayoutReadiness();
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

async function loadSellListCompositeReviewFromCheckout(
  api: ReturnType<typeof createCheckoutRequestApiClient>,
  options: Readonly<{ includeStandardComparison?: boolean }> = {},
): Promise<CheckoutSellListCompositeReview> {
  const client = api as Partial<ReturnType<typeof createCheckoutRequestApiClient>>;
  if (typeof client.getSellListCompositeReview !== "function") {
    return { offerReviews: [], productOfferReviews: [], inventoryItems: [] };
  }

  return client.getSellListCompositeReview(options);
}

async function loadGuestSellListOfferReviewsFromCheckout(
  api: ReturnType<typeof createCheckoutRequestApiClient>,
  anonymousSellListId: string | null,
): Promise<readonly SellListOfferReview[]> {
  const client = api as Partial<ReturnType<typeof createCheckoutRequestApiClient>>;
  if (typeof client.getGuestSellListOfferReviews !== "function") {
    return [];
  }

  return (await client.getGuestSellListOfferReviews(anonymousSellListId)).offerReviews;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const browserRequestUrl = new URL(request.url);
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  const actor = await resolveActorFromAuthApi({ request: resolvedRequest });
  const api = createCheckoutRequestApiClient(resolvedRequest);
  const anonymousSellListId = readAnonymousSellListId(resolvedRequest);
  const requestUrl = new URL(resolvedRequest.url);
  const registrationReturn: "seller-checkout" | null =
    requestUrl.searchParams.get("registrationReturn") === "seller-checkout" ? "seller-checkout" : null;
  const sellerCheckoutReturnTo = sellerCheckoutReturnToFromSellListRequest(browserRequestUrl);

  if (!canUseAccountSellList(actor)) {
    const { sellList, freshnessError, sellListRecovery } = await loadSellListWithPostWriteRecovery(
      resolvedRequest,
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
      offerReviews: await loadGuestSellListOfferReviewsFromCheckout(api, anonymousSellListId),
    };
  }

  let mergedLineCount = 0;
  let mergeError: string | null = null;
  let accountSellListRequest = resolvedRequest;
  let accountSellListApi = api;
  if (anonymousSellListId) {
    try {
      const guestSource = await loadSellListWithPostWriteRecovery(
        resolvedRequest,
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
          offerReviews: await loadGuestSellListOfferReviewsFromCheckout(api, anonymousSellListId),
          productOfferReviews: [],
          inventoryItems: [],
          payoutReadiness: await loadPayoutReadiness(resolvedRequest, api),
        };
      }

      const mergeResult = await api.mergeGuestSellListToAccount(anonymousSellListId);
      const count = Number((mergeResult as { mergedLineCount?: unknown }).mergedLineCount ?? 0);
      mergedLineCount = Number.isFinite(count) ? count : 0;
      accountSellListRequest = requestWithMergeFreshness(resolvedRequest, mergeResult, mergedLineCount);
      if (accountSellListRequest !== resolvedRequest) {
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
  const sellListCompositeReview = await loadSellListCompositeReviewFromCheckout(accountSellListApi, {
    includeStandardComparison: registrationReturn === "seller-checkout",
  });

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
    offerReviews: sellListCompositeReview.offerReviews,
    productOfferReviews: sellListCompositeReview.productOfferReviews,
    inventoryItems: sellListCompositeReview.inventoryItems,
    payoutReadiness: await loadPayoutReadiness(resolvedRequest, accountSellListApi),
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

function selectedOfferLineFromOffer(offer: CheckoutSellOfferMatch): AddCheckoutSellListLineRequest {
  return {
    lineType: "selected-offer",
    offerId: offer.offer_id,
    listingId: offer.listing_id,
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
  const listingId = limitedFormValue(formData, "listingId", 160);
  const catalogItemId = limitedFormValue(formData, "catalogItemId", 160);
  const productId = limitedFormValue(formData, "productId", 240);
  const itemTitle = limitedFormValue(formData, "itemTitle", 240);
  const offerPriceAmount = limitedFormValue(formData, "offerPriceAmount", 40);

  if (!offerId || !listingId || !catalogItemId || !productId || !itemTitle || !offerPriceAmount) {
    throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
  }

  return {
    lineType: "selected-offer",
    offerId,
    listingId,
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
  selectedOffer: Readonly<{ offerId: string; listingId: string; feeQuoteFingerprint: string }> | null;
  productOfferTargets: readonly Readonly<{
    offerId: string;
    listingId: string;
    feeQuoteFingerprint: string;
    quantity: number;
  }>[];
  fallbackListing: Readonly<{ inventoryItemId: string; priceAmount: string; quantityCap: number }> | null;
  skippedReasons: readonly string[];
}>;

async function buildSellListReviewPlan(
  api: ReturnType<typeof createCheckoutRequestApiClient>,
  lines: readonly CheckoutSellListLineRow[],
  formData: FormData,
): Promise<SellListReviewPlan> {
  const reviewLines: SellListReviewPlanLine[] = [];

  for (const line of lines) {
    if (line.line_type === "selected-offer") {
      const skippedReasons: string[] = [];
      const feeQuoteFingerprint = formValue(formData, `offerFeeQuoteFingerprint:${line.line_id}`);
      let selectedOffer: SellListReviewPlanLine["selectedOffer"] = null;

      if (!line.offer_id || !line.listing_id) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.selected.offer.missing.detail", { itemTitle: line.item_title }),
        );
      } else if (!feeQuoteFingerprint) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle: line.item_title }),
        );
      } else {
        selectedOffer = { offerId: line.offer_id, listingId: line.listing_id, feeQuoteFingerprint };
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
    const productOfferTargets: Array<{
      offerId: string;
      listingId: string;
      feeQuoteFingerprint: string;
      quantity: number;
    }> = [];
    let plannedRemainingQuantity = line.quantity;

    for (const offerId of formData
      .getAll(`productOfferId:${line.line_id}`)
      .map((value) => String(value).trim())
      .filter(Boolean)) {
      try {
        const offer = await api.getSellListOfferMatch(offerId);
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
        productOfferTargets.push({
          offerId,
          listingId: offer.listing_id,
          feeQuoteFingerprint,
          quantity: offer.quantity_requested,
        });
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
  const actor = await resolveActorFromAuthApi({ request });
  const useAccountSellList = canUseAccountSellList(actor);
  const anonymousSellListId = readAnonymousSellListId(request);

  try {
    if (intent === "add-selected-offer") {
      if (!useAccountSellList) {
        const anonymousOwnerId = ensureAnonymousSellListId(request);
        const result = await api.addGuestSellListLine(anonymousOwnerId, selectedOfferLineFromPostedSnapshot(formData));
        const response = redirect(
          await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
            handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
          }),
        );
        appendAnonymousSellListCookie(response.headers, anonymousOwnerId, request);
        return response;
      }

      const offerId = String(formData.get("offerId") ?? "");
      const offer = await api.getSellListOfferMatch(offerId);

      const result = await api.addSellListLine(selectedOfferLineFromOffer(offer));

      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
          handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        }),
      );
    }

    if (intent === "remove-sell-list-line") {
      if (!useAccountSellList && anonymousSellListId) {
        return redirect(
          await navigateAfterWriteWithPlatformPostWriteToken(
            await api.removeGuestSellListLine(anonymousSellListId, String(formData.get("lineId") ?? "")),
            "/account/sell-list",
          ),
        );
      }

      if (!useAccountSellList) {
        throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
      }

      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(
          await api.removeSellListLine(String(formData.get("lineId") ?? "")),
          "/account/sell-list",
        ),
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
      const reviewPlan = await buildSellListReviewPlan(api, sellList.items, formData);
      const readinessDecisions = readinessDecisionsFromReviewPlan(reviewPlan);
      const readiness = await api.createSellListReadiness(readinessDecisions);
      if (readiness.readiness.status !== "ready" || readiness.readiness.unresolvedLineIds.length > 0) {
        throw new Error("Sell List readiness must be resolved before seller checkout starts.");
      }

      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(
          readiness,
          sellCheckoutRedirectUrl(readiness, readinessDecisions, reviewPlan),
        ),
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
