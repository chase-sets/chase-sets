import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type { buildCheckoutApi } from "./api";
import type { CheckoutCartLine } from "./features/cart/api/contracts";
import type { CheckoutSessionRow } from "./features/sessions/read-model/queries";

type CheckoutApiApp = ReturnType<typeof buildCheckoutApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type CheckoutSelectedOptionInput = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type AddCheckoutCartLineRequest = Readonly<{
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle?: string | null;
  itemImageUrl?: string | null;
  itemImageLoadingUrl?: string | null;
  itemImageLoadingAlt?: string | null;
  itemImageLoadingSrcSet?: string | null;
  selectedOptions: readonly CheckoutSelectedOptionInput[];
  productSummary?: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
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

export type UpdateCheckoutCartLineQuantityRequest = Readonly<{
  quantity: number;
}>;

export type UpdateCheckoutCartLineFulfillmentRequest = Readonly<{
  fulfillmentMode: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type CreateCartCheckoutSessionRequest = Readonly<{
  source: Readonly<{ type: "cart" }>;
  shippingOption?: string;
}>;

export type CreateBuyNowCheckoutSessionRequest = Readonly<{
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

export type CreateOfferIntentCheckoutSessionRequest = Readonly<{
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

export type SelectCheckoutOptimizationGoalRequest = Readonly<{
  optimizationGoal: "lowest-total" | "fewest-shipments";
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
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

function mergeHeaders(
  headers: HeadersInit | undefined,
  extra: Record<string, string>,
) {
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

export function createCheckoutApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: CheckoutApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<CheckoutApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async getCart(): Promise<{ items: readonly CheckoutCartLine[]; count: number }> {
      return parseJsonResponse(
        await client.account.cart.$get({ header: headers }),
      );
    },
    async getGuestCart(
      anonymousCartId: string | null,
    ): Promise<{ items: readonly CheckoutCartLine[]; count: number }> {
      return parseJsonResponse(
        await client.guest.cart.$get({
          header: mergeHeaders(
            headers,
            anonymousCartId
              ? { "x-checkout-anonymous-cart-id": anonymousCartId }
              : {},
          ),
        }),
      );
    },
    async addCartLine(body: AddCheckoutCartLineRequest) {
      return parseJsonResponse(
        await client.account.cart.$post({ json: body, header: headers }),
      );
    },
    async addCartLines(
      body: AddCheckoutCartLinesRequest,
    ): Promise<AddCheckoutCartLinesResponse> {
      return parseJsonResponse(
        await client.account.cart.bulk.$post({ json: body, header: headers }),
      );
    },
    async addGuestCartLine(
      anonymousCartId: string,
      body: AddCheckoutCartLineRequest,
    ) {
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
    ): Promise<AddCheckoutCartLinesResponse> {
      return parseJsonResponse(
        await client.guest.cart.bulk.$post({
          json: body,
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async mergeGuestCartToAccount(anonymousCartId: string) {
      return parseJsonResponse(
        await client.guest.cart["merge-to-account"].$post({
          json: {},
          header: mergeHeaders(headers, {
            "x-checkout-anonymous-cart-id": anonymousCartId,
          }),
        }),
      );
    },
    async updateCartLineQuantity(
      lineId: string,
      body: UpdateCheckoutCartLineQuantityRequest,
    ) {
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
    ) {
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
    ) {
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
    ) {
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
    async removeCartLine(lineId: string) {
      return parseJsonResponse(
        await client.account.cart[":lineId"].remove.$post({
          param: { lineId },
          json: {},
          header: headers,
        }),
      );
    },
    async removeGuestCartLine(anonymousCartId: string, lineId: string) {
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
    ): Promise<{ session_id: string }> {
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
    async selectShippingOption(
      sessionId: string,
      body: SelectCheckoutShippingOptionRequest,
    ) {
      return parseJsonResponse(
        await client.account["checkout-sessions"][":sessionId"]["shipping-option"].$post({
          param: { sessionId },
          json: body,
          header: headers,
        }),
      );
    },
    async selectOptimizationGoal(
      sessionId: string,
      body: SelectCheckoutOptimizationGoalRequest,
    ) {
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
        fulfillmentPreviewRevision?: string | null;
        acknowledgedMaterialChanges?: boolean;
        shippingAddress?: CheckoutShippingAddressInput | null;
      }> = {},
    ): Promise<{
      payment_id?: string;
      order_ids?: readonly string[];
      offer_id?: string;
      status: string;
    }> {
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

export type { CheckoutCartLine, CheckoutSessionRow };
export const checkoutApi = createCheckoutApiClient();
