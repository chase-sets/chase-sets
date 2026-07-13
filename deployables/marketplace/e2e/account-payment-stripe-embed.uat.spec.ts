import { expect, test, type APIRequestContext } from "@playwright/test";
import { signInWithPassword } from "./support/auth";

// Manual staging UAT (issue #3974): the confirmation-card defect cluster left
// one seam entirely untested -- nothing mounted the real Stripe embed,
// confirmed with a card, and asserted the webhook-driven capture landed.
// account-payment.spec.ts deliberately stops at the auth/404 composition
// seams and defers capture/fee-math domain logic to the vitest suites; this
// spec is the browser-level closure of that gap, proving the
// @stripe/stripe-js typed loader against Stripe's real test-mode embed.
//
// Precondition: a pending-payment order created through the normal
// controlled checkout path in Stripe test mode (same precondition contract
// as SMOKE_ORDER_IDS in scripts/stripe-money-smoke-test.mjs; see
// docs/runbooks/money-operations.md "Stripe Money Smoke Test"). This spec
// creates the payment itself from that order via the same API the product
// checkout flow uses, then drives confirmation entirely through the browser
// so the typed loader, the mount, and the Payment Element are exercised for
// real -- not stubbed.
//
// Gate: set STRIPE_EMBED_UAT=true to run. Wired into the money-smoke family,
// not PR CI -- see scripts/e2e-suites.mjs e2eNoSuiteExclusions and the
// "Stripe Embed Confirmation UAT" section of docs/runbooks/money-operations.md.

const runStripeEmbedUat = process.env.STRIPE_EMBED_UAT === "true";
const orderIds = (process.env.STRIPE_EMBED_UAT_ORDER_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const buyerEmail = process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "";
const buyerPassword = process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "";
const paymentMethodCategory = process.env.STRIPE_EMBED_UAT_PAYMENT_METHOD_CATEGORY?.trim() || "card";
const balanceCreditAmount = process.env.STRIPE_EMBED_UAT_BALANCE_CREDIT_AMOUNT?.trim() || "0.00";
const embedReadyTimeoutMs = 60_000;
const captureTimeoutMs = 180_000;

// Stripe's official Payment Element testing guidance: the combined card
// sub-fields render inside one iframe titled "Secure payment input frame"
// with `name`-addressable inputs. https://docs.stripe.com/testing plus
// Stripe's Playwright/Cypress Elements testing docs.
const stripeTestCard = {
  number: "4242424242424242",
  expiry: "12/34",
  cvc: "123",
  postalCode: "94103",
};

test.describe("stripe embed confirmation UAT", () => {
  test("mounts the real Payment Element, confirms with a Stripe test card, and captures via webhook @stripe-embed-uat", async ({
    page,
  }) => {
    test.setTimeout(captureTimeoutMs + 120_000);
    test.skip(!runStripeEmbedUat, "Set STRIPE_EMBED_UAT=true to run the Stripe embed confirmation UAT.");
    test.skip(
      orderIds.length === 0,
      "Set STRIPE_EMBED_UAT_ORDER_IDS to one or more pending-payment order ids created through the normal checkout path in Stripe test mode.",
    );
    test.skip(
      !buyerEmail || !buyerPassword,
      "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Stripe embed confirmation UAT.",
    );

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });

    const paymentId = await createPendingPayment(page.request);

    await page.goto(`/account/payments/${paymentId}`, { waitUntil: "domcontentloaded" });

    const embedContainer = page.getByTestId("payment-element-container");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await expect(page.getByTestId("payment-element-skeleton")).toHaveCount(0, { timeout: embedReadyTimeoutMs });

    const stripeFrame = page.frameLocator('iframe[title="Secure payment input frame"]');
    await stripeFrame.locator('input[name="number"]').fill(stripeTestCard.number);
    await stripeFrame.locator('input[name="expiry"]').fill(stripeTestCard.expiry);
    await stripeFrame.locator('input[name="cvc"]').fill(stripeTestCard.cvc);
    const postalCode = stripeFrame.locator('input[name="postalCode"]');
    if (await postalCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await postalCode.fill(stripeTestCard.postalCode);
    }

    await page
      .getByRole("button", { name: /^Confirm payment$/i })
      .first()
      .click();

    // The confirmation card itself only flips out of "processing" once the
    // route revalidates against webhook-delivered truth (see
    // StripeConfirmationCard's poll effect). Poll the payment resource
    // directly so this assertion fails on the webhook leg specifically, not
    // on client-side UI state.
    await expect
      .poll(
        async () => {
          const current = await getJson(page.request, `/api/marketplace/account/payments/${paymentId}`);
          return current.status;
        },
        {
          message: "payment did not reach captured status -- webhook-driven capture did not land",
          intervals: [2_000, 5_000, 10_000],
          timeout: captureTimeoutMs,
        },
      )
      .toBe("captured");
  });
});

async function getJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), `${path} failed with ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function createPendingPayment(request: APIRequestContext): Promise<string> {
  const statusQuery = orderIds.map((orderId) => `orderId=${encodeURIComponent(orderId)}`).join("&");
  const status = await getJson(request, `/api/marketplace/account/checkout/status?${statusQuery}`);
  expect(
    status.can_start_payment,
    "checkout status must allow starting a payment for STRIPE_EMBED_UAT_ORDER_IDS -- confirm those order ids are pending-payment and unclaimed",
  ).toBe(true);

  const created = await request.post("/api/marketplace/account/payments", {
    data: {
      orderIds,
      currencyCode: "usd",
      requestedBalanceCreditAmount: balanceCreditAmount,
      paymentMethodCategory,
      marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
    },
  });
  expect(created.ok(), `payment creation failed with ${created.status()}: ${await created.text()}`).toBe(true);
  const payment = await created.json();
  const paymentId = payment.payment_id as string | undefined;
  expect(paymentId, "payment creation did not return a payment_id").toBeTruthy();

  return paymentId!;
}
