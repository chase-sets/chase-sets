// Uses the Catalog attention queue on the scopes list in a browser as a signed-in platform admin,
// with JavaScript and without it, against the real platform API, beside admin-web's own queue on
// its scopes page: the same items in the same order and the same count. Then an item's sheet
// (Review), a dismiss and a defer with their reasons (the item leaves the queue on the page the
// write sends the browser to), Restore (it comes back), and a phone's width. It parks and restores
// the queue's first item, so it changes sandbox data and puts it back.
// Usage: node scripts/smoke-attention.mjs [pilot-url] [admin-web-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7790",
  adminWeb = "http://localhost:7752",
  stateFile = "../../artifacts/corten-pilot/admin-state.json",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  // A 503 is the API's "preparing" after a write, which `settled` reloads through.
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 503") && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

// After a write the page waits for the write's projection; when the API's freshness wait runs
// out it answers "preparing" (503) and asks for a refresh. Do what it asks, for up to 90 s.
async function settled(page) {
  const start = Date.now();
  while ((await page.getByText("Refresh in a moment").count()) && Date.now() - start < 90_000) {
    await page.waitForTimeout(2_000);
    await page.reload();
  }
}

/** Waits for the page Corten swaps in after a navigation, and for the write it follows. */
async function navigated(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
  await settled(page);
}

/** Whether the page shows the queue (not its unavailable banner). */
const shown = async (page) => (await page.locator("[data-attention-queue]").count()) === 1;

const queue = (page) => page.locator("[data-attention-queue] tbody tr");
/** Each item's title, in order. */
const titles = (page) =>
  queue(page).evaluateAll((trs) => trs.map((tr) => tr.querySelector("strong")?.textContent?.trim() ?? ""));
/** The queue's count pill ("214 need you"), as a number. */
const count = async (page) =>
  Number((await page.locator("[data-attention-queue] header span").first().textContent())?.split(" ")[0]);
/** Whether the item keyed `key` is in the queue. */
const has = (page, key) => page.locator(`[data-attention-queue] button[name="item"][value="${key}"]`).count();

// With JavaScript, beside admin-web.
let key = "";
{
  const { ctx, page, problems } = await context(true);
  await page.goto(`${adminWeb}/catalog/scopes`, { waitUntil: "networkidle" });
  const theirs = await page
    .locator('[data-catalog-attention-queue="true"] table tbody tr')
    .evaluateAll((trs) => trs.map((tr) => (tr.querySelector("td")?.textContent ?? "").replace(/\s+/g, " ").trim()));
  await page.goto(`${base}/catalog/scopes`);
  const ours = await titles(page);
  check(ours.length > 0, `the queue has items (${ours.length})`);
  const same = ours.length === theirs.length && ours.every((title, i) => theirs[i].startsWith(title));
  check(same, `the same items as admin-web's queue, in its order (${theirs.length} there)`);
  if (!same)
    console.log(`  pilot ${JSON.stringify(ours.slice(0, 3))}\n  admin-web ${JSON.stringify(theirs.slice(0, 3))}`);
  const before = await count(page);
  check(before === ours.length, `the count is the API's (${before})`);

  // The first item's sheet.
  const first = queue(page).first();
  key = (await first.locator('button[name="item"]').getAttribute("value")) ?? "";
  await first.locator('button[name="item"]').click();
  const sheet = page.locator("dialog#attention-sheet[open]");
  await sheet.waitFor();
  check((await sheet.locator("h2").textContent()) === ours[0], "Review opens the item's sheet");
  check(
    await page.evaluate(() => document.querySelector("dialog#attention-sheet")?.matches(":modal") ?? false),
    "as a modal",
  );
  const destination = await sheet
    .locator("[data-attention-destination]")
    .getAttribute("href")
    .catch(() => null);
  check(destination === null || destination.startsWith(adminWeb), `its destination is admin-web's (${destination})`);

  // Dismiss without a reason: the browser asks for one; with one, the item leaves the queue.
  await sheet.locator("#attention-dismiss").getByRole("button", { name: "Dismiss" }).click();
  check(
    await sheet.locator("#attention-dismiss input[name=reason]").evaluate((i) => !i.validity.valid),
    "a dismiss needs a reason",
  );
  await sheet.locator("#attention-dismiss input[name=reason]").fill("Corten pilot smoke");
  await sheet.locator("#attention-dismiss").getByRole("button", { name: "Dismiss" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "queued");
  await navigated(page);
  check((await page.getByText("Command queued").count()) === 1, "the banner says the command was queued");
  check(
    (await shown(page)) && (await has(page, key)) === 0,
    "the dismissed item is gone from the queue (read after the write)",
  );
  check((await count(page)) === before - 1, `the count is one less (${await count(page)})`);

  await page.getByRole("button", { name: "Restore" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "queued" && !u.searchParams.has("parked"));
  await navigated(page);
  check((await shown(page)) && (await has(page, key)) === 1, "Restore brings it back");
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Without JavaScript: Review is a page with the sheet open, and a defer works the same way.
{
  const { ctx, page } = await context(false);
  await page.goto(`${base}/catalog/scopes`);
  await page.locator(`[data-attention-queue] button[name="item"][value="${key}"]`).click();
  await page.waitForURL((u) => u.pathname === "/catalog/scopes/attention/review");
  check(
    (await page.locator("dialog#attention-sheet[open]").count()) === 1,
    "Review without JavaScript is the page with the sheet open",
  );
  await page.locator("#attention-defer input[name=reason]").fill("Corten pilot smoke, no script");
  await page.locator("#attention-defer").getByRole("button", { name: "Defer 24h" }).click();
  await page.waitForURL((u) => u.searchParams.get("parked") === key);
  await settled(page);
  check((await shown(page)) && (await has(page, key)) === 0, "the deferred item is gone from the queue");
  await page.getByRole("button", { name: "Restore" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "queued" && !u.searchParams.has("parked"));
  await settled(page);
  check((await shown(page)) && (await has(page, key)) === 1, "Restore brings it back");
  await ctx.close();
}

// A phone's width.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${base}/catalog/scopes`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `the page does not scroll sideways at 390 px (${wide} px over)`);
  await page.locator("[data-attention-queue]").screenshot({ path: "../../artifacts/corten-pilot/attention-390.png" });
  await queue(page).first().locator('button[name="item"]').click();
  await page.locator("dialog#attention-sheet[open]").waitFor();
  const sheetWide = await page.evaluate(() => {
    const d = document.querySelector("dialog#attention-sheet");
    return d ? d.scrollWidth - d.clientWidth : 0;
  });
  check(sheetWide <= 0, `the sheet fits (${sheetWide} px over)`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/attention-sheet-390.png" });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
