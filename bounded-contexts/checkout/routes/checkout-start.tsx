import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, redirectDocument } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWriteFromSourcesWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { AuthApiError, createAuthRequestApiClient } from "@chase-sets/auth/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  HiddenInput,
  Form,
  Banner,
  Button,
  OrderProtectionModule,
  CheckoutFlowShell,
  CheckoutMobileSummaryDisclosure,
  LinkButton,
  OrderIntentSummary,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
  Surface,
  Text,
  TextInput,
  formatMarketplaceNumber,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import {
  CheckoutApiError,
  createCheckoutRequestApiClient,
  type CartReadinessDecisionInput,
  type CartReadinessSnapshot,
  type CreateCheckoutSessionRequest,
} from "../support/request-support/api-client";
import { parseCheckoutStartCartReadinessDecisions } from "../features/cart/api/readiness-decisions";
import {
  checkoutRecoveryForError,
  checkoutRecoveryForKind,
  type CheckoutRecovery,
} from "../features/sessions/api/checkout-recovery";
import {
  appendClearedAnonymousCartCookie,
  appendGuestCheckoutCookie,
  CHECKOUT_GUEST_COOKIE_NAME,
  readAnonymousCartId,
} from "../support/request-support/guest-checkout";

const ACCOUNT_SIGN_IN_REQUIRED_CODE = "account_sign_in_required";
const MERGED_CART_PROJECTION_WAIT_MS = 15_000;
const MERGED_CART_PROJECTION_POLL_MS = 300;
type CheckoutActor = Awaited<ReturnType<typeof resolveActorFromAuthApi>>;
type GuestCheckoutStart = Readonly<{
  accountId: string;
  guestToken: string;
  expiresAt: string;
}>;
type CheckoutStartCartReadinessSummary = Readonly<{
  status: CartReadinessSnapshot["status"];
  lineCount: number;
  customerSafeFacts: readonly string[];
}>;

function parseSelectedOptions(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((selection): selection is { dimensionId: string; optionId: string } =>
            Boolean(
              selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection,
            ),
          )
          .map((selection) => ({
            dimensionId: String(selection.dimensionId ?? ""),
            optionId: String(selection.optionId ?? ""),
          }))
      : [];
  } catch {
    return [];
  }
}

function parseQuantity(value: FormDataEntryValue | string | null) {
  const quantity = Number(value ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function parseReadinessDecisions(value: FormDataEntryValue | null): CartReadinessDecisionInput | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parseCheckoutStartCartReadinessDecisions(parsed);
  } catch {
    return null;
  }
}

function entryAttemptKeyFromForm(formData: FormData) {
  const key = String(formData.get("entryAttemptKey") ?? "").trim();
  return key ? key : null;
}

function withEntryAttemptKey(request: CreateCheckoutSessionRequest, formData: FormData): CreateCheckoutSessionRequest {
  const entryAttemptKey = entryAttemptKeyFromForm(formData);
  return entryAttemptKey ? { ...request, entryAttemptKey } : request;
}

function sourceFromUrl(url: URL) {
  const sourceType = url.searchParams.get("source");
  if (sourceType !== "buy-now" && sourceType !== "offer-intent") {
    return null;
  }

  if (sourceType === "offer-intent") {
    return {
      type: "offer-intent" as const,
      catalogItemId: url.searchParams.get("catalogItemId") ?? "",
      productId: url.searchParams.get("productId") ?? "",
      itemTitle: url.searchParams.get("itemTitle") ?? "",
      itemSubtitle: url.searchParams.get("itemSubtitle") || null,
      selectedOptions: parseSelectedOptions(url.searchParams.get("selectedOptions")),
      productSummary: url.searchParams.get("productSummary") || null,
      offerPriceAmount: url.searchParams.get("offerPriceAmount") ?? url.searchParams.get("priceAmount") ?? "",
      quantity: parseQuantity(url.searchParams.get("quantity") ?? url.searchParams.get("quantityRequested")),
    };
  }

  return {
    type: "buy-now" as const,
    listingId: url.searchParams.get("listingId") ?? "",
    fulfillmentMode:
      url.searchParams.get("fulfillmentMode") === "locked-listing"
        ? ("locked-listing" as const)
        : ("optimize" as const),
    lockedListingId: url.searchParams.get("lockedListingId") || null,
    catalogItemId: url.searchParams.get("catalogItemId") ?? "",
    productId: url.searchParams.get("productId") ?? "",
    itemTitle: url.searchParams.get("itemTitle") ?? "",
    itemSubtitle: url.searchParams.get("itemSubtitle") || null,
    selectedOptions: parseSelectedOptions(url.searchParams.get("selectedOptions")),
    productSummary: url.searchParams.get("productSummary") || null,
    quantity: parseQuantity(url.searchParams.get("quantity")),
    priceAmount: url.searchParams.get("priceAmount") || null,
    sellerName: url.searchParams.get("sellerName") || null,
    availability: url.searchParams.get("availability") || null,
    fulfillment: url.searchParams.get("fulfillment") || null,
  };
}

function sourceFromForm(formData: FormData) {
  if (String(formData.get("source") ?? "cart") === "offer-intent") {
    return {
      type: "offer-intent" as const,
      catalogItemId: String(formData.get("catalogItemId") ?? ""),
      productId: String(formData.get("productId") ?? ""),
      itemTitle: String(formData.get("itemTitle") ?? ""),
      itemSubtitle: String(formData.get("itemSubtitle") ?? "") || null,
      selectedOptions: parseSelectedOptions(String(formData.get("selectedOptions") ?? "[]")),
      productSummary: String(formData.get("productSummary") ?? "") || null,
      offerPriceAmount: String(formData.get("offerPriceAmount") ?? formData.get("priceAmount") ?? ""),
      quantity: parseQuantity(formData.get("quantity") ?? formData.get("quantityRequested")),
    };
  }

  return {
    type: "buy-now" as const,
    listingId: String(formData.get("listingId") ?? ""),
    fulfillmentMode:
      formData.get("fulfillmentMode") === "locked-listing" ? ("locked-listing" as const) : ("optimize" as const),
    lockedListingId: String(formData.get("lockedListingId") ?? "") || null,
    catalogItemId: String(formData.get("catalogItemId") ?? ""),
    productId: String(formData.get("productId") ?? ""),
    itemTitle: String(formData.get("itemTitle") ?? ""),
    itemSubtitle: String(formData.get("itemSubtitle") ?? "") || null,
    selectedOptions: parseSelectedOptions(String(formData.get("selectedOptions") ?? "[]")),
    productSummary: String(formData.get("productSummary") ?? "") || null,
    quantity: parseQuantity(formData.get("quantity")),
    priceAmount: String(formData.get("priceAmount") ?? "") || null,
    sellerName: String(formData.get("sellerName") ?? "") || null,
    availability: String(formData.get("availability") ?? "") || null,
    fulfillment: String(formData.get("fulfillment") ?? "") || null,
  };
}

function checkoutSessionRequestFromForm(formData: FormData): CreateCheckoutSessionRequest {
  const sourceType = String(formData.get("source") ?? "cart");
  if (sourceType === "offer-intent") {
    const source = sourceFromForm(formData);
    if (source.type !== "offer-intent") {
      throw new Error("Purchase intent source was not preserved.");
    }
    return withEntryAttemptKey({ source }, formData);
  }

  if (sourceType === "buy-now") {
    const source = sourceFromForm(formData);
    if (source.type !== "buy-now") {
      throw new Error("Buy now source was not preserved.");
    }
    return withEntryAttemptKey({ source }, formData);
  }

  return withEntryAttemptKey(
    {
      source: {
        type: "cart" as const,
        readinessSnapshotId: String(formData.get("readinessSnapshotId") ?? ""),
        readinessSourceRevision: String(formData.get("readinessSourceRevision") ?? ""),
        readinessDecisions: parseReadinessDecisions(formData.get("readinessDecisions")),
      },
    },
    formData,
  );
}

type CheckoutRequestApi = ReturnType<typeof createCheckoutRequestApiClient>;

async function ensureCartReadinessSnapshot(
  api: CheckoutRequestApi,
  request: CreateCheckoutSessionRequest,
  options: Readonly<{ forceRefresh?: boolean }> = {},
): Promise<CreateCheckoutSessionRequest> {
  if (request.source.type !== "cart") {
    return request;
  }

  const hasReadinessToken = Boolean(request.source.readinessSnapshotId && request.source.readinessSourceRevision);
  if (hasReadinessToken && !options.forceRefresh) {
    return request;
  }

  const readiness = await api.createCartReadiness(request.source.readinessDecisions ?? {});
  return {
    source: {
      ...request.source,
      readinessSnapshotId: readiness.readiness.snapshotId,
      readinessSourceRevision: readiness.readiness.sourceRevision,
      readinessDecisions: request.source.readinessDecisions,
    },
  };
}

export function checkoutStartHeaderCopy(params: Readonly<{ isSignedIn: boolean; isOfferIntent: boolean }>) {
  if (params.isOfferIntent) {
    return params.isSignedIn
      ? {
          title: t("checkout.routes.checkoutStart.place.purchase.intent"),
          description: t("checkout.routes.checkoutStart.confirm.shipping.so.the.seller.can.review"),
        }
      : {
          title: t("checkout.routes.checkoutStart.register.to.place.purchase.intent"),
          description: t("checkout.routes.checkoutStart.register.or.sign.in.purchase.intent.copy"),
        };
  }

  return params.isSignedIn
    ? {
        title: t("checkout.routes.checkoutStart.continue.checkout"),
        description: t("checkout.routes.checkoutStart.continue.with.your.account.so.purchases.payments"),
      }
    : {
        title: t("checkout.routes.checkoutStart.sign.in.or.continue.as.guest"),
        description: t("checkout.routes.checkoutStart.sign.in.to.keep.orders.with.your.account"),
      };
}

export function checkoutStartBuyerProtectionItems(isOfferIntent: boolean) {
  return isOfferIntent
    ? [
        {
          title: t("checkout.routes.checkoutStart.transparent.next.step"),
          description: t("checkout.routes.checkoutStart.sellers.review.purchase.intent.before.payment"),
        },
        {
          title: t("checkout.routes.checkoutStart.recoverable.checkout"),
          description: t("checkout.routes.checkoutStart.account.keeps.purchase.intent.traceable"),
        },
        {
          title: t("checkout.routes.checkoutStart.protected.payment"),
          description: t("checkout.routes.checkoutStart.payment.collected.only.after.seller.accepts"),
        },
      ]
    : [
        {
          title: t("checkout.routes.checkoutStart.transparent.next.step"),
          description: t("checkout.routes.checkoutStart.shipping.fees.and.final.totals.are.shown"),
        },
        {
          title: t("checkout.routes.checkoutStart.recoverable.checkout"),
          description: t("checkout.routes.checkoutStart.guest.receipts.and.signed.in.order.history"),
        },
        {
          title: t("checkout.routes.checkoutStart.protected.payment"),
          description: t("checkout.routes.checkoutStart.payment.begins.only.after.the.checkout.session"),
        },
      ];
}

function currentPathWithSearch(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function requestWithFreshWriteSource(request: Request, source: unknown) {
  const freshPath = appendFreshWriteToken(currentPathWithSearch(request), source);
  return new Request(new URL(freshPath, request.url), { headers: request.headers });
}

function mergedCartLineCount(source: unknown) {
  if (typeof source !== "object" || source === null || !("mergedLineCount" in source)) {
    return 0;
  }

  const count = Number((source as { mergedLineCount?: unknown }).mergedLineCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMergedCartProjection(api: CheckoutRequestApi, mergeResult: unknown) {
  const expectedLineCount = mergedCartLineCount(mergeResult);
  if (expectedLineCount === 0) {
    return;
  }

  const deadline = Date.now() + MERGED_CART_PROJECTION_WAIT_MS;
  while (Date.now() <= deadline) {
    const cart = await api.getCart();
    if (cart.count >= expectedLineCount) {
      return;
    }

    await delay(MERGED_CART_PROJECTION_POLL_MS);
  }

  throw new CheckoutApiError(503, {
    error: {
      code: "projection_freshness_timeout",
      message: t("checkout.routes.checkoutRecovery.checkout.preparing.description"),
    },
  });
}

async function checkoutSessionPath(session: Readonly<{ session_id: string }>, writeSources: readonly unknown[] = []) {
  return navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
    [...writeSources, session],
    `/checkout/buy/session/${session.session_id}`,
  );
}

function signInPathForReturnTo(returnTo: string) {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

function cartReadinessSummary(snapshot: CartReadinessSnapshot): CheckoutStartCartReadinessSummary {
  return {
    status: snapshot.status,
    lineCount: snapshot.lineCount,
    customerSafeFacts: snapshot.customerSafeFacts,
  };
}

function checkoutStatusLabel(status: CheckoutStartCartReadinessSummary["status"] | null) {
  if (status === "ready" || status === null) {
    return t("checkout.routes.checkoutStart.ready");
  }

  return t("checkout.routes.checkoutStart.needs.review");
}

function cartCheckoutCanContinue(summary: CheckoutStartCartReadinessSummary | null) {
  return summary === null || summary.status === "ready";
}

function isAccountSignInRequiredError(error: unknown) {
  if (!(error instanceof AuthApiError) || error.status !== 409) {
    return false;
  }

  const body = error.body;
  return Boolean(
    body &&
    typeof body === "object" &&
    "error" in body &&
    (body as { error?: { code?: unknown } }).error?.code === ACCOUNT_SIGN_IN_REQUIRED_CODE,
  );
}

function isCheckoutAuthorizationError(error: unknown) {
  return error instanceof CheckoutApiError && error.status === 403;
}

function isGuestCheckoutActor(actor: CheckoutActor) {
  return actor?.roleKey === "guest-buyer";
}

function canRecoverGuestCheckoutMismatch(sourceType: string, anonymousCartId: string | null) {
  return sourceType === "buy-now" || (sourceType === "cart" && Boolean(anonymousCartId));
}

async function loadGuestCheckoutStartContact(
  request: Request,
): Promise<Readonly<{ email: string; contactName: string }> | null> {
  try {
    const context = await createAuthRequestApiClient(request).getGuestCheckoutClaimContext<{
      contactEmail?: string | null;
      contactName?: string | null;
    }>({});
    const email = String(context.contactEmail ?? "").trim();
    if (!email) {
      return null;
    }

    return {
      email,
      contactName: String(context.contactName ?? "").trim(),
    };
  } catch {
    return null;
  }
}

function guestCheckoutContactFromForm(formData: FormData) {
  return {
    contactName: String(formData.get("contactName") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
  };
}

function hasGuestCheckoutContact(contact: Readonly<{ contactName: string; email: string }>) {
  return Boolean(contact.contactName && contact.email);
}

async function createGuestCheckoutStart(
  request: Request,
  contact: Readonly<{ contactName: string; email: string }>,
): Promise<GuestCheckoutStart> {
  return createAuthRequestApiClient(request).startGuestCheckout<GuestCheckoutStart>({
    displayName: contact.contactName,
    email: contact.email,
  });
}

async function startGuestCheckoutSession(
  request: Request,
  formData: FormData,
  params: Readonly<{
    anonymousCartId: string | null;
    sourceType: string;
    guest: GuestCheckoutStart;
  }>,
) {
  const guestHeaders = {
    cookie: `${CHECKOUT_GUEST_COOKIE_NAME}=${encodeURIComponent(params.guest.guestToken)}`,
  };
  let guestApi = createCheckoutRequestApiClient(request, {
    headers: {
      ...guestHeaders,
    },
  });
  const writeSources: unknown[] = [];
  const forceReadinessRefresh = params.sourceType === "cart" && Boolean(params.anonymousCartId);
  if (params.sourceType === "cart" && params.anonymousCartId) {
    const mergeResult = await guestApi.mergeGuestCartToAccount(params.anonymousCartId);
    writeSources.push(mergeResult);
    await waitForMergedCartProjection(guestApi, mergeResult);
    guestApi = createCheckoutRequestApiClient(requestWithFreshWriteSource(request, mergeResult), {
      headers: guestHeaders,
    });
  }

  const sessionRequest = await ensureCartReadinessSnapshot(guestApi, checkoutSessionRequestFromForm(formData), {
    forceRefresh: forceReadinessRefresh,
  });
  const session = await guestApi.createCheckoutSession(sessionRequest);
  const response = redirectDocument(await checkoutSessionPath(session, writeSources));
  appendGuestCheckoutCookie(response.headers, params.guest.guestToken, request, params.guest.expiresAt);
  appendClearedAnonymousCartCookie(response.headers, request);

  return response;
}

async function recoverGuestCheckoutStartMismatch(
  error: unknown,
  actor: CheckoutActor,
  request: Request,
  formData: FormData,
  params: Readonly<{ anonymousCartId: string | null; sourceType: string }>,
) {
  if (
    !isCheckoutAuthorizationError(error) ||
    !isGuestCheckoutActor(actor) ||
    !canRecoverGuestCheckoutMismatch(params.sourceType, params.anonymousCartId)
  ) {
    return null;
  }

  const contact = await loadGuestCheckoutStartContact(request);
  if (!contact) {
    return null;
  }

  try {
    const guest = await createGuestCheckoutStart(request, contact);
    return await startGuestCheckoutSession(request, formData, { ...params, guest });
  } catch (recoveryError) {
    if (isCheckoutAuthorizationError(recoveryError)) {
      return null;
    }

    throw recoveryError;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const url = new URL(request.url);
  const source = sourceFromUrl(url);
  const api = createCheckoutRequestApiClient(request);
  const isGuestBuyer = actor?.roleKey === "guest-buyer";
  const cartReadiness =
    actor && !isGuestBuyer && !source ? cartReadinessSummary((await api.createCartReadiness({})).readiness) : null;
  const cart = actor || source ? null : await api.getGuestCart(readAnonymousCartId(request));
  const returnTo = currentPathWithSearch(request);

  return {
    isSignedIn: Boolean(actor && !isGuestBuyer),
    isGuestBuyer,
    source,
    cartReadiness,
    cartCount: cartReadiness?.lineCount ?? cart?.count ?? (source ? 1 : 0),
    entryAttemptKey: createId("chkentry"),
    signInPath: signInPathForReturnTo(returnTo),
  };
}

type CheckoutStartActionData =
  | Readonly<{ error: string; signInPath: string }>
  | Readonly<{ emailExistsError: string; signInPath: string }>
  | Readonly<{ recovery: CheckoutRecovery }>;

function recoverCheckoutStartError(
  error: unknown,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  request: Request,
): CheckoutStartActionData {
  const recovery = checkoutRecoveryForError(error, actor, currentPathWithSearch(request));
  if (!recovery) {
    throw error;
  }

  return { recovery };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const api = createCheckoutRequestApiClient(request);
  const formData = await request.formData();
  const anonymousCartId = readAnonymousCartId(request);
  const sourceType = String(formData.get("source") ?? "cart");

  if (actor) {
    try {
      const forceReadinessRefresh = sourceType === "cart";
      let sessionApi = api;
      const writeSources: unknown[] = [];
      if (sourceType === "cart" && anonymousCartId) {
        const mergeResult = await api.mergeGuestCartToAccount(anonymousCartId);
        writeSources.push(mergeResult);
        await waitForMergedCartProjection(api, mergeResult);
        sessionApi = createCheckoutRequestApiClient(requestWithFreshWriteSource(request, mergeResult));
      }

      const sessionRequest = await ensureCartReadinessSnapshot(sessionApi, checkoutSessionRequestFromForm(formData), {
        forceRefresh: forceReadinessRefresh,
      });
      const session = await sessionApi.createCheckoutSession(sessionRequest);
      const response = redirect(await checkoutSessionPath(session, writeSources));
      if (anonymousCartId) {
        appendClearedAnonymousCartCookie(response.headers, request);
      }

      return response;
    } catch (error) {
      const recovered = await recoverGuestCheckoutStartMismatch(error, actor, request, formData, {
        anonymousCartId,
        sourceType,
      });
      if (recovered) {
        return recovered;
      }

      return recoverCheckoutStartError(error, actor, request);
    }
  }

  if (sourceType === "offer-intent") {
    return {
      error: t("checkout.routes.checkoutStart.register.or.sign.in.to.place.purchase.intent"),
      signInPath: signInPathForReturnTo(currentPathWithSearch(request)),
    };
  }

  if (sourceType === "cart") {
    try {
      const cart = await api.getGuestCart(anonymousCartId);
      if (cart.count === 0) {
        return { recovery: checkoutRecoveryForKind("cart-empty", currentPathWithSearch(request)) };
      }
    } catch (error) {
      return recoverCheckoutStartError(error, actor, request);
    }
  }

  const contact = guestCheckoutContactFromForm(formData);
  if (!hasGuestCheckoutContact(contact)) {
    return null;
  }

  let guest: GuestCheckoutStart;

  try {
    guest = await createGuestCheckoutStart(request, contact);
  } catch (error) {
    if (isAccountSignInRequiredError(error)) {
      return {
        emailExistsError: t("checkout.routes.checkoutStart.email.already.has.account"),
        signInPath: signInPathForReturnTo(currentPathWithSearch(request)),
      };
    }

    throw error;
  }

  try {
    return await startGuestCheckoutSession(request, formData, { anonymousCartId, sourceType, guest });
  } catch (error) {
    if (isCheckoutAuthorizationError(error) && canRecoverGuestCheckoutMismatch(sourceType, anonymousCartId)) {
      let retryGuest: GuestCheckoutStart;
      try {
        retryGuest = await createGuestCheckoutStart(request, contact);
      } catch {
        return recoverCheckoutStartError(error, actor, request);
      }

      try {
        return await startGuestCheckoutSession(request, formData, {
          anonymousCartId,
          sourceType,
          guest: retryGuest,
        });
      } catch (retryError) {
        return recoverCheckoutStartError(retryError, null, request);
      }
    }

    return recoverCheckoutStartError(error, actor, request);
  }
}

export default function CheckoutStartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as CheckoutStartActionData | undefined;
  const source = data.source;
  const isOfferIntent = source?.type === "offer-intent";
  const cartReadiness = source ? null : data.cartReadiness;
  const cartCanContinue = cartCheckoutCanContinue(cartReadiness);
  const checkoutStatus = checkoutStatusLabel(cartReadiness?.status ?? null);
  const headerCopy = checkoutStartHeaderCopy({
    isSignedIn: data.isSignedIn,
    isOfferIntent,
  });
  const signInReturnTo =
    new URLSearchParams(data.signInPath.split("?")[1] ?? "").get("returnTo") ?? "/checkout/buy/readiness";
  const registerPath = `/register?returnTo=${encodeURIComponent(signInReturnTo)}`;
  const emailExistsError = actionData && "emailExistsError" in actionData ? actionData.emailExistsError : null;
  const emailExistsSignInPath =
    actionData && "emailExistsError" in actionData ? actionData.signInPath : data.signInPath;
  const sourceFields = source ? (
    <>
      <HiddenInput type="hidden" name="entryAttemptKey" value={data.entryAttemptKey} />
      <HiddenInput type="hidden" name="source" value={source.type} />
      {"listingId" in source ? <HiddenInput type="hidden" name="listingId" value={source.listingId} /> : null}
      {"fulfillmentMode" in source ? (
        <HiddenInput type="hidden" name="fulfillmentMode" value={source.fulfillmentMode} />
      ) : null}
      {"lockedListingId" in source ? (
        <HiddenInput type="hidden" name="lockedListingId" value={source.lockedListingId ?? ""} />
      ) : null}
      <HiddenInput type="hidden" name="catalogItemId" value={source.catalogItemId} />
      <HiddenInput type="hidden" name="productId" value={source.productId} />
      <HiddenInput type="hidden" name="itemTitle" value={source.itemTitle} />
      <HiddenInput type="hidden" name="itemSubtitle" value={source.itemSubtitle ?? ""} />
      <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(source.selectedOptions)} />
      <HiddenInput type="hidden" name="productSummary" value={source.productSummary ?? ""} />
      <HiddenInput type="hidden" name="quantity" value={source.quantity} />
      {"offerPriceAmount" in source ? (
        <HiddenInput type="hidden" name="offerPriceAmount" value={source.offerPriceAmount} />
      ) : null}
      {"priceAmount" in source ? (
        <HiddenInput type="hidden" name="priceAmount" value={source.priceAmount ?? ""} />
      ) : null}
      {"sellerName" in source ? <HiddenInput type="hidden" name="sellerName" value={source.sellerName ?? ""} /> : null}
      {"availability" in source ? (
        <HiddenInput type="hidden" name="availability" value={source.availability ?? ""} />
      ) : null}
      {"fulfillment" in source ? (
        <HiddenInput type="hidden" name="fulfillment" value={source.fulfillment ?? ""} />
      ) : null}
    </>
  ) : (
    <>
      <HiddenInput type="hidden" name="entryAttemptKey" value={data.entryAttemptKey} />
      <HiddenInput type="hidden" name="source" value="cart" />
    </>
  );
  const sourceSummary = source ? (
    <OrderIntentSummary
      title={source.itemTitle || t("checkout.routes.checkoutStart.buy.now")}
      subtitle={
        source.itemSubtitle ??
        (source.productSummary ? (
          <ProductOptions options={productOptionsFromSummary(source.productSummary)} variant="compact" />
        ) : null)
      }
      price={
        source.type === "offer-intent"
          ? `$${source.offerPriceAmount}`
          : source.priceAmount
            ? `$${source.priceAmount}`
            : t("checkout.routes.checkoutStart.price.confirmed.before.payment")
      }
      quantity={formatMarketplaceNumber(
        source.quantity,
        t("checkout.routes.checkoutStart.quantity.confirmed.before.payment"),
      )}
      seller={
        source.type === "buy-now"
          ? (source.sellerName ?? t("checkout.routes.checkoutStart.marketplace.seller"))
          : t("checkout.routes.checkoutStart.marketplace.seller")
      }
      availability={
        source.type === "buy-now"
          ? (source.availability ?? t("checkout.routes.checkoutStart.availability.confirmed.before.payment"))
          : t("checkout.routes.checkoutStart.waiting.for.seller.acceptance")
      }
      fulfillment={
        source.type === "buy-now"
          ? (source.fulfillment ?? t("checkout.routes.checkoutStart.fulfillment.confirmed.before.payment"))
          : t("checkout.routes.checkoutStart.offer.submitted.after.registration")
      }
      protection={t("checkout.routes.checkoutStart.buyer.protection.included")}
      paymentStatus={
        source.type === "offer-intent"
          ? t("checkout.routes.checkoutStart.no.payment.today")
          : t("checkout.routes.checkoutStart.not.charged.yet")
      }
    />
  ) : null;

  const checkoutSummary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          {
            label: source ? t("checkout.routes.checkoutStart.source") : t("checkout.routes.checkoutStart.cart"),
            value: source
              ? source.itemTitle || t("checkout.routes.checkoutStart.buy.now")
              : t("checkout.routes.checkoutStart.item.count", {
                  count: data.cartCount,
                  itemLabel:
                    data.cartCount === 1
                      ? t("checkout.routes.checkoutStart.item")
                      : t("checkout.routes.checkoutStart.items"),
                }),
          },
          ...(source
            ? [
                {
                  label: t("checkout.routes.checkoutStart.seller"),
                  value:
                    source.type === "buy-now"
                      ? (source.sellerName ?? t("checkout.routes.checkoutStart.marketplace.seller"))
                      : t("checkout.routes.checkoutStart.marketplace.seller"),
                },
                {
                  label: t("checkout.routes.checkoutStart.price"),
                  value:
                    source.type === "offer-intent"
                      ? `$${source.offerPriceAmount}`
                      : source.priceAmount
                        ? `$${source.priceAmount}`
                        : t("checkout.routes.checkoutStart.price.confirmed.before.payment"),
                },
                {
                  label: t("checkout.routes.checkoutStart.quantity"),
                  value: formatMarketplaceNumber(
                    source.quantity,
                    t("checkout.routes.checkoutStart.quantity.confirmed.before.payment"),
                  ),
                },
              ]
            : []),
          {
            label: t("checkout.routes.checkoutStart.account.choice"),
            value: data.isGuestBuyer
              ? t("checkout.routes.checkoutStart.guest.checkout.active")
              : data.isSignedIn
                ? t("checkout.routes.checkoutStart.signed.in")
                : isOfferIntent
                  ? t("checkout.routes.checkoutStart.register.or.sign.in")
                  : t("checkout.routes.checkoutStart.sign.in.or.guest"),
          },
          {
            label: t("checkout.routes.checkoutStart.payment"),
            value: isOfferIntent
              ? t("checkout.routes.checkoutStart.no.payment.today")
              : t("checkout.routes.checkoutStart.not.charged.yet"),
          },
        ]}
        total={checkoutStatus}
        totalLabel={t("checkout.routes.checkoutStart.checkout.status")}
        reassurance={
          <SecurePaymentIndicator
            label={
              isOfferIntent
                ? t("checkout.routes.checkoutStart.no.payment.today")
                : t("checkout.routes.checkoutStart.secure.payment")
            }
          />
        }
      />
      <OrderProtectionModule items={checkoutStartBuyerProtectionItems(isOfferIntent)} />
    </Stack>
  );

  const checkoutMain = (
    <Stack gap={4}>
      {sourceSummary}
      {data.isSignedIn && !source && !cartCanContinue ? (
        <Banner
          title={t("checkout.routes.checkoutStart.cart.needs.review")}
          description={
            cartReadiness?.customerSafeFacts[0] ?? t("checkout.routes.checkoutStart.cart.needs.review.description")
          }
          tone="warning"
          actions={
            <LinkButton href="/account/cart" leadingIcon="cart" tone="secondary">
              {t("checkout.routes.checkoutStart.review.buy.cart")}
            </LinkButton>
          }
        />
      ) : null}

      {actionData && "recovery" in actionData ? (
        <Banner
          title={actionData.recovery.title}
          description={actionData.recovery.description}
          tone="warning"
          actions={
            <>
              <LinkButton
                href={actionData.recovery.primaryAction.href}
                leadingIcon={actionData.recovery.primaryAction.leadingIcon}
                tone={actionData.recovery.primaryAction.tone}
              >
                {actionData.recovery.primaryAction.label}
              </LinkButton>
              {actionData.recovery.secondaryAction ? (
                <LinkButton
                  href={actionData.recovery.secondaryAction.href}
                  leadingIcon={actionData.recovery.secondaryAction.leadingIcon}
                  tone={actionData.recovery.secondaryAction.tone}
                >
                  {actionData.recovery.secondaryAction.label}
                </LinkButton>
              ) : null}
            </>
          }
        />
      ) : null}

      {actionData && "error" in actionData ? (
        <Banner
          title={t("checkout.routes.checkoutStart.sign.in.required")}
          description={actionData.error}
          tone="warning"
          actions={
            <LinkButton href={actionData.signInPath} tone="secondary">
              {t("checkout.routes.checkoutStart.sign.in")}
            </LinkButton>
          }
        />
      ) : null}

      {(data.isSignedIn || data.isGuestBuyer) && (source || cartCanContinue) ? (
        <PageSection
          title={
            data.isGuestBuyer
              ? t("checkout.routes.checkoutStart.guest.checkout.active")
              : t("checkout.routes.checkoutStart.account.checkout")
          }
        >
          <Surface elevated glow>
            <RouterForm method="post" spacing="none">
              <Stack gap={3}>
                <Text tone="secondary">
                  {data.isGuestBuyer
                    ? t("checkout.routes.checkoutStart.continue.with.guest.checkout")
                    : t("checkout.routes.checkoutStart.continue.with.your.account.any.saved.guest")}
                </Text>
                {sourceFields}
                <Button type="submit" size="lg" leadingIcon="lock">
                  {t("checkout.routes.checkoutStart.continue.to.checkout")}
                </Button>
              </Stack>
            </RouterForm>
          </Surface>
        </PageSection>
      ) : isOfferIntent ? (
        <>
          <PageSection title={t("checkout.routes.checkoutStart.register.to.place.purchase.intent")}>
            <Surface elevated glow>
              <Stack gap={3}>
                <Text tone="secondary">{t("checkout.routes.checkoutStart.registration.purchase.intent.copy")}</Text>
                <LinkButton href={registerPath} size="lg" leadingIcon="shield">
                  {t("checkout.routes.checkoutStart.register.with.passkey")}
                </LinkButton>
                <LinkButton href={data.signInPath} tone="secondary" size="lg" leadingIcon="lock">
                  {t("checkout.routes.checkoutStart.sign.in")}
                </LinkButton>
              </Stack>
            </Surface>
          </PageSection>
        </>
      ) : (
        <>
          <PageSection title={t("checkout.routes.checkoutStart.guest.checkout")}>
            <Surface elevated glow>
              <RouterForm method="post" spacing="none">
                <Stack gap={3}>
                  <Text tone="secondary">{t("checkout.routes.checkoutStart.continue.as.guest.fast.path")}</Text>
                  {emailExistsError ? (
                    <Banner
                      title={t("checkout.routes.checkoutStart.sign.in.required")}
                      description={emailExistsError}
                      tone="warning"
                      actions={
                        <LinkButton href={emailExistsSignInPath} tone="secondary">
                          {t("checkout.routes.checkoutStart.sign.in")}
                        </LinkButton>
                      }
                    />
                  ) : null}
                  <TextInput label={t("checkout.routes.checkoutStart.contact.name")} name="contactName" required />
                  <TextInput
                    label={t("checkout.routes.checkoutStart.email")}
                    name="email"
                    type="email"
                    required
                    error={emailExistsError ?? undefined}
                  />
                  {sourceFields}
                  <Button type="submit" size="lg" leadingIcon="lock">
                    {t("checkout.routes.checkoutStart.continue.as.guest")}
                  </Button>
                </Stack>
              </RouterForm>
            </Surface>
          </PageSection>
          <PageSection title={t("checkout.routes.checkoutStart.account")}>
            <Surface elevated>
              <Stack gap={3}>
                <Text tone="secondary">{t("checkout.routes.checkoutStart.sign.in.to.keep.purchases.payments")}</Text>
                <LinkButton href={data.signInPath} tone="secondary" size="lg" leadingIcon="lock">
                  {t("checkout.routes.checkoutStart.sign.in")}
                </LinkButton>
              </Stack>
            </Surface>
          </PageSection>
        </>
      )}
    </Stack>
  );

  const checkoutMobileSummary = (
    <CheckoutMobileSummaryDisclosure
      label={t("checkout.routes.checkoutStart.checkout.status")}
      collapsedSummary={
        source
          ? source.itemTitle || t("checkout.routes.checkoutStart.buy.now")
          : t("checkout.routes.checkoutStart.item.count", {
              count: data.cartCount,
              itemLabel:
                data.cartCount === 1
                  ? t("checkout.routes.checkoutStart.item")
                  : t("checkout.routes.checkoutStart.items"),
            })
      }
      total={checkoutStatus}
    >
      {checkoutSummary}
    </CheckoutMobileSummaryDisclosure>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.routes.checkoutStart.secure.checkout")}
        title={headerCopy.title}
        description={headerCopy.description}
      />
      <CheckoutFlowShell
        summaryLabel={t("checkout.routes.checkoutStart.checkout.summary")}
        main={checkoutMain}
        desktopSummary={checkoutSummary}
        mobileSummary={checkoutMobileSummary}
      />
    </Page>
  );
}
