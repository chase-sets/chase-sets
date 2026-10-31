// Reads the Seller Desk home pilot in a browser as marketplace's seed seller, with JavaScript and
// without it, against the real platform API, and compares it with the API's own answers: the queue's
// count and one row per item in the API's order, each row's link (the pilot's own page for a
// listing, shipment or sale, as the queue now links them; marketplace's
// otherwise), the sources the
// API could not read named without its internal reason, and the
// active listings and open orders tiles. Then the page at 390 px. Only reads.
// Usage: node scripts/smoke-market-desk.mjs [pilot-url] [state-file] [api-url]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  stateFile = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const desk = `${base}/account/desk`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport) {
  const ctx = await browser.newContext({
    storageState: stateFile,
    javaScriptEnabled,
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** What the API answers the seller. */
async function apiRead(page, path) {
  const answer = await page.request.get(`${api}/api/marketplace/account${path}`);
  return answer.ok() ? answer.json() : null;
}

/** Where the pilot sends a deep link the API gives. */
function expected(href) {
  const own = [
    [/^\/account\/desk\/listings\/([^/?#]+)$/, "/account/listings/"],
    [/^\/account\/desk\/shipments\/([^/?#]+)$/, "/account/sales/shipments/"],
    [/^\/account\/desk\/sales\/([^/?#]+)$/, "/account/sales/"],
  ];
  for (const [pattern, to] of own) {
    const match = pattern.exec(href);
    if (match) return `${base}${to}${match[1]}`;
  }
  if (href === "/account/desk" || href.startsWith("/account/desk?")) return `${base}${href}`;
  return null; // marketplace's
}

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems } = await context(javaScriptEnabled);
  const answer = await page.goto(desk);
  check(answer?.status() === 200, `${label}: the Desk answers 200 (${answer?.status()})`);
  if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent())?.trim() === "Seller Desk", `${label}: the page renders in the shell`);
  const queue = await apiRead(page, "/seller-attention-queue");
  const counts = await apiRead(page, "/listings?limit=1&offset=0");
  const orders = await apiRead(page, "/sales/order-capacity");
  check(queue !== null, "the API answers the queue");
  const rows = page.locator("[data-seller-desk-item]");
  check(
    (await page.getByText(`${queue.rollup.total} to handle`).count()) === 1,
    `${label}: the count is the API's (${queue.rollup.total})`,
  );
  const ids = await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-seller-desk-item")));
  check(
    JSON.stringify(ids) === JSON.stringify(queue.items.map((item) => item.id)),
    `${label}: a row per item, in the API's order (${ids.length})`,
  );
  for (const item of queue.items) {
    const href = await page.locator(`[data-seller-desk-item="${item.id}"] a`).getAttribute("href");
    const own = expected(item.deepLink.href);
    check(
      own ? href === own || base + href === own : href?.startsWith("http://localhost:7753"),
      `${label}: ${item.id} links to ${href}`,
    );
  }
  const summaries = await rows.locator("p:nth-child(2)").allTextContents();
  check(
    summaries.every((s) => s.trim() !== "" && !/\{[A-Za-z]+\}/.test(s)),
    `${label}: every summary is filled in`,
  );
  const unavailable = queue.sources.filter((source) => source.status === "unavailable");
  const banner = page.locator('[data-seller-desk-degraded="true"]');
  check(
    (await banner.count()) === (unavailable.length > 0 ? 1 : 0),
    `${label}: the degraded banner when the API marks a source unavailable (${unavailable.length})`,
  );
  if (unavailable.length > 0) {
    const said = (await banner.textContent()) ?? "";
    check((await banner.locator("li").count()) === unavailable.length, `${label}: one line per unavailable source`);
    check(
      !unavailable.some((source) => source.reason && said.includes(source.reason)),
      `${label}: without the API's internal reason (chase-sets/chase-sets#8766)`,
    );
  }
  const tiles = await page.locator("dl dd").allTextContents();
  check(
    tiles[0]?.trim() === String(counts?.statusCounts?.active ?? "Unavailable"),
    `${label}: active listings is the API's (${tiles[0]})`,
  );
  check(
    tiles[1]?.trim() === String(orders?.open_order_count ?? "Unavailable"),
    `${label}: open orders to ship is Ordering's (${tiles[1]})`,
  );
  check(problems.length === 0, `${label}: no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// A phone.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(desk);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const columns = await page.locator("dl").evaluate((dl) => getComputedStyle(dl).gridTemplateColumns.split(" ").length);
  check(columns === 1, `the counts stack on a phone (${columns} column)`);
  const small = await page
    .locator("main a")
    .evaluateAll((links) => links.filter((a) => a.getBoundingClientRect().height < 44).length);
  check(small === 0, `every link is at least 44 px tall (${small} not)`);
  // A link drawn as a button keeps its text readable on its own background (WCAG AA, 4.5:1).
  const weak = await page.locator("main a").evaluateAll((links) => {
    const rgb = (value) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]) =>
      [r, g, b]
        .map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    return links
      .map((a) => ({ text: a.textContent?.trim(), style: getComputedStyle(a) }))
      .filter(({ style }) => (rgb(style.backgroundColor)[3] ?? 1) > 0 && style.backgroundColor !== "rgba(0, 0, 0, 0)")
      .map(({ text, style }) => {
        const [a, b] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))].sort((x, y) => y - x);
        return { text, ratio: (a + 0.05) / (b + 0.05) };
      })
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ text, ratio }) => `${text} ${ratio.toFixed(2)}:1`);
  });
  check(
    weak.length === 0,
    `every button-like link's text is readable on its background (${weak.join(", ") || "all at least 4.5:1"})`,
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
