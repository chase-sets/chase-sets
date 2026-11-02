// Uses the item page pilot in a browser, against the real platform API, beside marketplace's own
// item page: as a guest without JavaScript and as the auth seed's collector with it. It checks the
// market summary, the rail and the market book against the API's ranked listings and offers,
// choosing a product option (a link) and one from a long list (a GET form), choosing a listing,
// one that is gone, the sell side, the moved and unknown addresses, and the page at 390 px:
// nothing scrolls sideways, every control is at least 40 px tall, and the mobile dock goes to the
// rail. It writes nothing.
// Usage: node scripts/smoke-market-item.mjs [pilot-url] [state-file] [marketplace-url] [api-url] [slug]
//   (state from `scripts/sign-in.mjs <pilot-url> <state-file> collector --api <api-url>`)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7792",
  stateFile = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
  slug = "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const usd = (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));
const browser = await chromium.launch();

async function context({ javaScriptEnabled, signedIn, viewport }) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    ...(signedIn ? { storageState: stateFile } : {}),
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  // Only the pilot's: the sell block also opens marketplace's page in this tab, whose realtime
  // stream the sandbox sometimes refuses (429).
  const ours = () => page.url().startsWith(base);
  page.on("console", (m) => m.type() === "error" && ours() && problems.push(m.text()));
  page.on("pageerror", (e) => ours() && problems.push(String(e)));
  return { ctx, page, problems };
}

const read = await (
  await fetch(`${api}/api/marketplace/items/${slug}`, { headers: { "chase-sets-read-target-context": "discovery" } })
).json();
const available = (l) => Number(l.visible_quantity ?? l.quantity_cap ?? 0);
const buyable = read.market_listings.filter(
  (l) => l.catalog_catalog_item_id === read.catalog_item_id && available(l) > 0,
);
const offers = read.offer_demand_matches.filter((o) => o.catalog_catalog_item_id === read.catalog_item_id);
check(
  buyable.length > 1 && offers.length > 0,
  `the API has listings and offers for ${slug} (${buyable.length}, ${offers.length})`,
);
const form = read.product_schema.dimensions.find((d) => d.appliesWhen.length === 0 && d.allowedOptions.length <= 5);
const graded = form?.allowedOptions.find((o) =>
  buyable.some((l) => l.selected_options.some((s) => s.optionId === o.optionId) && l !== buyable[0]),
);
const long = read.product_schema.dimensions.find(
  (d) => d.allowedOptions.length > 5 && d.appliesWhen.some((c) => c.optionIds.includes(graded?.optionId)),
);

/** The page's market: the price, its label, the facts, the rail and the book's prices. */
async function market(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[aria-labelledby="market-price"]');
    const rail = document.querySelector('[aria-labelledby="rail-title"]');
    return {
      label: card?.querySelector("#market-price")?.textContent?.trim(),
      price: card?.querySelector("p:nth-of-type(2)")?.textContent?.trim(),
      facts: Array.from(card?.querySelectorAll("dd") ?? [], (d) => d.textContent.trim()),
      rail: rail?.querySelector("h2")?.textContent?.trim(),
      railPrice: rail?.querySelector("p")?.textContent?.trim(),
      rows: Array.from(document.querySelectorAll('[aria-labelledby="market-book"] li[aria-label]'), (li) =>
        li.getAttribute("aria-label"),
      ),
      chosen:
        document
          .querySelector('[aria-labelledby="market-book"] [aria-current="true"]')
          ?.closest("li")
          ?.getAttribute("aria-label") ?? null,
      wide: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

// As a guest, without JavaScript, beside the API.
{
  const { ctx, page, problems } = await context({ javaScriptEnabled: false });
  const response = await page.goto(`${base}/items/${slug}`);
  check(response?.status() === 200, `a guest reads the page without signing in (${response?.status()})`);
  check((await page.locator("h1").textContent()) === read.title, "the item's title");
  const m = await market(page);
  const sellers = new Set(buyable.map((l) => l.account_id)).size;
  check(
    m.label === "Lowest ask" && m.price === usd(buyable[0].price_amount),
    `the lowest ask is the API's best listing (${m.price})`,
  );
  check(
    m.facts.join("|") ===
      `${buyable.reduce((n, l) => n + available(l), 0)}|${buyable.length} listings|${sellers} sellers`,
    `the facts (${m.facts.join(", ")})`,
  );
  check(
    m.rail === "Best available listing" && m.railPrice === usd(buyable[0].price_amount),
    `the rail has the best listing (${m.rail}, ${m.railPrice})`,
  );
  const prices = buyable.map((l) => usd(l.price_amount));
  check(
    m.rows.length === buyable.length && m.rows.every((r, i) => r.startsWith(`Listing ${prices[i]} `)),
    `the book has the API's listings in its order (${m.rows.join("; ")})`,
  );
  check(m.chosen === m.rows[0], "the best listing is the selected row");

  // A product option is a link: choosing it filters the book and the market.
  await page.getByRole("link", { name: new RegExp(`^${graded.label}`) }).click();
  const url = new URL(page.url());
  check(
    url.searchParams.get(`dimension.${form.dimensionId}`) === graded.optionId,
    `choosing ${graded.label} is in the address (${url.search})`,
  );
  const matching = buyable.filter((l) => l.selected_options.some((s) => s.optionId === graded.optionId));
  const g = await market(page);
  check(
    g.price === usd(matching[0].price_amount) && g.rows.length === matching.length,
    `${graded.label}: the lowest ask and the book are its listings (${g.price}, ${g.rows.length})`,
  );
  if (long) {
    // A long list of options is a GET form that keeps the option already chosen.
    const option = long.allowedOptions.find((o) =>
      matching.some((l) => l.selected_options.some((s) => s.optionId === o.optionId)),
    );
    await page.selectOption(`select[name="dimension.${long.dimensionId}"]`, option.optionId);
    await page
      .locator(`select[name="dimension.${long.dimensionId}"]`)
      .locator("xpath=ancestor::form")
      .getByRole("button")
      .click();
    const next = new URL(page.url()).searchParams;
    check(
      next.get(`dimension.${long.dimensionId}`) === option.optionId &&
        next.get(`dimension.${form.dimensionId}`) === graded.optionId,
      `the ${long.dimensionName} form keeps ${form.dimensionName} (${next})`,
    );
  }

  // A listing chosen in the book is the rail's; one that is gone says so.
  await page.goto(`${base}/items/${slug}`);
  await page
    .locator('[aria-labelledby="market-book"] li[aria-label]')
    .nth(1)
    .getByRole("link", { name: "Select" })
    .click();
  const chosen = await market(page);
  check(
    chosen.rail === "Selected listing" && chosen.railPrice === usd(buyable[1].price_amount),
    `Select puts the listing in the rail (${chosen.railPrice})`,
  );
  await page.goto(`${base}/items/${slug}?listing=lst_gone_for_good`);
  check(await page.getByText("Listing unavailable").isVisible(), "a listing that is gone says so");
  check(problems.length === 0, `no console errors (${problems.join("; ")})`);
  await ctx.close();
}

// Signed in, with JavaScript: the sell side, beside marketplace's page.
{
  const { ctx, page, problems } = await context({ javaScriptEnabled: true, signedIn: true });
  await page.goto(`${base}/items/${slug}`);
  await page.getByRole("link", { name: "Sell", exact: true }).click();
  await page.waitForURL(/market=sell/);
  await page.waitForFunction(() => document.querySelector("#market-price")?.textContent?.trim() === "Best offer");
  const s = await market(page);
  check(s.price === usd(offers[0].price_amount), `selling: the best offer is the API's first (${s.price})`);
  check(
    s.rows.length === offers.length && s.rows.every((r, i) => r.startsWith(`Offer ${usd(offers[i].price_amount)} `)),
    `the book has the offers in the API's order (${s.rows.length})`,
  );
  check(s.rail === "Best offer", `the rail has the best offer (${s.rail})`);
  const theirs = await page.goto(`${web}/items/${slug}`);
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const buy = await (async () => {
    const p2 = await ctx.newPage();
    await p2.goto(`${base}/items/${slug}`);
    const m = await market(p2);
    await p2.close();
    return m;
  })();
  check(
    theirs?.status() === 200 && body.includes(buy.price),
    `marketplace's page has the same lowest ask (${buy.price})`,
  );
  check(
    buy.facts.slice(1).every((f) => body.includes(f)),
    `and the same listing and seller counts (${buy.facts.slice(1).join(", ")})`,
  );
  check(problems.length === 0, `no console errors (${problems.join("; ")})`);
  await ctx.close();
}

// Moved and unknown addresses.
{
  const moved = await fetch(`${base}/items/${read.catalog_item_id}?market=sell`, { redirect: "manual" });
  check(
    moved.status === 301 && moved.headers.get("location") === `/items/${slug}?market=sell`,
    `the item's id moves to its slug for good (${moved.status} ${moved.headers.get("location")})`,
  );
  const unknown = await fetch(`${base}/items/no-such-item-anywhere`);
  check(unknown.status === 404, `an unknown item is not found (${unknown.status})`);
}

// At 390 px: nothing scrolls sideways, every control is at least 40 px tall.
for (const address of ["", `?dimension.${form.dimensionId}=${graded.optionId}`, "?market=sell", "?book=details"]) {
  const { ctx, page } = await context({ javaScriptEnabled: true, viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/items/${slug}${address}`);
  const { wide, small } = await page.evaluate(() => ({
    wide: document.documentElement.scrollWidth > window.innerWidth,
    small: Array.from(document.querySelectorAll("main a, main button, main select"))
      // A seller's or buyer's name is a link in a line of text, not a control.
      // (Corten scopes class names: `item-detail__who`.) Such a link is 24 px, WCAG 2.5.8's minimum.
      .filter((e) => !e.closest('[class*="__who"]') && e.getBoundingClientRect().height > 0)
      .filter((e) => e.getBoundingClientRect().height < 40)
      .map(
        (e) => `${e.tagName} "${e.textContent.trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`,
      ),
  }));
  check(!wide, `390 px ${address || "(nothing chosen)"}: nothing scrolls sideways`);
  check(
    small.length === 0,
    `390 px ${address || "(nothing chosen)"}: every control is at least 40 px (${small.join(", ")})`,
  );
  await ctx.close();
}

// The mobile action dock: held at the bottom at 390 px, its Sell goes to the rail on the Sell side
// (with and without JavaScript), and it is not shown at 1280 px.
for (const javaScriptEnabled of [true, false]) {
  const { ctx, page } = await context({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/items/${slug}`);
  const dock = page.locator('[class*="__dock-bar"]');
  const box = await dock.boundingBox();
  const how = javaScriptEnabled ? "with JavaScript" : "without";
  check(
    Boolean(box) && box.y + box.height <= 844 && box.y > 600,
    `390 px: the dock is at the bottom of the screen (${how}, top ${Math.round(box?.y ?? -1)})`,
  );
  await dock.getByRole("link", { name: "Sell", exact: true }).click();
  await page.waitForURL((u) => u.searchParams.get("market") === "sell" && u.hash === "#rail-title");
  await page.waitForTimeout(300);
  const top = (await page.locator("#rail-title").boundingBox())?.y ?? -1;
  // Scrolled to it, the title sits at the top, give or take a fraction of a pixel.
  check(top > -2 && top < 200, `its Sell lands on the Sell rail (${how}, the rail's title at ${Math.round(top)} px)`);
  await ctx.close();
}
{
  const { ctx, page } = await context({ javaScriptEnabled: true, viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/items/${slug}`);
  check(!(await page.locator('[class*="__dock"]').first().isVisible()), "1280 px: no dock");
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
