// Uses the cart pilot in a browser as the auth seed's collector, with JavaScript and without it,
// against the real platform API, beside marketplace's own cart page: the lines, badges, prices and
// total the API returns, the lower-price offer, the links to marketplace's checkout, and the page
// at 390 px. It only reads: the cart's writes are not ported yet.
// Usage: node scripts/smoke-cart.mjs [pilot-url] [state-file] [marketplace-url] [api-url]
//   (state from `scripts/sign-in.mjs <pilot-url> <state-file> collector --api <api-url>`)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7792",
  stateFile = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const cartUrl = `${base}/account/cart`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const money = (m) => (m ? new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(Number(m.amount)) : "Priced at checkout");
const labels = {
  ready: "Ready",
  "unassigned-fulfillment": "Needs fulfillment",
  unavailable: "Unavailable",
  "waiting-for-supply": "Waiting for supply",
  changed: "Needs review",
  "shipping-measure-missing": "Shipping measure missing",
  "currency-mismatch": "Needs review",
};
const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, ...(viewport ? { viewport } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** What the page shows: each line's id, title, badge, quantity and price, and the total. */
async function shown(page) {
  const lines = await page.locator("li[data-cart-line]").evaluateAll((items) =>
    items.map((li) => ({
      id: li.getAttribute("data-cart-line"),
      title: li.querySelector("p")?.textContent?.trim(),
      reason: li.querySelector("[data-reason]")?.textContent?.trim() ?? null,
      quantity: li.querySelector("[data-quantity]")?.textContent?.trim(),
      price: li.querySelector("[data-price]")?.textContent?.replace(/\s+/g, " ").trim(),
    })),
  );
  const total = (await page.locator("[data-total]").first().textContent())?.trim();
  return { lines, total };
}

// With JavaScript, beside the API's answer.
{
  const { ctx, page, problems } = await context(true);
  const answer = await page.request.get(`${api}/api/marketplace/account/cart`, { headers: { "chase-sets-read-target-context": "checkout" } });
  check(answer.ok(), `the API reads the collector's cart (${answer.status()})`);
  const cart = await answer.json();
  const response = await page.goto(cartUrl);
  check(response?.status() === 200, `the page answers (${response?.status()})`);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent()) === "Your cart", "the page renders in the shell");
  const { lines, total } = await shown(page);
  check(cart.items.length > 0, `the collector's cart has lines (${cart.items.length})`);
  check(lines.length > 0 && lines.length <= cart.items.length, `one card per product and fulfillment (${lines.length} for ${cart.items.length} lines)`);
  const outcomes = Object.fromEntries(cart.readiness.loaded.lineOutcomes.map((o) => [o.lineId, o.reason]));
  for (const line of lines) {
    const item = cart.items.find((i) => i.line_id === line.id);
    check(Boolean(item) && item.item_title === line.title, `${line.title}: a line the API returned`);
    check(line.reason === labels[outcomes[line.id]], `${line.title}: the badge is the API's line outcome (${line.reason}, ${outcomes[line.id]})`);
    check(/^(from )?\$[\d,]+\.\d{2}$|^Priced at checkout$/.test(line.price ?? ""), `${line.title}: a price (${line.price})`);
  }
  check(total === money(cart.readiness.estimatedSubtotal), `the total is the API's estimated subtotal (${total})`);
  const notice = await page.locator('[role="note"]').first().textContent().catch(() => null);
  if (cart.readiness.declined.status === "ready" && cart.readiness.declined.optimization.available) {
    check(notice?.includes(`Save ${money(cart.readiness.savings)}`) ?? false, `the offer is the API's savings (${notice?.trim().split("\n")[0]})`);
  } else {
    check(!notice?.includes("Save "), "no offer for a cart the API does not offer one");
  }
  const checkout = page.getByRole("link", { name: /^(Check out|Continue to checkout)$/ });
  check((await checkout.getAttribute("href")) === `${web}/checkout/buy/readiness`, "checkout is marketplace's");
  check((await page.getByRole("link", { name: "Keep shopping" }).getAttribute("href")) === `${web}/search`, "keep shopping is marketplace's search");
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);

  // marketplace's own page, when it is running: the same lines, in the same order, and total.
  const webPage = await ctx.newPage();
  const webAnswer = await webPage.goto(`${web}/account/cart`, { waitUntil: "load", timeout: 180_000 }).catch(() => null);
  if (webAnswer?.ok()) {
    const titles = await webPage.locator("[data-marketplace-cart-line]").evaluateAll((items) =>
      items.map((li) => li.querySelector(".line-clamp-2")?.textContent?.trim()),
    );
    check(titles.join() === lines.map((l) => l.title).join(), `marketplace shows the same lines in the same order (${titles.join(", ")})`);
    const webText = (await webPage.locator("main").innerText()).replace(/\s+/g, " ");
    check(webText.includes(`Estimated total ${total}`), `marketplace shows the same total (${total})`);
  } else {
    console.log(`skip marketplace's cart is not answering at ${web}`);
  }
  await ctx.close();
}

// Without JavaScript: the same page, drawn by the server.
{
  const { ctx, page } = await context(false);
  await page.goto(cartUrl);
  check((await page.locator("h1").textContent()) === "Your cart", "without JavaScript the page is the same");
  check((await page.locator("li[data-cart-line]").count()) > 0, "with its lines");
  await ctx.close();
}

// At 390 px.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(cartUrl);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `the page does not scroll sideways at 390 px (${over} px over)`);
  const bar = await page.getByRole("link", { name: /^(Check out|Continue to checkout)$/ }).boundingBox();
  check(Boolean(bar) && bar.x >= 0 && bar.x + bar.width <= 390, "checkout fits on the screen");
  const cards = await page.locator("li[data-cart-line]").evaluateAll((items) => items.map((li) => li.getBoundingClientRect().right));
  check(cards.every((right) => right <= 390), "every line fits");
  await page.screenshot({ path: "../../artifacts/corten-pilot/cart-390.png", fullPage: true });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
