import { expect, test, type Page } from "@playwright/test";

// Charter scope: this spec owns the browse -> item-detail composition wiring that
// real browsers exercise (SSR of the decomposed `items/:id` route, hydration of the
// commerce panel SegmentedControl, and the search -> detail link handoff). It does
// NOT re-test discovery/checkout domain logic, which the vitest item-detail suites own.
//
// CI lane: tagged @marketplace-browse so the change-scope `marketplace_browse`
// suite (selected for discovery search/item routes and root browser-runtime changes)
// runs it. Playwright auto-discovers this file via the marketplace testMatch glob.

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

test.describe("marketplace item detail", () => {
  test("searches from the persistent item-detail header @marketplace-browse", async ({ page }) => {
    await expectPageOk(page, "/search");

    const pageSearch = page.getByRole("searchbox", { name: "Marketplace search" });
    await pageSearch.fill(searchQuery);
    const detailLink = page.getByRole("link", { name: /View details for/i }).first();
    await expect(detailLink).toBeVisible();
    await detailLink.click();
    await expect(page).toHaveURL(/\/items\//);

    const headerSearch = page.getByRole("combobox", { name: "Search marketplace" });
    await expect(headerSearch).toBeVisible();
    // The server-rendered header is visible before React hydrates. Retry the
    // interaction until navigation proves the search handler is attached.
    await expect(async () => {
      await headerSearch.fill("pikachu");
      await headerSearch.press("Enter");
      await expect(page).toHaveURL(/\/search\?q=pikachu$/, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByRole("searchbox", { name: "Marketplace search" })).toHaveValue("pikachu");
  });

  test("browse search results into the decomposed item-detail route and its commerce panel @marketplace-browse", async ({
    page,
  }) => {
    await expectPageOk(page, "/search");

    const searchBox = page.getByRole("searchbox", { name: "Marketplace search" });
    await expect(searchBox).toBeVisible();
    await searchBox.fill(searchQuery);
    await expect(searchBox).toHaveValue(searchQuery);

    const detailLink = page.getByRole("link", { name: /View details for/i }).first();
    await expect(detailLink).toBeVisible();

    // The search -> item-detail handoff is a real document navigation; assert the
    // decomposed route both routes to /items/:slug and returns a non-error document.
    const detailResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith("/items/") && response.request().resourceType() === "document",
    );
    await detailLink.click();
    const detailResponse = await detailResponsePromise;
    expect(detailResponse.status(), "item-detail document should not be a server error").toBeLessThan(400);
    await expect(page).toHaveURL(/\/items\//);

    // SSR + hydration composition: the item-detail page renders its title heading,
    // a breadcrumb trail rooted at Home, and the lowest-ask market summary.
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Home$/i }).first()).toBeVisible();
    await expect(page.getByText(/Lowest ask/i).first()).toBeVisible();

    // Commerce panel composition: the buy action surface hydrates and stays
    // interactive after the SSR handoff (the panel that milestone 25 decomposed).
    await expect(page.getByText(/^Buy options$/i).first()).toBeVisible();

    // Market panel (m111): the Sales tab renders the price-history panel
    // (range selector + chart/empty-state) instead of the old static
    // "unavailable" placeholder, without erroring the hydrated tab switch.
    // Seed data may or may not have recorded trades, so accept any of the
    // panel's honest states rather than asserting a specific one.
    // The DS tab strip is inert until React hydrates; a click that lands
    // before hydration is silently dropped, so re-click until the tab
    // actually reports selected instead of trusting the first click.
    const salesTab = page.getByRole("tab", { name: "Sales" });
    await expect(async () => {
      await salesTab.click();
      await expect(salesTab).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(
      page.getByText(/Time range|Select a condition|No sales recorded yet|Sales history unavailable/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
