import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { AuthApiError, createAuthRequestApiClient } from "@chase-sets/auth/server";
import {
  Banner,
  Button,
  CheckoutLayout,
  LinkButton,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  TextInput,
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

function buyNowSourceFromUrl(url: URL) {
  if (url.searchParams.get("source") !== "buy-now") {
    return null;
  }

  return {
    type: "buy-now" as const,
    listingId: url.searchParams.get("listingId") ?? "",
    catalogItemId: url.searchParams.get("catalogItemId") ?? "",
    productId: url.searchParams.get("productId") ?? "",
    itemTitle: url.searchParams.get("itemTitle") ?? "",
    itemSubtitle: url.searchParams.get("itemSubtitle") || null,
    selectedOptions: parseSelectedOptions(url.searchParams.get("selectedOptions")),
    productSummary: url.searchParams.get("productSummary") || null,
    quantity: Number(url.searchParams.get("quantity") ?? 1),
  };
}

function buyNowSourceFromForm(formData: FormData) {
  return {
    type: "buy-now" as const,
    listingId: String(formData.get("listingId") ?? ""),
    catalogItemId: String(formData.get("catalogItemId") ?? ""),
    productId: String(formData.get("productId") ?? ""),
    itemTitle: String(formData.get("itemTitle") ?? ""),
    itemSubtitle: String(formData.get("itemSubtitle") ?? "") || null,
    selectedOptions: parseSelectedOptions(
      String(formData.get("selectedOptions") ?? "[]"),
    ),
    productSummary: String(formData.get("productSummary") ?? "") || null,
    quantity: Number(formData.get("quantity") ?? 1),
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
          "Sign in to continue checkout with this email. Your cart will stay ready.",
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
      <input type="hidden" name="catalogItemId" value={source.catalogItemId} />
      <input type="hidden" name="productId" value={source.productId} />
      <input type="hidden" name="itemTitle" value={source.itemTitle} />
      <input type="hidden" name="itemSubtitle" value={source.itemSubtitle ?? ""} />
      <input type="hidden" name="selectedOptions" value={JSON.stringify(source.selectedOptions)} />
      <input type="hidden" name="productSummary" value={source.productSummary ?? ""} />
      <input type="hidden" name="quantity" value={source.quantity} />
    </>
  ) : (
    <input type="hidden" name="source" value="cart" />
  );

  return (
    <Page>
      <PageHeader
        eyebrow="Secure checkout"
        title={data.isSignedIn ? "Continue checkout" : "Sign in or continue as guest"}
        description={
          data.isSignedIn
            ? "Continue with your account so purchases, payments, and order history stay together."
            : "Sign in to keep orders with your account, or continue as guest with an email receipt."
        }
      />
      <CheckoutLayout
        summary={
          <OrderSummary
            title="Checkout summary"
            lines={[
              {
                label: source ? "Source" : "Cart",
                value: source ? "Buy Now" : `${data.cartCount} item${data.cartCount === 1 ? "" : "s"}`,
              },
            ]}
            total="Ready"
            totalLabel="Status"
          />
        }
      >
        <Stack gap={4}>
          {actionData && "error" in actionData ? (
            <Banner
              title="Sign in required"
              description={actionData.error}
              tone="warning"
              actions={
                <LinkButton href={actionData.signInPath} tone="secondary">
                  Sign in
                </LinkButton>
              }
            />
          ) : null}

          {data.isSignedIn ? (
            <PageSection title="Account checkout">
              <Surface elevated glow>
                <Form method="post">
                  <Stack gap={3}>
                    <Text tone="secondary">
                      Continue with your account. Any saved guest cart items will be moved into your account cart before checkout starts.
                    </Text>
                    {sourceFields}
                    <Button type="submit" size="lg" leadingIcon="lock">
                      Continue to checkout
                    </Button>
                  </Stack>
                </Form>
              </Surface>
            </PageSection>
          ) : (
            <>
              <PageSection title="Account">
                <Surface elevated glow>
                  <Stack gap={3}>
                    <Text tone="secondary">
                      Sign in to keep purchases, payments, and order history under your account.
                    </Text>
                    <LinkButton href={data.signInPath} size="lg" leadingIcon="lock">
                      Sign in
                    </LinkButton>
                  </Stack>
                </Surface>
              </PageSection>
              <PageSection title="Guest checkout">
                <Surface elevated>
                  <Form method="post">
                    <Stack gap={3}>
                      <Text tone="secondary">
                        Continue as guest only if you do not already have an account. We will use this email for your receipt and order recovery.
                      </Text>
                      <TextInput label="Contact name" name="contactName" required />
                      <TextInput label="Email" name="email" type="email" required />
                      {sourceFields}
                      <Button type="submit" size="lg" tone="secondary" leadingIcon="lock">
                        Continue as guest
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
