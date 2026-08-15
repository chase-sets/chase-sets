import { expect, test, type Locator, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import sharp from "sharp";
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
const seededDetailPath = marketplaceBrowserE2eSeedContract.itemDetail.routePath;

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

async function openSeededSearchResult(page: Page, colorScheme: "light" | "dark" = "light") {
  await page.emulateMedia({ colorScheme });
  await expectPageOk(page, `/search?q=${encodeURIComponent(searchQuery)}`);
  await page.waitForLoadState("load");
  const detailLink = page.locator(`article > a[href="${seededDetailPath}"]`);
  await expect(detailLink, `Search must render the seeded ${seededDetailPath} result`).toHaveCount(1);
  await expect(detailLink).toBeVisible();
  return detailLink;
}

async function proveLinkHydrated(link: Locator) {
  await expect
    .poll(() => link.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
}

async function decodeScreenshot(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function changedPixelsInBand(
  before: Awaited<ReturnType<typeof decodeScreenshot>>,
  after: Awaited<ReturnType<typeof decodeScreenshot>>,
  band: { x: number; y: number; width: number; height: number },
) {
  let changed = 0;
  for (let y = band.y; y < band.y + band.height; y += 1) {
    for (let x = band.x; x < band.x + band.width; x += 1) {
      const offset = (y * before.width + x) * before.channels;
      if ([0, 1, 2].some((channel) => Math.abs(before.data[offset + channel]! - after.data[offset + channel]!) > 8)) {
        changed += 1;
      }
    }
  }
  return { changed, total: band.width * band.height };
}

async function assertBorderExcludedFocusInk(page: Page, detailLink: Locator, mode: "light" | "dark") {
  const article = detailLink.locator("..");
  await article.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => window.devicePixelRatio),
    "focus oracle requires one CSS pixel per screenshot pixel",
  ).toBe(1);
  const focusContract = await detailLink.evaluate((link) => {
    const card = link.closest("article");
    const focusable = card
      ? Array.from(
          card.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
      : [];
    return {
      firstFocusableIsBase: focusable[0] === link,
      articleRole: card?.getAttribute("role") ?? null,
      articleTabIndex: card?.getAttribute("tabindex") ?? null,
    };
  });
  expect(focusContract).toEqual({ firstFocusableIsBase: true, articleRole: null, articleTabIndex: null });

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const beforeBox = await article.boundingBox();
  expect(beforeBox, `${mode} Search Result card must have populated geometry`).not.toBeNull();
  const beforePng = await page.screenshot({ clip: beforeBox! });

  const focusBaseByTab = async (label: string) => {
    let reachedByTab = false;
    for (let index = 0; index < 50; index += 1) {
      await page.keyboard.press("Tab");
      if (await detailLink.evaluate((link) => document.activeElement === link)) {
        reachedByTab = true;
        break;
      }
    }
    expect(reachedByTab, `${mode} ${label} base detail anchor must be reachable through keyboard Tab`).toBe(true);
    expect(await detailLink.evaluate((link) => link.matches(":focus-visible"))).toBe(true);
  };
  await focusBaseByTab("candidate");
  const afterBox = await article.boundingBox();
  expect(afterBox, `${mode} focused Search Result card must retain populated geometry`).not.toBeNull();
  expect({ width: afterBox!.width, height: afterBox!.height }).toEqual({
    width: beforeBox!.width,
    height: beforeBox!.height,
  });
  const afterPng = await page.screenshot({ clip: afterBox! });
  const before = await decodeScreenshot(beforePng);
  const after = await decodeScreenshot(afterPng);
  expect({ width: after.width, height: after.height, channels: after.channels }).toEqual({
    width: before.width,
    height: before.height,
    channels: before.channels,
  });

  const start = 2;
  const depth = 2;
  const corner = 14;
  const bands = {
    top: { x: corner, y: start, width: before.width - corner * 2, height: depth },
    bottom: {
      x: corner,
      y: before.height - start - depth,
      width: before.width - corner * 2,
      height: depth,
    },
    left: { x: start, y: corner, width: depth, height: before.height - corner * 2 },
    right: {
      x: before.width - start - depth,
      y: corner,
      width: depth,
      height: before.height - corner * 2,
    },
  };
  const deltas = Object.fromEntries(
    Object.entries(bands).map(([name, band]) => [name, changedPixelsInBand(before, after, band)]),
  );
  console.log(`Search Result border-excluded focus ink (${mode}): ${JSON.stringify(deltas)}`);
  for (const [name, delta] of Object.entries(deltas)) {
    expect(
      delta.changed / delta.total,
      `${mode} ${name} band must contain inset-1.5 peer-ring ink beyond the border/anti-alias rows`,
    ).toBeGreaterThanOrEqual(0.8);
  }

  const visualRing = article.locator(':scope > span[aria-hidden="true"]');
  await expect(visualRing).toHaveCount(1);
  const candidateRingClass = await visualRing.getAttribute("class");
  for (const mutant of [
    {
      name: "clipped inset-0 ring",
      className: "focus-ring pointer-events-none absolute inset-0 z-40 rounded-tokenMd",
    },
    {
      name: "no ring",
      className: "pointer-events-none absolute inset-1.5 z-40 rounded-tokenSm",
    },
  ]) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await visualRing.evaluate((ring, className) => ring.setAttribute("class", className), mutant.className);
    const mutantBeforeBox = await article.boundingBox();
    expect(mutantBeforeBox, `${mode} ${mutant.name} unfocused card geometry`).not.toBeNull();
    const mutantBeforePng = await page.screenshot({ clip: mutantBeforeBox! });
    await focusBaseByTab(mutant.name);
    const mutantAfterBox = await article.boundingBox();
    expect(mutantAfterBox, `${mode} ${mutant.name} focused card geometry`).not.toBeNull();
    expect({ width: mutantAfterBox!.width, height: mutantAfterBox!.height }).toEqual({
      width: mutantBeforeBox!.width,
      height: mutantBeforeBox!.height,
    });
    const mutantAfterPng = await page.screenshot({ clip: mutantAfterBox! });
    const mutantBefore = await decodeScreenshot(mutantBeforePng);
    const mutantAfter = await decodeScreenshot(mutantAfterPng);
    const mutantDeltas = Object.fromEntries(
      Object.entries(bands).map(([name, band]) => [name, changedPixelsInBand(mutantBefore, mutantAfter, band)]),
    );
    console.log(`Search Result border-excluded focus ink (${mode}, ${mutant.name}): ${JSON.stringify(mutantDeltas)}`);
    for (const [name, delta] of Object.entries(mutantDeltas)) {
      expect(
        delta.changed / delta.total,
        `${mode} ${mutant.name} ${name} band must fail the candidate focus-ink threshold`,
      ).toBeLessThan(0.05);
    }
  }
  await visualRing.evaluate((ring, className) => ring.setAttribute("class", className), candidateRingClass!);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await focusBaseByTab("restored candidate");

  return detailLink;
}

test.describe("marketplace item detail", () => {
  test("opens item detail from Search Result card media without an action intent @marketplace-browse", async ({
    page,
    context,
  }) => {
    const detailLink = await openSeededSearchResult(page);
    const article = detailLink.locator("..");
    const media = article.getByRole("img").first();
    await expect(media).toBeVisible();
    const mediaBox = await media.boundingBox();
    expect(mediaBox, "seeded Search Result media must have populated geometry").not.toBeNull();
    const point = { x: mediaBox!.x + mediaBox!.width / 2, y: mediaBox!.y + mediaBox!.height / 2 };
    expect(
      await detailLink.evaluate(
        (link, coordinates) => document.elementFromPoint(coordinates.x, coordinates.y) === link,
        point,
      ),
    ).toBe(true);
    expect(await article.evaluate((card) => getComputedStyle(card).cursor)).toBe("pointer");
    await page.mouse.move(0, 0);
    const restingBorder = await article.evaluate((card) => getComputedStyle(card).borderColor);
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => article.evaluate((card) => getComputedStyle(card).borderColor)).not.toBe(restingBorder);

    await assertBorderExcludedFocusInk(page, detailLink, "light");
    const focusedMediaBox = await media.boundingBox();
    expect(focusedMediaBox, "focused modifier-open media must retain populated geometry").not.toBeNull();
    const focusedMediaPoint = {
      x: focusedMediaBox!.x + focusedMediaBox!.width / 2,
      y: focusedMediaBox!.y + focusedMediaBox!.height / 2,
    };
    const sourceUrl = page.url();
    const modifierPagePromise = context.waitForEvent("page");
    await page.keyboard.down("Control");
    await page.mouse.click(focusedMediaPoint.x, focusedMediaPoint.y);
    await page.keyboard.up("Control");
    const modifierPage = await modifierPagePromise;
    await modifierPage.waitForLoadState("domcontentloaded");
    await expect(modifierPage).toHaveURL(new URL(seededDetailPath, sourceUrl).href);
    expect(page.url()).toBe(sourceUrl);
    await modifierPage.close();

    const navigationMediaBox = await media.boundingBox();
    expect(navigationMediaBox, "document-navigation media must retain populated geometry").not.toBeNull();
    const navigationPoint = {
      x: navigationMediaBox!.x + navigationMediaBox!.width / 2,
      y: navigationMediaBox!.y + navigationMediaBox!.height / 2,
    };
    const expectedDetailUrl = new URL(seededDetailPath, page.url()).href;
    const detailResponsePromise = page.waitForResponse(
      (response) => response.url() === expectedDetailUrl && response.request().resourceType() === "document",
    );
    await page.mouse.click(navigationPoint.x, navigationPoint.y);
    const detailResponse = await detailResponsePromise;
    expect(detailResponse.status(), "item-detail document should not be a server error").toBeLessThan(400);
    await expect(page).toHaveURL(expectedDetailUrl);
    await page.waitForLoadState("load");
    expect(new URL(page.url()).searchParams.has("market")).toBe(false);

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

  test("keeps Search Result actions isolated and base navigation browser-native @marketplace-browse", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const ledger: unknown[] = [];
      Object.defineProperty(window, "__issue6874SelectionLedger", { value: ledger });
      window.addEventListener("chase-sets:item-detail-rail-analytics", (event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.event === "search_result_selected") ledger.push(detail);
      });
    });

    let detailLink = await openSeededSearchResult(page);
    const article = detailLink.locator("..");
    const primaryAction = article.getByRole("link", { name: "Add product to Buy Cart" });
    await proveLinkHydrated(primaryAction);
    const actionHref = `${seededDetailPath}?market=buy`;
    await expect(primaryAction).toHaveAttribute("href", actionHref);
    await page.evaluate(() => {
      document.documentElement.dataset.issue6874SourceDocument = "search-source";
    });
    const documentRequests: string[] = [];
    const recordDocumentRequest = (request: { resourceType(): string; url(): string }) => {
      if (request.resourceType() === "document") documentRequests.push(request.url());
    };
    page.on("request", recordDocumentRequest);
    await primaryAction.click();
    await expect(page).toHaveURL(new URL(actionHref, page.url()).href);
    page.off("request", recordDocumentRequest);
    expect(documentRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.dataset.issue6874SourceDocument)).toBe("search-source");
    expect(
      await page.evaluate(
        () => (window as unknown as { __issue6874SelectionLedger: unknown[] }).__issue6874SelectionLedger,
      ),
    ).toEqual([]);

    detailLink = await openSeededSearchResult(page, "dark");
    await assertBorderExcludedFocusInk(page, detailLink, "dark");

    const expectedDetailUrl = new URL(seededDetailPath, page.url()).href;
    const detailResponsePromise = page.waitForResponse(
      (response) => response.url() === expectedDetailUrl && response.request().resourceType() === "document",
    );
    await page.keyboard.press("Enter");
    const detailResponse = await detailResponsePromise;
    expect(detailResponse.status(), "item-detail document should not be a server error").toBeLessThan(400);
    await expect(page).toHaveURL(expectedDetailUrl);

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

test.describe("marketplace item detail mobile Product options and Market book (#5964)", () => {
  const itemDetailRoutePath = marketplaceBrowserE2eSeedContract.itemDetail.routePath;
  const selectedProductRoutePath = marketplaceBrowserE2eSeedContract.itemDetail.selectedProductRoutePath;
  const unresolvedProductRoutePath = marketplaceBrowserE2eSeedContract.itemDetailWithoutListings.routePath;
  const rawProductId =
    "cat_seed_charizard_base_set::dim_seed_form:chc_seed_form_raw|dim_seed_condition:chc_seed_condition_near_mint|dim_seed_grading_company:-|dim_seed_grade:-";
  const implicitGradedProductId =
    "cat_seed_charizard_base_set::dim_seed_form:chc_seed_form_graded|dim_seed_condition:-|dim_seed_grading_company:chc_seed_grading_company_psa|dim_seed_grade:chc_seed_grade_nm_mt_8";
  const gradedProductId =
    "cat_seed_charizard_base_set::dim_seed_form:chc_seed_form_graded|dim_seed_condition:-|dim_seed_grading_company:chc_seed_grading_company_psa|dim_seed_grade:chc_seed_grade_gem_mint_10";

  async function openItemRoute(page: Page, path: string, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    await expectPageOk(page, path);
  }

  function productOptionsSurface(page: Page) {
    return page.locator("[data-product-options-surface]");
  }

  function mobileProductOptions(page: Page) {
    return page.locator("[data-product-options-mobile]");
  }

  async function expectCollapsedProductOptions(page: Page) {
    const surface = productOptionsSurface(page);
    const mobile = mobileProductOptions(page);
    await expect(surface).toHaveCount(1);
    await expect(surface).toHaveAttribute("data-product-id", rawProductId);
    await expect(mobile.getByRole("button", { name: /Chosen options/ })).toHaveAttribute("aria-expanded", "false");
    await expect(mobile.getByLabel(/Product options: Form Raw, Condition Near Mint/)).toHaveCount(1);
    await expect(page.locator("[data-product-options-desktop]")).toBeHidden();
  }

  async function expectExpandedProductOptions(page: Page) {
    const surface = productOptionsSurface(page);
    const mobile = mobileProductOptions(page);
    await expect(surface).toHaveCount(1);
    await expect(surface).toHaveAttribute("data-product-id", "");
    await expect(mobile.getByRole("button", { name: "Choose options" })).toHaveAttribute("aria-expanded", "true");
    await expect(mobile.getByRole("radiogroup", { name: "Form" })).toBeVisible();
    await expect(page.locator("[data-product-options-desktop]")).toBeHidden();
  }

  async function expectActiveTabInsideTabList(page: Page, label: "Listings" | "Offers" | "Sales" | "Details") {
    const navigation = page.locator("[data-market-book-navigation]");
    const tabList = navigation.getByRole("tablist");
    const tabs = navigation.getByRole("tab");
    const activeTab = navigation.getByRole("tab", { name: label });
    await expect(tabs).toHaveCount(4);
    await expect(activeTab).toHaveAttribute("aria-selected", "true");

    const listBounds = await tabList.boundingBox();
    const activeBounds = await activeTab.boundingBox();
    expect(listBounds, "the Market book tab list must have live layout").not.toBeNull();
    expect(activeBounds, `the active ${label} tab must have live layout`).not.toBeNull();
    await expect
      .poll(
        async () => {
          const currentListBounds = await tabList.boundingBox();
          const currentActiveBounds = await activeTab.boundingBox();
          return Boolean(
            currentListBounds &&
            currentActiveBounds &&
            currentActiveBounds.x >= currentListBounds.x - 0.5 &&
            currentActiveBounds.x + currentActiveBounds.width <= currentListBounds.x + currentListBounds.width + 0.5,
          );
        },
        { message: `the active ${label} tab must settle fully inside the tab-list bounds`, timeout: 5_000 },
      )
      .toBe(true);

    const tabBounds = await tabs.evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
    );
    expect(
      Math.max(...tabBounds.map((bounds) => bounds.top)) - Math.min(...tabBounds.map((bounds) => bounds.top)),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.max(...tabBounds.map((bounds) => bounds.bottom)) - Math.min(...tabBounds.map((bounds) => bounds.bottom)),
    ).toBeLessThanOrEqual(0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  async function activateMarketBookTab(
    page: Page,
    label: "Listings" | "Offers" | "Sales" | "Details",
    method: "initial" | "pointer" | "keyboard" | "controlled",
  ) {
    const navigation = page.locator("[data-market-book-navigation]");
    await navigation.scrollIntoViewIfNeeded();
    const activeTab = navigation.getByRole("tab", { name: label });

    if (method === "pointer") {
      await expect(async () => {
        await activeTab.click();
        await expect(activeTab).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
    } else if (method === "keyboard") {
      const listings = navigation.getByRole("tab", { name: "Listings" });
      await expect(async () => {
        await listings.focus();
        await listings.press(label === "Details" ? "ArrowLeft" : "ArrowRight");
        await activeTab.press("Enter");
        await expect(activeTab).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
    } else if (method === "controlled") {
      await changeMarketBookWithDock(page, "Sell", activeTab);
    }

    await expectActiveTabInsideTabList(page, label);
  }

  async function captureMarketBookState(
    page: Page,
    label: "Listings" | "Offers" | "Sales" | "Details",
    method: "initial" | "pointer" | "keyboard" | "controlled",
  ) {
    await activateMarketBookTab(page, label, method);
    await expect(page.locator("[data-market-book-navigation]").getByRole("tabpanel", { name: label })).toBeVisible();
  }

  async function chooseCustomSelectOption(page: Page, label: string, option: RegExp) {
    const control = mobileProductOptions(page).getByRole("combobox", { name: label });
    await control.click();
    await page.getByRole("option", { name: option }).click();
  }

  async function openMobileProductOptions(page: Page) {
    const trigger = mobileProductOptions(page).getByRole("button", { name: /Chosen options/ });
    await expect(async () => {
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
  }

  async function changeMarketBookWithDock(page: Page, action: "Buy" | "Sell", targetTab: Locator) {
    const dockAction = page.getByTestId("product-detail-mobile-dock").getByRole("button", { name: action });
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await dockAction.click();
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(targetTab).toHaveAttribute("aria-selected", "true");
  }

  async function failureMessageOf(evidence: Promise<void>, message: string) {
    return evidence.then(
      () => {
        throw new Error(message);
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  test("Product options reconcile the real item route after each dependent choice @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openItemRoute(page, selectedProductRoutePath, { width: 390, height: 844 });
    const initialUrl = page.url();
    const surface = productOptionsSurface(page);
    const mobile = mobileProductOptions(page);
    await expectCollapsedProductOptions(page);
    await openMobileProductOptions(page);

    await mobile.getByRole("radio", { name: /^Graded/ }).click();
    await expect(mobile.getByRole("combobox", { name: "Condition" })).toHaveCount(0);
    await expect(mobile.getByRole("combobox", { name: "Grading Company" })).toBeVisible();
    await expect(mobile.getByRole("combobox", { name: "Grade" })).toBeVisible();
    await expect(surface).toHaveAttribute("data-product-id", implicitGradedProductId);

    await chooseCustomSelectOption(page, "Grading Company", /^PSA/);
    await expect(mobile.getByRole("combobox", { name: "Grade" })).toBeVisible();
    await expect(surface).toHaveAttribute("data-product-id", implicitGradedProductId);

    await chooseCustomSelectOption(page, "Grade", /^Gem Mint 10/);
    await expect(surface).toHaveAttribute("data-product-id", gradedProductId);
    await expect(mobile.getByRole("button", { name: /Chosen options/ })).toHaveAttribute("aria-expanded", "true");
    await expect(mobile.getByLabel(/Product options: Form Graded, Grading Company PSA, Grade Gem Mint 10/)).toHaveCount(
      1,
    );
    await expect(page.getByText("No active listings").first()).toBeVisible();

    await mobile.getByRole("radio", { name: /^Raw/ }).click();
    await expect(mobile.getByRole("combobox", { name: "Grading Company" })).toHaveCount(0);
    await expect(mobile.getByRole("combobox", { name: "Grade" })).toHaveCount(0);
    await expect(mobile.getByRole("combobox", { name: "Condition" })).toBeVisible();
    await expect(surface).toHaveAttribute("data-product-id", rawProductId);

    await chooseCustomSelectOption(page, "Condition", /^Near Mint/);
    await expect(surface).toHaveAttribute("data-product-id", rawProductId);
    await expect(mobile.getByLabel(/Product options: Form Raw, Condition Near Mint/)).toHaveCount(1);
    const selectedListing = page
      .getByRole("article", { name: /Listing .* from/i })
      .filter({ has: page.getByRole("button", { pressed: true }) })
      .first();
    await expect(selectedListing).toBeVisible();
    const selectedPrice = (
      await selectedListing
        .getByText(/^\$[\d,]+\.\d{2}$/)
        .first()
        .textContent()
    )?.trim();
    expect(selectedPrice).toBeTruthy();
    await expect(page.getByTestId("product-detail-mobile-dock")).toContainText(selectedPrice!);
    expect(page.url()).toBe(initialUrl);

    const stampFailure = await surface
      .evaluate((element) => element.removeAttribute("data-product-id"))
      .then(() =>
        failureMessageOf(
          expect(surface).toHaveAttribute("data-product-id", rawProductId, { timeout: 1_000 }),
          "the removed product-stamp control unexpectedly passed",
        ),
      );
    expect(stampFailure).toContain(rawProductId);
    expect(stampFailure).toContain("Received:");
    expect(stampFailure).toContain('""');
    await testInfo.attach("mutant-red:removed-product-settlement-stamp", {
      body: stampFailure,
      contentType: "text/plain",
    });
  });

  test("records collapsed Product options at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, selectedProductRoutePath, { width: 360, height: 800 });
    await expectCollapsedProductOptions(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-product-options-collapsed-360" });
  });

  test("records collapsed Product options at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, selectedProductRoutePath, { width: 390, height: 844 });
    await expectCollapsedProductOptions(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-product-options-collapsed-390" });
  });

  test("records expanded Product options at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, unresolvedProductRoutePath, { width: 360, height: 800 });
    await expectExpandedProductOptions(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-product-options-expanded-360" });
  });

  test("records expanded Product options at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, unresolvedProductRoutePath, { width: 390, height: 844 });
    await expectExpandedProductOptions(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-product-options-expanded-390" });
  });

  test("preserves expanded Product options and Market book at the 768px breakpoint @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openItemRoute(page, selectedProductRoutePath, { width: 768, height: 1024 });
    const surface = productOptionsSurface(page);
    const desktop = page.locator("[data-product-options-desktop]");
    await expect(surface).toHaveAttribute("data-product-id", rawProductId);
    await expect(mobileProductOptions(page)).toBeHidden();
    await expect(desktop).toBeVisible();
    await expect(desktop.getByRole("radiogroup", { name: "Form" })).toBeVisible();
    await expect(desktop.getByRole("combobox", { name: "Condition" })).toBeVisible();
    await expect(desktop.getByText("Chosen options")).toBeVisible();
    await expectActiveTabInsideTabList(page, "Listings");

    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-product-options-desktop-768" });
  });

  test("records Listings Market book tab at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 360, height: 800 });
    await captureMarketBookState(page, "Listings", "initial");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-listings-360" });
  });

  test("records Listings Market book tab at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 390, height: 844 });
    await captureMarketBookState(page, "Listings", "initial");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-listings-390" });
  });

  test("records Offers Market book tab at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 360, height: 800 });
    await captureMarketBookState(page, "Offers", "controlled");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-offers-360" });
  });

  test("records Offers Market book tab at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 390, height: 844 });
    await captureMarketBookState(page, "Offers", "controlled");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-offers-390" });
  });

  test("records Sales Market book tab at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 360, height: 800 });
    await captureMarketBookState(page, "Sales", "pointer");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-sales-360" });
  });

  test("records Sales Market book tab at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 390, height: 844 });
    await captureMarketBookState(page, "Sales", "pointer");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-sales-390" });
  });

  test("records Details Market book tab at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 360, height: 800 });
    await captureMarketBookState(page, "Details", "keyboard");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-details-360" });
  });

  test("records Details Market book tab at 390x844 @marketplace-browse", async ({ page }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 390, height: 844 });
    await captureMarketBookState(page, "Details", "keyboard");
    await captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-market-book-details-390" });
  });

  test("fails Product options evidence when the phone claim targets the hidden desktop sibling @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openItemRoute(page, selectedProductRoutePath, { width: 390, height: 844 });
    const failure = await failureMessageOf(
      captureResponsiveEvidence({ page, testInfo, claimId: "item-detail-product-options-hidden-desktop-control" }),
      "the hidden Product options sibling unexpectedly captured evidence",
    );

    expect(failure).toContain("reason=target-hidden-or-collapsed");
    await testInfo.attach("responsive-evidence:item-detail-product-options-hidden-desktop-control:failure", {
      body: failure,
      contentType: "text/plain",
    });
  });

  test("fails the active-tab bounds assertion when controlled reveal is bypassed @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openItemRoute(page, itemDetailRoutePath, { width: 360, height: 800 });
    const navigation = page.locator("[data-market-book-navigation]");
    const tabList = navigation.getByRole("tablist");
    await changeMarketBookWithDock(page, "Sell", navigation.getByRole("tab", { name: "Offers" }));
    await tabList.evaluate((element) => {
      const list = element as HTMLElement;
      list.scrollLeft = list.scrollWidth;
      Object.defineProperty(list, "scrollBy", { configurable: true, value: () => undefined });
    });
    await changeMarketBookWithDock(page, "Buy", navigation.getByRole("tab", { name: "Listings" }));

    const failure = await failureMessageOf(
      expectActiveTabInsideTabList(page, "Listings"),
      "the bypassed active-tab reveal unexpectedly satisfied the live bounds assertion",
    );
    expect(failure).toContain("must settle fully inside the tab-list bounds");
    await testInfo.attach("mutant-red:bypassed-active-tab-reveal", { body: failure, contentType: "text/plain" });
  });
});
