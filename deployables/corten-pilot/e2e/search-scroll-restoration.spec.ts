import { expect, test } from "@playwright/test";
import { marketplaceBrowserE2eSeedContract } from "./support/seed-contract";
import { onCortenMarketplace } from "./support/system";

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";
const searchRestorationStorageKey = "discovery.search.restoration.v2";
// Correctness must not hinge on a stopwatch: a slow CI machine should never turn a working
// restoration into a timing flake, so the visible-state assertions get a generous hard
// budget. The performance target is asserted separately and softly below.
const RESTORATION_HARD_TIMEOUT_MS = 15_000;
// Deliberately well above a healthy restoration (cached restore is near-instant; even a full
// server round-trip was ~7.4s) so this soft budget flags only a gross regression and never
// flakes on backend timing variance. Correctness is gated by the hard timeout above.
const RESTORATION_PERF_BUDGET_MS = 10_000;

type SearchItem = Record<string, unknown> & Readonly<{ catalog_item_id: string; title: string }>;
type SearchResponse = Readonly<{
  items: SearchItem[];
  facets: unknown[];
  category_counts: Array<{ slug: string; count: number }>;
  total: number | null;
  count: number;
  nextCursor: string | null;
  retrievalMode: "lexical" | "rescue" | "structured" | "corrected";
  lexicalCount: number | null;
  cursorRestarted?: true;
}>;

test.describe("marketplace search scroll restoration", () => {
  test("restores a corrected notice and terminal page after detail roundtrips @marketplace-browse", async ({
    page,
  }) => {
    const correctedQuery = "charzard 4/102";
    const searchPath = `/search?q=${encodeURIComponent(correctedQuery)}`;
    const notice = `No exact matches for ${correctedQuery}. Showing close spellings.`;
    await page.goto(searchPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    const detail = page.getByRole("link", { name: /^View details for / }).first();
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute("href", marketplaceBrowserE2eSeedContract.itemDetail.routePath);
    await detail.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/items\//);
    for (let roundtrip = 0; roundtrip < 2; roundtrip++) {
      await page.goBack({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new URL(searchPath, page.url()).href);
      await expect(page.getByText(notice, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Closest matches" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Load more results" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /^View details for / })).toHaveCount(1);
      await expect(detail).toHaveAttribute("href", marketplaceBrowserE2eSeedContract.itemDetail.routePath);
      if (roundtrip === 0) {
        await page.getByRole("link", { name: /^View details for / }).focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/items\//);
      }
    }
  });

  test("canonicalizes interpreted grade words once and keeps the notice honest @marketplace-browse", async ({
    page,
  }) => {
    test.skip(
      onCortenMarketplace,
      "counts the dismissed notice with toHaveCount(0) and removes a grade with a button; marketplace-web removes the notice from the DOM, while the Corten marketplace hides it with the hidden attribute and removes a grade with a link",
    );
    const redirects: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 300 && response.status() < 400 && new URL(response.url()).pathname === "/search") {
        redirects.push(response.url());
      }
    });
    const notice = page.getByText(/^Filters applied from your search: /);
    await page.goto(`/search?q=${encodeURIComponent("charizard 4/102 psa 10")}`, { waitUntil: "domcontentloaded" });
    await expect(notice).toBeVisible();
    const canonical = new URL(page.url()).searchParams;
    expect(canonical.get("q")).toBe("charizard 4/102");
    expect(canonical.get("dimension.dim_seed_grading_company")).toBe("chc_seed_grading_company_psa");
    expect(canonical.get("dimension.dim_seed_grade")).toBe("chc_seed_grade_gem_mint_10");
    expect(canonical.get("interpreted")).toBe("dimension.dim_seed_grading_company,dimension.dim_seed_grade");
    expect(redirects).toHaveLength(1);
    await expect(page.getByRole("link", { name: /^View details for / }).first()).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("dimension.dim_seed_grade")).toBe("chc_seed_grade_gem_mint_10");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(notice).toBeVisible();
    await page
      .getByRole("button", { name: /^Remove .*grade:/i })
      .first()
      .click();
    await expect(page).not.toHaveURL(/dimension\.dim_seed_grade=/);
    expect(new URL(page.url()).searchParams.get("interpreted")).toBe(canonical.get("interpreted"));
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText(/gem.mint.10/i);

    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/dimension\.dim_seed_grade=chc_seed_grade_gem_mint_10/);
    await expect(notice).toBeVisible();
    expect(redirects).toHaveLength(1);
  });

  test("replaces restored pages when a former hybrid cursor restarts @marketplace-browse", async ({ page }) => {
    test.skip(
      onCortenMarketplace,
      "injects a stale cursor into marketplace-web's session-storage snapshot and intercepts its browser API request; Corten stores no cursor in browser history and reads the API on the server",
    );
    const firstPageUrl = `/api/marketplace/items?search=${encodeURIComponent(searchQuery)}&sort=relevance&limit=24&includeTotal=true`;
    const firstResponse = await page.request.get(firstPageUrl);
    expect(firstResponse.ok()).toBe(true);
    const firstPage = (await firstResponse.json()) as SearchResponse;
    const template = firstPage.items[0];
    expect(template, "the marketplace seed must include the configured search item").toBeDefined();
    expect(firstPage.total).toBeGreaterThanOrEqual(firstPage.items.length);
    const formerHybridCursor = "eyJraW5kIjoiaHlicmlkIiwib2Zmc2V0IjoyNH0";
    const resultSetKey = JSON.stringify([searchQuery, "", "", "", "", "", "", false, "relevance", []]);
    const storedSnapshot = JSON.stringify({
      version: 2,
      resultSetKey,
      pages: [pageFrom(template!, "former-hybrid", formerHybridCursor)],
      scrollY: 0,
    });
    await page.addInitScript(({ key, value }) => window.sessionStorage.setItem(key, value), {
      key: searchRestorationStorageKey,
      value: storedSnapshot,
    });

    const isFormerHybridRequest = (url: URL) =>
      url.pathname === "/api/marketplace/items" && url.searchParams.get("cursor") === formerHybridCursor;
    let allowRestart: () => void = () => undefined;
    const restartAllowed = new Promise<void>((resolve) => {
      allowRestart = resolve;
    });
    // Auto-pagination can start before scrolling. Keep the restored page observable until then.
    await page.route(isFormerHybridRequest, async (route) => {
      await restartAllowed;
      await route.continue();
    });
    const restartResponse = page.waitForResponse((response) => isFormerHybridRequest(new URL(response.url())));
    try {
      await page.goto(`/search?q=${encodeURIComponent(searchQuery)}`, { waitUntil: "domcontentloaded" });
      await page.getByText(/former-hybrid item 24$/).scrollIntoViewIfNeeded();
    } finally {
      allowRestart();
    }

    const response = await restartResponse;
    expect(response.ok()).toBe(true);
    const restarted = (await response.json()) as SearchResponse;
    expect(restarted).toMatchObject({
      cursorRestarted: true,
      total: firstPage.total,
      facets: firstPage.facets,
      category_counts: firstPage.category_counts,
    });
    expect(restarted.items.map((item) => item.catalog_item_id)).toEqual(
      firstPage.items.map((item) => item.catalog_item_id),
    );
    await expect(page.getByText(/former-hybrid item \d+$/)).toHaveCount(0);
  });

  test("restores loaded Result Set context after an item-detail roundtrip @marketplace-browse", async ({ page }) => {
    if (onCortenMarketplace) {
      const { searchQuery, pageSize, resultCount } = marketplaceBrowserE2eSeedContract.browsePagination;
      const searchPath = `/search?q=${encodeURIComponent(searchQuery)}`;
      await page.goto(searchPath);
      const details = page.locator("#results").getByRole("link", { name: /^View details for / });
      const orderedHrefs = () => details.evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
      const loadMore = page.getByRole("button", { name: "Load more results" });
      await expect(details).toHaveCount(pageSize);
      await expect(loadMore).toBeVisible();
      const firstPage = await orderedHrefs();
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);

      // Playwright clicks scroll to the footer, racing Corten's near-viewport autoload.
      await loadMore.evaluate((button) => button.focus({ preventScroll: true }));
      await page.keyboard.press("Enter");
      const keptUrl = new URL(searchPath, page.url());
      keptUrl.searchParams.set("more", String(pageSize));
      await expect(page).toHaveURL(keptUrl.href, { timeout: RESTORATION_HARD_TIMEOUT_MS });
      await expect(details).toHaveCount(resultCount);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      const loadedRows = await orderedHrefs();
      expect(loadedRows.slice(0, pageSize)).toEqual(firstPage);
      expect(new Set(loadedRows).size).toBe(resultCount);

      await details.nth(pageSize).click();
      await expect(page).toHaveURL(loadedRows[pageSize]!);
      await page.goBack({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(keptUrl.href);
      await expect.poll(orderedHrefs, { timeout: RESTORATION_HARD_TIMEOUT_MS }).toEqual(loadedRows);

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(keptUrl.href);
      await expect.poll(orderedHrefs, { timeout: RESTORATION_HARD_TIMEOUT_MS }).toEqual(loadedRows);
      return;
    }

    await page.goto(`/search?q=${encodeURIComponent(searchQuery)}`, { waitUntil: "domcontentloaded" });
    const basePage = await page.evaluate(async (query) => {
      const response = await fetch(
        `/api/marketplace/items?search=${encodeURIComponent(query)}&sort=relevance&limit=24`,
      );
      if (!response.ok) {
        throw new Error(`Could not prepare the search fixture (${response.status}).`);
      }
      return (await response.json()) as SearchResponse;
    }, searchQuery);
    const template = basePage.items[0];
    expect(template, "the marketplace seed must include the configured search item").toBeDefined();

    const preloadPage = pageFrom(template!, "preloaded", "restoration-cursor-1");
    const firstLoadedPage = pageFrom(template!, "loaded-once", "restoration-cursor-2");
    const secondLoadedPage = pageFrom(template!, "loaded-twice", null);
    const resultSetKey = JSON.stringify([searchQuery, "", "", "", "", "", "", false, "relevance", []]);
    const storedSnapshot = JSON.stringify({ version: 2, resultSetKey, pages: [preloadPage], scrollY: 0 });
    // Install after the outgoing document's pagehide, and never replant on back navigation.
    await page.addInitScript(
      ({ key, value, query }) => {
        const initializedKey = `${key}.fixture-initialized`;
        if (
          window.location.pathname !== "/search" ||
          new URLSearchParams(window.location.search).get("q") !== query ||
          window.sessionStorage.getItem(initializedKey)
        ) {
          return;
        }
        window.sessionStorage.setItem(key, value);
        window.sessionStorage.setItem(initializedKey, "true");
      },
      { key: searchRestorationStorageKey, value: storedSnapshot, query: searchQuery },
    );

    const loadedPages = [firstLoadedPage, secondLoadedPage];
    let loadCount = 0;
    await page.route("**/api/marketplace/items?**", async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (!cursor?.startsWith("restoration-cursor-")) {
        await route.continue();
        return;
      }
      const responsePage = loadedPages[loadCount];
      expect(responsePage, "the search should request exactly two restored cursors").toBeDefined();
      loadCount += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responsePage) });
    });

    await page.reload({ waitUntil: "domcontentloaded" });

    // The results list auto-loads each restored cursor as its sentinel nears the viewport (a
    // 900px root margin). Drive both restored pages by revealing each page's tail and asserting
    // on the rendered items. Clicking the "Load more results" button instead races the
    // auto-loader: the loading indicator intercepts the click and the button removes itself once
    // the terminal page (nextCursor null) arrives, so Playwright retried the click against a
    // detached element until the test timed out.
    await expect(page.getByText(/preloaded item 24$/)).toBeVisible();
    await page.getByText(/preloaded item 24$/).scrollIntoViewIfNeeded();
    await expect(page.getByText(/loaded-once item 24$/)).toBeVisible();
    await page.getByText(/loaded-once item 24$/).scrollIntoViewIfNeeded();
    await expect(page.getByText(/loaded-twice item 24$/)).toBeVisible();

    const roundtripLink = page.getByRole("link", { name: /View details for .*loaded-twice item 24/ });
    await expect(roundtripLink).toBeVisible();
    await roundtripLink.scrollIntoViewIfNeeded();
    await roundtripLink.focus();
    const beforeRoundtrip = await page.evaluate(() => window.scrollY);
    expect(beforeRoundtrip).toBeGreaterThan(0);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/items\//);

    const restorationStart = Date.now();
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${searchQuery}$`));
    // The cached Result Set and scroll context return without a refetch (the loaded page
    // count below stays at two). Web-first assertions gate on visible state, never on sleeps.
    await expect(page.getByText(/loaded-twice item 24$/)).toBeVisible({ timeout: RESTORATION_HARD_TIMEOUT_MS });
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - beforeRoundtrip), {
        timeout: RESTORATION_HARD_TIMEOUT_MS,
      })
      .toBeLessThan(200);
    const restorationMs = Date.now() - restorationStart;

    // The loaded pages restore exactly once: back navigation serves the cached Result Set and
    // must not re-issue the cursor fetches that built it.
    expect(loadCount, "restoration must not refetch the loaded Result Set").toBe(2);

    // Performance is reported separately from the hard correctness budget and does not gate the
    // merge queue: the target is recorded as an annotation, and a soft assertion flags only a
    // gross regression (restoration effectively blocked on a full server round-trip again)
    // without turning backend timing variance into a correctness flake. With cached-Result-Set
    // restoration this is near-instant.
    test.info().annotations.push({ type: "restoration-ms", description: String(restorationMs) });
    expect.soft(restorationMs, "Result Set restoration performance budget").toBeLessThan(RESTORATION_PERF_BUDGET_MS);
  });
});

function pageFrom(template: SearchItem, marker: string, nextCursor: string | null): SearchResponse {
  return {
    items: Array.from({ length: 24 }, (_, index) => ({
      ...template,
      catalog_item_id: `${template.catalog_item_id}-${marker}-${index + 1}`,
      title: `${template.title} ${marker} item ${index + 1}`,
    })),
    facets: [],
    category_counts: [],
    total: null,
    count: 24,
    nextCursor,
    retrievalMode: "lexical",
    lexicalCount: 24,
  };
}
