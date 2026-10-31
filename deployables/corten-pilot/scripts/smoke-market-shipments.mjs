// Uses the account's shipment pages in a browser, against the real platform API, beside marketplace's.
// - Signed out: a shipment's page sends the visitor to the pilot's sign-in, back to it.
// - Without JavaScript, as the auth seed's collector: Shipments and a shipment of each status the
//   seeds have say what marketplace's say, word for word; Open shipment opens each card's shipment.
// - As the auth seed's seller: a shipment's page in each status says what marketplace's says, but
//   for its Actions, which are marketplace's for now (the pilot links there), and Start or Resume
//   packing, which smoke-market-packing.mjs checks; the seller's list is
//   marketplace's command center, where the pilot's address sends it.
// - Marketplace says each empty state twice; the comparison counts it once.
// - At 1280 px two cards to a row, at 390 px one; nothing scrolls sideways and every control is at
//   least 40 px tall; no console errors.
// It writes nothing.
// Usage: node scripts/smoke-market-shipments.mjs [pilot-url] [marketplace-url] [collector-state] [seller-state] [api-url]
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
  page.setDefaultTimeout(90_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

// The words a page's main says, as a multiset, leaving out a seller's Actions section (and
// marketplace's notice about getting them ready), which the pilot does not port yet.
const wordsOf = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main").cloneNode(true);
    for (const heading of main.querySelectorAll("h2")) {
      if (heading.textContent.trim() === "Actions") (heading.closest("section") ?? heading).remove();
    }
    document.body.append(main);
    main.style.position = "absolute";
    const text = main.innerText;
    main.remove();
    return (
      text
        .replace(
          /Preparing shipment actions\s+You can read shipment details and open links while actions get ready\./,
          " ",
        )
        // Marketplace says each empty state twice; the pilot once.
        .replace(/(No shipment exceptions recorded\.|No postage operations recorded\.)\s+\1/g, "$1")
        // Start and Resume packing: smoke-market-packing.mjs compares them.
        .replace(/\n(Start packing|Resume packing)\n/g, "\n")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
    );
  });
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
  let answer = await theirs.page.goto(`${market}${path}`, { waitUntil: "networkidle" });
  // Marketplace's dev server sometimes answers one read with its 500 page; read it again once.
  if (answer.status() >= 500) answer = await theirs.page.reload({ waitUntil: "networkidle" });
  const { missing, extra } = difference(await wordsOf(theirs.page), await wordsOf(ours.page));
  check(
    res.status() === 200 && answer.status() === 200 && missing.length === 0 && extra.length === 0,
    `${what} says what marketplace's says (${res.status()}, marketplace ${answer.status()}; missing [${missing.join(" ")}] extra [${extra.join(" ")}])`,
  );
  await theirs.ctx.close();
  return ours;
}

const bought = await read("/api/marketplace/account/shipments?limit=100&offset=0", collectorState);
const sold = await read("/api/marketplace/account/sales/shipments?limit=100&offset=0", sellerState);
const one = (list, status) => list.items.find((s) => s.status === status);
const statuses = ["delivered", "exception", "awaiting-package", "label-attached", "returned"];
check(
  statuses.every((s) => one(bought, s) && one(sold, s)),
  `the seeds have a shipment of each of ${statuses.join(", ")}`,
);

{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  const id = bought.items[0].shipment_id;
  await page.goto(`${base}/account/shipments/${id}`);
  const at = new URL(page.url());
  check(
    at.origin === base && at.pathname === "/sign-in" && at.searchParams.get("returnTo") === `/account/shipments/${id}`,
    `signed out, a shipment sends the visitor to the pilot's sign-in, back to it (${page.url()})`,
  );
  await ctx.close();
}

{
  const { ctx, page } = await same("/account/shipments", collectorState, "Shipments");
  const hrefs = await page
    .locator("main a", { hasText: "Open shipment" })
    .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check(
    hrefs.length === bought.items.length &&
      hrefs.every((h, i) => h === `/account/shipments/${bought.items[i].shipment_id}`),
    `each card's Open shipment opens its shipment here (${hrefs.length})`,
  );
  await page.locator("main a", { hasText: "Open shipment" }).first().click();
  check(
    new URL(page.url()).pathname === `/account/shipments/${bought.items[0].shipment_id}`,
    "and Open shipment goes there",
  );
  await ctx.close();
}

for (const status of statuses) {
  const { ctx } = await same(
    `/account/shipments/${one(bought, status).shipment_id}`,
    collectorState,
    `a buyer's ${status} shipment`,
  );
  await ctx.close();
}
for (const status of statuses) {
  const { ctx, page } = await same(
    `/account/sales/shipments/${one(sold, status).shipment_id}`,
    sellerState,
    `a seller's ${status} shipment`,
  );
  const actions = await page.locator("main a", { hasText: "Open on marketplace" }).getAttribute("href");
  check(
    actions === `${market}/account/sales/shipments/${one(sold, status).shipment_id}`,
    `its actions open marketplace's page (${actions})`,
  );
  await ctx.close();
}

{
  const { ctx, page } = await context({ javaScriptEnabled: false, storageState: sellerState });
  await page.goto(`${base}/account/sales/shipments`);
  check(
    page.url().startsWith(`${market}/account/sales/shipments`),
    `the seller's list is marketplace's command center (${page.url()})`,
  );
  await ctx.close();
}

const awaiting = one(bought, "awaiting-package").shipment_id;
const policied =
  sold.items.find((s) => s.shipping_plan_snapshot?.postagePolicySnapshot)?.shipment_id ??
  one(sold, "exception").shipment_id;
for (const [path, state, width, columns] of [
  ["/account/shipments", collectorState, 1280, 2],
  ["/account/shipments", collectorState, 390, 1],
  [`/account/shipments/${awaiting}`, collectorState, 390, 0],
  [`/account/sales/shipments/${policied}`, sellerState, 1280, 0],
  [`/account/sales/shipments/${policied}`, sellerState, 390, 0],
]) {
  const { ctx, page, problems } = await context({ storageState: state, viewport: { width, height: 900 } });
  await page.goto(`${base}${path}`);
  await page.waitForFunction(() => window.__hydratedAt);
  const layout = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("main a, main button")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.height < 40 && !el.closest("p:not([class*=__actions])"))
        small.push(`${el.tagName} ${el.textContent.trim().slice(0, 30)} ${Math.round(r.height)}`);
    }
    const grid = document.querySelector('main [class*="__cards"]');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small,
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
    };
  });
  check(layout.columns === columns, `${path} at ${width} px: ${columns || "no"} card columns (${layout.columns})`);
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
