import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { Form, useLoaderData } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createAuthRequestApiClient } from "@chase-sets/auth/server";
import {
  Button,
  CheckoutLayout,
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

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  if (actor) {
    throw redirect("/account/cart");
  }

  const url = new URL(request.url);
  const source = buyNowSourceFromUrl(url);
  const api = createCheckoutRequestApiClient(request);
  const cart = source ? null : await api.getGuestCart(readAnonymousCartId(request));

  return {
    source,
    cartCount: cart?.count ?? (source ? 1 : 0),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const api = createCheckoutRequestApiClient(request);

  if (actor) {
    const session = await api.createCheckoutSession({ source: { type: "cart" } });

    return redirect(`/checkout/${session.session_id}`);
  }

  const formData = await request.formData();
  const contactName = String(formData.get("contactName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const authApi = createAuthRequestApiClient(request);
  const guest = await authApi.startGuestCheckout<{
    accountId: string;
    guestToken: string;
    expiresAt: string;
  }>({
    displayName: contactName,
    email,
  });
  const guestApi = createCheckoutRequestApiClient(request, {
    headers: {
      cookie: `${CHECKOUT_GUEST_COOKIE_NAME}=${encodeURIComponent(guest.guestToken)}`,
    },
  });
  const sourceType = String(formData.get("source") ?? "cart");
  const anonymousCartId = readAnonymousCartId(request);

  if (sourceType === "cart" && anonymousCartId) {
    await guestApi.mergeGuestCartToAccount(anonymousCartId);
  }

  const session = await guestApi.createCheckoutSession(
    sourceType === "buy-now"
      ? {
          source: {
            type: "buy-now",
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
          },
        }
      : { source: { type: "cart" } },
  );
  const response = redirect(`/checkout/${session.session_id}`);
  appendGuestCheckoutCookie(response.headers, guest.guestToken);
  appendClearedAnonymousCartCookie(response.headers);

  return response;
}

export default function CheckoutStartRoute() {
  const data = useLoaderData<typeof loader>();
  const source = data.source;

  return (
    <Page>
      <PageHeader
        eyebrow="Guest checkout"
        title="Continue as guest"
        description="Enter your contact details to continue checkout. You can save the order with a passkey after payment."
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
        <PageSection title="Contact">
          <Surface elevated glow>
            <Form method="post">
              <Stack gap={3}>
                <Text tone="secondary">
                  Continue as guest. We will use this email for your receipt and order recovery.
                </Text>
                <TextInput label="Contact name" name="contactName" required />
                <TextInput label="Email" name="email" type="email" required />
                {source ? (
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
                )}
                <Button type="submit" size="lg" leadingIcon="lock">
                  Continue to checkout
                </Button>
              </Stack>
            </Form>
          </Surface>
        </PageSection>
      </CheckoutLayout>
    </Page>
  );
}
