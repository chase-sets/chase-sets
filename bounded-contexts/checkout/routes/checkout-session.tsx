import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
} from "react-router";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteTokenFromSources,
  loadFreshlyWrittenResource,
  readApiErrorCode,
  readFreshWriteToken,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createAuthRequestApiClient } from "@chase-sets/auth/server";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
  UnresolvedPostWriteTokenError,
} from "@chase-sets/platform-runtime/http";
import {
  navigateAfterWriteFromSourcesWithPlatformPostWriteToken,
  navigateAfterWriteWithPlatformPostWriteToken,
  resolvePlatformPostWriteRequest,
} from "@chase-sets/platform-runtime/post-write-tokens";
import {
  CheckoutApiError,
  createCheckoutRequestApiClient,
  type CheckoutFulfillmentPreview,
  type CheckoutShipFromAddressRow,
} from "../support/request-support/api-client";
import {
  checkoutRecoveryForError,
  checkoutRecoveryForFreshWriteError,
  createCheckoutRecoveryResponse,
  isCheckoutRecovery,
} from "../features/sessions/api/checkout-recovery";
import { createIdentityRequestApiClient } from "@chase-sets/identity/server";
import { type PaymentsSavedCheckoutInstrument } from "@chase-sets/payments/server";
import { checkoutSessionSourceCreatesOrders } from "@chase-sets/checkout-order-source";
import { normalizeRequestedBalanceCreditAmount } from "../support/request-support/balance-credit";
import { CheckoutSessionPage, type CheckoutEditSection } from "../features/sessions/ui/checkout-page";
import { CheckoutSessionRecoveryPage } from "../features/sessions/ui/checkout-recovery-page";
import {
  buildCheckoutPaymentPreviewStatus,
  type CheckoutPaymentPreviewStatus,
} from "../support/route-support/checkout-session/payment-preview";
import {
  assertCheckoutDeliveryServiceableForAction,
  deliveryCorrectionActionData,
} from "../support/route-support/checkout-session/delivery-correction";

const MARKETPLACE_DESCRIPTION = t("checkout.routes.checkoutSession.enter.contact.delivery.shipping.payment");
const FULFILLMENT_PREVIEW_UNAVAILABLE = t(
  "checkout.routes.checkoutSession.fulfillment.preview.temporarily.unavailable",
);
const CHECKOUT_SESSION_FRESH_READ_TIMEOUT_MS = 2_000;
const GUEST_SAVED_PAYMENT_UNAVAILABLE =
  "Saved payment methods are available after sign-in. Continue with card payment.";
const PAYMENT_START_FRESHNESS_SOURCE_CONTEXT_NAMES = new Set(["ordering"]);
const PAYMENT_START_RETRY_SOURCE_CONTEXT_NAMES = new Set(["checkout", "ordering"]);

type GuestCheckoutContact = Readonly<{
  contactEmail: string;
  contactName: string | null;
}>;

async function loadWalletBalance(request: Request) {
  const response = await createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "settlement" })(
    `${resolveRequestApiBaseUrl(request, "/api/settlement")}/wallet`,
  );

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<{
    available_balance_amount: string;
    currency_code: string;
  }>;
}

function normalizeText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function shippingAddressFromForm(formData: FormData) {
  return {
    shippingAddressId: normalizeText(formData.get("shippingAddressId")),
    name: String(formData.get("shippingName") ?? "").trim(),
    company: normalizeText(formData.get("shippingCompany")),
    line1: String(formData.get("shippingLine1") ?? "").trim(),
    line2: normalizeText(formData.get("shippingLine2")),
    city: String(formData.get("shippingCity") ?? "").trim(),
    state: String(formData.get("shippingState") ?? "")
      .trim()
      .toUpperCase(),
    postalCode: String(formData.get("shippingPostalCode") ?? "").trim(),
    country: String(formData.get("shippingCountry") ?? "US")
      .trim()
      .toUpperCase(),
    phone: normalizeText(formData.get("shippingPhone")),
    email: normalizeText(formData.get("shippingEmail")),
  };
}

function shippingAddressFromSavedAddress(address: CheckoutShipFromAddressRow) {
  return {
    shippingAddressId: address.shipping_address_id,
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

function normalizedAddressSignature(
  address: Readonly<{
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
  }>,
) {
  return JSON.stringify({
    name: address.name.trim(),
    company: String(address.company ?? "").trim(),
    line1: address.line1.trim(),
    line2: String(address.line2 ?? "").trim(),
    city: address.city.trim(),
    state: address.state.trim().toUpperCase(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
    phone: String(address.phone ?? "").trim(),
    email: String(address.email ?? "")
      .trim()
      .toLowerCase(),
  });
}

async function loadSavedShippingAddresses(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
) {
  if (
    !actor ||
    actor.roleKey === "guest-buyer" ||
    !Array.isArray(actor.permissions) ||
    !actor.permissions.includes("accounts.view")
  ) {
    return [];
  }
  const response = await createCheckoutRequestApiClient(request).listSellListShipFromAddresses();
  return response.items;
}

async function loadGuestCheckoutContact(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
): Promise<GuestCheckoutContact | null> {
  if (!actor || actor.roleKey !== "guest-buyer") {
    return null;
  }

  try {
    const context = await createAuthRequestApiClient(request).getGuestCheckoutClaimContext<{
      contactEmail?: string | null;
      contactName?: string | null;
    }>({});
    const contactEmail = String(context.contactEmail ?? "")
      .trim()
      .toLowerCase();
    if (!contactEmail) {
      return null;
    }

    const contactName = String(context.contactName ?? "").trim();
    return {
      contactEmail,
      contactName: contactName || null,
    };
  } catch {
    return null;
  }
}

async function resolveCheckoutShippingAddress(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  formData: FormData,
  options: Readonly<{ persistAddressBook?: boolean; validateServiceability?: boolean }> = {},
) {
  const selectedShippingAddressId = normalizeText(formData.get("shippingAddressId"));
  const addressBookAction = String(formData.get("addressBookAction") ?? "checkout-only");
  const makeDefault = String(formData.get("makeDefaultShippingAddress") ?? "") === "true";
  const formAddress = shippingAddressFromForm(formData);
  const persistAddressBook = options.persistAddressBook === true;

  const canReadAddressBook = Boolean(
    actor &&
    actor.roleKey !== "guest-buyer" &&
    Array.isArray(actor.permissions) &&
    actor.permissions.includes("accounts.view"),
  );
  const canManageAddressBook = Boolean(
    actor &&
    actor.roleKey !== "guest-buyer" &&
    Array.isArray(actor.permissions) &&
    actor.permissions.includes("accounts.manage"),
  );
  const actorAccountId = persistAddressBook && canManageAddressBook && actor ? actor.accountId : null;

  function assertServiceable(address: ReturnType<typeof shippingAddressFromForm>) {
    if (!options.validateServiceability) {
      return;
    }

    assertCheckoutDeliveryServiceableForAction(address);
  }

  if (!canReadAddressBook) {
    assertServiceable(formAddress);
    return {
      ...formAddress,
      shippingAddressId: null,
    };
  }

  const savedAddresses =
    selectedShippingAddressId && selectedShippingAddressId !== "__manual"
      ? await loadSavedShippingAddresses(request, actor)
      : [];
  const selectedSavedAddress = savedAddresses.find(
    (address) => address.shipping_address_id === selectedShippingAddressId,
  );

  if (selectedSavedAddress && addressBookAction !== "save-new" && addressBookAction !== "update-selected") {
    const savedAddress = shippingAddressFromSavedAddress(selectedSavedAddress);
    assertServiceable(savedAddress);
    return savedAddress;
  }

  if (addressBookAction === "update-selected" && selectedSavedAddress && actorAccountId) {
    assertServiceable(formAddress);
    const identityApi = createIdentityRequestApiClient(request);
    await identityApi.updateShippingAddress(actorAccountId!, selectedSavedAddress.shipping_address_id, {
      label: selectedSavedAddress.label,
      ...formAddress,
      makeDefault,
    });
    return {
      ...formAddress,
      shippingAddressId: selectedSavedAddress.shipping_address_id,
    };
  }

  if (addressBookAction === "save-new" && actorAccountId) {
    assertServiceable(formAddress);
    const identityApi = createIdentityRequestApiClient(request);
    const result = await identityApi.createShippingAddress<{ id: string }>(actorAccountId!, {
      ...formAddress,
      makeDefault,
    });
    return {
      ...formAddress,
      shippingAddressId: result.id,
    };
  }

  assertServiceable(formAddress);
  return {
    ...formAddress,
    shippingAddressId: selectedSavedAddress?.shipping_address_id ?? null,
  };
}

function paymentPathForActor(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>, paymentId: string) {
  return actor && actor.roleKey !== "guest-buyer"
    ? `/account/payments/${paymentId}`
    : `/checkout/payments/${paymentId}`;
}

function confirmationPathForSession(sessionId: string) {
  return `/checkout/buy/session/${sessionId}/confirmation`;
}

type VisibleFreshWriteSource = Readonly<{
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly SourceCommitPosition[];
}>;

function visibleFreshWriteSource(source: unknown): VisibleFreshWriteSource {
  const candidate = typeof source === "object" && source !== null ? (source as Partial<VisibleFreshWriteSource>) : {};
  return {
    ...(typeof candidate.commitPosition === "string" ? { commitPosition: candidate.commitPosition } : {}),
    ...(Array.isArray(candidate.commitEventIds) ? { commitEventIds: [...candidate.commitEventIds] } : {}),
    ...(Array.isArray(candidate.commitPositions) ? { commitPositions: [...candidate.commitPositions] } : {}),
  };
}

function currentPathWithSearch(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function requestWithoutCompactPostWriteToken(request: Request) {
  const url = new URL(request.url);
  if (!url.searchParams.has("postWriteToken")) {
    return request;
  }

  url.searchParams.delete("postWriteToken");
  return new Request(url, request);
}

async function resolveCheckoutSessionPostWriteRequest(request: Request) {
  try {
    return await resolvePlatformPostWriteRequest(request);
  } catch (error) {
    if (error instanceof UnresolvedPostWriteTokenError) {
      return requestWithoutCompactPostWriteToken(request);
    }

    throw error;
  }
}

function shouldRefreshPaymentQuote(error: unknown) {
  if (!(error instanceof CheckoutApiError) || error.status !== 409) {
    return false;
  }

  const code = readApiErrorCode(error.body);
  return code === "payment_quote_required" || code === "fee_quote_stale";
}

function shouldRefreshPaymentStart(error: unknown) {
  if (!(error instanceof CheckoutApiError) || error.status !== 409) {
    return false;
  }

  return readApiErrorCode(error.body) === "payment_start_pending";
}

function shouldRefreshReservationUnavailable(error: unknown) {
  if (!(error instanceof CheckoutApiError) || error.status !== 409) {
    return false;
  }

  return readApiErrorCode(error.body) === "checkout_reservation_unavailable";
}

function paymentQuoteRefreshPath(sessionId: string, paymentMethodCategory: string) {
  return `/checkout/buy/session/${sessionId}?paymentMethodCategory=${encodeURIComponent(paymentMethodCategory)}&review=updated&quote=required`;
}

function paymentStartRefreshPath(sessionId: string, paymentMethodCategory: string) {
  return `/checkout/buy/session/${sessionId}?paymentMethodCategory=${encodeURIComponent(paymentMethodCategory)}&review=updated&resumePaymentStart=1`;
}

function reservationUnavailableRefreshPath(sessionId: string, paymentMethodCategory: string) {
  return `/checkout/buy/session/${sessionId}?paymentMethodCategory=${encodeURIComponent(paymentMethodCategory)}&review=updated&reservation=unavailable`;
}

function checkoutPreviewRealtimeTopics(
  lines: readonly Readonly<{
    catalogItemId: string;
    listingId?: string | null;
    lockedListingId?: string | null;
  }>[],
) {
  return [
    ...new Set(
      lines.flatMap((line) => [
        `item:${line.catalogItemId}`,
        ...(line.lockedListingId ? [`listing:${line.lockedListingId}`] : []),
        ...(line.listingId ? [`listing:${line.listingId}`] : []),
      ]),
    ),
  ];
}

function parseCheckoutEditSection(value: string | null): CheckoutEditSection | null {
  return value === "contact" || value === "delivery" || value === "shipping" || value === "payment" ? value : null;
}

async function loadFulfillmentPreview(
  session: Awaited<ReturnType<ReturnType<typeof createCheckoutRequestApiClient>["getCheckoutSession"]>>,
) {
  if (!checkoutSessionSourceCreatesOrders(session.source_type)) {
    return { fulfillmentPreview: null, previewError: null };
  }

  if (!session.fulfillment_preview_snapshot) {
    return {
      fulfillmentPreview: null,
      previewError: FULFILLMENT_PREVIEW_UNAVAILABLE,
    };
  }

  return {
    fulfillmentPreview: session.fulfillment_preview_snapshot,
    previewError: null,
  };
}

type CheckoutReservationUnavailableLine = CheckoutFulfillmentPreview["sellerGroups"][number]["lines"][number];

function checkoutReservationLineKey(
  line: Pick<CheckoutReservationUnavailableLine, "lineKey" | "sellerAccountId" | "inventoryItemId">,
) {
  return `${line.lineKey}|${line.sellerAccountId}|${line.inventoryItemId}`;
}

function loadReservationUnavailableLines(
  searchParams: URLSearchParams,
  session: CheckoutSessionForReviewedPreview,
  fulfillmentPreview: CheckoutFulfillmentPreview | null,
): readonly CheckoutReservationUnavailableLine[] {
  if (searchParams.get("reservation") !== "unavailable" || !fulfillmentPreview) {
    return [];
  }

  const nowMs = Date.now();
  const currentReservationKeys = new Set(
    session.checkout_reservations
      .filter((reservation) => {
        if (reservation.status !== "active") {
          return false;
        }

        const expiresAtMs = Date.parse(reservation.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
      })
      .map(checkoutReservationLineKey),
  );

  return fulfillmentPreview.sellerGroups
    .flatMap((group) => group.lines)
    .filter((line) => !currentReservationKeys.has(checkoutReservationLineKey(line)));
}

type CheckoutRequestApiClient = ReturnType<typeof createCheckoutRequestApiClient>;
type CheckoutSessionForReviewedPreview = Awaited<ReturnType<CheckoutRequestApiClient["getCheckoutSession"]>>;
type CheckoutShippingAddressForReviewedPreview = Awaited<ReturnType<typeof resolveCheckoutShippingAddress>>;

function normalizeFulfillmentPreviewShippingOption(
  value: string,
): CheckoutSessionForReviewedPreview["shipping_option"] {
  return value === "priority" || value === "expedited" ? value : "standard";
}

async function loadCheckoutSessionForReviewedPreview(api: CheckoutRequestApiClient, sessionId: string) {
  if (typeof api.getCheckoutSession !== "function") {
    return null;
  }

  return api.getCheckoutSession(sessionId);
}

async function recordReviewedFulfillmentPreview(
  api: CheckoutRequestApiClient,
  session: CheckoutSessionForReviewedPreview | null,
  input: Readonly<{
    shippingOption: string;
    shippingAddress: CheckoutShippingAddressForReviewedPreview;
  }>,
) {
  if (!session || typeof api.recordFulfillmentPreview !== "function") {
    return null;
  }

  if (!checkoutSessionSourceCreatesOrders(session.source_type)) {
    return null;
  }

  try {
    return await api.recordFulfillmentPreview(session.session_id, {
      shippingOption: normalizeFulfillmentPreviewShippingOption(input.shippingOption),
      shippingAddress: input.shippingAddress,
    });
  } catch {
    return null;
  }
}

function reviewedPreviewWriteSources(sources: readonly unknown[]) {
  return sources.filter((source) => source !== null && source !== undefined);
}

function hasCommittedCheckoutSideEffects(session: CheckoutSessionForReviewedPreview | null) {
  return Boolean(
    session?.payment_id ||
    session?.submitted_offer_id ||
    (Array.isArray(session?.order_ids) && session.order_ids.length > 0),
  );
}

function requestWithoutReadAfterWrite(request: Request) {
  const url = new URL(request.url);
  const hadAfterWrite = url.searchParams.has("afterWrite");
  const hadPostWriteToken = url.searchParams.has("postWriteToken");
  const hadFreshWriteHeader =
    request.headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER) ||
    request.headers.has(CHASE_SETS_READ_TARGET_CONTEXT_HEADER);
  if (!hadAfterWrite && !hadPostWriteToken && !hadFreshWriteHeader) {
    return request;
  }

  url.searchParams.delete("afterWrite");
  url.searchParams.delete("postWriteHandoff");
  url.searchParams.delete("postWriteToken");
  const headers = new Headers(request.headers);
  headers.delete(CHASE_SETS_READ_AFTER_WRITE_HEADER);
  headers.delete(CHASE_SETS_READ_TARGET_CONTEXT_HEADER);
  return new Request(url, {
    headers,
    method: request.method,
  });
}

function sourceCommitEventIds(sources: readonly SourceCommitPosition[]) {
  return [...new Set(sources.flatMap((source) => source.eventIds))];
}

function paymentStartRetryFreshWriteSource(source: unknown): VisibleFreshWriteSource | null {
  const commitPositions =
    visibleFreshWriteSource(source).commitPositions?.filter((position) =>
      PAYMENT_START_RETRY_SOURCE_CONTEXT_NAMES.has(position.sourceContextName),
    ) ?? [];
  if (commitPositions.length === 0) {
    return null;
  }

  return {
    commitEventIds: sourceCommitEventIds(commitPositions),
    commitPositions,
  };
}

function requestWithOnlyFreshWriteSources(
  request: Request,
  sourceContextNames: ReadonlySet<string>,
  fallbackCommitPositions: readonly SourceCommitPosition[] = [],
) {
  const receipt = readFreshWriteToken(request);
  const commitPositions =
    receipt?.sources.filter((source) => sourceContextNames.has(source.sourceContextName)) ??
    fallbackCommitPositions.filter((source) => sourceContextNames.has(source.sourceContextName));
  if (commitPositions.length === 0) {
    return requestWithoutReadAfterWrite(request);
  }

  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  const destinationPath = `${url.pathname}${url.search}${url.hash}`;
  const freshPath = appendFreshWriteTokenFromSources(
    destinationPath,
    [
      {
        commitEventIds: sourceCommitEventIds(commitPositions),
        commitPositions,
      },
    ],
    receipt?.observedAtMs,
  );
  const headers = new Headers(request.headers);
  headers.delete(CHASE_SETS_READ_AFTER_WRITE_HEADER);
  headers.delete(CHASE_SETS_READ_TARGET_CONTEXT_HEADER);

  return new Request(new URL(freshPath, url.origin), {
    headers,
    method: request.method,
  });
}

function requestWithPaymentStartFreshness(
  request: Request,
  fallbackCommitPositions: readonly SourceCommitPosition[] = [],
) {
  return requestWithOnlyFreshWriteSources(
    request,
    PAYMENT_START_FRESHNESS_SOURCE_CONTEXT_NAMES,
    fallbackCommitPositions,
  );
}

function hasPaymentStartFreshnessSource(
  request: Request,
  session: Pick<CheckoutSessionForReviewedPreview, "order_write_commit_positions">,
) {
  return readFreshWriteToken(request) !== null || session.order_write_commit_positions.length > 0;
}

async function loadSavedCheckoutInstruments(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
): Promise<readonly PaymentsSavedCheckoutInstrument[]> {
  if (!actor || actor.roleKey === "guest-buyer") {
    return [];
  }

  try {
    const { items } = await createCheckoutRequestApiClient(request).listCheckoutSavedPaymentInstruments();
    return items.map((instrument) => ({
      id: instrument.instrument_id,
      instrument_id: instrument.instrument_id,
      account_id: actor.accountId,
      payment_method_category:
        instrument.payment_method_category as PaymentsSavedCheckoutInstrument["payment_method_category"],
      provider: "payments",
      display_label: instrument.display_label,
      confirmation_experience:
        instrument.confirmation_experience as PaymentsSavedCheckoutInstrument["confirmation_experience"],
      is_default: instrument.is_default,
      readiness: instrument.readiness as PaymentsSavedCheckoutInstrument["readiness"],
      removed_at: instrument.removed_at,
      created_at: instrument.created_at,
      updated_at: instrument.updated_at,
    }));
  } catch {
    return [];
  }
}

function loadPaymentPreview(
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  fulfillmentPreview: Awaited<ReturnType<typeof loadFulfillmentPreview>>["fulfillmentPreview"],
  wallet: Awaited<ReturnType<typeof loadWalletBalance>>,
  paymentMethodCategory: string,
  committedOrderIds: readonly string[],
): CheckoutPaymentPreviewStatus | null {
  if (!actor) {
    return null;
  }

  if (!fulfillmentPreview) {
    return null;
  }

  return buildCheckoutPaymentPreviewStatus({
    orderIds: committedOrderIds,
    amount: fulfillmentPreview.totals.totalAmount,
    currencyCode: wallet?.currency_code ?? "usd",
    requestedBalanceCreditAmount: wallet?.available_balance_amount ?? "0.00",
    paymentMethodCategory,
  });
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const resolvedRequest = await resolveCheckoutSessionPostWriteRequest(request);
  const actor = await resolveActorFromAuthApi({ request: resolvedRequest });
  if (!params.sessionId) {
    throw new Response(t("checkout.routes.checkoutSession.checkout.session.not.found"), { status: 404 });
  }

  const api = createCheckoutRequestApiClient(resolvedRequest, {
    requestTimeoutMs: CHECKOUT_SESSION_FRESH_READ_TIMEOUT_MS,
    recoverTransportErrorsAsGatewayTimeout: true,
  });
  const session = await loadFreshlyWrittenResource({
    request: resolvedRequest,
    isNotFound: (error) => error instanceof CheckoutApiError && error.status === 404,
    load: () => api.getCheckoutSession(params.sessionId!),
  }).catch((error) => {
    if (error instanceof CheckoutApiError && error.status === 403 && actor?.roleKey === "guest-buyer") {
      throw redirect("/checkout/buy/readiness");
    }

    const recovery = checkoutRecoveryForFreshWriteError(error, actor, resolvedRequest, currentPathWithSearch(request));
    if (recovery) {
      throw createCheckoutRecoveryResponse(recovery);
    }

    throw error;
  });
  if (session.payment_id) {
    throw redirect(paymentPathForActor(actor, session.payment_id));
  }
  if (session.submitted_offer_id) {
    throw redirect(`/account/offers/submitted/${session.submitted_offer_id}?feedbackWorkflow=offer-submit`);
  }

  const ancillaryRequest = requestWithoutReadAfterWrite(resolvedRequest);
  const wallet = actor && actor.roleKey !== "guest-buyer" ? await loadWalletBalance(ancillaryRequest) : null;
  const savedShippingAddresses = await loadSavedShippingAddresses(ancillaryRequest, actor);
  const savedCheckoutInstruments = await loadSavedCheckoutInstruments(ancillaryRequest, actor);
  const guestCheckoutContact = await loadGuestCheckoutContact(ancillaryRequest, actor);
  const { fulfillmentPreview, previewError } = await loadFulfillmentPreview(session);
  const searchParams = new URL(resolvedRequest.url).searchParams;
  const defaultSavedPaymentMethodCategory =
    savedCheckoutInstruments.find((instrument) => instrument.is_default && instrument.readiness === "ready")
      ?.payment_method_category ??
    savedCheckoutInstruments.find((instrument) => instrument.readiness === "ready")?.payment_method_category;
  const selectedPaymentMethodCategory =
    searchParams.get("paymentMethodCategory") ?? defaultSavedPaymentMethodCategory ?? "card";
  const isPaymentStartResume = searchParams.get("resumePaymentStart") === "1";
  const paymentPreview = loadPaymentPreview(
    actor,
    fulfillmentPreview,
    wallet,
    selectedPaymentMethodCategory,
    session.order_ids,
  );
  const reservationUnavailableLines = loadReservationUnavailableLines(searchParams, session, fulfillmentPreview);

  return {
    session,
    wallet,
    paymentPreview,
    selectedPaymentMethodCategory,
    savedShippingAddresses,
    savedCheckoutInstruments,
    guestCheckoutContact,
    canManageShippingAddresses: Boolean(
      actor &&
      actor.roleKey !== "guest-buyer" &&
      Array.isArray(actor.permissions) &&
      actor.permissions.includes("accounts.manage"),
    ),
    canSavePaymentMethods: Boolean(
      actor &&
      actor.roleKey !== "guest-buyer" &&
      Array.isArray(actor.permissions) &&
      actor.permissions.includes("orders.manage"),
    ),
    isSignedInBuyer: Boolean(actor && actor.roleKey !== "guest-buyer"),
    fulfillmentPreview,
    reservationUnavailableLines,
    previewError,
    reviewRefreshed: searchParams.get("review") === "updated",
    paymentQuoteRequired: searchParams.get("quote") === "required",
    autoResumePaymentStart:
      isPaymentStartResume &&
      hasPaymentStartFreshnessSource(resolvedRequest, session) &&
      !session.payment_id &&
      session.order_ids.length > 0 &&
      paymentPreview !== null,
    initialEditSection: parseCheckoutEditSection(searchParams.get("edit")),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const resolvedRequest = await resolveCheckoutSessionPostWriteRequest(request);
  const actor = await resolveActorFromAuthApi({ request: resolvedRequest });
  if (!params.sessionId) {
    throw new Response(t("checkout.routes.checkoutSession.checkout.session.not.found.2"), { status: 404 });
  }

  const formData = await resolvedRequest.formData();
  const intent = String(formData.get("intent") ?? "");
  const internalApiRequest = requestWithoutReadAfterWrite(resolvedRequest);
  const readApi = createCheckoutRequestApiClient(resolvedRequest);
  const writeApi = createCheckoutRequestApiClient(internalApiRequest);

  try {
    if (intent === "select-optimization-goal") {
      const result = await writeApi.selectOptimizationGoal(params.sessionId, {
        optimizationGoal: formData.get("optimizationGoal") === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
      });
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(result, `/checkout/buy/session/${params.sessionId}`),
      );
    }

    if (intent === "refresh-checkout-preview") {
      const shippingAddress = await resolveCheckoutShippingAddress(resolvedRequest, actor, formData, {
        persistAddressBook: false,
        validateServiceability: true,
      });
      const shippingOption = String(formData.get("shippingOption") ?? "standard");
      const session = await loadCheckoutSessionForReviewedPreview(readApi, params.sessionId);
      const shippingOptionResult = await writeApi.selectShippingOption(params.sessionId, {
        shippingOption,
      });
      const shippingAddressResult = await writeApi.selectShippingAddress(params.sessionId, {
        shippingAddress,
      });
      const fulfillmentPreviewResult = await recordReviewedFulfillmentPreview(writeApi, session, {
        shippingOption,
        shippingAddress,
      });
      const paymentMethodCategory = String(formData.get("previewPaymentMethodCategory") ?? "card");
      return redirect(
        await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
          reviewedPreviewWriteSources([shippingOptionResult, shippingAddressResult, fulfillmentPreviewResult]),
          `/checkout/buy/session/${params.sessionId}?paymentMethodCategory=${encodeURIComponent(paymentMethodCategory)}`,
        ),
      );
    }

    if (intent === "confirm-checkout") {
      const selectedSavedPaymentInstrumentId = normalizeText(formData.get("savedCheckoutInstrumentId"));
      const requestedSavePaymentMethodForFuture = String(formData.get("savePaymentMethodForFuture") ?? "") === "true";
      if (
        actor?.roleKey === "guest-buyer" &&
        (selectedSavedPaymentInstrumentId || requestedSavePaymentMethodForFuture)
      ) {
        return { error: GUEST_SAVED_PAYMENT_UNAVAILABLE };
      }

      const shippingAddress = await resolveCheckoutShippingAddress(resolvedRequest, actor, formData, {
        persistAddressBook: true,
        validateServiceability: true,
      });
      const shippingOption = String(formData.get("shippingOption") ?? "standard");
      const quotedPaymentMethodCategory = String(formData.get("paymentMethodCategory") ?? "card");
      const visiblePaymentMethodCategory = String(
        formData.get("previewPaymentMethodCategory") ?? quotedPaymentMethodCategory,
      );
      const reviewedShippingOption = normalizeText(formData.get("reviewedShippingOption"));
      const reviewedShippingAddressSignature = normalizeText(formData.get("reviewedShippingAddressSignature"));
      const marketplaceCheckoutFeeQuoteFingerprint =
        String(formData.get("marketplaceCheckoutFeeQuoteFingerprint") ?? "") || null;
      const savePaymentMethodForFuture =
        requestedSavePaymentMethodForFuture && actor?.roleKey !== "guest-buyer" && !selectedSavedPaymentInstrumentId;
      const session =
        typeof readApi.getCheckoutSession === "function" ? await readApi.getCheckoutSession(params.sessionId) : null;
      const hasCommittedSideEffects = hasCommittedCheckoutSideEffects(session);
      const shippingOptionResult = hasCommittedSideEffects
        ? null
        : await writeApi.selectShippingOption(params.sessionId, {
            shippingOption,
          });
      const sourceType = session?.source_type ?? String(formData.get("sourceType") ?? "");
      const visibleReviewChanged =
        visiblePaymentMethodCategory !== quotedPaymentMethodCategory ||
        (reviewedShippingOption !== null && reviewedShippingOption !== shippingOption) ||
        (reviewedShippingAddressSignature !== null &&
          reviewedShippingAddressSignature !== normalizedAddressSignature(shippingAddress));

      const needsPaymentQuote =
        sourceType.length > 0 &&
        sourceType !== "offer-intent" &&
        !marketplaceCheckoutFeeQuoteFingerprint &&
        !session?.payment_id &&
        !hasCommittedSideEffects;
      const shouldRefreshReviewBeforeConfirm =
        sourceType !== "offer-intent" && visibleReviewChanged && !hasCommittedSideEffects;
      if (shouldRefreshReviewBeforeConfirm || needsPaymentQuote) {
        const shippingAddressResult = await writeApi.selectShippingAddress(params.sessionId, {
          shippingAddress,
        });
        const fulfillmentPreviewResult = await recordReviewedFulfillmentPreview(writeApi, session, {
          shippingOption,
          shippingAddress,
        });
        const quoteReason = needsPaymentQuote ? "&quote=required" : "";
        return redirect(
          await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
            reviewedPreviewWriteSources([shippingOptionResult, shippingAddressResult, fulfillmentPreviewResult]),
            `/checkout/buy/session/${params.sessionId}?paymentMethodCategory=${encodeURIComponent(visiblePaymentMethodCategory)}&review=updated${quoteReason}`,
          ),
        );
      }
      const confirmApi = createCheckoutRequestApiClient(requestWithPaymentStartFreshness(resolvedRequest));
      let result: Awaited<ReturnType<typeof confirmApi.confirmCheckoutSession>>;
      try {
        result = await confirmApi.confirmCheckoutSession(params.sessionId, {
          requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(
            formData.get("requestedBalanceCreditAmount"),
          ),
          paymentMethodCategory: quotedPaymentMethodCategory,
          marketplaceCheckoutFeeQuoteFingerprint,
          savedCheckoutInstrumentId: selectedSavedPaymentInstrumentId,
          savePaymentMethodForFuture,
          fulfillmentPreviewRevision: String(formData.get("fulfillmentPreviewRevision") ?? "") || null,
          acknowledgedMaterialChanges: String(formData.get("acknowledgedMaterialChanges") ?? "") === "true",
          shippingAddress,
        });
      } catch (error) {
        const refreshPaymentQuote = shouldRefreshPaymentQuote(error);
        const refreshPaymentStart = shouldRefreshPaymentStart(error);
        const refreshReservationUnavailable = shouldRefreshReservationUnavailable(error);
        const refreshPath = refreshPaymentQuote
          ? paymentQuoteRefreshPath(params.sessionId, visiblePaymentMethodCategory)
          : refreshPaymentStart
            ? paymentStartRefreshPath(params.sessionId, visiblePaymentMethodCategory)
            : refreshReservationUnavailable
              ? reservationUnavailableRefreshPath(params.sessionId, visiblePaymentMethodCategory)
              : null;
        if (refreshPath) {
          return redirect(
            await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
              reviewedPreviewWriteSources([
                error instanceof CheckoutApiError && refreshPaymentStart
                  ? paymentStartRetryFreshWriteSource(error.body)
                  : error instanceof CheckoutApiError
                    ? visibleFreshWriteSource(error.body)
                    : null,
              ]),
              refreshPath,
            ),
          );
        }

        throw error;
      }
      if (result.offer_id) {
        return redirect(
          await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
            [result, visibleFreshWriteSource(result)],
            `/account/offers/submitted/${result.offer_id}?feedbackWorkflow=offer-submit`,
          ),
        );
      }
      if (!result.payment_id) {
        throw new Error("Checkout confirmation did not return payment or purchases.");
      }
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(result, confirmationPathForSession(params.sessionId)),
      );
    }

    return null;
  } catch (error) {
    const deliveryCorrection = deliveryCorrectionActionData(error);
    if (deliveryCorrection) {
      return deliveryCorrection;
    }

    const recovery = checkoutRecoveryForError(error, actor, currentPathWithSearch(request));
    if (recovery) {
      throw createCheckoutRecoveryResponse(recovery);
    }

    return {
      error: error instanceof Error ? error.message : t("checkout.routes.checkoutSession.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.checkoutSession.checkout.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function CheckoutSessionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const realtimeTopics = checkoutPreviewRealtimeTopics(data.session.lines);
  const realtimeSubscriptionKey = realtimeTopics.join("\n");
  const actionEditSection = actionData && "editSection" in actionData ? actionData.editSection : null;

  useEffect(() => {
    const subscription = subscribeRealtimePatches({
      topics: realtimeTopics,
      onPatch: reloadForRealtimeSync,
      onSyncRequired: reloadForRealtimeSync,
    });

    return () => subscription.close();
  }, [realtimeSubscriptionKey]);

  return (
    <CheckoutSessionPage
      session={data.session}
      wallet={data.wallet}
      paymentPreview={data.paymentPreview}
      selectedPaymentMethodCategory={data.selectedPaymentMethodCategory}
      fulfillmentPreview={data.fulfillmentPreview}
      reservationUnavailableLines={data.reservationUnavailableLines}
      savedShippingAddresses={data.savedShippingAddresses}
      savedCheckoutInstruments={data.savedCheckoutInstruments}
      guestCheckoutContact={data.guestCheckoutContact}
      canManageShippingAddresses={data.canManageShippingAddresses}
      canSavePaymentMethods={data.canSavePaymentMethods}
      isSignedInBuyer={data.isSignedInBuyer}
      errorMessage={actionData?.error ?? data.previewError ?? null}
      reviewRefreshed={data.reviewRefreshed}
      paymentQuoteRequired={data.paymentQuoteRequired}
      autoResumePaymentStart={!actionData?.error && data.autoResumePaymentStart}
      initialEditSection={actionEditSection ?? data.initialEditSection}
      isSubmitting={navigation.state === "submitting"}
    />
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();

  if (!isRouteErrorResponse(error) || ![202, 400, 401, 403, 404, 410, 503].includes(error.status)) {
    throw error;
  }

  const currentPath = `${location.pathname}${location.search}`;
  const signInPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
  const recovery = isCheckoutRecovery(error.data) ? error.data : null;
  const title = recovery?.title ?? error.statusText ?? t("checkout.routes.checkoutSession.checkout.unavailable");
  const description =
    recovery?.description ??
    (typeof error.data === "string" && error.data.trim()
      ? error.data
      : t("checkout.routes.checkoutSession.checkout.unavailable.description"));
  const trustCue = recovery?.trustCue ?? t("checkout.routes.checkoutSession.payment.has.not.started");
  const primaryAction = recovery?.primaryAction ?? {
    href: "/search",
    label: t("checkout.routes.checkoutRecovery.browse.marketplace"),
    leadingIcon: "search" as const,
  };
  const secondaryAction = recovery?.secondaryAction ?? {
    href: signInPath,
    label: t("checkout.routes.checkoutSession.sign.in.to.continue"),
    leadingIcon: "lock" as const,
    tone: "secondary" as const,
  };

  return (
    <CheckoutSessionRecoveryPage
      kind={recovery?.kind ?? null}
      title={title}
      description={description}
      trustCue={trustCue}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      currentPath={currentPath}
    />
  );
}
