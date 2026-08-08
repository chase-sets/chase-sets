import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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

// #6015 AC-08. The Ink & Foil re-value hands Stripe a set of appearance values this
// repository has never sent before, including a dark --border that is an rgba() alpha
// hairline rather than a hex. Whether Stripe accepts an alpha colour in colorBorder and
// in the .Input / .Block rule borders is a provider fact; internal fixtures have passed
// every internal gate and still been rejected live (#5811).
//
// Stripe reports a rejected or unparsable appearance value as a console warning, not as
// a failed promise, so an unstyled Element otherwise reads as a green run. These helpers
// promote that console traffic to a test failure and record the transcript at the exact
// lifecycle moments the appearance object is consumed.
const stripeAppearanceRejectionPattern =
  /IntegrationError|Invalid value for (?:appearance|elements)|Unrecognized (?:appearance )?(?:variable|rule|property)|appearance\.(?:variables|rules)|Unsupported (?:CSS )?(?:value|property)/i;

type ConsoleTranscript = {
  readonly entries: string[];
  readonly rejections: string[];
};

function watchStripeConsole(page: Page): ConsoleTranscript {
  const entries: string[] = [];
  const rejections: string[] = [];

  page.on("console", (message) => {
    const entry = `[${message.type()}] ${message.text()}`;
    entries.push(entry);
    if (stripeAppearanceRejectionPattern.test(message.text())) {
      rejections.push(entry);
    }
  });
  page.on("pageerror", (error) => {
    const entry = `[pageerror] ${error.message}`;
    entries.push(entry);
    if (stripeAppearanceRejectionPattern.test(error.message)) {
      rejections.push(entry);
    }
  });

  return { entries, rejections };
}

async function recordLifecycleMoment(page: Page, transcript: ConsoleTranscript, moment: string) {
  await test.info().attach(`stripe-appearance:${moment}:console`, {
    body: transcript.entries.join("\n") || "<no console output>",
    contentType: "text/plain",
  });
  await test.info().attach(`stripe-appearance:${moment}:screenshot`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  expect(
    transcript.rejections,
    `Stripe rejected or warned on an appearance value at the '${moment}' lifecycle moment`,
  ).toEqual([]);
}

// The dark tokens reach Stripe only on the mode transition: observeStripeAppearance
// watches data-color-mode and re-issues elements.update({ appearance }). Asserting the
// light mount alone proves nothing about the dark values.
async function toggleColorMode(page: Page, mode: "light" | "dark") {
  const root = page.locator("[data-chase-theme]").first();
  await expect(root).toBeVisible();
  await root.evaluate((element, nextMode) => element.setAttribute("data-color-mode", nextMode), mode);
  await expect(root).toHaveAttribute("data-color-mode", mode);
}

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

    const transcript = watchStripeConsole(page);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });

    const paymentId = await createPendingPayment(page.request);

    await page.goto(`/account/payments/${paymentId}`, { waitUntil: "domcontentloaded" });

    const embedContainer = page.getByTestId("payment-element-container");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await expect(page.getByTestId("payment-element-skeleton")).toHaveCount(0, { timeout: embedReadyTimeoutMs });

    // Lifecycle moment 1: the mount request completed with the light appearance.
    await toggleColorMode(page, "light");
    await recordLifecycleMoment(page, transcript, "elements-mount-light");

    // Lifecycle moment 2: the mode change drives elements.update({ appearance }) with
    // the dark values, including the rgba() border anchor.
    await toggleColorMode(page, "dark");
    await expect(embedContainer).toBeVisible();
    await recordLifecycleMoment(page, transcript, "elements-update-dark");

    await toggleColorMode(page, "light");

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

    await recordLifecycleMoment(page, transcript, "elements-post-confirmation");
  });

  // Lifecycle moment 3. createStripeConnectAppearance emits an entirely different
  // variable set (actionPrimaryColorText, badgeNeutralColorBorder,
  // formHighlightColorBorder, ...) than the Elements object, so Stripe's acceptance of
  // the Elements appearance proves nothing about the Connect one.
  test("initialises the Connect embedded component with the re-valued appearance @stripe-embed-uat", async ({
    page,
  }) => {
    test.setTimeout(embedReadyTimeoutMs + 120_000);
    test.skip(!runStripeEmbedUat, "Set STRIPE_EMBED_UAT=true to run the Stripe embed confirmation UAT.");
    test.skip(
      !buyerEmail || !buyerPassword,
      "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Stripe embed confirmation UAT.",
    );

    const transcript = watchStripeConsole(page);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpayouts%2Fsetup");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });
    await page.goto("/account/payouts/setup", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: embedReadyTimeoutMs });

    await toggleColorMode(page, "light");
    await recordLifecycleMoment(page, transcript, "connect-initialisation-light");

    await toggleColorMode(page, "dark");
    await recordLifecycleMoment(page, transcript, "connect-initialisation-dark");
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
