import path from "node:path";
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
const screenshotDir = path.join("artifacts", "playwright", "mobile-action-dock-screenshots");

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

// Issue #5963: the compact mobile action dock must stay short, keep every
// action at a 44px touch target, sit directly above the bottom nav using
// shell-owned geometry (no offset once the nav disappears at tablet width),
// and leave keyboard-focused Market book controls fully clear of the dock.
test.describe("marketplace item detail mobile action dock @marketplace-browse", () => {
  // Deterministic seeded item: the English Base Set Charizard
  // (bounded-contexts/catalog/features/catalog-items/api/seed.ts) is the only
  // "charizard" search hit seeded with active market listings — the sibling
  // Japanese Base Set Charizard has none. Match on the full "Charizard — Base
  // Set" accessible-name substring (not just "charizard") so this never lands
  // on the listing-less item and silently starves the focus/obscuration proof.
  async function gotoBaseSetCharizardDetail(page: Page) {
    await expectPageOk(page, "/search");
    const searchBox = page.getByRole("searchbox", { name: "Marketplace search" });
    await searchBox.fill(searchQuery);
    const detailLink = page.getByRole("link", { name: /View details for Charizard — Base Set/i });
    await expect(detailLink).toBeVisible();

    // The DS card overlay link is inert until React hydrates; a click that
    // lands before hydration is silently dropped and the page stays on
    // /search, so retry the click until the route actually changes.
    await expect(async () => {
      await detailLink.click();
      await expect(page).toHaveURL(/\/items\//, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  }

  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps the compact dock <=76px with 44px actions above the bottom nav at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await gotoBaseSetCharizardDetail(page);

      const dock = page.getByRole("region", { name: "Mobile commerce actions" });
      await expect(dock).toBeVisible();
      const dockBox = await dock.boundingBox();
      expect(dockBox, "dock should report a bounding box").not.toBeNull();
      const safeAreaInsetBottom = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.height = "env(safe-area-inset-bottom, 0px)";
        document.body.appendChild(probe);
        const height = probe.getBoundingClientRect().height;
        probe.remove();
        return height;
      });
      expect(dockBox!.height - safeAreaInsetBottom).toBeLessThanOrEqual(76);

      // Assert whatever the dock actually rendered instead of probing fixed
      // "Buy"/"Sell"/"Watch" names and silently skipping when they're absent
      // (the default, no-product-selected state renders "Select options" /
      // "Choose to sell" / "Choose to watch" instead).
      const actions = dock.locator("a, button");
      const actionCount = await actions.count();
      expect(actionCount, "dock should render the buy/sell/watch action row").toBe(3);
      for (let index = 0; index < actionCount; index += 1) {
        const action = actions.nth(index);
        await expect(action).toBeVisible();
        const accessibleName = (await action.textContent())?.trim();
        expect(accessibleName, `dock action ${index} should keep a visible text label`).toBeTruthy();
        const box = await action.boundingBox();
        expect(box, `dock action "${accessibleName}" should report a bounding box`).not.toBeNull();
        expect(box!.width, `"${accessibleName}" width`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `"${accessibleName}" height`).toBeGreaterThanOrEqual(44);
      }

      const bottomNav = page.locator("nav.fixed.inset-x-0.bottom-0");
      await expect(bottomNav).toBeVisible();
      const bottomNavBox = await bottomNav.boundingBox();
      expect(bottomNavBox, "bottom nav should report a bounding box").not.toBeNull();
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(bottomNavBox!.y + 1);

      await page.screenshot({
        path: path.join(screenshotDir, `phone-dock-${viewport.width}x${viewport.height}.png`),
        fullPage: false,
      });
    });
  }

  test("reserves no mobile bottom-nav offset for the dock at the tablet breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await gotoBaseSetCharizardDetail(page);
    await expect(page).toHaveURL(/\/items\//);

    const dock = page.getByRole("region", { name: "Mobile commerce actions" });
    await expect(dock).toBeVisible();
    const dockBox = await dock.boundingBox();
    expect(dockBox, "dock should report a bounding box").not.toBeNull();
    const viewportHeight = page.viewportSize()?.height ?? 1180;
    expect(viewportHeight - (dockBox!.y + dockBox!.height)).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: path.join(screenshotDir, "tablet-dock-820x1180.png"),
      fullPage: false,
    });
  });

  test("keeps a focused Market book control fully clear of the dock at 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoBaseSetCharizardDetail(page);

    const dock = page.getByRole("region", { name: "Mobile commerce actions" });
    await expect(dock).toBeVisible();

    const selectButton = page.getByRole("button", { name: /^Select .+ listing at /i }).first();
    await expect(selectButton).toBeVisible();
    await selectButton.focus();
    await expect(selectButton).toBeFocused();

    const dockBox = await dock.boundingBox();
    const controlBox = await selectButton.boundingBox();
    expect(dockBox, "dock should report a bounding box").not.toBeNull();
    expect(controlBox, "focused control should report a bounding box").not.toBeNull();
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(dockBox!.y + 1);

    await page.screenshot({
      path: path.join(screenshotDir, "phone-focus-clearance-390x844.png"),
      fullPage: false,
    });
  });
});
