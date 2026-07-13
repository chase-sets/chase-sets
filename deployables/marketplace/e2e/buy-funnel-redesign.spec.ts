import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { registerOrSignInSyntheticAccount, signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";
import { logMarketplaceSeedContractGap } from "./support/seed-contract-gap";

// Charter scope: this spec owns the buy-funnel redesign verification (milestone
// #33, issue #1858). It exercises the REDESIGNED surfaces — cart, checkout
// session, and confirmation — and asserts the original cart-review defects are
// CLOSED per the acceptance signals in the closed buy-funnel epic:
// https://github.com/chase-sets/chase-sets/issues/1850.
//
// Defects asserted:
//   1. The literal string "Price at checkout" appears ZERO times across the
//      funnel (replaced by "Estimated total" with a single deferral caption).
//   2. Exactly one primary action per surface (data-primary-action-count="1"
//      on action-hierarchy primitives; cart lines stamp "0").
//   3. Quantity uses the DS QuantityStepper — the underlying input is NOT a
//      bare type="number" with browser native spinners (role="spinbutton" via
//      Base UI NumberField; appearance suppressed by DS styles.css).
//   4. Line items render a designed placeholder (no blank square) when no
//      image: the DS MarketplaceCartLineItem routes through Image primitive
//      whose fallback slot renders the icon placeholder.
//   5. Status messaging is not duplicated: at most one notice is rendered at a
//      time (CheckoutNoticeStack renders only the highest-priority active
//      candidate).
//
// CI lane: tagged @marketplace-checkout so the change-scope
// `marketplace_checkout` suite runs it.

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

const screenshotDir = path.join("artifacts", "playwright", "buy-funnel-screenshots");

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
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
  const titleSlug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
  return {
    email: `buy-funnel-${syntheticAccountRunId}-${syntheticAccountNonce}-${testInfo.workerIndex}-${testInfo.retry}-${titleSlug}@chasesets.test`,
    password: `buy-funnel-${syntheticAccountRunId}-${testInfo.workerIndex}-${testInfo.retry}`,
    displayName: `Buy Funnel ${syntheticAccountRunId} ${syntheticAccountNonce} ${testInfo.workerIndex} ${testInfo.retry}`,
    shouldRegister: true,
  };
}

async function authenticateAccount(page: Page, testInfo: TestInfo) {
  await expectPageOk(page, "/");
  const origin = new URL(page.url()).origin;
  const credentials = marketplaceAccountFor(testInfo);

  if (credentials.shouldRegister) {
    await registerOrSignInSyntheticAccount(page, origin, credentials);
    return;
  }

  await signInWithPassword(page, origin, credentials);
}

async function authenticateSeededBuyer(page: Page) {
  await expectPageOk(page, "/");
  await signInWithPassword(page, new URL(page.url()).origin, marketplaceBrowserE2eBuyerCredentials());
}

async function waitForAccountRoute(page: Page, routePath: string) {
  await expect
    .poll(
      async () => {
        await page.goto(routePath, { waitUntil: "domcontentloaded" });
        return new URL(page.url()).pathname === routePath;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: authProjectionTimeoutMs },
    )
    .toBe(true);
}

async function captureScreenshot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
    fullPage: true,
  });
}

// ─── Helper: assert no "Price at checkout" text anywhere on the page ─────────

async function assertNoPriceAtCheckoutText(page: Page, surfaceName: string) {
  // The redesign replaces the "Price at checkout" repetition with a single
  // "Estimated total" label + one "Final total confirmed at checkout" caption.
  // The literal string must appear zero times across the whole rendered DOM.
  const matches = await page.locator("text=Price at checkout").count();
  expect(matches, `"Price at checkout" must appear 0 times on the ${surfaceName} surface (found ${matches})`).toBe(0);
}

// ─── Helper: assert the single-primary contract per surface ──────────────────

async function assertSinglePrimaryActionPerSurface(page: Page, surfaceName: string) {
  // data-primary-action-count="1" must appear at least once (the action
  // hierarchy primitives stamp it) and every stamped count must be ≤ 1.
  // Cart line cards stamp "0" — that is the per-line contract.
  const allCounts = await page
    .locator("[data-primary-action-count]")
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-primary-action-count"))));

  for (const count of allCounts) {
    expect(count, `Every data-primary-action-count on ${surfaceName} must be ≤ 1 (found ${count})`).toBeLessThanOrEqual(
      1,
    );
  }

  // The surface must have at least one primary-action region stamped.
  expect(allCounts.length, `${surfaceName} should have at least one data-primary-action-count region`).toBeGreaterThan(
    0,
  );
}

// ─── Helper: assert QuantityStepper is in use (not bare type=number) ─────────

async function assertQuantityStepperUsed(page: Page, surfaceName: string) {
  // The DS QuantityStepper builds on Base UI NumberField which renders an
  // <input role="spinbutton" inputMode="numeric"> — not a bare <input type="number">.
  // The browser-native spinner is suppressed by DS styles.css (appearance: none).
  //
  // Assert: there must be at least one stepper input (role="spinbutton") and
  // there must be ZERO inputs with type="number" that still carry the
  // OS-native spinner (we cannot inspect CSS appearance at runtime without
  // getComputedStyle, but we verify the structural contract: the input is
  // role="spinbutton" with inputMode="numeric", not type="number" in the
  // traditional spinner-bearing form).
  // Wait for the first QuantityStepper to hydrate before counting — the cart
  // line renders its Base UI NumberField spinbutton on client hydration, which
  // can land a beat after the line markup, so a bare count can race it.
  await expect(
    page.locator("input[role='spinbutton'][inputmode='numeric']").first(),
    `${surfaceName} should render a hydrated QuantityStepper input`,
  ).toBeVisible({ timeout: 15_000 });
  const stepperInputs = await page.locator("input[role='spinbutton'][inputmode='numeric']").count();
  expect(stepperInputs, `${surfaceName} should have at least one QuantityStepper input`).toBeGreaterThan(0);

  // There must be no VISIBLE bare <input type="number"> without the
  // role="spinbutton" override — i.e. no legacy number-spinner that the DS
  // suppression has not reached. Base UI NumberField's *visible* input carries
  // role="spinbutton"; the primitive ALSO renders a visually-hidden
  // `aria-hidden="true"` `<input type="number" tabindex="-1">` for native form
  // submission (see @base-ui/react NumberFieldRoot, which always emits it). That
  // hidden form input is part of the DS QuantityStepper itself, so it is excluded
  // here — a genuine legacy bare spinner would be a visible, non-aria-hidden input.
  const bareNumberInputs = await page
    .locator("input[type='number']:not([role='spinbutton']):not([aria-hidden='true'])")
    .count();
  expect(
    bareNumberInputs,
    `${surfaceName} must have zero visible bare type="number" inputs without role="spinbutton" (found ${bareNumberInputs})`,
  ).toBe(0);
}

// ─── Helper: assert at most one notice is rendered at a time ─────────────────

async function assertSingleNoticeAtATime(page: Page, surfaceName: string) {
  // CheckoutNoticeStack renders role="status" aria-live="polite" and only
  // populates the one winning candidate. Counting visible [role="status"]
  // regions with non-empty text content reflects that at most one is active.
  //
  // The contract: multiple [role="status"] containers may exist in the DOM
  // (they stay mounted even when empty for ARIA stability), but at most ONE
  // top-level region should contain visible children with substantive text.
  //
  // Count only TOP-LEVEL status regions (those not nested inside another
  // role="status"). A populated cart wraps its optimistic-update items live
  // region in a role="status" and a per-line notice (e.g. a fulfillment-savings
  // suggestion) renders its own nested role="status" inside it — a single
  // logical live-region subtree, not two stacked notices. Counting every
  // descendant role="status" would double-count that nesting; the stacking
  // violation this guards against is multiple SIBLING top-level notice regions.
  const noticeRegions = await page.locator("[role='status']:not([role='status'] [role='status'])").all();
  let activeNoticeCount = 0;
  for (const region of noticeRegions) {
    const text = (await region.textContent()) ?? "";
    if (text.trim().length > 0) {
      activeNoticeCount++;
    }
  }
  expect(
    activeNoticeCount,
    `${surfaceName} must have at most one active top-level notice at a time (found ${activeNoticeCount})`,
  ).toBeLessThanOrEqual(1);
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("buy funnel redesign — defect verification", () => {
  // ── 1. Cart surface (unauthenticated empty state) ─────────────────────────

  test("empty buy cart renders the redesigned surface without price-at-checkout text @marketplace-checkout", async ({
    page,
  }) => {
    // /account/cart is accessible to unauthenticated visitors (anonymous/cookie
    // cart). Verify the route renders cleanly — no root error — and the redesign
    // defect (no "Price at checkout") is already satisfied on the empty surface.
    const response = await page.goto("/account/cart", { waitUntil: "domcontentloaded" });
    expect(response, "cart should return a page response").not.toBeNull();
    expect(response!.status(), "cart should not be a server error").toBeLessThan(500);

    // The cart page renders the "Your cart" heading (the redesigned PageHeader).
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    // Defect 1: "Price at checkout" must be absent entirely.
    await assertNoPriceAtCheckoutText(page, "unauthenticated empty cart");

    await captureScreenshot(page, "cart-unauthenticated-empty");
  });

  // ── 2. Authenticated cart — core redesign defect assertions ───────────────

  test("authenticated buy cart satisfies all redesign acceptance signals @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);
    await waitForAccountRoute(page, "/account/cart");

    // The authenticated cart is now loaded (empty for a fresh account).
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    // Defect 1: "Price at checkout" must be absent entirely.
    await assertNoPriceAtCheckoutText(page, "cart");

    // The redesigned empty state renders "Estimated total" in the StickyCtaBar
    // and CheckoutTotals only when lines are present. On an empty cart the totals
    // section is absent — assert the empty-state recovery surface instead.
    // Heading observed at runtime: "Your buy cart is empty"
    await expect(page.getByRole("heading", { name: /your.*cart.*empty/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Keep shopping$/i }).first()).toBeVisible();

    await assertSingleNoticeAtATime(page, "empty cart");

    // Screenshot: empty cart.
    await captureScreenshot(page, "cart-empty");
  });

  // ── 3. Cart with lines — verify "Estimated total" + stepper + hierarchy ───

  test("buy cart with seeded items shows Estimated total and passes all redesign contracts @marketplace-checkout", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await authenticateSeededBuyer(page);
    await waitForAccountRoute(page, "/account/cart");

    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    // Defect 1: "Price at checkout" must appear ZERO times regardless of
    // whether the cart has items or is empty.
    await assertNoPriceAtCheckoutText(page, "cart");

    const cartLines = page.locator("[data-marketplace-cart-line]");
    await expect(cartLines, "browser-e2e seed contract requires the seeded cart lines").toHaveCount(
      marketplaceBrowserE2eSeedContract.cart.lineCount,
    );

    // Defect 2: Every action-hierarchy region stamps at most one primary.
    // Per-line ActionStack stamps "0"; the StickyCtaBar stamps "1".
    await assertSinglePrimaryActionPerSurface(page, "cart with lines");

    // "Estimated total" must appear as the total label (CheckoutTotals +
    // StickyCtaBar both use the redesigned totalLabel prop).
    await expect(page.locator("text=Estimated total").first()).toBeVisible();

    // "Final total confirmed at checkout" is the single deferral caption —
    // it must appear exactly once as the totalCaption.
    const deferralCaptions = await page.locator("text=Final total confirmed at checkout").count();
    expect(deferralCaptions, '"Final total confirmed at checkout" should appear exactly once').toBe(1);

    // Defect 3: QuantityStepper must be in use per cart line.
    await assertQuantityStepperUsed(page, "cart with lines");

    // Defect 4: no blank image squares — every cart line image slot renders
    // either an actual image or the designed Icon placeholder (never empty).
    // The DS Image primitive routes through a fallback slot; asserting that
    // [data-marketplace-cart-line] children contain an img or the icon
    // placeholder span.
    const cartLineElements = await cartLines.all();
    for (const line of cartLineElements) {
      const hasImg = (await line.locator("img").count()) > 0;
      // The placeholder renders an aria-hidden span with Icon; its presence
      // is indicated by the icon element's surrounding span class.
      const hasPlaceholder = (await line.locator("[aria-hidden='true'] svg").count()) > 0;
      expect(
        hasImg || hasPlaceholder,
        "every cart line image slot must render either an img or the designed placeholder",
      ).toBe(true);
    }

    await assertSingleNoticeAtATime(page, "cart with lines");

    await captureScreenshot(page, "cart-with-lines");
  });

  // ── 4. Checkout session surface (unauthenticated recovery) ────────────────

  test("buy checkout session shows access-recovery surface for missing access — not root error @marketplace-checkout", async ({
    page,
  }) => {
    // This is the canonical composition seam test from critical-flows, extended
    // to also verify the redesign contracts hold on the recovery surface.
    const response = await page.goto("/checkout/buy/session/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });

    expect(response, "checkout recovery should return a page response").not.toBeNull();
    expect(response!.status(), "missing checkout access should not be a server error").toBe(401);
    await expect(page.getByRole("heading", { name: /^Checkout access required$/i })).toBeVisible();
    await expect(page.getByText("Your payment has not started.").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    // Redesign contract: no "Price at checkout" on the recovery surface.
    await assertNoPriceAtCheckoutText(page, "checkout session recovery");

    await captureScreenshot(page, "checkout-session-recovery");
  });

  // ── 5. Checkout session — authenticated + contracts ───────────────────────

  test("authenticated buy checkout session satisfies redesign contracts @marketplace-checkout", async ({ page }) => {
    test.setTimeout(120_000);

    await authenticateSeededBuyer(page);
    await waitForAccountRoute(page, "/account/cart");

    const sessionResponse = await page.goto(
      `/checkout/buy/session/${marketplaceBrowserE2eSeedContract.cart.startedSessionId}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    expect(sessionResponse, "checkout session should return a page response").not.toBeNull();
    expect(sessionResponse!.status(), "checkout session should not be a server error").toBeLessThan(500);
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    // Defect 1: "Price at checkout" must be absent.
    await assertNoPriceAtCheckoutText(page, "checkout session");

    await captureScreenshot(page, "checkout-session-authenticated");

    // The checkout session surface always renders under the "Secure checkout" banner —
    // the reachable checkout-session boundary. Assert it hard.
    await expect(page.getByRole("heading", { name: /^Secure checkout$/i }).first()).toBeVisible();

    // The payment-ready buyer stepper (Contact/Delivery/Shipping/Payment/Review) only
    // renders once checkout deciders start payment. browser-e2e wires no payment provider,
    // so the seeded started-cart session stays on the "Secure checkout" readiness surface
    // ("Checkout needs attention") and never advances to the stepper. Assert the step
    // labels and the redesign single-primary/single-notice contracts only when a
    // payment-ready stepper actually rendered (real/staging env); otherwise log the gap
    // loudly and assert the reachable readiness surface.
    const checkoutSteps = page.locator("[aria-label='Checkout steps']");
    if (await checkoutSteps.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await expect(page.getByText(/^Contact$/i).first()).toBeVisible();
      await expect(page.getByText(/^Delivery$/i).first()).toBeVisible();
      await expect(page.getByText(/^Shipping$/i).first()).toBeVisible();
      await expect(page.getByText(/^Review$/i).first()).toBeVisible();
      await assertSinglePrimaryActionPerSurface(page, "checkout session with stepper");
      await assertSingleNoticeAtATime(page, "checkout session with stepper");
      await captureScreenshot(page, "checkout-session-stepper");
    } else {
      logMarketplaceSeedContractGap(
        "Seeded checkout session did not render the payment-ready buyer stepper: browser-e2e wires no payment " +
          "provider, so the seeded started-cart checkout session stays on the 'Secure checkout' readiness surface. " +
          "The reachable checkout-session redesign contracts are asserted instead.",
      );
      await expect(
        page.getByRole("heading", { name: /Preparing checkout|Checkout needs attention/i }).first(),
      ).toBeVisible();
    }
  });

  // ── 6. Buy checkout confirmation route (unauthenticated — access recovery) ─

  test("buy checkout confirmation shows access-recovery surface — not root error @marketplace-checkout", async ({
    page,
  }) => {
    // The confirmation route for a missing / unauthorized session must render
    // the checkout recovery surface, never the marketplace root error.
    const response = await page.goto("/checkout/buy/confirm/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });

    // The route may return 401/403/404 or redirect — any non-5xx is acceptable.
    expect(response, "confirmation access recovery should return a page response").not.toBeNull();
    expect(response!.status(), "confirmation access recovery must not be a server error").toBeLessThan(500);
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    // Redesign contract.
    await assertNoPriceAtCheckoutText(page, "checkout confirmation recovery");

    await captureScreenshot(page, "checkout-confirmation-recovery");
  });

  // ── 7. Authenticated checkout confirmation — contracts ────────────────────

  test("authenticated buy checkout confirmation satisfies redesign contracts @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);
    await waitForAccountRoute(page, "/account/cart");

    // For a synthetic account there is no real confirmation page; navigate to
    // the buy-checkout-confirmation route with a sentinel session id. The route
    // will return a recovery surface or redirect — assert it is clean and does
    // not render a root error.
    const confirmResponse = await page.goto("/checkout/buy/confirm/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });
    expect(confirmResponse, "authenticated confirmation recovery should return a page response").not.toBeNull();
    expect(confirmResponse!.status(), "confirmation surface must not be a server error").toBeLessThan(500);
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    // Defect 1: "Price at checkout" absent from the confirmation surface.
    await assertNoPriceAtCheckoutText(page, "checkout confirmation");

    await captureScreenshot(page, "checkout-confirmation-authenticated");

    // Missing confirmation access must not render a payment continuation panel.
    await expect(page.locator("text=Continue to payment")).toHaveCount(0);
  });

  // ── 8. Design-system structural contract: QuantityStepper has no bare
  //       type=number spinner across the whole funnel cart page ───────────────

  test("buy cart has no bare native number-spinner inputs (QuantityStepper DS contract) @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);
    await waitForAccountRoute(page, "/account/cart");

    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    // Defect 3 assertion regardless of cart state: there must be zero VISIBLE bare
    // <input type="number"> without role="spinbutton" anywhere on the cart page.
    // Base UI NumberField's visible input sets role="spinbutton" — the legacy
    // NumberInput does not. The primitive also emits a visually-hidden
    // `aria-hidden="true"` `<input type="number">` per field for native form
    // submission, which is DS-compliant and excluded here; any *visible* bare
    // type=number is evidence the old pattern slipped in.
    const bareNumberInputs = await page
      .locator("input[type='number']:not([role='spinbutton']):not([aria-hidden='true'])")
      .count();
    expect(
      bareNumberInputs,
      `Cart must have zero visible bare type="number" inputs without role="spinbutton" (found ${bareNumberInputs}). Use QuantityStepper.`,
    ).toBe(0);

    await captureScreenshot(page, "cart-quantity-stepper-contract");
  });

  // ── 9. Cross-surface: "Estimated total" label and single deferral caption ──

  test("buy cart Estimated total label and single deferred caption contract @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await authenticateSeededBuyer(page);
    await waitForAccountRoute(page, "/account/cart");

    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    // The redesign replaces all "Price at checkout" repetitions with a single
    // "Estimated total" + one "Final total confirmed at checkout" caption. This
    // test verifies the full label vocabulary is correct on the cart surface.
    //
    await expect(
      page.locator("[data-marketplace-cart-line]"),
      "browser-e2e seed contract requires cart lines for the total contract",
    ).toHaveCount(marketplaceBrowserE2eSeedContract.cart.lineCount);

    // "Estimated total" must appear (totalLabel in CheckoutTotals and StickyCtaBar).
    const estimatedTotalCount = await page.locator("text=Estimated total").count();
    expect(estimatedTotalCount, '"Estimated total" must appear at least once on the cart surface').toBeGreaterThan(0);

    // "Final total confirmed at checkout" must appear exactly once
    // (totalCaption in CheckoutTotals).
    const deferralCount = await page.locator("text=Final total confirmed at checkout").count();
    expect(deferralCount, '"Final total confirmed at checkout" must appear exactly once').toBe(1);

    // "Shipping & tax" line must have "Calculated at checkout" (once, muted).
    // Exact match: a ready cart also renders the sticky-bar context copy
    // ("Taxes and shipping are calculated at checkout."), which a
    // case-insensitive substring locator would match a second time.
    const shippingTaxLine = await page.getByText("Calculated at checkout", { exact: true }).count();
    expect(shippingTaxLine, '"Calculated at checkout" should appear exactly once for the shipping/tax line').toBe(1);

    await captureScreenshot(page, "cart-estimated-total-contract");
  });
});
