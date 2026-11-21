import { expect, test } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { registerSyntheticAccount, signInThroughMarketplaceForm, syntheticAccountFor } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

test.describe("marketplace buyer purchase journey", () => {
  test("phone buyer searches, adds a product and reaches payment review @marketplace-checkout @mobile @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    async function expectNoHorizontalOverflow(step: string) {
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${step} must fit the phone viewport`).toBeLessThanOrEqual(page.viewportSize()!.width);
    }

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await registerSyntheticAccount(page, new URL(page.url()).origin, syntheticAccountFor(testInfo), {
      freshReadRoute: "/account",
    });
    const line = page.locator("[data-marketplace-cart-line]");
    if (testInfo.retry > 0) {
      await page.goto("/account/cart", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/account\/cart$/);
      // The retry resumes this test's account; an earlier attempt may have added the product.
      if (await line.count()) {
        const removal = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            /\/account\/cart(?:\.data)?$/.test(new URL(response.url()).pathname),
        );
        await line.getByRole("button", { name: "Remove", exact: true }).tap();
        expect((await removal).ok()).toBe(true);
        await expect(line).toHaveCount(0);
      }
    }
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const search = page.getByRole("combobox", { name: "Search marketplace" });
    await expect(search).toBeVisible();
    await expect(async () => {
      await search.tap();
      await search.fill("charizard");
      await search.press("Enter");
      await expect(page).toHaveURL(/\/search\?q=charizard$/, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    const detailPath = marketplaceBrowserE2eSeedContract.itemDetail.routePath;
    const result = page.locator(`article > a[href="${detailPath}"]`);
    await expect(result).toBeVisible();
    await expectNoHorizontalOverflow("Search results");
    await result.tap();
    await expect(page).toHaveURL(new URL(detailPath, page.url()).href);

    const buy = page.getByTestId("product-detail-mobile-dock").getByRole("button", { name: "Buy" });
    await expect(buy).toBeVisible();
    await expectNoHorizontalOverflow("Item detail");
    const buyDialog = page.getByRole("dialog");
    await expect(async () => {
      await buy.tap();
      await expect(buyDialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await buyDialog.getByRole("button", { name: /^Selected product/ }).tap();
    const addToCart = buyDialog.getByRole("button", { name: "Add product to Buy Cart" });
    await expect(addToCart).toBeVisible();
    await expectNoHorizontalOverflow("Add to Buy Cart");
    await addToCart.tap();
    const viewCart = buyDialog.getByRole("link", { name: "View buy cart" });
    await expect(viewCart).toBeVisible();
    await expectNoHorizontalOverflow("Added to Buy Cart");
    await viewCart.tap();
    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);

    await expect(line).toHaveCount(1);
    await expect(line).toContainText("Charizard");
    await expectNoHorizontalOverflow("Buy Cart");
    const quantity = line.getByRole("spinbutton", { name: "Quantity" });
    await expect(quantity).toHaveValue("1");
    const increase = line.getByRole("button", { name: "Increase" });
    await expect(increase).toBeVisible();
    await increase.tap();
    await expect(quantity).toHaveValue("2");
    const quantityStatus = line.locator("[data-optimistic-status]").filter({
      has: page.getByRole("spinbutton", { name: "Quantity" }),
    });
    await expect(quantityStatus).toHaveAttribute("data-optimistic-status", "idle");
    await expect(quantity).toHaveValue("2");
    await expectNoHorizontalOverflow("Updated Buy Cart");
    const cartUrl = new URL(page.url());
    await captureResponsiveEvidence({
      page,
      testInfo,
      claimId: "mobile-buy-cart-quantity",
      routePath: cartUrl.pathname + cartUrl.search,
    });

    const checkout = page.getByRole("button", { name: "Check out", exact: true }).filter({ visible: true });
    await expect(checkout).toBeVisible();
    await checkout.tap();
    await expect(page).toHaveURL(/\/checkout\/buy\/session\/[^/?]+/);
    await expect(page.getByText("Payment review comes next", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow("Payment review");
  });

  test("seeded buyer submits the marketplace sign-in form @marketplace-account @browser-e2e-seed", async ({ page }) => {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());

    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();
  });

  test("seeded buyer walks the real cart to the checkout-session boundary @marketplace-checkout @browser-e2e-seed", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());
    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    // The seeded buyer's cart is genuinely non-vacuous: exactly the seeded line count,
    // the redesigned "Estimated total" label, and the single deferral caption. These are
    // hard contracts backed by real seed data (checkout_cart_line_pages for the collector
    // account), so they stay hard.
    const cartLines = page.locator("[data-marketplace-cart-line]");
    await expect(
      cartLines,
      `browser-e2e seed contract requires ${marketplaceBrowserE2eSeedContract.cart.lineCount} cart lines for ${marketplaceBrowserE2eSeedContract.buyer.email}`,
    ).toHaveCount(marketplaceBrowserE2eSeedContract.cart.lineCount);
    await expect(page.getByText("Estimated total").first()).toBeVisible();
    await expect(page.getByText("Final total confirmed at checkout")).toHaveCount(1);

    // Clicking "Check out" creates a REAL checkout session from the seeded cart and
    // navigates to it — a genuine, non-vacuous hand-off from cart to the checkout
    // context. This stays hard.
    const checkoutButton = page.getByRole("button", { name: /^Check out$/i }).first();
    await expect(checkoutButton, "browser-e2e seed contract requires a ready buyer cart").toBeVisible();
    await checkoutButton.click();

    await expect(page).toHaveURL(/\/checkout\/buy\/session\/[^/?]+/);

    // The seeded collector's email is unverified (the identity seed gives it no verifiedAt), so
    // Auth withholds orders.manage and Payments would refuse to start the payment. Checkout
    // offers email verification where Pay now would be and reserves and orders nothing until
    // the buyer verifies; the link signs in by magic link and returns to this session.
    const verifyEmail = page.getByRole("link", { name: /^Verify your email to pay$/i }).first();
    await expect(
      verifyEmail,
      "an unverified buyer must be offered email verification in place of Pay now",
    ).toBeVisible();
    await expect(verifyEmail).toHaveAttribute(
      "href",
      /^\/sign-in\?returnTo=%2Fcheckout%2Fbuy%2Fsession%2F[^&]+%3FverifyEmail%3Dpay-checkout&signInMethod=magic-link$/,
    );
    await expect(page.getByRole("button", { name: /^Pay now$/i })).toHaveCount(0);
  });
});
