// The seller's offer matches in a browser, against the real platform API, as the auth seed's
// demo seller, with the seed collector making the offer the run watches. WRITES: one synthetic
// offer from the collector on the seller's Pikachu (11.11 or 11.12 USD, one card), reused by every
// run since the collector cannot withdraw it; its price moves
// between the two to see the list redraw live. Add selected offer to Sell List adds it to the
// seller's sell list, and the run removes that line. With "decline", a second synthetic offer is
// made and declined through the page, which cannot be undone: it stays the collector's open offer.
// - At 390 px nothing scrolls sideways and every control is at least 40 px tall.
// - The list shows the snapshot, the Sell List card and each match; the synthetic offer's row is
//   drawn again live when its price changes, without a reload.
// - An offer match's page shows its overview and the acceptance terms; on a phone its actions sit
//   at the bottom of the screen.
// - Add selected offer to Sell List goes to marketplace's sell list, which has the line.
// - Without JavaScript: the list and Add selected offer to Sell List work as forms.
// - No console errors.
// Usage: node scripts/smoke-market-offer-matches.mjs [pilot-url] [seller-state] [collector-state] [api-url] [decline]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const decline = args.includes("decline");
const [
  base = "http://localhost:7794",
  sellerState = "../../artifacts/corten-pilot/marketplace-state.json",
  collectorState = "../../artifacts/corten-pilot/collector-state.json",
  api = "http://localhost:7762",
] = args.filter((a) => a !== "decline");
const PRICES = ["11.11", "11.12"];
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}
const session = (file) =>
  JSON.parse(readFileSync(file, "utf8"))
    .cookies.filter((c) => c.name === "chase_sets_session")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
const seller = session(sellerState);
const collector = session(collectorState);
async function call(cookie, method, path, body) {
  const headers = { cookie, "content-type": "application/json", "chase-sets-read-target-context": "marketplace" };
  const res = await fetch(`${api}/api/marketplace/account${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const matches = async () => (await call(seller, "GET", "/offers/matches?limit=100&offset=0")).body?.items ?? [];
const until = async (ready) => {
  for (let i = 0; i < 20; i += 1) {
    const found = (await matches()).find(ready);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

// The offer the run watches: the collector's synthetic one if a run made it, else a new one on
// the product of the seller's first match that can be fulfilled.
const before = await matches();
const target = before.find((o) => o.can_fulfill && !PRICES.includes(o.price_amount) && o.buyer_account_id);
check(Boolean(target), "the seller has an offer match to copy the product from");
async function submit(price) {
  const o = target;
  const res = await call(collector, "POST", "/offers/submitted", {
    catalogItemId: o.catalog_catalog_item_id,
    productId: o.product_id,
    itemTitle: o.item_title,
    itemSubtitle: o.item_subtitle,
    selectedOptions: o.selected_options,
    productSummary: o.product_summary,
    shippingDestinationSnapshot: {
      name: "Pilot Smoke",
      line1: "1 Test St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    priceAmount: price,
    priceCurrencyCode: "USD",
    quantityRequested: 1,
  });
  return res.status === 201 ? res.body.id : null;
}
let probe = before.find((o) => PRICES.includes(o.price_amount) && o.quantity_requested === 1)?.offer_id;
if (!probe) probe = await submit(PRICES[0]);
check(Boolean(probe && (await until((o) => o.offer_id === probe))), `the synthetic offer is a match (${probe})`);

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: sellerState });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => page.url().startsWith(base) && problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
let added = null;
/** The sell list's line for the offer once Checkout's read has it (up to 15 s). */
async function lineFor(offer) {
  for (let i = 0; i < 15; i += 1) {
    const line = (await call(seller, "GET", "/sell-list")).body?.items?.find((l) => l.offer_id === offer);
    if (line) return line.line_id ?? line.id ?? null;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

try {
  // On a phone.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account/offers/matches`);
    check(res?.status() === 200, `the list answers 200 (${res?.status()})`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main a.button, main button, main input:not([type=hidden])")]
        .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40)
        .map((e) => e.textContent.trim() || e.outerHTML.slice(0, 60)),
    );
    check(short.length === 0, `every control is at least 40 px tall (${short.join(", ") || "all"})`);
    const text = await main(page);
    const missing = ["Best match snapshot", "Checkout Sell List", "Best Offer Matches"].filter(
      (w) => !text.includes(w),
    );
    check(
      missing.length === 0,
      `the snapshot, the Sell List card and the matches are drawn (${missing.join(", ") || "all"}; ${text.slice(0, 80)})`,
    );
    await page.goto(`${base}/account/offers/matches/${probe}`);
    const detail = await main(page);
    check(
      detail.includes("Offer Match Overview") && detail.includes("Seller net"),
      "a match's page shows its overview and the acceptance terms",
    );
    const bar = await page.evaluate(() => {
      const accept = [...document.querySelectorAll("main button")].find((b) =>
        b.textContent.includes("Accept offer match"),
      );
      const r = accept?.getBoundingClientRect();
      return r ? Math.round(innerHeight - r.bottom) : null;
    });
    check(bar !== null && bar >= 0 && bar < 160, `its actions sit at the bottom of the screen (${bar} px above it)`);
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // With JavaScript on a desktop.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account/offers/matches`);
    await page
      .waitForFunction(() => document.querySelector("corten-live")?.getAttribute("status") === "live", null, {
        timeout: 15_000,
      })
      .catch(() => {});
    const loads = [];
    page.on("load", () => loads.push(1));
    const now = (await matches()).find((o) => o.offer_id === probe)?.price_amount ?? PRICES[0];
    const next = now === PRICES[0] ? PRICES[1] : PRICES[0];
    const moved = await call(collector, "PATCH", `/offers/submitted/${probe}/price`, {
      priceAmount: next,
      priceCurrencyCode: "USD",
    });
    check(moved.status === 200, `the collector changes the offer's price (${moved.status})`);
    const row = page.locator("li", { has: page.locator(`a[href$="/${probe}"]`) });
    await row
      .getByText(`$${next}`)
      .first()
      .waitFor({ timeout: 20_000 })
      .then(
        () => check(loads.length === 0, "its row is drawn again live, without a reload"),
        () => check(false, "its row is drawn again live, without a reload (it was not)"),
      );
    await page.goto(`${base}/account/offers/matches/${probe}`);
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/account/sell-list", { waitUntil: "commit" }),
      page.getByRole("button", { name: "Add selected offer to Sell List" }).click(),
    ]);
    check(
      new URL(page.url()).searchParams.has("afterWrite"),
      "Add selected offer to Sell List goes to the sell list with the write's receipt",
    );
    added = await lineFor(probe);
    check(Boolean(added), "and the sell list has the offer's line");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    const res = await page.goto(`${base}/account/offers/matches`);
    check(
      res?.status() === 200 && (await main(page)).includes("Best Offer Matches"),
      "the list is drawn without a script",
    );
    if (added) await call(seller, "POST", `/sell-list/${added}/remove`, {});
    await page.goto(`${base}/account/offers/matches/${probe}`);
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/account/sell-list", { waitUntil: "commit" }),
      page.locator("main").getByRole("button", { name: "Add selected offer to Sell List" }).click(),
    ]);
    added = await lineFor(probe);
    check(Boolean(added), "Add selected offer to Sell List posts without a script");
    if (decline) {
      const fresh = await submit(PRICES[0]);
      check(Boolean(fresh && (await until((o) => o.offer_id === fresh))), "a second synthetic offer is a match");
      await page.goto(`${base}/account/offers/matches/${fresh}`);
      await Promise.all([
        page.waitForNavigation(),
        page.locator("main").getByRole("button", { name: "Decline" }).click(),
      ]);
      check(new URL(page.url()).pathname === "/account/offers/matches", "Decline goes back to the list");
      const gone = !(await matches()).some((o) => o.offer_id === fresh);
      check(gone && !(await main(page)).includes(`/${fresh}`), "and the declined offer is not a match");
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
} finally {
  if (added) {
    const removed = await call(seller, "POST", `/sell-list/${added}/remove`, {});
    check(removed.status < 300, `the sell list line is removed (${removed.status})`);
  }
  await browser.close();
}
console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
