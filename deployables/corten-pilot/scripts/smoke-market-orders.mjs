// Uses the account's order pages in a browser, against the real platform API, beside marketplace's.
// - Signed out: a purchase's page sends the visitor to the pilot's sign-in, back to it.
// - Without JavaScript, as the auth seed's collector: Purchases and two purchases' pages say what
//   marketplace's say, word for word; Open order opens each card's purchase; with two to a page the
//   pages are links that work without a script, and the second page has the API's next two.
// - A member without orders.manage (the collector, whose email is not verified) cannot cancel; a
//   cancellation the API refuses (the seller's sale, being packed) is the sale again with what the
//   API said. Both are forms a browser posts; the API applies nothing.
// - As the auth seed's seller: Sales and a sale's page say what marketplace's say.
// - At 1280 px two cards to a row and the money beside the order; at 390 px one column, nothing
//   scrolls sideways and every control is at least 40 px tall; no console errors.
// It writes nothing.
// Usage: node scripts/smoke-market-orders.mjs [pilot-url] [marketplace-url] [collector-state] [seller-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  market = "http://localhost:7753",
  collectorState = "../../artifacts/corten-pilot/collector-state.json",
  sellerState = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = (state) =>
  JSON.parse(readFileSync(state, "utf8"))
    .cookies.filter((c) => c.name === "chase_sets_session")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
const read = async (path, state) => {
  const res = await fetch(`${api}${path}`, { headers: { cookie: cookie(state) } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, storageState } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

// The words a page's main says, as a multiset, without the pilot's decorative icons.
const wordsOf = async (page) =>
  (await page.locator("main").innerText())
    .replace(/[\u{1f0cf}\u{1f512}]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
function difference(a, b) {
  const count = (list) => list.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
  const [ca, cb] = [count(a), count(b)];
  const missing = [...ca].filter(([w, n]) => (cb.get(w) ?? 0) < n).map(([w]) => w);
  const extra = [...cb].filter(([w, n]) => (ca.get(w) ?? 0) < n).map(([w]) => w);
  return { missing, extra };
}
async function same(path, state, what) {
  const [ours, theirs] = [
    await context({ javaScriptEnabled: false, storageState: state }),
    await context({ storageState: state }),
  ];
  const res = await ours.page.goto(`${base}${path}`);
  await theirs.page.goto(`${market}${path}`, { waitUntil: "networkidle" });
  const { missing, extra } = difference(await wordsOf(theirs.page), await wordsOf(ours.page));
  check(
    res.status() === 200 && missing.length === 0 && extra.length === 0,
    `${what} says what marketplace's says (${res.status()}; missing [${missing.join(" ")}] extra [${extra.join(" ")}])`,
  );
  await theirs.ctx.close();
  return ours;
}

const purchases = await read("/api/marketplace/account/purchases?limit=100&offset=0", collectorState);
const sales = await read("/api/marketplace/account/sales?limit=100&offset=0", sellerState);
const packed = purchases.items.find((o) => o.cancellation_unavailable_reason === "fulfillment-started");
const cancelled = purchases.items.find((o) => o.status === "cancelled");
const sold = sales.items.find((o) => o.status === "ready-for-fulfillment") ?? sales.items[0];
check(
  Boolean(packed && cancelled && sold),
  `the seeds have a purchase being packed, a cancelled one and a sale (${packed?.order_id}, ${cancelled?.order_id}, ${sold?.order_id})`,
);

{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await page.goto(`${base}/account/purchases/${packed.order_id}`);
  const at = new URL(page.url());
  check(
    at.origin === base &&
      at.pathname === "/sign-in" &&
      at.searchParams.get("returnTo") === `/account/purchases/${packed.order_id}`,
    `signed out, a purchase sends the visitor to the pilot's sign-in, back to it (${page.url()})`,
  );
  await ctx.close();
}

{
  const { ctx, page } = await same("/account/purchases", collectorState, "Purchases");
  const hrefs = await page
    .locator("main a", { hasText: "Open order" })
    .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check(
    hrefs.length === purchases.items.length &&
      hrefs.every((h, i) => h === `/account/purchases/${purchases.items[i].order_id}`),
    `each card's Open order opens its purchase here (${hrefs.length})`,
  );
  await page.locator("main a", { hasText: "Open order" }).first().click();
  check(
    new URL(page.url()).pathname === `/account/purchases/${purchases.items[0].order_id}`,
    "and Open order goes there",
  );
  // Two to a page: the pages are links.
  const second = await read("/api/marketplace/account/purchases?limit=2&offset=2", collectorState);
  await page.goto(`${base}/account/purchases?limit=2`);
  await page.getByRole("link", { name: "Next page" }).click();
  const url = new URL(page.url());
  check(
    url.searchParams.get("offset") === "2" && url.searchParams.get("limit") === "2",
    `Next page is a link to the next two (${url.search})`,
  );
  const titles = await page.locator("main article h3").allInnerTexts();
  const expected = second.items.map(
    (o) => o.item_titles[0] + (o.item_titles.length > 1 ? ` +${o.item_titles.length - 1} more` : ""),
  );
  check(JSON.stringify(titles) === JSON.stringify(expected), `and it shows the API's next two (${titles.join(", ")})`);
  check((await page.locator('main nav a[aria-current="page"]').innerText()).trim() === "2", "as page 2");
  await ctx.close();
}

for (const [order, what] of [
  [packed, "a purchase being packed"],
  [cancelled, "a cancelled purchase"],
]) {
  const { ctx } = await same(`/account/purchases/${order.order_id}`, collectorState, `the page of ${what}`);
  await ctx.close();
}

// A Cancel form a browser posts, on a page that offers none (the order is being packed).
async function postCancel(state, path) {
  const { ctx, page } = await context({ javaScriptEnabled: false, storageState: state });
  await page.goto(`${base}${path}`);
  const offered = await page.locator('main form[action$="/cancel"]').count();
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/cancel")),
    page.evaluate((action) => {
      const form = Object.assign(document.createElement("form"), { method: "post", action });
      document.body.append(form);
      form.submit();
    }, `${path}/cancel`),
  ]);
  await page.waitForLoadState();
  return { ctx, page, offered, status: answer.status() };
}
{
  // The collector's session lacks orders.manage until its email is verified (Auth's
  // EMAIL_VERIFICATION_RESTRICTED_PERMISSIONS): the pilot refuses before calling the API.
  const { ctx, offered, status } = await postCancel(collectorState, `/account/purchases/${packed.order_id}`);
  check(offered === 0, "a purchase being packed has no Cancel");
  check(status === 403, `a member without orders.manage cannot cancel (${status})`);
  await ctx.close();
}
{
  const { ctx, page, offered, status } = await postCancel(sellerState, `/account/sales/${sold.order_id}`);
  check(
    offered === 0 && sold.cancellation_unavailable_reason === "fulfillment-started",
    "a sale being packed has no Cancel",
  );
  const alert = await page.locator('main [role="alert"]').innerText();
  check(
    status === 400 && alert.includes("Sale issue") && alert.includes("support"),
    `a cancellation the API refuses is the sale with what it said (${status}: ${alert.replace(/\s+/g, " ")})`,
  );
  const after = await read(`/api/marketplace/account/sales/${sold.order_id}`, sellerState);
  check(after.status === sold.status, `and nothing changed (${after.status})`);
  await ctx.close();
}

{
  const { ctx } = await same("/account/sales", sellerState, "Sales");
  await ctx.close();
  const { ctx: detail } = await same(`/account/sales/${sold.order_id}`, sellerState, "a sale's page");
  await detail.close();
}

for (const [path, state, width, columns] of [
  ["/account/purchases", collectorState, 1280, 2],
  [`/account/purchases/${packed.order_id}`, collectorState, 1280, 2],
  ["/account/purchases", collectorState, 390, 1],
  [`/account/purchases/${packed.order_id}`, collectorState, 390, 1],
  ["/account/sales", sellerState, 390, 1],
  [`/account/sales/${sold.order_id}`, sellerState, 390, 1],
]) {
  const { ctx, page, problems } = await context({ storageState: state, viewport: { width, height: 900 } });
  await page.goto(`${base}${path}`);
  await page.waitForFunction(() => window.__hydratedAt);
  const layout = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("main a, main button")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.height < 40 && !el.closest("p"))
        small.push(`${el.tagName} ${el.textContent.trim().slice(0, 30)} ${Math.round(r.height)}`);
    }
    const grid = document.querySelector('main [class*="__cards"], main [class*="__layout"]');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small,
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
    };
  });
  check(layout.columns === columns, `${path} at ${width} px: ${columns} column(s) (${layout.columns})`);
  check(layout.overflow <= 0, `${path} at ${width} px: nothing scrolls sideways (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `${path} at ${width} px: every control is at least 40 px tall${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
