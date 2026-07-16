import { expect, test } from "@playwright/test";

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";
const searchRestorationStorageKey = "discovery.search.restoration.v2";
// Correctness must not hinge on a stopwatch: a slow CI machine should never turn a working
// restoration into a timing flake, so the visible-state assertions get a generous hard
// budget. The performance target is asserted separately and softly below.
const RESTORATION_HARD_TIMEOUT_MS = 15_000;
const RESTORATION_PERF_BUDGET_MS = 5_000;

type SearchItem = Record<string, unknown> & Readonly<{ catalog_item_id: string; title: string }>;
type SearchResponse = Readonly<{
  items: SearchItem[];
  facets: unknown[];
  total: number | null;
  count: number;
  nextCursor: string | null;
  retrievalMode: "lexical" | "rescue" | "hybrid" | "structured";
  lexicalCount: number | null;
}>;

test.describe("marketplace search scroll restoration", () => {
  test("restores loaded Result Set context after an item-detail roundtrip @marketplace-browse", async ({ page }) => {
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
    await page.evaluate(({ key, value }) => window.sessionStorage.setItem(key, value), {
      key: searchRestorationStorageKey,
      value: storedSnapshot,
    });

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
    const loadMore = page.getByRole("button", { name: "Load more results" });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(page.getByText(/loaded-once item 24$/)).toBeVisible();
    await loadMore.click();

    const roundtripLink = page.getByRole("link", { name: /View details for .*loaded-twice item 24/ });
    await expect(roundtripLink).toBeVisible();
    await roundtripLink.scrollIntoViewIfNeeded();
    const beforeRoundtrip = await page.evaluate(() => window.scrollY);
    expect(beforeRoundtrip).toBeGreaterThan(0);

    await roundtripLink.click();
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

    // Performance target, reported separately from the hard correctness budget above. A soft
    // assertion surfaces a restoration regression without masking it as a correctness failure.
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
    total: null,
    count: 24,
    nextCursor,
    retrievalMode: "lexical",
    lexicalCount: 24,
  };
}
