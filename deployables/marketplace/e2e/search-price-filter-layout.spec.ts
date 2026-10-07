import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";

type SearchResponse = {
  items: Array<{ slug: string }>;
  facets: Array<{
    kind: string;
    id: string;
    label: string;
    values: Array<{ id: string; label: string }>;
  }>;
  total: number | null;
  nextCursor: string | null;
};

test("Maximum price stays typeable at 1280x720 @marketplace-browse", async ({ page }, testInfo) => {
  const fixture = await openPriceFilters(page, testInfo, { width: 1280, height: 720 });
  await captureResponsiveEvidence({ page, testInfo, claimId: "search-price-max-typeable-1280x720" });
  const response = await typeMaximumPrice(page, fixture);
  await captureResponsiveEvidence({ page, testInfo, claimId: "search-price-max-filtered-1280x720" });
  await assertSettledResults(page, testInfo, fixture, response);
});

test("Maximum price stays typeable at 360x800 @marketplace-browse", async ({ page }, testInfo) => {
  const fixture = await openPriceFilters(page, testInfo, { width: 360, height: 800 });
  await captureResponsiveEvidence({ page, testInfo, claimId: "search-price-max-typeable-360x800" });
  const response = await typeMaximumPrice(page, fixture);
  await captureResponsiveEvidence({ page, testInfo, claimId: "search-price-max-filtered-360x800" });
  await assertSettledResults(page, testInfo, fixture, response);
});

async function openPriceFilters(page: Page, testInfo: TestInfo, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const query = new URLSearchParams({ search: "charizard", sort: "relevance", limit: "24" });
  const initial = await readSearch(page, query);
  const expansion = initial.facets.find((facet) => facet.kind === "reference" && facet.label === "Expansion");
  expect(expansion, "the existing search seed must expose the Expansion facet").toBeDefined();
  const baseSet = expansion!.values.find((value) => value.label === "Base Set");
  expect(baseSet, "the existing Expansion facet must contain Base Set").toBeDefined();
  const filterKey = `${expansion!.kind}.${expansion!.id}`;
  query.set(filterKey, baseSet!.id);
  const before = await readSearch(page, query);
  query.set("priceMax", "25.00");
  const after = await readSearch(page, query);
  expect(before.items.length, "Base Set must have seeded search results").toBeGreaterThan(0);
  expect(after.nextCursor, "the filtered seed must fit in one Result Set page").toBeNull();
  expect(
    after.items.map((item) => item.slug),
    "price filtering must visibly change the seeded Result Set",
  ).not.toEqual(before.items.map((item) => item.slug));

  const params = new URLSearchParams({ q: "charizard", [filterKey]: baseSet!.id });
  await page.goto(`/search?${params}`, { waitUntil: "domcontentloaded" });
  const mobile = viewport.width === 360;
  if (mobile) {
    await page.getByRole("button", { name: "Open filters", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Filters", exact: true })).toBeVisible();
  }
  const owner = page.locator(`[data-facet-list-presentation="${mobile ? "mobile" : "desktop"}"]`);
  await expect(owner).toBeVisible();
  await expand(owner.getByRole("button", { name: /^Expansion/ }));
  await expect(owner.getByRole("button", { name: /^Base Set \(/ })).toHaveAttribute("aria-pressed", "true");
  await expand(owner.getByRole("button", { name: /^Price and availability/ }));
  const input = owner.getByRole("spinbutton", { name: "Maximum price", exact: true });
  await expect(input).toBeVisible();
  await expect(input).toBeEditable();
  await page.evaluate(() => document.fonts.ready);

  // Restore only the old shared layout, on the same mounted controls and fixture.
  // Desktop's two-column rail is the negative control; mobile's full-width cell
  // is also measured, but was not the collapsing state in the old layout.
  await setOldLayout(owner, true);
  const oldGeometry = await measureInput(input);
  await attachGeometry(testInfo, "old-layout", oldGeometry);
  if (!mobile) {
    expect(() => assertUsableGeometry(oldGeometry)).toThrow(/Maximum price must be at least 4ch wide/);
  }
  await setOldLayout(owner, false);
  const geometry = await measureInput(input);
  await attachGeometry(testInfo, "fixed-layout", geometry);
  assertUsableGeometry(geometry);
  return { input, filterKey, baseSet: baseSet!, after, mobile };
}

async function typeMaximumPrice(
  page: Page,
  { input, filterKey, baseSet }: Awaited<ReturnType<typeof openPriceFilters>>,
) {
  await input.click();
  await expect(input).toBeFocused();
  const filteredResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/search.data" &&
      url.searchParams.get("priceMax") === "25.00" &&
      url.searchParams.get(filterKey) === baseSet!.id &&
      response.request().method() === "GET"
    );
  });
  await input.pressSequentially("25");
  await input.press("Tab");
  const response = await filteredResponse;
  expect(response.status(), "the real filtered search loader must succeed").toBe(200);
  await response.finished();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("priceMax") === "25.00" && url.searchParams.get(filterKey) === baseSet!.id,
  );
  await expect(input).toHaveValue("25.00");
  return response;
}

async function assertSettledResults(
  page: Page,
  testInfo: TestInfo,
  { mobile, after }: Awaited<ReturnType<typeof openPriceFilters>>,
  response: Awaited<ReturnType<typeof typeMaximumPrice>>,
) {
  if (mobile) {
    await page.getByRole("button", { name: "Show results", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Filters", exact: true })).not.toBeVisible();
  }
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const resultLinks = page.getByRole("link", { name: /^View details for / });
  await expect(resultLinks).toHaveCount(after.items.length);
  await expect
    .poll(async () =>
      resultLinks.evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname)),
    )
    .toEqual(after.items.map((item) => `/items/${item.slug}`));
  if (after.items.length === 0) {
    await expect(page.getByRole("heading", { name: "No items found", exact: true })).toBeVisible();
  }
  await testInfo.attach("filtered-loader", {
    body: JSON.stringify({
      url: response.url(),
      status: response.status(),
      expectedItems: after.items,
      total: after.total,
    }),
    contentType: "application/json",
  });
}

async function readSearch(page: Page, query: URLSearchParams): Promise<SearchResponse> {
  const response = await page.request.get(`/api/marketplace/items?${query}`);
  expect(response.status(), "existing guest search read must succeed").toBe(200);
  return response.json();
}

async function expand(trigger: Locator) {
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function setOldLayout(owner: Locator, restore: boolean) {
  await owner.getByRole("spinbutton").evaluateAll((inputs, oldLayout) => {
    for (const input of inputs) {
      const middle = input.parentElement!;
      const group = middle.parentElement!;
      if (oldLayout) {
        Object.assign(group.style, {
          display: "grid",
          gridTemplateColumns: "var(--control-sm-height) minmax(0, 1fr) var(--control-sm-height)",
          justifyContent: "normal",
        });
        Object.assign(middle.style, { minWidth: "0", flex: "0 1 auto" });
        Object.assign((input as HTMLElement).style, { minWidth: "0", width: "auto" });
      } else {
        group.removeAttribute("style");
        middle.removeAttribute("style");
        input.removeAttribute("style");
      }
    }
  }, restore);
}

async function measureInput(input: Locator) {
  // Native scrolling also handles the old zero-width input, so the negative
  // control fails the width oracle rather than Playwright's visibility setup.
  await input.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  return input.evaluate((element) => {
    const font = getComputedStyle(element);
    const ruler = document.createElement("span");
    Object.assign(ruler.style, {
      position: "absolute",
      visibility: "hidden",
      width: "4ch",
      font: font.font,
      fontVariantNumeric: font.fontVariantNumeric,
    });
    document.body.append(ruler);
    const fourCh = ruler.getBoundingClientRect().width;
    ruler.remove();
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      fourCh,
      hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element,
    };
  });
}

function assertUsableGeometry(geometry: Awaited<ReturnType<typeof measureInput>>) {
  expect(geometry.fourCh, "the computed-font ruler must have width").toBeGreaterThan(0);
  expect(geometry.width, "Maximum price must be at least 4ch wide").toBeGreaterThanOrEqual(geometry.fourCh);
  expect(geometry.hit, "Maximum price must receive pointer hits").toBe(true);
}

async function attachGeometry(testInfo: TestInfo, name: string, geometry: Awaited<ReturnType<typeof measureInput>>) {
  await testInfo.attach(name, { body: JSON.stringify(geometry), contentType: "application/json" });
}
