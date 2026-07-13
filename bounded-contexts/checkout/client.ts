import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type { MutationResult } from "@chase-sets/http/responses";
import type { buildCheckoutApi } from "./api";
import type { CheckoutCartLine } from "./features/cart/api/contracts";
import type { CartReadinessDecisionInput, CartReadinessSnapshot } from "./features/cart/api/contracts";
import type {
  CheckoutSellListCompositeReview,
  CheckoutSellListConfirmationRow,
  CheckoutSellListLineRow,
  CheckoutSellOfferMatch,
  CheckoutSellListOfferReview,
  CheckoutSellPayoutReadinessRow,
} from "./features/sell-list/read-model/queries";
import type { CheckoutShipFromAddressRow } from "./features/cart/integrations/identity/identity-queries";
import type {
  SellListConfirmationSummary,
  SellListReadinessDecisionInput,
  SellListReadinessSnapshot,
  SellListSellerConfirmationEvidence,
} from "./features/sell-list/api/contracts";
import type { CheckoutSessionRow } from "./features/sessions/read-model/queries";
import type { CheckoutSavedPaymentInstrumentRow } from "./features/sessions/integrations/payments/payment-affordance-queries";
import type { CheckoutPaymentSummaryRow } from "./features/sessions/integrations/payments/payment-summary-queries";
import type { CheckoutPaymentConfirmation } from "./features/sessions/integrations/payments/payment-confirmation-queries";
import type { CheckoutFulfillmentPreview } from "./features/sessions/domain/fulfillment-preview";

type CheckoutApiApp = ReturnType<typeof buildCheckoutApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type { CartReadinessDecisionInput, CartReadinessSnapshot } from "./features/cart/api/contracts";
export type {
  SellListConfirmationSummary,
  SellListReadinessDecisionInput,
  SellListReadinessSnapshot,
  SellListSellerConfirmationEvidence,
} from "./features/sell-list/api/contracts";

export type CheckoutMutationResult<T extends object> = MutationResult<T>;
type CheckoutCommandMutationResult = CheckoutMutationResult<Readonly<{ id: string; version: number; status: string }>>;

export type CheckoutSelectedOptionInput = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type CheckoutSelectedListingSnapshotInput = Readonly<{
  listingId: string;
  sellerAccountId?: string | null;
  sellerDisplayName?: string | null;
  sellerSlug?: string | null;
  priceAmount?: string | null;
  source?: string | null;
}>;

export type AddCheckoutCartLineRequest = Readonly<{
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle?: string | null;
  itemImageUrl?: string | null;
  itemImageSrcSet?: string | null;
  itemImageLoadingUrl?: string | null;
  itemImageLoadingAlt?: string | null;
  itemImageLoadingSrcSet?: string | null;
  selectedOptions: readonly CheckoutSelectedOptionInput[];
  productSummary?: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
}>;

export type AddCheckoutCartLinesRequest = Readonly<{
  lines: readonly AddCheckoutCartLineRequest[];
}>;

export type AddCheckoutCartLinesResponse = Readonly<{
  status: "completed";
  requestedLineCount: number;
  addedLineCount: number;
  mergedLineCount: number;
  failedLineCount: number;
  lines: readonly {
    index: number;
    lineId: string | null;
    status: "added" | "merged" | "failed";
    message: string | null;
  }[];
}>;

export type AddCheckoutSellListLineRequest = Readonly<{
  lineType: "selected-offer" | "product";
  offerId?: string | null;
  listingId?: string | null;
  buyerAccountId?: string | null;
  buyerDisplayName?: string | null;
  offerPriceAmount?: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle?: string | null;
  selectedOptions: readonly CheckoutSelectedOptionInput[];
  productSummary?: string | null;
  quantity: number;
  fallbackMode?: "none" | "create-listing";
  minimumListingPriceAmount?: string | null;
}>;

export type UpdateCheckoutCartLineQuantityRequest = Readonly<{
  quantity: number;
}>;

export type UpdateCheckoutCartLineFulfillmentRequest = Readonly<{
  fulfillmentMode: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
  selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
}>;

export type CheckoutEntryAttemptInput = Readonly<{
  entryAttemptKey?: string | null;
}>;

export type CreateCartCheckoutSessionRequest = CheckoutEntryAttemptInput &
  Readonly<{
    source: Readonly<{
      type: "cart";
      readinessSnapshotId: string;
      readinessSourceRevision: string;
      readinessDecisions?: CartReadinessDecisionInput | null;
    }>;
    shippingOption?: string;
  }>;

export type CreateBuyNowCheckoutSessionRequest = CheckoutEntryAttemptInput &
  Readonly<{
    source: Readonly<{
      type: "buy-now";
      listingId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle?: string | null;
      selectedOptions: readonly CheckoutSelectedOptionInput[];
      productSummary?: string | null;
      quantity: number;
      fulfillmentMode?: "optimize" | "locked-listing";
      lockedListingId?: string | null;
      sellerPreferenceId?: string | null;
    }>;
    shippingOption?: string;
  }>;

export type CreateOfferIntentCheckoutSessionRequest = CheckoutEntryAttemptInput &
  Readonly<{
    source: Readonly<{
      type: "offer-intent";
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle?: string | null;
      selectedOptions: readonly CheckoutSelectedOptionInput[];
      productSummary?: string | null;
      offerPriceAmount: string;
      quantity: number;
    }>;
    shippingOption?: string;
  }>;

export type CreateCheckoutSessionRequest =
  | CreateCartCheckoutSessionRequest
  | CreateBuyNowCheckoutSessionRequest
  | CreateOfferIntentCheckoutSessionRequest;

export type SelectCheckoutShippingOptionRequest = Readonly<{
  shippingOption: string;
}>;

export type SelectCheckoutAuthenticityCheckOptInRequest = Readonly<{
  selected: boolean;
  quoteFingerprint?: string | null;
}>;

export type SelectCheckoutOptimizationGoalRequest = Readonly<{
  optimizationGoal: "lowest-total" | "fewest-shipments";
}>;

export type RecordCheckoutFulfillmentPreviewRequest = Readonly<{
  fulfillmentPreviewRevision?: string;
  fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
  fulfillmentPreview?: CheckoutFulfillmentPreview | null;
  shippingOption?: string;
  shippingAddress?: CheckoutShippingAddressInput | null;
}>;

export type CheckoutShippingAddressInput = Readonly<{
  shippingAddressId?: string | null;
  name: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string | null;
  email?: string | null;
}>;

export class CheckoutApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(checkoutApiErrorMessage(status, body));
  }
}

export interface CheckoutApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
  requestTimeoutMs?: number;
  recoverTransportErrorsAsGatewayTimeout?: boolean;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

function mergeHeaders(headers: HeadersInit | undefined, extra: Record<string, string>) {
  return {
    ...Object.fromEntries(new Headers(headers).entries()),
    ...extra,
  };
}

function checkoutApiErrorMessage(status: number, body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return `API error ${status}`;
  }

  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return String(error ?? `API error ${status}`);
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.trim()) {
    return code;
  }

  return `API error ${status}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new CheckoutApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function timeoutFetchSignal(timeoutMs: number, upstreamSignal?: AbortSignal) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeUpstreamListener: (() => void) | null = null;
  const timeoutResponse = new Promise<Response>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(gatewayTimeoutResponse());
    }, timeoutMs);
  });

  if (upstreamSignal) {
    const abortFromUpstream = () => controller.abort();
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
      removeUpstreamListener = () => upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
  }

  return {
    signal: controller.signal,
    wait: (request: Promise<Response>) => Promise.race([request, timeoutResponse]),
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      removeUpstreamListener?.();
    },
  };
}

function gatewayTimeoutResponse() {
  return new Response(null, {
    status: 504,
    statusText: "Gateway Timeout",
  });
}

export function createCheckoutApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
  requestTimeoutMs,
  recoverTransportErrorsAsGatewayTimeout = false,
}: CheckoutApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = async (input, init = {}) => {
    const timeout =
      typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? timeoutFetchSignal(requestTimeoutMs, init.signal ?? undefined)
        : null;

    try {
      const request = fetch(input, {
        ...init,
        credentials: init.credentials ?? credentials,
        ...(timeout ? { signal: timeout.signal } : {}),
      });
      return await (timeout ? timeout.wait(request) : request);
    } catch (error) {
      if (recoverTransportErrorsAsGatewayTimeout) {
        return gatewayTimeoutResponse();
      }

      throw error;
    } finally {
      timeout?.cleanup();
    }
  };
  const client = honoClientResource(
    hc<CheckoutApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async getCart(): Promise<{ items: readonly CheckoutCartLine[]; count: number }> {
      return parseJsonResponse(await client.account.cart.$get({ header: headers }));
    },
    async getGuestCart(anonymousCartId: string | null): Promise<{ items: readonly CheckoutCartLine[]; count: number }> {
      return parseJsonResponse(
        await client.guest.cart.$get({
          header: mergeHeaders(headers, anonymousCartId ? { "x-checkout-anonymous-cart-id": anonymousCartId } : {}),
        }),
      );
    },
    async createCartReadiness(
      body: CartReadinessDecisionInput = {},
    ): Promise<CheckoutMutationResult<{ readiness: CartReadinessSnapshot }>> {
      return parseJsonResponse(await client.account.cart.readiness.$post({ json: body, header: headers }));
    },
    async createGuestCartReadiness(
      anonymousCartId: string,
      body: CartReadinessDecisionInput = {},
    ): Promise<CheckoutMutationResult<{ readiness: CartReadinessSnapshot }>> {
      return parseJsonResponse(
        await client.guest.cart.readiness.$post({
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async addCartLine(body: AddCheckoutCartLineRequest): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(await client.account.cart.$post({ json: body, header: headers }));
    },
    async addCartLines(
      body: AddCheckoutCartLinesRequest,
    ): Promise<CheckoutMutationResult<AddCheckoutCartLinesResponse>> {
      return parseJsonResponse(await client.account.cart.bulk.$post({ json: body, header: headers }));
    },
    async addGuestCartLine(
      anonymousCartId: string,
      body: AddCheckoutCartLineRequest,
    ): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.guest.cart.$post({
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async addGuestCartLines(
      anonymousCartId: string,
      body: AddCheckoutCartLinesRequest,
    ): Promise<CheckoutMutationResult<AddCheckoutCartLinesResponse>> {
      return parseJsonResponse(
        await client.guest.cart.bulk.$post({
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async getSellList(): Promise<{
      items: readonly CheckoutSellListLineRow[];
      count: number;
      latestConfirmation?: CheckoutSellListConfirmationRow | null;
    }> {
      return parseJsonResponse(await client.account["sell-list"].$get({ header: headers }));
    },
    async getSellListPayoutReadiness(): Promise<CheckoutSellPayoutReadinessRow> {
      return parseJsonResponse(await client.account["sell-list"]["payout-readiness"].$get({ header: headers }));
    },
    async listSellListShipFromAddresses(): Promise<{ items: readonly CheckoutShipFromAddressRow[] }> {
      return parseJsonResponse(await client.account["sell-list"]["ship-from-addresses"].$get({ header: headers }));
    },
    async getSellListCompositeReview(
      options: Readonly<{ includeStandardComparison?: boolean }> = {},
    ): Promise<CheckoutSellListCompositeReview> {
      return parseJsonResponse(
        await client.account["sell-list"]["composite-review"].$get({
          query: options.includeStandardComparison ? { includeStandardComparison: "true" } : {},
          header: headers,
        }),
      );
    },
    async getSellListOfferMatch(offerId: string): Promise<CheckoutSellOfferMatch> {
      return parseJsonResponse(
        await client.account["sell-list"]["offer-matches"][":offerId"].$get({
          param: { offerId },
          header: headers,
        }),
      );
    },
    async getGuestSellList(
      anonymousSellListId: string | null,
    ): Promise<{ items: readonly CheckoutSellListLineRow[]; count: number }> {
      return parseJsonResponse(
        await client.guest["sell-list"].$get({
          header: mergeHeaders(
            headers,
            anonymousSellListId ? { "x-checkout-anonymous-sell-list-id": anonymousSellListId } : {},
          ),
        }),
      );
    },
    async getGuestSellListOfferReviews(
      anonymousSellListId: string | null,
    ): Promise<{ offerReviews: readonly CheckoutSellListOfferReview[] }> {
      return parseJsonResponse(
        await client.guest["sell-list"]["offer-reviews"].$get({
          header: mergeHeaders(
            headers,
            anonymousSellListId ? { "x-checkout-anonymous-sell-list-id": anonymousSellListId } : {},
          ),
        }),
      );
    },
    async createSellListReadiness(
      body: SellListReadinessDecisionInput & { sellerEvidence?: SellListSellerConfirmationEvidence | null } = {},
    ): Promise<CheckoutMutationResult<{ readiness: SellListReadinessSnapshot }>> {
      return parseJsonResponse(await client.account["sell-list"].readiness.$post({ json: body, header: headers }));
    },
    async createGuestSellListReadiness(
      anonymousSellListId: string,
      body: SellListReadinessDecisionInput & { sellerEvidence?: SellListSellerConfirmationEvidence | null } = {},
    ): Promise<CheckoutMutationResult<{ readiness: SellListReadinessSnapshot }>> {
      return parseJsonResponse(
        await client.guest["sell-list"].readiness.$post({
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-sell-list-id": anonymousSellListId,
          }),
        }),
      );
    },
    async addSellListLine(body: AddCheckoutSellListLineRequest): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(await client.account["sell-list"].$post({ json: body, header: headers }));
    },
    async addGuestSellListLine(
      anonymousSellListId: string,
      body: AddCheckoutSellListLineRequest,
    ): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.guest["sell-list"].$post({
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-sell-list-id": anonymousSellListId,
          }),
        }),
      );
    },
    async removeSellListLine(lineId: string): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.account["sell-list"][":lineId"].remove.$post({
          param: { lineId },
          json: {},
          header: headers,
        }),
      );
    },
    async getSellListConfirmation(confirmationId: string): Promise<CheckoutSellListConfirmationRow> {
      return parseJsonResponse(
        await client.account["sell-list"].confirmations[":confirmationId"].$get({
          param: { confirmationId },
          header: headers,
        }),
      );
    },
    async confirmSellListCheckout(
      body: Readonly<{
        confirmationId: string;
        readinessSnapshotId: string;
        readinessSourceRevision: string;
        readinessDecisions?: SellListReadinessDecisionInput | null;
        completedLineIds?: readonly string[];
        remainingLineQuantities?: readonly { lineId: string; quantity: number }[];
        sellerEvidence: SellListSellerConfirmationEvidence;
        handoffSummary: SellListConfirmationSummary;
      }>,
    ): Promise<CheckoutMutationResult<{ confirmation: CheckoutSellListConfirmationRow }>> {
      return parseJsonResponse(await client.account["sell-list"].confirm.$post({ json: body, header: headers }));
    },
    async removeGuestSellListLine(anonymousSellListId: string, lineId: string): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.guest["sell-list"][":lineId"].remove.$post({
          param: { lineId },
          json: {},
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-sell-list-id": anonymousSellListId,
          }),
        }),
      );
    },
    async mergeGuestCartToAccount(
      anonymousCartId: string,
    ): Promise<CheckoutMutationResult<{ mergedLineCount: number }>> {
      return parseJsonResponse(
        await client.guest.cart["merge-to-account"].$post({
          json: {},
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async mergeGuestSellListToAccount(
      anonymousSellListId: string,
    ): Promise<CheckoutMutationResult<{ mergedLineCount: number }>> {
      return parseJsonResponse(
        await client.guest["sell-list"]["merge-to-account"].$post({
          json: {},
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-sell-list-id": anonymousSellListId,
          }),
        }),
      );
    },
    async updateCartLineQuantity(
      lineId: string,
      body: UpdateCheckoutCartLineQuantityRequest,
    ): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.account.cart[":lineId"].quantity.$post({
          param: { lineId },
          json: body,
          header: headers,
        }),
      );
    },
    async updateGuestCartLineQuantity(
      anonymousCartId: string,
      lineId: string,
      body: UpdateCheckoutCartLineQuantityRequest,
    ): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.guest.cart[":lineId"].quantity.$post({
          param: { lineId },
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async updateCartLineFulfillment(
      lineId: string,
      body: UpdateCheckoutCartLineFulfillmentRequest,
    ): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.account.cart[":lineId"].fulfillment.$post({
          param: { lineId },
          json: body,
          header: headers,
        }),
      );
    },
    async updateGuestCartLineFulfillment(
      anonymousCartId: string,
      lineId: string,
      body: UpdateCheckoutCartLineFulfillmentRequest,
    ): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.guest.cart[":lineId"].fulfillment.$post({
          param: { lineId },
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async removeCartLine(lineId: string): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.account.cart[":lineId"].remove.$post({
          param: { lineId },
          json: {},
          header: headers,
        }),
      );
    },
    async removeGuestCartLine(anonymousCartId: string, lineId: string): Promise<CheckoutCommandMutationResult> {
      return parseJsonResponse(
        await client.guest.cart[":lineId"].remove.$post({
          param: { lineId },
          json: {},
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async createCheckoutSession(
      body: CreateCheckoutSessionRequest,
    ): Promise<CheckoutMutationResult<{ session_id: string }>> {
      return parseJsonResponse(
        await client.account["checkout-sessions"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async getCheckoutSession(sessionId: string): Promise<CheckoutSessionRow> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"].$get({
          param: { sessionId },
          header: headers,
        }),
      );
    },
    async getCheckoutPaymentSummary(paymentId: string): Promise<CheckoutPaymentSummaryRow> {
      return parseJsonResponse(
        await client.account["checkout-payment-summaries"][":paymentId"].$get({
          param: { paymentId },
          header: headers,
        }),
      );
    },
    async getCheckoutPaymentConfirmation(sessionId: string): Promise<CheckoutPaymentConfirmation> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["payment-confirmation"].$get({
          param: { sessionId },
          header: headers,
        }),
      );
    },
    async listCheckoutSavedPaymentInstruments(): Promise<{ items: CheckoutSavedPaymentInstrumentRow[] }> {
      return parseJsonResponse(
        await client.account["checkout-payment-affordances"].$get({
          header: headers,
        }),
      );
    },
    async selectShippingOption(
      sessionId: string,
      body: SelectCheckoutShippingOptionRequest,
    ): Promise<CheckoutMutationResult<{ status: string }>> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["shipping-option"].$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
    async selectShippingAddress(
      sessionId: string,
      body: Readonly<{ shippingAddress: CheckoutShippingAddressInput | null }>,
    ): Promise<CheckoutMutationResult<{ status: string }>> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["shipping-address"].$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
    async selectAuthenticityCheckOptIn(
      sessionId: string,
      body: SelectCheckoutAuthenticityCheckOptInRequest,
    ): Promise<CheckoutMutationResult<{ status: string }>> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["authenticity-check-opt-in"].$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
    async recordFulfillmentPreview(
      sessionId: string,
      body: RecordCheckoutFulfillmentPreviewRequest,
    ): Promise<CheckoutMutationResult<{ status: string }>> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["fulfillment-preview"].$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
    async selectOptimizationGoal(
      sessionId: string,
      body: SelectCheckoutOptimizationGoalRequest,
    ): Promise<CheckoutMutationResult<{ status: string }>> {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["optimization-goal"].$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
    async confirmCheckoutSession(
      sessionId: string,
      body: Readonly<{
        requestedBalanceCreditAmount?: string | null;
        paymentMethodCategory?: string;
        marketplaceCheckoutFeeQuoteFingerprint?: string | null;
        savedCheckoutInstrumentId?: string | null;
        savePaymentMethodForFuture?: boolean;
        fulfillmentPreviewRevision?: string | null;
        acknowledgedMaterialChanges?: boolean;
        shippingAddress?: CheckoutShippingAddressInput | null;
      }> = {},
    ): Promise<
      CheckoutMutationResult<{
        payment_id?: string;
        order_ids?: readonly string[];
        offer_id?: string;
        status: string;
      }>
    > {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"].confirm.$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
  };
}

export type {
  CheckoutCartLine,
  CheckoutSellListCompositeReview,
  CheckoutSellListConfirmationRow,
  CheckoutSellListLineRow,
  CheckoutSellListOfferReview,
  CheckoutSellOfferMatch,
  CheckoutSellPayoutReadinessRow,
  CheckoutShipFromAddressRow,
  CheckoutSessionRow,
  CheckoutPaymentSummaryRow,
  CheckoutPaymentConfirmation,
  CheckoutFulfillmentPreview,
};
export const checkoutApi = createCheckoutApiClient();
