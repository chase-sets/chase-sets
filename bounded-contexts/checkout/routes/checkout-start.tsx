import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { AuthApiError, createAuthRequestApiClient } from "@chase-sets/auth/server";
import {
  Banner,
  Button,
  BuyerProtectionModule,
  CheckoutLayout,
  LinkButton,
  OrderIntentSummary,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  SecurePaymentIndicator,
  Stack,
  Surface,
  Text,
  TextInput,
  formatMarketplaceNumber,
} from "@chase-sets/design-system";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
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
          .filter(
            (selection): selection is { dimensionId: string; optionId: string } =>
              Boolean(
                selection &&
                  typeof selection === "object" &&
                  "dimensionId" in selection &&
                  "optionId" in selection,
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

function buyNowSourceFromUrl(url: URL) {
  if (url.searchParams.get("source") !== "buy-now") {
    return null;
  }

  return {
    type: "buy-now" as const,
    listingId: url.searchParams.get("listingId") ?? "",
    fulfillmentMode:
      url.searchParams.get("fulfillmentMode") === "locked-listing"
        ? "locked-listing" as const
        : "optimize" as const,
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

function buyNowSourceFromForm(formData: FormData) {
  return {
    type: "buy-now" as const,
    listingId: String(formData.get("listingId") ?? ""),
    fulfillmentMode:
      formData.get("fulfillmentMode") === "locked-listing"
        ? "locked-listing" as const
        : "optimize" as const,
    lockedListingId: String(formData.get("lockedListingId") ?? "") || null,
    catalogItemId: String(formData.get("catalogItemId") ?? ""),
    productId: String(formData.get("productId") ?? ""),
    itemTitle: String(formData.get("itemTitle") ?? ""),
    itemSubtitle: String(formData.get("itemSubtitle") ?? "") || null,
    selectedOptions: parseSelectedOptions(
      String(formData.get("selectedOptions") ?? "[]"),
    ),
    productSummary: String(formData.get("productSummary") ?? "") || null,
    quantity: parseQuantity(formData.get("quantity")),
    priceAmount: String(formData.get("priceAmount") ?? "") || null,
    sellerName: String(formData.get("sellerName") ?? "") || null,
    availability: String(formData.get("availability") ?? "") || null,
    fulfillment: String(formData.get("fulfillment") ?? "") || null,
  };
}

function checkoutSessionRequestFromForm(formData: FormData) {
  return String(formData.get("source") ?? "cart") === "buy-now"
    ? { source: buyNowSourceFromForm(formData) }
    : { source: { type: "cart" as const } };
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
      (body as { error?: { code?: unknown } }).error?.code ===
        ACCOUNT_SIGN_IN_REQUIRED_CODE,
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const url = new URL(request.url);
  const source = buyNowSourceFromUrl(url);
  const api = createCheckoutRequestApiClient(request);
  const cart = actor || source
    ? null
    : await api.getGuestCart(readAnonymousCartId(request));
  const returnTo = currentPathWithSearch(request);

  return {
    isSignedIn: Boolean(actor),
    source,
    cartCount: cart?.count ?? (source ? 1 : 0),
    signInPath: signInPathForReturnTo(returnTo),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const api = createCheckoutRequestApiClient(request);
  const formData = await request.formData();
  const anonymousCartId = readAnonymousCartId(request);

  if (actor) {
    const sourceType = String(formData.get("source") ?? "cart");
    if (sourceType === "cart" && anonymousCartId) {
      await api.mergeGuestCartToAccount(anonymousCartId);
    }

    const session = await api.createCheckoutSession(
      checkoutSessionRequestFromForm(formData),
    );
    const response = redirect(`/checkout/${session.session_id}`);
    if (anonymousCartId) {
      appendClearedAnonymousCartCookie(response.headers);
    }

    return response;
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
        error:
          t("checkout.routes.checkoutStart.sign.in.to.continue.checkout.with.this.email.your.cart"),
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
  const sourceType = String(formData.get("source") ?? "cart");

  if (sourceType === "cart" && anonymousCartId) {
    await guestApi.mergeGuestCartToAccount(anonymousCartId);
  }

  const session = await guestApi.createCheckoutSession(
    checkoutSessionRequestFromForm(formData),
  );
  const response = redirect(`/checkout/${session.session_id}`);
  appendGuestCheckoutCookie(response.headers, guest.guestToken);
  appendClearedAnonymousCartCookie(response.headers);

  return response;
}

export default function CheckoutStartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const source = data.source;
  const sourceFields = source ? (
    <>
      <input type="hidden" name="source" value="buy-now" />
      <input type="hidden" name="listingId" value={source.listingId} />
      <input type="hidden" name="fulfillmentMode" value={source.fulfillmentMode} />
      <input type="hidden" name="lockedListingId" value={source.lockedListingId ?? ""} />
      <input type="hidden" name="catalogItemId" value={source.catalogItemId} />
      <input type="hidden" name="productId" value={source.productId} />
      <input type="hidden" name="itemTitle" value={source.itemTitle} />
      <input type="hidden" name="itemSubtitle" value={source.itemSubtitle ?? ""} />
      <input type="hidden" name="selectedOptions" value={JSON.stringify(source.selectedOptions)} />
      <input type="hidden" name="productSummary" value={source.productSummary ?? ""} />
      <input type="hidden" name="quantity" value={source.quantity} />
      <input type="hidden" name="priceAmount" value={source.priceAmount ?? ""} />
      <input type="hidden" name="sellerName" value={source.sellerName ?? ""} />
      <input type="hidden" name="availability" value={source.availability ?? ""} />
      <input type="hidden" name="fulfillment" value={source.fulfillment ?? ""} />
    </>
  ) : (
    <input type="hidden" name="source" value="cart" />
  );
  const sourceSummary = source ? (
    <OrderIntentSummary
      title={source.itemTitle || t("checkout.routes.checkoutStart.buy.now")}
      subtitle={source.itemSubtitle ?? source.productSummary ?? null}
      price={
        source.priceAmount
          ? `$${source.priceAmount}`
          : t("checkout.routes.checkoutStart.price.confirmed.before.payment")
      }
      quantity={formatMarketplaceNumber(
        source.quantity,
        t("checkout.routes.checkoutStart.quantity.confirmed.before.payment"),
      )}
      seller={source.sellerName ?? t("checkout.routes.checkoutStart.marketplace.seller")}
      availability={source.availability ?? t("checkout.routes.checkoutStart.availability.confirmed.before.payment")}
      fulfillment={source.fulfillment ?? t("checkout.routes.checkoutStart.fulfillment.confirmed.before.payment")}
      protection={t("checkout.routes.checkoutStart.buyer.protection.included")}
      paymentStatus={t("checkout.routes.checkoutStart.not.charged.yet")}
    />
  ) : null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.routes.checkoutStart.secure.checkout")}
        title={data.isSignedIn ? t("checkout.routes.checkoutStart.continue.checkout") : t("checkout.routes.checkoutStart.sign.in.or.continue.as.guest")}
        description={
          data.isSignedIn
            ? t("checkout.routes.checkoutStart.continue.with.your.account.so.purchases.payments")
            : t("checkout.routes.checkoutStart.sign.in.to.keep.orders.with.your.account")
        }
      />
      <CheckoutLayout
        summary={
          <Stack gap={4}>
            <PriceBreakdown
              lines={[
                {
                  label: source ? t("checkout.routes.checkoutStart.source") : t("checkout.routes.checkoutStart.cart"),
                  value: source
                    ? (source.itemTitle || t("checkout.routes.checkoutStart.buy.now"))
                    : t("checkout.routes.checkoutStart.item.count", {
                        count: data.cartCount,
                        itemLabel: data.cartCount === 1
                          ? t("checkout.routes.checkoutStart.item")
                          : t("checkout.routes.checkoutStart.items"),
                      }),
                },
                ...(source
                  ? [
                      {
                        label: t("checkout.routes.checkoutStart.seller"),
                        value: source.sellerName ?? t("checkout.routes.checkoutStart.marketplace.seller"),
                      },
                      {
                        label: t("checkout.routes.checkoutStart.price"),
                        value: source.priceAmount
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
                  value: data.isSignedIn ? t("checkout.routes.checkoutStart.signed.in") : t("checkout.routes.checkoutStart.sign.in.or.guest"),
                },
                {
                  label: t("checkout.routes.checkoutStart.payment"),
                  value: t("checkout.routes.checkoutStart.not.charged.yet"),
                },
              ]}
              total={t("checkout.routes.checkoutStart.ready")}
              totalLabel={t("checkout.routes.checkoutStart.checkout.status")}
              reassurance={<SecurePaymentIndicator label={t("checkout.routes.checkoutStart.secure.payment")} />}
            />
            <BuyerProtectionModule
              items={[
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
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          {sourceSummary}
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

          {data.isSignedIn ? (
            <PageSection title={t("checkout.routes.checkoutStart.account.checkout")}>
              <Surface elevated glow>
                <Form method="post">
                  <Stack gap={3}>
                    <Text tone="secondary">
                      {t("checkout.routes.checkoutStart.continue.with.your.account.any.saved.guest")}
                    </Text>
                    {sourceFields}
                    <Button type="submit" size="lg" leadingIcon="lock">
                      {t("checkout.routes.checkoutStart.continue.to.checkout")}
                    </Button>
                  </Stack>
                </Form>
              </Surface>
            </PageSection>
          ) : (
            <>
              <PageSection title={t("checkout.routes.checkoutStart.account")}>
                <Surface elevated glow>
                  <Stack gap={3}>
                    <Text tone="secondary">
                      {t("checkout.routes.checkoutStart.sign.in.to.keep.purchases.payments")}
                    </Text>
                    <LinkButton href={data.signInPath} size="lg" leadingIcon="lock">
                      {t("checkout.routes.checkoutStart.sign.in")}
                    </LinkButton>
                  </Stack>
                </Surface>
              </PageSection>
              <PageSection title={t("checkout.routes.checkoutStart.guest.checkout")}>
                <Surface elevated>
                  <Form method="post">
                    <Stack gap={3}>
                      <Text tone="secondary">
                        {t("checkout.routes.checkoutStart.continue.as.guest.only.if.you.do")}
                      </Text>
                      <TextInput label={t("checkout.routes.checkoutStart.contact.name")} name="contactName" required />
                      <TextInput label={t("checkout.routes.checkoutStart.email")} name="email" type="email" required />
                      {sourceFields}
                      <Button type="submit" size="lg" tone="secondary" leadingIcon="lock">
                        {t("checkout.routes.checkoutStart.continue.as.guest")}
                      </Button>
                    </Stack>
                  </Form>
                </Surface>
              </PageSection>
            </>
          )}
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
