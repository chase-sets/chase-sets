import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, redirectDocument } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { AuthApiError, createAuthRequestApiClient } from "@chase-sets/auth/server";
import {
  Form,
  Banner,
  Button,
  OrderProtectionModule,
  CheckoutLayout,
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
  createCheckoutRequestApiClient,
  type CreateCheckoutSessionRequest,
} from "../support/request-support/api-client";
import {
  checkoutRecoveryForError,
  checkoutRecoveryForKind,
  type CheckoutRecovery,
} from "../support/request-support/checkout-recovery";
import {
  appendClearedAnonymousCartCookie,
  appendGuestCheckoutCookie,
  CHECKOUT_GUEST_COOKIE_NAME,
  readAnonymousCartId,
} from "../support/request-support/guest-checkout";

const ACCOUNT_SIGN_IN_REQUIRED_CODE = "account_sign_in_required";

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
    return { source };
  }

  if (sourceType === "buy-now") {
    const source = sourceFromForm(formData);
    if (source.type !== "buy-now") {
      throw new Error("Buy now source was not preserved.");
    }
    return { source };
  }

  return { source: { type: "cart" as const } };
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

function signInPathForReturnTo(returnTo: string) {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
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

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const url = new URL(request.url);
  const source = sourceFromUrl(url);
  const api = createCheckoutRequestApiClient(request);
  const cart = actor || source ? null : await api.getGuestCart(readAnonymousCartId(request));
  const returnTo = currentPathWithSearch(request);
  const isGuestBuyer = actor?.roleKey === "guest-buyer";

  return {
    isSignedIn: Boolean(actor && !isGuestBuyer),
    isGuestBuyer,
    source,
    cartCount: cart?.count ?? (source ? 1 : 0),
    signInPath: signInPathForReturnTo(returnTo),
  };
}

type CheckoutStartActionData =
  | Readonly<{ error: string; signInPath: string }>
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
      if (sourceType === "cart" && anonymousCartId) {
        await api.mergeGuestCartToAccount(anonymousCartId);
      }

      const session = await api.createCheckoutSession(checkoutSessionRequestFromForm(formData));
      const response = redirect(appendFreshWriteToken(`/checkout/${session.session_id}`, session));
      if (anonymousCartId) {
        appendClearedAnonymousCartCookie(response.headers, request);
      }

      return response;
    } catch (error) {
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

  const contactName = String(formData.get("contactName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const authApi = createAuthRequestApiClient(request);
  let guest: {
    accountId: string;
    guestToken: string;
    expiresAt: string;
  };

  try {
    guest = await authApi.startGuestCheckout<{
      accountId: string;
      guestToken: string;
      expiresAt: string;
    }>({
      displayName: contactName,
      email,
    });
  } catch (error) {
    if (isAccountSignInRequiredError(error)) {
      return {
        error: t("checkout.routes.checkoutStart.sign.in.to.continue.checkout.with.this.email.your.cart"),
        signInPath: signInPathForReturnTo(currentPathWithSearch(request)),
      };
    }

    throw error;
  }

  const guestApi = createCheckoutRequestApiClient(request, {
    headers: {
      cookie: `${CHECKOUT_GUEST_COOKIE_NAME}=${encodeURIComponent(guest.guestToken)}`,
    },
  });
  try {
    if (sourceType === "cart" && anonymousCartId) {
      await guestApi.mergeGuestCartToAccount(anonymousCartId);
    }

    const session = await guestApi.createCheckoutSession(checkoutSessionRequestFromForm(formData));
    const response = redirectDocument(appendFreshWriteToken(`/checkout/${session.session_id}`, session));
    appendGuestCheckoutCookie(response.headers, guest.guestToken, request);
    appendClearedAnonymousCartCookie(response.headers, request);

    return response;
  } catch (error) {
    return recoverCheckoutStartError(error, actor, request);
  }
}

export default function CheckoutStartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as CheckoutStartActionData | undefined;
  const source = data.source;
  const isOfferIntent = source?.type === "offer-intent";
  const headerCopy = checkoutStartHeaderCopy({
    isSignedIn: data.isSignedIn,
    isOfferIntent,
  });
  const signInReturnTo = new URLSearchParams(data.signInPath.split("?")[1] ?? "").get("returnTo") ?? "/checkout/start";
  const registerPath = `/register?returnTo=${encodeURIComponent(signInReturnTo)}`;
  const sourceFields = source ? (
    <>
      <input type="hidden" name="source" value={source.type} />
      {"listingId" in source ? <input type="hidden" name="listingId" value={source.listingId} /> : null}
      {"fulfillmentMode" in source ? (
        <input type="hidden" name="fulfillmentMode" value={source.fulfillmentMode} />
      ) : null}
      {"lockedListingId" in source ? (
        <input type="hidden" name="lockedListingId" value={source.lockedListingId ?? ""} />
      ) : null}
      <input type="hidden" name="catalogItemId" value={source.catalogItemId} />
      <input type="hidden" name="productId" value={source.productId} />
      <input type="hidden" name="itemTitle" value={source.itemTitle} />
      <input type="hidden" name="itemSubtitle" value={source.itemSubtitle ?? ""} />
      <input type="hidden" name="selectedOptions" value={JSON.stringify(source.selectedOptions)} />
      <input type="hidden" name="productSummary" value={source.productSummary ?? ""} />
      <input type="hidden" name="quantity" value={source.quantity} />
      {"offerPriceAmount" in source ? (
        <input type="hidden" name="offerPriceAmount" value={source.offerPriceAmount} />
      ) : null}
      {"priceAmount" in source ? <input type="hidden" name="priceAmount" value={source.priceAmount ?? ""} /> : null}
      {"sellerName" in source ? <input type="hidden" name="sellerName" value={source.sellerName ?? ""} /> : null}
      {"availability" in source ? <input type="hidden" name="availability" value={source.availability ?? ""} /> : null}
      {"fulfillment" in source ? <input type="hidden" name="fulfillment" value={source.fulfillment ?? ""} /> : null}
    </>
  ) : (
    <input type="hidden" name="source" value="cart" />
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

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.routes.checkoutStart.secure.checkout")}
        title={headerCopy.title}
        description={headerCopy.description}
      />
      <CheckoutLayout
        summaryLabel="Checkout summary"
        summary={
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
              total={t("checkout.routes.checkoutStart.ready")}
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
        }
      >
        <Stack gap={4}>
          {sourceSummary}
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

          {data.isSignedIn || data.isGuestBuyer ? (
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
                      <TextInput label={t("checkout.routes.checkoutStart.contact.name")} name="contactName" required />
                      <TextInput label={t("checkout.routes.checkoutStart.email")} name="email" type="email" required />
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
                    <Text tone="secondary">
                      {t("checkout.routes.checkoutStart.sign.in.to.keep.purchases.payments")}
                    </Text>
                    <LinkButton href={data.signInPath} tone="secondary" size="lg" leadingIcon="lock">
                      {t("checkout.routes.checkoutStart.sign.in")}
                    </LinkButton>
                  </Stack>
                </Surface>
              </PageSection>
            </>
          )}
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
