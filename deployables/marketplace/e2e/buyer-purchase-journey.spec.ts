import { expect, test } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

test.describe("marketplace buyer purchase journey", () => {
  test("seeded buyer submits the marketplace sign-in form @marketplace-account", async ({ page }) => {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());

    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();
  });

  test("seeded buyer walks the real cart into the checkout payment boundary @marketplace-checkout", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());
    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    const cartLines = page.locator("[data-marketplace-cart-line]");
    await expect(
      cartLines,
      `browser-e2e seed contract requires ${marketplaceBrowserE2eSeedContract.cart.lineCount} cart lines for ${marketplaceBrowserE2eSeedContract.buyer.email}`,
    ).toHaveCount(marketplaceBrowserE2eSeedContract.cart.lineCount);
    await expect(page.getByText("Estimated total").first()).toBeVisible();
    await expect(page.getByText("Final total confirmed at checkout")).toHaveCount(1);

    const checkoutButton = page.getByRole("button", { name: /^Check out$/i }).first();
    await expect(checkoutButton, "browser-e2e seed contract requires a ready buyer cart").toBeVisible();
    await checkoutButton.click();

    await expect(page).toHaveURL(/\/checkout\/buy\/session\/[^/?]+/);
    await expect(page.getByRole("heading", { name: /^Checkout$/i })).toBeVisible();

    const checkoutSteps = page.locator("[aria-label='Checkout steps']");
    await expect(checkoutSteps, "checkout must render the real buyer stepper").toBeVisible();
    for (const step of ["Contact", "Delivery", "Shipping", "Payment", "Review"]) {
      await expect(checkoutSteps.getByText(new RegExp(`^${step}$`, "i"))).toBeVisible();
    }

    const updateTotals = page.getByRole("button", { name: /Update totals|Pay now/i }).first();
    await expect(updateTotals, "checkout must reach the payment boundary action").toBeVisible();
    await updateTotals.click();
    await expect(
      page.getByText(/Payment review comes next|Final totals before payment|Pay now/i).first(),
    ).toBeVisible();
  });
});
