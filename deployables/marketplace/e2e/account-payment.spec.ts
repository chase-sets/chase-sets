import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { registerOrSignInSyntheticAccount, signInWithPassword } from "./support/auth";

// Charter scope: this spec owns the payment-confirmation composition wiring real
// browsers exercise on the decomposed `account/payments/:paymentId` (signed-in) and
// `checkout/payments/:paymentId` (guest) routes -- the auth gate + returnTo handoff
// into the Stripe confirmation surface, and the guest claim-prompt entry point that
// SSRs a recovery surface instead of a root error when a claim link is expired. It
// does NOT re-test payments/checkout domain logic (capture, fee math, claim token
// lifecycle), which the vitest account-payment suites own.
//
// A captured-payment confirmation render with a live guest claim prompt requires a
// completed buy checkout that mints a real payment + claim context; the vitest suites
// already prove that surface and its claim flow. Re-minting it through the browser
// would duplicate domain coverage and add a flaky multi-step money fixture, so the
// browser layer asserts the composition seams launch risk actually lives in: the auth
// redirect, the confirmation-surface error boundary, and the guest claim entry point.
//
// CI lane: tagged @marketplace-checkout so the change-scope `marketplace_checkout`
// suite (selected for the account-payment/checkout-payment routes and root
// browser-runtime changes) runs it. Playwright auto-discovers this file via the
// marketplace testMatch glob.

const configuredMarketplaceAccount = {
  email: process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "",
  password: process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "",
};

const syntheticAccountRunId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}-${process.pid}`)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .slice(0, 12);
const syntheticAccountNonce = Math.random().toString(36).slice(2, 8);
const authProjectionTimeoutMs = 90_000;

// New accounts become authorized for orders.view only after the auth projection
// drains; poll a real signed-in commerce route until the session stops bouncing to
// sign-in before exercising the payment confirmation surface.
async function waitForAuthorizedSession(page: Page, readyPath: string) {
  await expect
    .poll(
      async () => {
        await page.goto(readyPath, { waitUntil: "domcontentloaded" });
        return new URL(page.url()).pathname === readyPath;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: authProjectionTimeoutMs },
    )
    .toBe(true);
}

// Navigate to a route expected to resolve to its not-found recovery surface,
// retrying past transient upstream 5xx (e.g. auth-actor resolution 502 during
// warmup) so the assertion reflects route composition rather than warmup noise.
async function gotoExpectingNotFound(page: Page, path: string) {
  let response = await page.goto(path, { waitUntil: "domcontentloaded" });
  if (response && response.status() >= 500) {
    await expect
      .poll(
        async () => {
          response = await page.goto(path, { waitUntil: "domcontentloaded" });
          return response && response.status() >= 500 ? "retry" : "ready";
        },
        { intervals: [1_000, 2_000, 5_000], timeout: authProjectionTimeoutMs },
      )
      .toBe("ready");
  }
  expect(response, `${path} did not return a page response`).not.toBeNull();
  return response!;
}

function marketplaceAccountFor(testInfo: TestInfo) {
  if (configuredMarketplaceAccount.email) {
    if (!configuredMarketplaceAccount.password) {
      throw new Error("MARKETPLACE_E2E_PASSWORD is required when MARKETPLACE_E2E_EMAIL is configured.");
    }

    return {
      email: configuredMarketplaceAccount.email,
      password: configuredMarketplaceAccount.password,
      displayName: "Marketplace E2E Account",
      shouldRegister: false,
    };
  }

  return {
    email: `account-payment-${syntheticAccountRunId}-${syntheticAccountNonce}-${testInfo.workerIndex}-${testInfo.retry}@chasesets.test`,
    password: `account-payment-${syntheticAccountRunId}-${testInfo.workerIndex}-${testInfo.retry}`,
    displayName: `Account Payment ${syntheticAccountRunId} ${syntheticAccountNonce} ${testInfo.workerIndex} ${testInfo.retry}`,
    shouldRegister: true,
  };
}

async function authenticateAccount(page: Page, testInfo: TestInfo) {
  // The caller has already navigated to a marketplace page; derive the origin from
  // the live URL rather than a fragile extra round-trip to the index route.
  const origin = new URL(page.url()).origin;
  const credentials = marketplaceAccountFor(testInfo);

  if (credentials.shouldRegister) {
    await registerOrSignInSyntheticAccount(page, origin, credentials);
    return;
  }

  await signInWithPassword(page, origin, credentials);
}

test.describe("marketplace account payment", () => {
  test("signed-out account-payment access preserves the return path into the confirmation surface @marketplace-checkout", async ({
    page,
  }) => {
    // The signed-in confirmation route gates on auth: an unauthenticated visitor
    // must be handed to sign-in with the payment path preserved, never dropped on a
    // root error.
    const paymentPath = "/account/payments/pay_e2e_confirmation";
    await page.goto(paymentPath);
    await expect(page).toHaveURL(/\/sign-in/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(paymentPath);
    await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("authenticated account-payment confirmation surface SSRs recovery for a missing payment @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await authenticateAccount(page, testInfo);
    await waitForAuthorizedSession(page, "/account/purchases");

    // The confirmation surface composition path: a signed-in account hitting a
    // payment id that does not exist must render the secure-checkout recovery
    // surface (Payment not found) via the route error boundary, not the marketplace
    // root error. Retry through transient auth-resolution 5xx blips so the assertion
    // measures route composition, not upstream warmup.
    const response = await gotoExpectingNotFound(page, "/account/payments/pay_e2e_missing");
    expect(response.status(), "missing payment should be a not-found, not a server error").toBe(404);
    await expect(page.getByText(/Secure Checkout/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Payment not found\.?$/i }).first()).toBeVisible();
    await expect(page.getByText(/Your payment has not started\./i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("guest checkout-payment claim entry point SSRs an expired-link recovery surface @marketplace-checkout", async ({
    page,
  }) => {
    // The guest claim prompt is gated by the guest checkout-payment loader. An
    // expired/invalid claim link must SSR the guest expired-link recovery surface
    // (401) that offers a path back to the cart -- never the marketplace root error.
    const response = await page.goto("/checkout/payments/pay_e2e_guest_claim", { waitUntil: "domcontentloaded" });
    expect(response, "guest checkout-payment should return a page response").not.toBeNull();
    expect(response!.status(), "an expired guest claim link should not be a server error").toBe(401);
    await expect(page.getByText(/Secure Checkout/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Payment link expired$/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Return to buy cart$/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });
});
