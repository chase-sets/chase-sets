// Reads the support page pilot (/account/support) in a browser as marketplace's seed seller, with
// JavaScript and without it, against the real platform API, and compares it with Platform
// Operations' own answers and with marketplace's page: one row per case on each side, each linking
// to the pilot's case page, one row per flow, and Report a problem for an order with a case open
// (the duplicate banner, and its in-page link) and for an order that does not exist (the API's
// words). Then the page at 390 px. It reads only: it never posts the last step.
// Usage: node scripts/smoke-market-support-list.mjs [pilot-url] [state-file] [marketplace-url] [api-url]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  stateFile = "../../artifacts/corten-pilot/marketplace-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
] = process.argv.slice(2);
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
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

const read = async (page, path) => {
  const res = await page.request.get(`${api}/api/marketplace/support-requests/${path}`);
  return res.ok() ? res.json() : null;
};

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems } = await context(javaScriptEnabled);
  const [flows, purchases, sales] = await Promise.all([
    read(page, "flows"),
    read(page, "purchases"),
    read(page, "sales"),
  ]);
  check(flows && purchases && sales, `${label}: the API answers the list reads`);
  const answer = await page.goto(`${base}/account/support`);
  check(answer?.status() === 200, `${label}: the page answers 200 (${answer?.status()})`);
  if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const rows = async (title) =>
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
      .locator("tbody tr")
      .count();
  check(
    (await rows("Buyer requests")) === purchases.items.length,
    `${label}: a row per buyer case (${purchases.items.length})`,
  );
  check(
    (await rows("Seller requests")) === sales.items.length,
    `${label}: a row per seller case (${sales.items.length})`,
  );
  check((await rows("Available flows")) === flows.items.length, `${label}: a row per flow (${flows.items.length})`);
  const cases = [...purchases.items, ...sales.items];
  for (const c of cases.slice(0, 5)) {
    const href = await page.locator(`a[href="/account/support/${c.support_request_id}"]`).count();
    check(href > 0, `${label}: ${c.display_reference || c.support_request_id} links to the pilot's case page`);
  }

  // Report a problem for an order with a case open: the case, not the intake.
  const open = cases.find((c) => !["resolved", "closed", "cancelled"].includes(c.status));
  if (open) {
    const lookup = await read(page, `orders/${encodeURIComponent(open.order_id)}`);
    await page.goto(`${base}/account/support?orderId=${encodeURIComponent(open.order_id)}`);
    if (lookup?.existingOpenRequest) {
      check(
        await page.getByText("A case is already open for this order").isVisible(),
        `${label}: ${open.order_id}: the case already open`,
      );
      check(
        (await page.locator('a[href="#existing-case"]').count()) === 1,
        `${label}: View existing case links in the page`,
      );
      check((await page.locator('[name="step"]').count()) === 0, `${label}: no intake beside it`);
    } else if (lookup) {
      const boxes = await page.locator('input[name="line"]').count();
      check(
        boxes === lookup.lines.length,
        `${label}: ${open.order_id}: a box per line (${boxes} of ${lookup.lines.length})`,
      );
    } else {
      check(
        (await page.locator('[data-tone="danger"]').count()) > 0,
        `${label}: ${open.order_id}: the lookup's refusal is shown`,
      );
    }
  } else {
    console.log(`skip ${label}: no open case to look an order up by`);
  }
  const missing = await page.goto(`${base}/account/support?orderId=ord_does_not_exist`);
  check(
    missing?.status() === 200,
    `${label}: an order the API does not know is the page with its words (${missing?.status()})`,
  );
  check((await page.locator('[data-tone="danger"]').count()) > 0, `${label}: and says so`);
  check(problems.length === 0, `${label}: no console errors (${problems.join(" | ")})`);

  if (javaScriptEnabled) {
    const theirs = await ctx.newPage();
    await theirs.goto(`${web}/account/support`, { waitUntil: "networkidle", timeout: 120_000 });
    const text = (await theirs.locator("main").innerText()).replace(/\s+/g, " ");
    for (const c of cases.slice(0, 5)) {
      const reference = c.display_reference || c.support_request_id;
      check(text.includes(reference), `marketplace's page lists ${reference} too`);
    }
    await theirs.close();
  }
  await ctx.close();
}

// A phone: nothing scrolls sideways, and every link, button and label (a box's target) is a
// thumb's height.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${base}/account/support`);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const small = await page
    .locator("main a, main button, main label")
    .evaluateAll((controls) =>
      controls
        .filter((c) => c.getClientRects().length > 0 && c.getBoundingClientRect().height < 40)
        .map((c) => c.textContent?.trim()),
    );
  check(small.length === 0, `every link, button and label is at least 40 px tall (${small.join(", ") || "all"})`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/support-list-390.png", fullPage: true });
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}
{
  const { ctx, page } = await context(true, { width: 1280, height: 900 });
  await page.goto(`${base}/account/support`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/support-list-1280.png", fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
