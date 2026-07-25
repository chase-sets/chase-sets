import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

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

// Charter scope: compacts the mobile Detail Page action dock (#5963). Route identity
// is pinned in support/seed-contract.ts rather than reached by a generic search query
// (AC11) — cat_seed_charizard_base_set is the seeded item with real listings; its
// Japanese counterpart has none and previously starved the focus proof.
test.describe("marketplace item detail mobile action dock (#5963)", () => {
  const itemDetailRoutePath = marketplaceBrowserE2eSeedContract.itemDetail.routePath;
  const selectedProductRoutePath = marketplaceBrowserE2eSeedContract.itemDetail.selectedProductRoutePath;
  const unselectedProductRoutePath = marketplaceBrowserE2eSeedContract.itemDetailWithoutListings.routePath;

  async function openDockRoute(page: Page, path: string, viewport: { width: number; height: number }) {
    // Render at the claim's viewport from the first paint. Navigating at Playwright's
    // 1280x720 device default first paints the dock inside the xl breakpoint, where the
    // pattern hides it (xl:hidden), so the dock's first self-measurement would be of a
    // display:none box that a later resize has to correct.
    await page.setViewportSize(viewport);
    await expectPageOk(page, path);
  }

  async function waitForPublishedDockHeight(page: Page) {
    // Waits for the pattern to have PUBLISHED a dock measurement at all — the presence
    // of --product-detail-dock-height, never a particular value. The claim's
    // {"minimum":44,"maximum":76} bound is what judges the value, so a pattern that
    // publishes 0px, or 200px, still fails its claim; only "has not measured yet" is
    // waited out. Without this wait the claims sampled the server-rendered document,
    // where React has not hydrated and the ResizeObserver has not run, and every
    // published-dock-height read the pre-measurement fallback instead of the dock.
    await page.waitForFunction(
      () => {
        const target = document.querySelector("[data-focus-clearance-target]");
        return Boolean(target && getComputedStyle(target).getPropertyValue("--product-detail-dock-height").trim());
      },
      undefined,
      { timeout: 30_000 },
    );
  }

  // The shell declares [--shell-bottom-nav-height:5.25rem] for phones (shells.tsx), which
  // resolves to 84px against the 16px root font size. This is the single value the
  // frozen-variable negative control pins the variable to at the tablet viewport, where
  // the shell's own md: rule would otherwise resolve it to 0px.
  const frozenShellBottomNavHeightPx = 84;

  async function failureMessageOf(evidence: Promise<void>) {
    // Not a catch-and-log. An evidence run that does NOT fail throws here, so the only
    // way past this helper is a genuine failure, whose exact message the caller then
    // asserts on and attaches to the run as the published failing output.
    return evidence.then(
      () => {
        throw new Error("the frozen-variable negative control captured evidence instead of failing");
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  async function readPublishedDockHeightPx(page: Page) {
    return page.evaluate(() => {
      const target = document.querySelector("[data-focus-clearance-target][aria-pressed='true']");
      return Number.parseFloat(getComputedStyle(target!).getPropertyValue("--product-detail-dock-height"));
    });
  }

  async function focusSelectedListingControl(page: Page) {
    const control = page.locator("[data-focus-clearance-target][aria-pressed='true']");
    await expect(control).toHaveCount(1);
    const accessibleName = await control.getAttribute("aria-label");
    expect(accessibleName, "the Market book control must publish an accessible name").toBeTruthy();
    // scrollIntoView({block:"end"}) respects the control's own scroll-margin-bottom, so
    // this reproduces the scroll behavior a keyboard Tab into this control would
    // trigger — positioning its bottom edge above the dock rather than incidentally far
    // from it (AC4; round 2's focus screenshot contained no focused control at all).
    await control.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await control.focus();
    await expect(control).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(accessibleName);
    return accessibleName;
  }

  test("publishes dock height and shell-symbolic focus clearance at 360x800 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, itemDetailRoutePath, { width: 360, height: 800 });
    await waitForPublishedDockHeight(page);
    await focusSelectedListingControl(page);

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-geometry-360" });
  });

  test("publishes dock height and shell-symbolic focus clearance at 390x844 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, itemDetailRoutePath, { width: 390, height: 844 });
    await waitForPublishedDockHeight(page);
    await focusSelectedListingControl(page);

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-geometry-390" });
  });

  test("resolves shell-symbolic focus clearance to zero bottom-nav contribution at 820x1180 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, itemDetailRoutePath, { width: 820, height: 1180 });
    await waitForPublishedDockHeight(page);
    await focusSelectedListingControl(page);

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-geometry-tablet" });
  });

  test("fails the tablet focus-clearance assertion when --shell-bottom-nav-height is frozen to the phone value @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, itemDetailRoutePath, { width: 820, height: 1180 });
    await waitForPublishedDockHeight(page);
    // The single respect this run differs from the unfrozen 820x1180 run above: the
    // shell's own responsive rule (md:[--shell-bottom-nav-height:0px]) is overridden
    // with !important on the exact same shell element, so the variable stays pinned to
    // the phone value regardless of breakpoint (AC2). Route, fixture, viewport, DOM,
    // and the "focus-clearance" assertion identity are all identical to the unfrozen
    // 820x1180 run above.
    await page.addStyleTag({
      content: '[class*="--shell-bottom-nav-height:5.25rem"] { --shell-bottom-nav-height: 5.25rem !important; }',
    });
    await focusSelectedListingControl(page);
    const publishedDockHeightPx = await readPublishedDockHeightPx(page);

    const frozenFailure = await failureMessageOf(
      captureResponsiveEvidence({
        page,
        testInfo,
        claimId: "item-detail-mobile-dock-geometry-tablet-frozen-control",
      }),
    );

    // The control must fail on the named focus-clearance assertion carrying the
    // byte-identical {"minimum":44,"maximum":76} bound that the unfrozen 820x1180 run
    // above passes, and its actual value must be exactly the dock's real published
    // height plus the frozen phone bottom-navigation height. Pinning the arithmetic is
    // what separates "failed because the frozen variable propagated" from the ways a
    // control can fail for the wrong reason — aborting earlier, asserting on a
    // different measurement, or measuring an element that is not there.
    expect(frozenFailure).toContain(
      `reason=measurement-failed(focus-clearance, expected={"minimum":44,"maximum":76}, actual=${
        publishedDockHeightPx + frozenShellBottomNavHeightPx
      })`,
    );
    await testInfo.attach("responsive-evidence:item-detail-mobile-dock-geometry-tablet-frozen-control:failure", {
      body: frozenFailure,
      contentType: "text/plain",
    });
  });

  // AC5 route scope (re-scoped under decision #6096): the no-product-selected dock is
  // not reachable on the charizard route, because useItemDetailPageModel resolves
  // selectedProductId implicitly from the best visible listing whenever an item has
  // seeded listings. It is measured on the seeded no-listings item instead — see
  // support/seed-contract.ts itemDetailWithoutListings.
  test("keeps the unselected-state dock label unclipped at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openDockRoute(page, unselectedProductRoutePath, { width: 360, height: 800 });

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-labels-unselected-360" });
  });

  test("keeps the unselected-state dock label unclipped at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openDockRoute(page, unselectedProductRoutePath, { width: 390, height: 844 });

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-labels-unselected-390" });
  });

  test("keeps the unselected-state dock label unclipped at 820x1180 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, unselectedProductRoutePath, { width: 820, height: 1180 });

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-labels-unselected-tablet" });
  });

  test("keeps the Buy, Sell, and Watch dock labels unclipped at 360x800 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, selectedProductRoutePath, { width: 360, height: 800 });

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-labels-selected-360" });
  });

  test("keeps the Buy, Sell, and Watch dock labels unclipped at 390x844 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, selectedProductRoutePath, { width: 390, height: 844 });

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-labels-selected-390" });
  });

  test("keeps the Buy, Sell, and Watch dock labels unclipped at 820x1180 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openDockRoute(page, selectedProductRoutePath, { width: 820, height: 1180 });

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-mobile-dock-labels-selected-tablet" });
  });
});
