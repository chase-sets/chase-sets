import type { SellListReviewSelections } from "../features/sell-list/api/review-plan-contracts";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, redirect, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import { createHash } from "node:crypto";
import { submitCheckoutSellListAdd } from "../features/command-attempts/api/sell-list-submission";
import {
  submitCheckoutCartAttempt,
  checkoutCartAttemptCommitSource,
} from "../features/command-attempts/api/attempt-submission";
import { isCheckoutCommandAttemptId, mintCheckoutCommandAttemptId } from "../features/command-attempts/api/contracts";
import {
  SellListAttemptBoundary,
  type SellListAttemptState,
} from "../features/sell-list/ui/sell-list-attempt-boundary";
import {
  evaluatePostWriteHandoff,
  loadFreshlyWrittenResource,
  postWriteRecoveryKindForFreshWriteReadError,
  postWriteRecoveryKindForHandoffState,
  readPostWriteHandoffState,
  readFreshWriteTokenState,
  recoverFreshWriteReadError,
  type PostWriteRecoveryKind,
  type PostWriteHandoffState,
} from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { defineFormAction, navigateAfterWrite, type FormActionContext } from "@chase-sets/platform-runtime/http";
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
import {
  usePendingFreshWriteRevalidation,
  type PendingFreshWriteTiming,
} from "../support/route-support/pending-fresh-write-revalidation";

function canUseAccountSellList(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

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
    const recovery = recoverSellListFreshWriteReadError(request, error, actorMode, "fresh-read");
    if (recovery) {
      return { sellList: { items: [], count: 0, latestConfirmation: null }, ...recovery };
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

function recoverSellListFreshWriteReadError(
  request: Request,
  error: unknown,
  actorMode: AccountSellListActorMode,
  correctionSource: string,
) {
  return recoverFreshWriteReadError({
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
        correctionSource,
      );
      return {
        freshnessError: t("checkout.routes.accountSellList.sell.list.request.failed"),
        sellListRecovery: pendingSellListRecovery(
          actorMode,
          readPostWriteHandoffState(request),
          correctionSource,
          postWriteRecoveryKindForFreshWriteReadError(classification),
        ),
      };
    },
  });
}

async function loadGuestSellListCompositeReviewWithRecovery(
  api: ReturnType<typeof createCheckoutRequestApiClient>,
  anonymousSellListId: string | null,
  request: Request,
  actorMode: AccountSellListActorMode,
) {
  try {
    return { compositeReview: await api.getGuestSellListCompositeReview(anonymousSellListId), recovery: null };
  } catch (error) {
    const recovery = recoverSellListFreshWriteReadError(request, error, actorMode, "guest-sell-list-offer-reviews");
    if (!recovery) throw error;
    return { compositeReview: null, recovery };
  }
}

function pendingFreshWriteTimingForRequest(request: Request): PendingFreshWriteTiming | null {
  const freshWriteState = readFreshWriteTokenState(request);
  return freshWriteState.kind === "valid"
    ? { observedAtMs: freshWriteState.receipt.observedAtMs, expiresAtMs: freshWriteState.expiresAtMs }
    : null;
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

    const guestCompositeReview = await loadGuestSellListCompositeReviewWithRecovery(
      api,
      anonymousSellListId,
      resolvedRequest,
      "guest",
    );
    return {
      isSignedIn: false,
      registrationReturn: null,
      mergedLineCount: 0,
      mergeError: null,
      sellerCheckoutRegisterHref: sellerCheckoutRegisterHref(sellerCheckoutReturnTo),
      sellerCheckoutSignInHref: sellerCheckoutSignInHref(sellerCheckoutReturnTo),
      freshnessError: freshnessError ?? guestCompositeReview.recovery?.freshnessError ?? null,
      sellListRecovery: sellListRecovery ?? guestCompositeReview.recovery?.sellListRecovery ?? null,
      pendingFreshWriteTiming: pendingFreshWriteTimingForRequest(resolvedRequest),
      sellList,
      compositeReview: guestCompositeReview.compositeReview,
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
        const guestCompositeReview = await loadGuestSellListCompositeReviewWithRecovery(
          api,
          anonymousSellListId,
          resolvedRequest,
          "account",
        );
        return {
          isSignedIn: true,
          registrationReturn,
          mergedLineCount,
          mergeError,
          sellerCheckoutRegisterHref: sellerCheckoutRegisterHref(sellerCheckoutReturnTo),
          sellerCheckoutSignInHref: sellerCheckoutSignInHref(sellerCheckoutReturnTo),
          freshnessError: guestSource.freshnessError ?? guestCompositeReview.recovery?.freshnessError ?? null,
          sellListRecovery: guestSource.sellListRecovery ?? guestCompositeReview.recovery?.sellListRecovery ?? null,
          pendingFreshWriteTiming: pendingFreshWriteTimingForRequest(resolvedRequest),
          sellList: guestSource.sellList,
          compositeReview: guestCompositeReview.compositeReview,
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
  let sellListCompositeReview: CheckoutSellListCompositeReview | null;
  let compositeReviewRecovery: ReturnType<typeof recoverSellListFreshWriteReadError> = null;
  try {
    sellListCompositeReview = await accountSellListApi.getSellListCompositeReview({
      includeStandardComparison: registrationReturn === "seller-checkout",
      sellListPath: browserRequestUrl.pathname,
    });
  } catch (error) {
    compositeReviewRecovery = recoverSellListFreshWriteReadError(
      accountSellListRequest,
      error,
      "account",
      "sell-list-composite-review",
    );
    if (!compositeReviewRecovery) throw error;
    sellListCompositeReview = null;
  }
  if (requestHasFreshWriteSource(resolvedRequest, "settlement")) {
    const available = Boolean(sellListCompositeReview?.screen?.payoutReadiness);
    recordPayoutReadinessPostWriteConsistencyOutcome(
      available ? "projection_hit" : "freshness_timeout",
      freshWriteOutcomeForRequest(resolvedRequest),
      available ? "none" : "reload_prompt",
    );
  }
  return {
    isSignedIn: true,
    registrationReturn,
    mergedLineCount,
    mergeError,
    sellerCheckoutRegisterHref: sellerCheckoutRegisterHref(sellerCheckoutReturnTo),
    sellerCheckoutSignInHref: sellerCheckoutSignInHref(sellerCheckoutReturnTo),
    freshnessError: freshnessError ?? compositeReviewRecovery?.freshnessError ?? null,
    sellListRecovery: effectiveSellListRecovery ?? compositeReviewRecovery?.sellListRecovery ?? null,
    pendingFreshWriteTiming: pendingFreshWriteTimingForRequest(accountSellListRequest),
    sellList: accountSellList,
    compositeReview: effectiveSellListRecovery ? null : sellListCompositeReview,
  };
}

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function evidenceClassificationFromForm(formData: FormData) {
  const [slotId, viewKind] = formValue(formData, "classification").split("::", 2);
  if (!slotId || !viewKind) {
    throw new Error(t("checkout.features.sellList.ui.sellListPage.evidence.choose.slot"));
  }
  return { slotId, viewKind };
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

function selectedOfferLineFromOffer(offer: CheckoutSellOfferMatch): Omit<AddCheckoutSellListLineRequest, "attemptId"> {
  return {
    lineType: "selected-offer",
    offerId: offer.offer_id,
    listingId: offer.listing_id,
    buyerAccountId: offer.buyer_account_id,
    buyerDisplayName: offer.buyer_display_name,
    offerPriceAmount: offer.price_amount,
    offerPriceCurrencyCode: offer.price_currency_code,
    offerStreamVersion: offer.offer_stream_version,
    listingPriceAmount: offer.listing_price_amount,
    listingPriceCurrencyCode: offer.listing_price_currency_code,
    listingStreamVersion: offer.listing_stream_version,
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

function selectedOfferLineFromPostedSnapshot(formData: FormData): Omit<AddCheckoutSellListLineRequest, "attemptId"> {
  const offerId = limitedFormValue(formData, "offerId", 160);
  const listingId = limitedFormValue(formData, "listingId", 160);
  const catalogItemId = limitedFormValue(formData, "catalogItemId", 160);
  const productId = limitedFormValue(formData, "productId", 240);
  const itemTitle = limitedFormValue(formData, "itemTitle", 240);
  const offerPriceAmount = limitedFormValue(formData, "offerPriceAmount", 40);
  const offerPriceCurrencyCode = limitedFormValue(formData, "offerPriceCurrencyCode", 3).toUpperCase();
  const offerStreamVersion = Number(limitedFormValue(formData, "offerStreamVersion", 20));
  const listingPriceAmount = limitedFormValue(formData, "listingPriceAmount", 40);
  const listingPriceCurrencyCode = limitedFormValue(formData, "listingPriceCurrencyCode", 3).toUpperCase();
  const listingStreamVersion = Number(limitedFormValue(formData, "listingStreamVersion", 20));

  if (
    !offerId ||
    !listingId ||
    !catalogItemId ||
    !productId ||
    !itemTitle ||
    !offerPriceAmount ||
    !/^[A-Z]{3}$/.test(offerPriceCurrencyCode) ||
    !Number.isInteger(offerStreamVersion) ||
    offerStreamVersion <= 0 ||
    !listingPriceAmount ||
    !/^[A-Z]{3}$/.test(listingPriceCurrencyCode) ||
    !Number.isInteger(listingStreamVersion) ||
    listingStreamVersion <= 0 ||
    offerPriceCurrencyCode !== listingPriceCurrencyCode
  ) {
    throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
  }

  return {
    lineType: "selected-offer",
    offerId,
    listingId,
    buyerAccountId: null,
    buyerDisplayName: limitedFormValue(formData, "buyerDisplayName", 160) || null,
    offerPriceAmount,
    offerPriceCurrencyCode,
    offerStreamVersion,
    listingPriceAmount,
    listingPriceCurrencyCode,
    listingStreamVersion,
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

function reviewSelectionsFromForm(formData: FormData): SellListReviewSelections {
  const prefixes = ["offerFeeQuoteFingerprint:", "productOfferId:", "fallbackMode:"];
  const lineIds = new Set(
    [...formData.keys()].flatMap((key) => {
      const prefix = prefixes.find((prefix) => key.startsWith(prefix));
      return prefix ? [key.slice(prefix.length)] : [];
    }),
  );
  return {
    bulkOfferIds: formData
      .getAll("bulkOfferId")
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean),
    lines: [...lineIds].map((lineId) => ({
      lineId,
      selectedOfferFeeQuoteFingerprint: formValue(formData, `offerFeeQuoteFingerprint:${lineId}`),
      productOffers: formData.getAll(`productOfferId:${lineId}`).map((value) => {
        const offerId = String(value).trim();
        return {
          offerId,
          feeQuoteFingerprint: formValue(formData, `productOfferFeeQuoteFingerprint:${lineId}:${offerId}`),
        };
      }),
      fallbackListing:
        formValue(formData, `fallbackMode:${lineId}`) === "create-listing"
          ? {
              inventoryItemId: formValue(formData, `inventoryItemId:${lineId}`),
              priceAmount: formValue(formData, `priceAmount:${lineId}`),
              priceCurrencyCode: formValue(formData, `priceCurrencyCode:${lineId}`),
              quantityCap: formValue(formData, `quantityCap:${lineId}`),
            }
          : null,
    })),
  };
}

function sellCheckoutRedirectUrl(
  readiness: Readonly<{ readiness: Readonly<{ snapshotId: string; sourceRevision: string }> }>,
) {
  const query = new URLSearchParams({
    readinessSnapshotId: readiness.readiness.snapshotId,
    readinessSourceRevision: readiness.readiness.sourceRevision,
  });
  return `/checkout/sell/session/${createId("chk")}?${query.toString()}`;
}

async function handleAction(intent: string, { request, formData }: FormActionContext) {
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });
  const useAccountSellList = canUseAccountSellList(actor);
  const anonymousSellListId = readAnonymousSellListId(request);
  const presented = String(formData.get("attemptId") ?? "");
  const attemptId = isCheckoutCommandAttemptId(presented) ? presented : mintCheckoutCommandAttemptId();
  formData.set("attemptId", attemptId);
  const attemptResult = (
    state: SellListAttemptState["state"],
    message: string | null = null,
    lines: SellListAttemptState["lines"] = [],
  ) => ({
    error: message,
    sellListAttempt: {
      state,
      fields: [...formData.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      lines,
    } satisfies SellListAttemptState,
  });
  async function finishSubmission(
    submission: Awaited<ReturnType<typeof submitCheckoutCartAttempt>>,
    ownerId?: string,
    handoff = false,
  ) {
    const headers = new Headers();
    if (ownerId) appendAnonymousSellListCookie(headers, ownerId, request);
    if (submission.state !== "succeeded")
      return data(
        attemptResult(
          submission.state,
          submission.message,
          (submission.attempt?.vector ?? []).map((line) => ({ id: line.lineId ?? "", status: line.outcome })),
        ),
        { headers },
      );
    return redirect(
      await navigateAfterWriteWithPlatformPostWriteToken(
        checkoutCartAttemptCommitSource(submission),
        sellListSurfacePath,
        handoff ? { handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF } : undefined,
      ),
      { headers },
    );
  }
  const sellListSurfacePath =
    new URL(request.url).pathname === "/account/desk/offers" ? "/account/desk/offers" : "/account/sell-list";

  try {
    if (intent === "decline-sell-list-offers") {
      if (!useAccountSellList) {
        throw new Error(t("checkout.features.sellList.ui.sellListPage.sign.in.required"));
      }

      const offerIds = [
        ...new Set(
          formData
            .getAll("bulkOfferId")
            .map((value) => String(value).trim())
            .filter(Boolean),
        ),
      ].slice(0, 100);
      if (offerIds.length === 0) {
        throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
      }

      const marketplaceApi = createMarketplaceRequestApiClient(request);
      if (!formData.has("declinedLineTargetsCaptured")) {
        const sellList = await api.getSellList();
        const declined = new Set(offerIds);
        formData.delete("declinedLineId");
        for (const line of sellList.items) {
          if (line.line_type === "selected-offer" && line.offer_id && declined.has(line.offer_id))
            formData.append("declinedLineId", line.line_id);
        }
        formData.set("declinedLineTargetsCaptured", "true");
      }
      const lineIds = formData.getAll("declinedLineId").map(String);
      const outcomes: { id: string; status: string }[] = [];
      for (const offerId of offerIds) {
        try {
          await marketplaceApi.declineOfferMatch(offerId, {
            attemptId: createHash("sha256")
              .update(JSON.stringify(["sell-list-decline", attemptId, offerId]))
              .digest("base64url"),
          });
          outcomes.push({ id: offerId, status: "declined" });
        } catch (error) {
          outcomes.push(
            { id: offerId, status: "ambiguous" },
            ...offerIds.slice(outcomes.length + 1).map((id) => ({ id, status: "not-attempted" })),
          );
          return attemptResult("partial", error instanceof Error ? error.message : null, outcomes);
        }
      }
      if (!lineIds.length) return redirect(sellListSurfacePath);
      const body = { attemptId, lineIds };
      return finishSubmission(
        await submitCheckoutCartAttempt({
          attemptId,
          kind: "sell-list-batch",
          target: "sell-list",
          body,
          send: () => api.removeSellListLines(body),
          lookup: (query) => api.getSellListCommandAttempt(query),
        }),
      );
    }

    if (intent === "add-selected-offer") {
      if (!useAccountSellList) {
        const anonymousOwnerId = ensureAnonymousSellListId(request);
        const body = { ...selectedOfferLineFromPostedSnapshot(formData), attemptId };
        return finishSubmission(await submitCheckoutSellListAdd(api, body, anonymousOwnerId), anonymousOwnerId, true);
      }

      const offerId = String(formData.get("offerId") ?? "");
      const offer = await api.getSellListOfferMatch(offerId);

      const body = { ...selectedOfferLineFromOffer(offer), attemptId };
      return finishSubmission(await submitCheckoutSellListAdd(api, body), undefined, true);
    }

    if (intent === "remove-sell-list-line") {
      if (!useAccountSellList && !anonymousSellListId) {
        throw new Error(t("checkout.routes.accountSellList.sell.list.request.failed"));
      }
      const lineId = String(formData.get("lineId") ?? "");
      const ownerId = useAccountSellList ? undefined : anonymousSellListId!;
      const body = { attemptId };
      return finishSubmission(
        await submitCheckoutCartAttempt({
          attemptId,
          kind: "sell-list-line",
          target: lineId,
          body,
          send: () =>
            ownerId ? api.removeGuestSellListLine(ownerId, lineId, body) : api.removeSellListLine(lineId, body),
          lookup: (query) => api.getSellListCommandAttempt(query, ownerId),
        }),
        ownerId,
      );
    }

    if (intent === "add-listing-evidence" || intent === "classify-listing-evidence") {
      if (!useAccountSellList) {
        throw new Error(t("checkout.features.sellList.ui.sellListPage.sign.in.required"));
      }

      const marketplaceApi = createMarketplaceRequestApiClient(request);
      const listingId = formValue(formData, "listingId");
      if (!listingId) {
        throw new Error(t("checkout.features.sellList.ui.sellListPage.evidence.unavailable"));
      }

      if (intent === "classify-listing-evidence") {
        const classification = evidenceClassificationFromForm(formData);
        await marketplaceApi.updateListingPhotoClassification(
          listingId,
          formValue(formData, "photoId"),
          classification,
        );
      } else {
        const file = formData.get("listingPhoto");
        if (!(file instanceof File) || file.size <= 0) {
          throw new Error(t("checkout.features.sellList.ui.sellListPage.evidence.photo"));
        }
        const upload = new FormData();
        upload.append("evidence", file);
        upload.append("listingPhotoAltText", formValue(formData, "listingPhotoAltText"));
        await marketplaceApi.addListingPhotos(listingId, upload);
      }

      return redirect(sellListSurfacePath);
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

      const readiness = await api.createSellListReadiness({ selections: reviewSelectionsFromForm(formData) });
      if (readiness.readiness.status !== "ready" || readiness.readiness.unresolvedLineIds.length > 0) {
        throw new Error("Sell List readiness must be resolved before seller checkout starts.");
      }

      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(readiness, sellCheckoutRedirectUrl(readiness)),
      );
    }

    return null;
  } catch (error) {
    return attemptResult(
      "failed-safe",
      error instanceof Error ? error.message : t("checkout.routes.accountSellList.sell.list.request.failed"),
    );
  }
}

export const action = defineFormAction({
  intents: {
    "add-listing-evidence": (context) => handleAction("add-listing-evidence", context),
    "add-selected-offer": (context) => handleAction("add-selected-offer", context),
    "classify-listing-evidence": (context) => handleAction("classify-listing-evidence", context),
    "decline-sell-list-offers": (context) => handleAction("decline-sell-list-offers", context),
    "remove-sell-list-line": (context) => handleAction("remove-sell-list-line", context),
    "review-sell-list-checkout": (context) => handleAction("review-sell-list-checkout", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.accountSellList.sell.list.chase.sets"),
    description: t("checkout.routes.accountSellList.review.selected.offers.and.product.level"),
  });

export default function CheckoutAccountSellListRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigation = useNavigation();
  const sellListRecovery = "sellListRecovery" in data ? data.sellListRecovery : null;
  const { currentPath, isAutoRevalidating } = usePendingFreshWriteRevalidation(
    sellListRecovery?.kind === "pending-fresh-write",
    { freshWrite: data.pendingFreshWriteTiming },
  );

  return (
    <SellListAttemptBoundary attempt={actionData?.sellListAttempt} pending={navigation.state !== "idle"}>
      <CheckoutSellListPage
        sellListLines={data.sellList.items}
        isSignedIn={data.isSignedIn}
        compositeReview={data.compositeReview}
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
        sellListPath={location.pathname === "/account/desk/offers" ? location.pathname : "/account/sell-list"}
      />
    </SellListAttemptBoundary>
  );
}
