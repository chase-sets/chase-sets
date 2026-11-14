import { expect, test } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

test.describe("marketplace buyer purchase journey", () => {
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
