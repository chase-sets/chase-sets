// The buyer's submitted offers in a browser, against the real platform API. WRITES: the seed
// seller (who has offers.manage) submits one synthetic offer (1.01 USD, one card) on the product of
// one of the collector's open offers that the seller does not list (at most four tries), pauses and resumes it through the page, pauses it again as a
// checked offer, and withdraws it at the end, which is final: it stays the seller's withdrawn offer.
// - At 390 px nothing scrolls sideways and every control is at least 40 px tall.
// - The list shows the status filter with counts and the offer's row; Paused shows the paused one.
// - Pause and Resume change the row's status with the outcome above the list; a checked offer
//   pauses from the bulk bar, which shows once one is checked. While the API has not opened them
//   (503 offer_lifecycle_closed, as the dev sandbox answers), the page says so for the offer and
//   its row stays Open; the offer then stays open, and the next run reuses it.
// - The row's price is drawn again live when the offer's price changes, without a reload.
// - Without JavaScript: Resume works as a form, and Withdraw from its dialog.
// - The collector, who may read offers but not change them, sees no
//   boxes or buttons.
// - No console errors.
// Usage: node scripts/smoke-market-submitted-offers.mjs [pilot-url] [seller-state] [collector-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  sellerState = "../../artifacts/corten-pilot/marketplace-state.json",
  collectorState = "../../artifacts/corten-pilot/collector-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
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
const mine = async () => (await call(seller, "GET", "/offers/submitted?limit=100&offset=0")).body?.items ?? [];
const until = async (ready) => {
  for (let i = 0; i < 20; i += 1) {
    const found = (await mine()).find(ready);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

// The synthetic offer: the seller's open or paused one at 1.01 or 1.02 if a run left it, else a new one.
const PRICES = ["1.01", "1.02"];
let probe = (await mine()).find((o) => PRICES.includes(o.price_amount) && ["submitted", "paused"].includes(o.status));
if (!probe) {
  const open =
    (await call(collector, "GET", "/offers/submitted?limit=100&offset=0&status=submitted")).body?.items ?? [];
  const products = [...new Map(open.map((o) => [o.product_id, o])).values()].slice(0, 4);
  check(products.length > 0, "the collector has an open offer to copy a product from");
  let res = null;
  for (const source of products) {
    res = await call(seller, "POST", "/offers/submitted", {
      catalogItemId: source.catalog_catalog_item_id,
      productId: source.product_id,
      itemTitle: source.item_title,
      itemSubtitle: source.item_subtitle,
      selectedOptions: source.selected_options,
      productSummary: source.product_summary,
      shippingDestinationSnapshot: {
        name: "Pilot Smoke",
        line1: "1 Test St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      priceAmount: PRICES[0],
      priceCurrencyCode: "USD",
      quantityRequested: 1,
    });
    // The seller's own listing's product is refused (400); try the next.
    if (res.status !== 400) break;
  }
  check(
    res?.status === 201,
    `the seller submits a synthetic offer (${res?.status} ${JSON.stringify(res?.body?.error ?? "")})`,
  );
  probe = res?.status === 201 ? await until((o) => o.offer_id === res.body.id) : null;
}
check(Boolean(probe), `the synthetic offer is listed (${probe?.offer_id})`);
const id = probe?.offer_id;
if (probe?.status === "paused") await call(seller, "POST", `/offers/submitted/${id}/resume`, {});
if (!id) {
  console.log("FAIL (no synthetic offer to run with)");
  process.exit(1);
}

const browser = await chromium.launch();
async function context(state, options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: state });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => page.url().startsWith(base) && problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
const row = (page) => page.locator("li", { has: page.locator(`input[value="${id}"]`) });

try {
  // On a phone.
  {
    const { ctx, page, problems } = await context(sellerState, { viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account/offers/submitted`);
    check(res?.status() === 200, `the list answers 200 (${res?.status()})`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main a, main button, main label")]
        .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40)
        .map((e) => e.textContent.trim() || e.outerHTML.slice(0, 60)),
    );
    check(short.length === 0, `every control is at least 40 px tall (${short.join(", ") || "all"})`);
    const text = await main(page);
    check(
      /All \(\d+\) Open \(\d+\) Paused \(\d+\) Withdrawn \(\d+\) Accepted \(\d+\)/.test(text),
      "the status filter shows each status's count",
    );
    check((await row(page).count()) === 1, "the synthetic offer has its row, with a box");
    const bar = await page.getByRole("button", { name: "Pause selected" }).isVisible();
    check(!bar, "the bulk bar waits for a checked offer");
    await row(page).locator("input[type=checkbox]").check();
    check(await page.getByText(/1 Offers? selected/).isVisible(), "checking it shows the bar with its count");
    const wideAfter = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(wideAfter <= 0, `the bar does not scroll sideways (${wideAfter})`);
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // With JavaScript on a desktop: live, then Pause (and Resume and Pause selected while the API
  // admits lifecycle changes; when it is closed, the page says so for the offer and nothing changes).
  let closed = false;
  {
    const { ctx, page, problems } = await context(sellerState);
    await page.goto(`${base}/account/offers/submitted?status=submitted`);
    const loads = [];
    page.on("load", () => loads.push(1));
    const now = (await mine()).find((o) => o.offer_id === id)?.price_amount ?? PRICES[0];
    const next = now === PRICES[0] ? PRICES[1] : PRICES[0];
    const moved = await call(seller, "PATCH", `/offers/submitted/${id}/price`, {
      priceAmount: next,
      priceCurrencyCode: "USD",
    });
    check(moved.status === 200, `the offer's price changes (${moved.status})`);
    await row(page)
      .getByText(`$${next}`)
      .first()
      .waitFor({ timeout: 20_000 })
      .then(
        () => check(loads.length === 0, "its row is drawn again live, without a reload"),
        () => check(false, "its row is drawn again live, without a reload (it was not)"),
      );
    await row(page)
      .getByRole("button", { name: /^Pause / })
      .click();
    await page.waitForLoadState();
    const said = await main(page);
    closed = said.includes("are not open yet");
    if (closed) {
      console.log(
        "note the API has not opened Pause, Resume and Withdraw (503 offer_lifecycle_closed): no state changes",
      );
      check(
        said.includes("0 changed, 0 already in that state, 1 could not change"),
        "Pause says the offer could not change, and why",
      );
      check((await row(page).innerText()).includes("Open"), "and its row is still Open");
    } else {
      check(said.includes(": now Paused"), "Pause says the offer is now Paused");
      check((await row(page).innerText()).includes("Paused"), "and its row says Paused");
      await page.goto(`${base}/account/offers/submitted?status=paused`);
      check((await row(page).count()) === 1, "Paused shows it");
      await row(page)
        .getByRole("button", { name: /^Resume / })
        .click();
      await page.waitForLoadState();
      check((await main(page)).includes(": now Open"), "Resume says the offer is Open again");
      await row(page).locator("input[type=checkbox]").check();
      await page.getByRole("button", { name: "Pause selected" }).click();
      await page.waitForLoadState();
      check((await main(page)).includes("1 changed"), "Pause selected changes the checked offer");
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript: Resume (when admitted), then Withdraw from its dialog.
  {
    const { ctx, page } = await context(sellerState, { javaScriptEnabled: false });
    await page.goto(`${base}/account/offers/submitted`);
    if (!closed) {
      await row(page)
        .getByRole("button", { name: /^Resume / })
        .click();
      await page.waitForLoadState();
      check((await main(page)).includes(": now Open"), "Resume posts without a script");
    }
    await row(page)
      .getByRole("button", { name: /^Withdraw / })
      .click();
    const dialog = page.locator(`dialog:has(button[value="withdraw:${id}"])`);
    check(await dialog.isVisible(), "Withdraw opens its dialog without a script");
    await dialog.getByRole("button", { name: "Withdraw" }).click();
    await page.waitForLoadState();
    const said = await main(page);
    check(
      said.includes(closed ? "are not open yet" : ": now Withdrawn"),
      `and withdrawing from it posts (${closed ? "refused: closed" : "Withdrawn"})`,
    );
    await ctx.close();
  }

  // The collector reads, with nothing to change.
  {
    const { ctx, page } = await context(collectorState);
    const res = await page.goto(`${base}/account/offers/submitted`);
    check(res?.status() === 200, `the collector's list answers 200 (${res?.status()})`);
    const boxes = await page.locator("main input[type=checkbox], main button[name=row]").count();
    check(boxes === 0, `the collector has no boxes or buttons (${boxes})`);
    await ctx.close();
  }
} finally {
  await browser.close();
  const left = (await mine()).find((o) => o.offer_id === id);
  if (left && left.status !== "withdrawn") {
    const res = await call(seller, "POST", `/offers/submitted/${id}/withdraw`, {});
    console.log(
      `withdrawing the synthetic offer after the run answered ${res.status}${res.status === 503 ? " (closed: it stays open for the next run)" : ""}`,
    );
  }
}
console.log(failures === 0 ? "all passed" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
