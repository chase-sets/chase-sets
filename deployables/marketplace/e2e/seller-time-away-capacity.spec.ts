import { expect, test, type Locator, type Page } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

// Charter scope: this spec drives the m127 "Time away & order capacity" card
// end to end through the real seller listings workspace and the
// real marketplace API -- scheduling a future away window makes it appear on
// the card, cancelling removes it, and setting an Order Capacity cap makes the
// current-cap line reflect the new value. Availability domain/read-model logic
// is owned by the marketplace vitest suites; this spec's launch risk is the
// browser round-trip: SSR of the single card, the post/redirect/fresh-read
// cycle for each seller control, and the DS form wiring.
//
// The verified seeded seller can both buy and sell (accounts are encouraged to
// do both). The unverified buyer fixture intentionally cannot use restricted
// listings.manage mutations, so this seller-management charter must not use it.
//
// CI lane: tagged @marketplace-account so the change-scope account suite runs
// it. Playwright auto-discovers this file via the marketplace testMatch glob.

test.describe("marketplace seller time away & order capacity", () => {
  test("schedules an away window, sees it, cancels it, and sets an order capacity cap @marketplace-account", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Flistings", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
    await expect(page).toHaveURL(/\/account\/listings(?:\?|$)/);

    // The single settings surface renders as one card under its section title.
    await expect(page.getByRole("heading", { name: /^Time away & order capacity$/i }).first()).toBeVisible();

    // Start from a clean slate: if a prior run left a pending window, cancel it.
    const preexistingCancel = page.getByRole("button", { name: /^Cancel scheduled away window$/i });
    if (await preexistingCancel.isVisible().catch(() => false)) {
      await submitAndWaitForAccountListingsPostWrite(page, preexistingCancel);
    }

    // Schedule a future away window through the real schedule form. The date
    // inputs are converted to seller-local start-of-day instants client-side.
    const startDate = futureDate(14);
    const endDate = futureDate(21);
    await page.locator('select[name="awayWindowReasonCategory"]').selectOption("travel");
    await page.locator('input[name="awayWindowStartsOn"]').fill(startDate);
    await page.locator('input[name="awayWindowEndsOn"]').fill(endDate);
    await submitAndWaitForAccountListingsPostWrite(page, page.getByRole("button", { name: /^Schedule away window$/i }));

    // Card now shows the scheduled window with the automatic-return notice and
    // a cancel control, and no longer offers the schedule form.
    await expect(page.getByRole("button", { name: /^Cancel scheduled away window$/i })).toBeVisible();
    await expect(page.getByText(/Your listings will turn off on/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Schedule away window$/i })).toHaveCount(0);

    // Cancel the window; the schedule form returns and the cancel control goes.
    await submitAndWaitForAccountListingsPostWrite(
      page,
      page.getByRole("button", { name: /^Cancel scheduled away window$/i }),
    );
    await expect(page.getByRole("button", { name: /^Schedule away window$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Cancel scheduled away window$/i })).toHaveCount(0);

    // Set an Order Capacity cap through the real form; the current-cap line
    // reflects the new value after the post/redirect/fresh-read cycle.
    await page.locator('input[name="maxOpenOrders"]').fill("5");
    await submitAndWaitForAccountListingsPostWrite(page, page.getByRole("button", { name: /^Set capacity$/i }));
    await expect(page.getByText(/^Current cap: 5 open orders$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove cap$/i })).toBeVisible();

    // Clean up so re-runs start capacity-unset.
    await submitAndWaitForAccountListingsPostWrite(page, page.getByRole("button", { name: /^Remove cap$/i }));
    await expect(page.getByText(/No cap set/i)).toBeVisible();
  });
});

function futureDate(daysFromNow: number): string {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function submitAndWaitForAccountListingsPostWrite(page: Page, submit: Locator): Promise<void> {
  const previousUrl = page.url();
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === "/account/listings" && url.href !== previousUrl && url.searchParams.has("postWriteToken"),
    ),
    submit.click(),
  ]);
}
