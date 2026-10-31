// Uses marketplace search in a browser, against the real platform API, as a visitor.
// - Without JavaScript: words the API reads a filter from (`charizard psa 10`) land on the address
//   with the filters applied and say so; the filters form applies In stock with Show results; a
//   chip is a link without its filter; `page` and `category=..` move for good.
// - With JavaScript on a desktop: a filter applies as soon as it changes, and the page keeps the
//   checkbox focused and the scroll where it was (todd-skelton/corten#92); the sort applies on
//   change; a category in the rail is its own path.
// - At 390 px: Filters opens the filters as a modal dialog, a choice there waits for Show results,
//   nothing scrolls sideways and every control is at least 40 px tall.
// - The home page (`/`): the featured categories (four columns at 1280 px) and the three newest
//   items (two columns) in place of the results; words searched there stay at `/`; at 390 px one
//   column, nothing sideways and 40 px controls.
// Load more needs more than 24 results, which the sandbox's seed does not have; the router tests
// cover it. The first search after a quiet minute fails in the sandbox,
// so the smoke reads once before it starts.
// Usage: node scripts/smoke-market-search.mjs [pilot-url]
import { chromium } from "@playwright/test";

const [base = "http://localhost:7793"] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

// Wake the search read.
for (let i = 0; i < 3 && (await fetch(`${base}/search?q=warm`)).status !== 200; i += 1);

const browser = await chromium.launch();
async function context({ javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const query = (page) => new URL(page.url()).searchParams;
// The runtime's navigation changes the address first and swaps the page after (`main[aria-busy]`
// meanwhile), so a step waits for both.
async function settled(page, url) {
  await page.waitForURL(url);
  await page.waitForFunction(() => !document.querySelector("main")?.hasAttribute("aria-busy"));
}

// No script.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  const moved = await page.request.get(`${base}/search?page=2&q=charizard`, { maxRedirects: 0 });
  check(moved.status() === 301 && moved.headers().location === "/search?q=charizard", "page= moves for good");
  await page.goto(`${base}/search?q=charizard%20psa%2010`);
  const params = query(page);
  check(
    params.get("q") === "charizard" &&
      params.getAll("dimension.dim_seed_grade").includes("chc_seed_grade_gem_mint_10") &&
      params.has("interpreted"),
    `the words' filters applied: ${page.url()}`,
  );
  check(
    await page.getByText("Filters applied from your search:").isVisible(),
    "the page says which filters it applied",
  );
  await page.getByLabel("In stock").check();
  await page.getByRole("button", { name: "Show results" }).click();
  await page.waitForURL(/inStock=true/);
  check(
    query(page).get("inStock") === "true" && query(page).get("q") === "charizard",
    `Show results sends every choice: ${page.url()}`,
  );
  check(query(page).has("priceMin"), "without a script, the form sends its empty fields too");
  const chip = page.getByRole("link", { name: "Remove In stock" });
  await chip.click();
  await page.waitForURL((u) => !u.searchParams.has("inStock"));
  check(
    !query(page).has("inStock") && query(page).get("q") === "charizard",
    "a chip is the address without its filter",
  );
  const category = await page.request.get(`${base}/search?category=Singles`, { maxRedirects: 0 });
  check(
    category.status() === 301 && /^\/categories\/singles-/.test(category.headers().location ?? ""),
    `category= moves to its path: ${category.headers().location}`,
  );
  await ctx.close();
}

// Script, desktop (short, so the rail scrolls).
{
  const { ctx, page, problems } = await context({ viewport: { width: 1280, height: 600 } });
  await page.goto(`${base}/search?q=charizard`);
  await page.waitForFunction(() => window.__hydratedAt);
  const grade = page.locator("details", { has: page.locator("summary", { hasText: /^Grade/ }) });
  await grade.locator("summary").click();
  const box = grade.getByLabel(/Gem Mint 10/);
  await box.scrollIntoViewIfNeeded();
  const rail = () => page.evaluate(() => document.getElementById("search-filters")?.scrollTop ?? 0);
  const before = { y: await page.evaluate(() => window.scrollY), rail: await rail() };
  await box.focus();
  await page.keyboard.press("Space");
  await settled(page, /dimension\.dim_seed_grade=chc_seed_grade_gem_mint_10/);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    y: window.scrollY,
    rail: document.getElementById("search-filters")?.scrollTop ?? 0,
    inView: (() => {
      const a = document.activeElement?.getBoundingClientRect();
      const r = document.getElementById("search-filters")?.getBoundingClientRect();
      return Boolean(a && r && a.top >= r.top && a.bottom <= r.bottom && a.bottom <= window.innerHeight);
    })(),
    name: document.activeElement?.getAttribute("name"),
    value: document.activeElement?.getAttribute("value"),
    checked: document.activeElement?.checked,
  }));
  check(
    after.name === "dimension.dim_seed_grade" && after.value === "chc_seed_grade_gem_mint_10" && after.checked,
    `focus stays on the checked filter: ${JSON.stringify(after)}`,
  );
  check(before.rail > 0, `the rail had to scroll to the filter (${before.rail})`);
  check(
    Math.abs(after.y - before.y) < 80 && Math.abs(after.rail - before.rail) < 80 && after.inView,
    `the page and the rail stay where they were, the filter in view: ${JSON.stringify(before)} then ${JSON.stringify(after)}`,
  );
  check(
    ![...query(page).entries()].some(([, v]) => v === "") && !query(page).has("sort"),
    `the address has no empty fields: ${page.url()}`,
  );
  await page.locator('select[name="sort"]').selectOption("price_asc");
  await settled(page, /sort=price_asc/);
  check(
    query(page).get("sort") === "price_asc" && query(page).has("dimension.dim_seed_grade"),
    "the sort applies on change, with the filters",
  );
  await page.getByRole("link", { name: /^Singles \(/ }).click();
  await settled(page, /\/categories\/singles-/);
  check(
    (await page.getByRole("heading", { name: "Search results for charizard" }).count()) === 1 &&
      query(page).get("sort") === "price_asc",
    `a category is its own path, the other choices kept: ${page.url()}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Script, 390 px.
{
  const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/search?q=charizard`);
  await page.waitForFunction(() => window.__hydratedAt);
  check(!(await page.locator("#search-filters").isVisible()), "the filters are behind a button");
  await page.getByRole("button", { name: /^Filters/ }).click();
  check(
    await page.evaluate(() => document.querySelector("#search-filters")?.matches(":modal")),
    "Filters opens a modal dialog",
  );
  const url = page.url();
  await page.locator("#search-filters summary", { hasText: /^Language/ }).click();
  await page.locator("#search-filters").getByLabel("Japanese").check();
  await page.waitForTimeout(500);
  check(page.url() === url, "a choice in the dialog waits for Show results");
  await page.getByRole("button", { name: "Show results" }).click();
  await settled(page, /language=ja/);
  check(query(page).get("language") === "ja", "Show results applies it");
  await page.getByRole("link", { name: "Remove Language: Japanese" }).click();
  await settled(page, (u) => !u.searchParams.has("language"));
  const layout = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("main a, main button, main input, main select")) {
      const r = el.getBoundingClientRect();
      if (
        r.width === 0 ||
        el.closest("dialog:not([open])") ||
        el.closest(".visually-hidden") ||
        el.type === "checkbox" ||
        el.type === "radio" ||
        el.type === "hidden"
      )
        continue;
      if (r.height < 40)
        small.push(
          `${el.tagName} ${(el.textContent || el.getAttribute("name") || "").trim().slice(0, 30)} ${Math.round(r.height)}`,
        );
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
  });
  check(layout.overflow <= 0, `nothing scrolls sideways (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `every control is at least 40 px tall${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// The home page.
const columns = (page, selector) =>
  page.evaluate((s) => getComputedStyle(document.querySelector(s)).gridTemplateColumns.split(" ").length, selector);
const layoutAt = (page) =>
  page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("main a, main button, main input, main select")) {
      const r = el.getBoundingClientRect();
      if (
        r.width === 0 ||
        el.closest("dialog:not([open])") ||
        el.closest(".visually-hidden") ||
        el.type === "checkbox" ||
        el.type === "radio" ||
        el.type === "hidden" ||
        el.getAttribute("aria-hidden") === "true"
      )
        continue;
      if (r.height < 40)
        small.push(
          `${el.tagName} ${(el.textContent || el.getAttribute("name") || "").trim().slice(0, 30)} ${Math.round(r.height)}`,
        );
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
  });
{
  const categories = await (await fetch(`${base.replace(/:\d+$/, ":7762")}/api/marketplace/categories`))
    .json()
    .catch(() => null);
  const expected = Math.min(4, categories?.items?.length ?? 0);
  const { ctx, page, problems } = await context();
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__hydratedAt);
  const featured = await page.locator('[aria-labelledby="home-featured-heading"] li').count();
  check(expected > 0 && featured === expected, `the featured categories: ${featured} of ${expected}`);
  check((await page.getByRole("link", { name: "View item" }).count()) === 3, "the three newest items");
  check((await page.locator('li[id^="result-"]').count()) === 0, "the shelf is in place of the results");
  check(
    (await columns(page, '[aria-labelledby="home-featured-heading"] ul')) === 4,
    "four featured columns at 1280 px",
  );
  check((await columns(page, '[aria-labelledby="home-arrivals-heading"] ol')) === 2, "two arrival columns at 1280 px");
  const newest = await page.getByRole("link", { name: "Browse all new arrivals" }).getAttribute("href");
  check(newest === "/search?sort=newest", `Browse all new arrivals: ${newest}`);
  await page.locator('input[name="q"]').first().fill("charizard");
  await page.locator('input[name="q"]').first().press("Enter");
  await settled(page, /\?q=charizard/);
  check(
    new URL(page.url()).pathname === "/" && (await page.locator('li[id^="result-"]').count()) > 0,
    `words searched at the home page stay there: ${page.url()}`,
  );
  check(
    (await page.locator('[aria-labelledby="home-featured-heading"]').count()) === 0,
    "and show results, not the shelf",
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}
{
  const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__hydratedAt);
  check((await columns(page, '[aria-labelledby="home-featured-heading"] ul')) === 1, "one featured column at 390 px");
  check((await columns(page, '[aria-labelledby="home-arrivals-heading"] ol')) === 1, "one arrival column at 390 px");
  const layout = await layoutAt(page);
  check(layout.overflow <= 0, `the home page does not scroll sideways (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `every home page control is at least 40 px tall${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
