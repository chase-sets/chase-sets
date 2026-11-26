import { expect, test, type Locator, type Page } from "@playwright/test";
import { marketplaceBrowserE2eSeedContract as seed } from "./seed-contract";
import { onCortenMarketplace } from "./system";

const searchPath = `/search?q=${encodeURIComponent(seed.browse.searchQuery)}`;
const formKey = "dimension.dim_seed_form";
const itemPath = seed.itemDetail.selectedProductRoutePath;

async function open(page: Page, path: string) {
  // Without load, Corten intentionally leaves the first navigation to the browser.
  const response = await page.goto(path, { waitUntil: "load" });
  expect(response?.ok(), `expected the real marketplace page for ${path}`).toBe(true);
}

function bookLink(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Market book", exact: true }).getByRole("link", { name, exact: true });
}

function rangeLink(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Time range", exact: true }).getByRole("link", { name, exact: true });
}

function watchDocument(page: Page) {
  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documentRequests.push(request.url());
  });
  return documentRequests;
}

function scrollTop(page: Page) {
  return page.evaluate(() => window.scrollY);
}

async function expectScrollRetained(page: Page, previousY: number) {
  expect(previousY, "exercise the transition below the top of the page").toBeGreaterThan(24);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(24);
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const available = document.documentElement.scrollHeight - window.innerHeight;
        // If the replacement is shorter, the browser can only keep this much of the old scroll.
        return Math.abs(scrollY - Math.min(previous, available));
      }, previousY),
    )
    .toBeLessThanOrEqual(8);
}

async function activateBelowFold(page: Page, control: Locator) {
  await control.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await expect(control).toBeInViewport();
  await control.focus();
  const previousY = await scrollTop(page);
  await control.press("Enter");
  return previousY;
}

export function registerMarketplaceInteractionTests() {
  test.describe("Corten marketplace same-page refinements", () => {
    test.skip(!onCortenMarketplace, "This journey exercises the Corten marketplace and its browser-e2e seed.");
    test.use({ locale: "en-US" });

    for (const [surface, tag] of [
      ["desktop", ["@browser-e2e-seed"]],
      ["phone", ["@browser-e2e-seed", "@mobile"]],
    ] as const) {
      test(`market book and variants preserve place on ${surface}`, { tag: [...tag] }, async ({ page }) => {
        if (surface === "desktop") await page.setViewportSize({ width: 1280, height: 640 });
        await open(page, itemPath);
        await expect(page.getByRole("heading", { level: 1, name: "Charizard", exact: true })).toBeVisible();
        await expect(bookLink(page, "Listings")).toHaveAttribute("aria-current", "page");
        const documents = watchDocument(page);

        const offers = bookLink(page, "Offers");
        let previousY = await activateBelowFold(page, offers);
        await expect(page).toHaveURL((url) => url.searchParams.get("book") === "offers");
        await expect(offers).toHaveAttribute("aria-current", "page");
        await expect(offers).toBeFocused();
        await expectScrollRetained(page, previousY);
        expect(documents).toEqual([]);

        await page.goBack();
        await expect(page).toHaveURL((url) => !url.searchParams.has("book"));
        await expect(bookLink(page, "Listings")).toHaveAttribute("aria-current", "page");
        await page.goForward();
        await expect(offers).toHaveAttribute("aria-current", "page");

        const graded = page.getByRole("region", { name: "Choose options" }).getByRole("link", { name: /^Graded\b/ });
        // The rail may already fit above the fold at a wide viewport.
        if (surface === "phone") {
          previousY = await activateBelowFold(page, graded);
        } else {
          await graded.scrollIntoViewIfNeeded();
          await graded.focus();
          await graded.press("Enter");
        }
        await expect(page).toHaveURL(
          (url) =>
            url.searchParams.get(formKey) === "chc_seed_form_graded" && url.searchParams.get("book") === "offers",
        );
        await expect(graded).toHaveAttribute("aria-current", "true");
        await expect(graded).toBeFocused();
        if (surface === "phone") await expectScrollRetained(page, previousY);
        expect(documents).toEqual([]);

        await page.goBack();
        await expect(page).toHaveURL((url) => url.searchParams.get(formKey) === "chc_seed_form_raw");
        const sales = bookLink(page, "Sales");
        previousY = await activateBelowFold(page, sales);
        await expect(sales).toHaveAttribute("aria-current", "page");
        await expect(sales).toBeFocused();
        await expectScrollRetained(page, previousY);
        const month = rangeLink(page, "30 days");
        previousY = await activateBelowFold(page, month);
        await expect(page).toHaveURL((url) => url.searchParams.get("range") === "30d");
        await expect(month).toHaveAttribute("aria-current", "page");
        await expect(month).toBeFocused();
        await expectScrollRetained(page, previousY);
        await page.goBack();
        await expect(rangeLink(page, "90 days")).toHaveAttribute("aria-current", "page");
        expect(documents).toEqual([]);
      });
    }

    test(
      "large variant choices follow browser history and Clear filters keeps place",
      { tag: "@browser-e2e-seed" },
      async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 640 });
        await open(page, itemPath);
        const conditionLabel = { name: "Condition", exact: true };
        const form = page
          .getByRole("region", { name: "Choose options" })
          .locator("form")
          .filter({ has: page.getByRole("combobox", conditionLabel) });
        const condition = form.getByRole("combobox", conditionLabel);
        const apply = form.getByRole("button", { name: "Select", exact: true });
        const conditionKey = "dimension.dim_seed_condition";
        const documents = watchDocument(page);
        const mint = "chc_seed_condition_mint";
        const excellent = "chc_seed_condition_excellent";
        await expect(condition).toHaveValue("chc_seed_condition_near_mint");
        for (const value of [mint, excellent]) {
          await condition.selectOption(value);
          await apply.focus();
          await apply.press("Enter");
          await expect(page).toHaveURL((url) => url.searchParams.get(conditionKey) === value);
          await expect(condition).toHaveValue(value);
          await expect(apply).toBeFocused();
        }
        await page.goBack();
        await expect(page).toHaveURL((url) => url.searchParams.get(conditionKey) === mint);
        await expect(condition).toHaveValue(mint);
        await page.goForward();
        await expect(page).toHaveURL((url) => url.searchParams.get(conditionKey) === excellent);
        await expect(condition).toHaveValue(excellent);

        const clear = page
          .getByRole("region", { name: "Market book", exact: true })
          .getByRole("link", { name: "Clear filters", exact: true });
        const previousY = await activateBelowFold(page, clear);
        await expect(clear).toHaveCount(0);
        await expect(page).toHaveURL((url) => !url.searchParams.has(formKey) && !url.searchParams.has(conditionKey));
        await expect(bookLink(page, "Listings")).toBeFocused();
        await expectScrollRetained(page, previousY);
        expect(documents).toEqual([]);
      },
    );

    test(
      "sort and chip removal preserve the search document and place",
      { tag: "@browser-e2e-seed" },
      async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 640 });
        await open(page, searchPath);
        const main = page.getByRole("main");
        const sort = main.getByRole("combobox", { name: "Sort", exact: true });
        await expect(main.getByRole("link", { name: /^View details for / }).first()).toBeVisible();
        const documents = watchDocument(page);
        await sort.focus();
        await page.evaluate(() => window.scrollTo(0, 48));
        const previousY = await scrollTop(page);
        await sort.selectOption({ label: "Title A-Z" });
        await expect(page).toHaveURL((url) => url.searchParams.get("sort") === "title_asc");
        const chip = main.getByRole("link", { name: "Remove Sort: Title A-Z", exact: true });
        await expect(chip).toBeVisible();
        await expect(sort).toBeFocused();
        await expectScrollRetained(page, previousY);

        await chip.focus();
        const chipY = await scrollTop(page);
        await chip.press("Enter");
        await expect(page).toHaveURL(
          (url) => !url.searchParams.has("sort") && url.searchParams.get("q") === seed.browse.searchQuery,
        );
        await expect(chip).toHaveCount(0);
        await expect(main.getByRole("button", { name: "Marketplace search", exact: true })).toBeFocused();
        await expectScrollRetained(page, chipY);
        expect(documents).toEqual([]);

        await page.goBack();
        await expect(sort).toHaveValue("title_asc");
        await expect(chip).toBeVisible();
        await page.goForward();
        await expect(sort).toHaveValue("relevance");
        await expect(chip).toHaveCount(0);
        expect(documents).toEqual([]);
      },
    );

    test(
      "returning to Relevance on a sort-only search focuses the search action",
      { tag: "@browser-e2e-seed" },
      async ({ page }) => {
        await open(page, "/search?sort=title_asc");
        const main = page.getByRole("main");
        const sort = main.getByRole("combobox", { name: "Sort", exact: true });
        await expect(sort).toHaveValue("title_asc");
        const documents = watchDocument(page);
        await sort.focus();
        await sort.selectOption("relevance");
        await expect(page).toHaveURL((url) => url.pathname === "/search" && !url.search);
        await expect(sort).toHaveCount(0);
        await expect(main.getByRole("button", { name: "Marketplace search", exact: true })).toBeFocused();

        await page.goBack();
        await expect(page).toHaveURL((url) => url.searchParams.get("sort") === "title_asc");
        await expect(sort).toHaveValue("title_asc");
        await page.goForward();
        await expect(page).toHaveURL((url) => url.pathname === "/search" && !url.search);
        await expect(sort).toHaveCount(0);
        expect(documents).toEqual([]);
      },
    );

    test(
      "phone filters apply and return focus to their opener",
      { tag: ["@browser-e2e-seed", "@mobile"] },
      async ({ page }) => {
        await open(page, searchPath);
        const main = page.getByRole("main");
        const opener = main.getByRole("button", { name: /^Filters\b/ });
        const documents = watchDocument(page);
        await opener.click();
        const dialog = page.getByRole("dialog", { name: "Filters", exact: true });
        const inStock = dialog.getByRole("checkbox", { name: /^In stock\b/ });
        await expect(dialog).toBeVisible();
        await inStock.check();
        await expect(inStock).toBeChecked();
        await expect(page).toHaveURL((url) => !url.searchParams.has("inStock"));
        await dialog.getByRole("button", { name: "Show results", exact: true }).click();
        await expect(page).toHaveURL((url) => url.searchParams.get("inStock") === "true");
        await expect(main.getByRole("link", { name: "Remove In stock", exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
        expect(documents).toEqual([]);

        await page.goBack();
        await expect(main.getByRole("link", { name: "Remove In stock", exact: true })).toHaveCount(0);
        await opener.click();
        await expect(inStock).not.toBeChecked();
        await dialog.getByRole("button", { name: "Close filters", exact: true }).click();
        await page.goForward();
        await expect(main.getByRole("link", { name: "Remove In stock", exact: true })).toBeVisible();
        await opener.click();
        await expect(inStock).toBeChecked();
        expect(documents).toEqual([]);
      },
    );

    test(
      "item and search states remain native destinations without JavaScript",
      { tag: "@browser-e2e-seed" },
      async ({ browser, baseURL }) => {
        const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
        try {
          const page = await context.newPage();
          await open(page, itemPath);
          const sales = bookLink(page, "Sales");
          await sales.click();
          await expect(sales).toHaveAttribute("aria-current", "page");
          await expect(page).toHaveURL((url) => url.hash === "#market-book");
          await expect(page.getByRole("heading", { name: "Market book", exact: true })).toBeInViewport();
          const year = rangeLink(page, "1 year");
          await year.click();
          await expect(year).toHaveAttribute("aria-current", "page");
          const direct = new URL(page.url());
          expect(direct.pathname).toBe(seed.itemDetail.routePath);
          expect(direct.searchParams.get("book")).toBe("sales");
          expect(direct.searchParams.get("range")).toBe("1y");
          expect(direct.hash).toMatch(/^#sales-ranges-[a-z]+$/);
          await expect(page.getByRole("navigation", { name: "Time range", exact: true })).toHaveAttribute(
            "id",
            direct.hash.slice(1),
          );
          await expect(year).toBeInViewport();

          const directPage = await context.newPage();
          await open(directPage, direct.href);
          await expect(bookLink(directPage, "Sales")).toHaveAttribute("aria-current", "page");
          await expect(rangeLink(directPage, "1 year")).toHaveAttribute("aria-current", "page");
          await expect(rangeLink(directPage, "1 year")).toBeInViewport();
          await directPage.close();

          await open(page, searchPath);
          const main = page.getByRole("main");
          const sort = main.getByRole("combobox", { name: "Sort", exact: true });
          await sort.selectOption({ label: "Title A-Z" });
          await main.getByRole("button", { name: "Marketplace search", exact: true }).click();
          await expect(page).toHaveURL(
            (url) =>
              url.searchParams.get("sort") === "title_asc" && url.searchParams.get("q") === seed.browse.searchQuery,
          );
          await expect(sort).toHaveValue("title_asc");
          await expect(main.getByRole("link", { name: "Remove Sort: Title A-Z", exact: true })).toBeVisible();
        } finally {
          await context.close();
        }
      },
    );
  });
}
