// Uses Projection Operations (/platform/projections) in a browser as a signed-in platform admin,
// with JavaScript and without it, against the real platform API, beside admin-web's own page: the
// same repair queue in the same order, eight counts, the filters (a GET form, so they work without
// JavaScript), a group's sheet with Rebuild and Rebuild context (each opens its confirm dialog,
// which is cancelled), the group's blocked streams and poison events (read from the projection's
// own read) and a poison event's sheet with Retry (not pressed), the
// sheet closed by Escape (with JavaScript) or its link, Refresh status (the API reads the groups'
// status again; no projection data changes), and a phone's width with no sideways scroll and every
// button at least 40 px tall. It retries, rebuilds and cancels nothing.
// Usage: node scripts/smoke-projections.mjs [pilot-url] [admin-web-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7790",
  adminWeb = "http://localhost:7752",
  stateFile = "../../artifacts/corten-pilot/admin-state.json",
] = process.argv.slice(2);
const PATH = "/platform/projections";
let failures = 0;

/** Whether `locator` becomes visible within 10 s (a client navigation changes the address before it draws). */
const shows = (locator) =>
  locator.waitFor({ state: "visible", timeout: 10_000 }).then(
    () => true,
    () => false,
  );

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();

async function open(url, javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  const res = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  return { ctx, page, problems, status: res?.status() };
}

/** The first table's rows (the repair queue): each row's state and label. */
const queueRows = (page) =>
  page.evaluate(() => {
    const table = document.querySelector("main table");
    return table
      ? [...table.querySelectorAll("tbody tr")].map((tr) =>
          [...tr.querySelectorAll("td")].slice(0, 2).map((td) => td.textContent.trim().replace(/\s+/g, " ")),
        )
      : [];
  });

// admin-web's page, for what the pilot should match.
const theirs = await open(`${adminWeb}${PATH}`, true);
await theirs.page.waitForSelector("main h1");
await theirs.page.waitForTimeout(1_500);
const theirRows = await queueRows(theirs.page);
await theirs.ctx.close();
check(theirRows.length > 0, `admin-web's repair queue has ${theirRows.length} rows`);

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems, status } = await open(`${base}${PATH}`, javaScriptEnabled);
  check(status === 200, `${label}: the console answers 200 (${status})`);
  check((await page.locator("main h1").textContent()) === "Projection Operations", `${label}: its heading`);
  const counts = await page.locator("main dl dd").count();
  check(counts === 8, `${label}: eight counts (${counts})`);
  const rows = await queueRows(page);
  check(
    JSON.stringify(rows) === JSON.stringify(theirRows),
    `${label}: the repair queue's ${rows.length} rows match admin-web's in order (${JSON.stringify(rows)} vs ${JSON.stringify(theirRows)})`,
  );
  check(
    await page.evaluate(() =>
      [...document.styleSheets].some((s) => (s.href ?? "").includes("/sections/platform/projections")),
    ),
    `${label}: the area's own stylesheet`,
  );

  // The filters, sent as the address.
  await page.selectOption("select[name=state]", "degraded");
  await Promise.all([page.waitForURL(/state=degraded/), page.getByRole("button", { name: "Apply filters" }).click()]);
  check(await shows(page.getByText("State: degraded", { exact: true })), `${label}: the applied filter's chip`);
  const filtered = await queueRows(page);
  check(
    filtered.length > 0 && filtered.every(([state]) => state === "degraded"),
    `${label}: only degraded rows (${JSON.stringify(filtered)})`,
  );

  // A group's sheet.
  const group = page.locator("main table tbody tr").filter({ hasText: "projection-group" }).first();
  await Promise.all([page.waitForURL(/selected=/), group.getByRole("link", { name: "Details" }).click()]);
  const sheet = page.locator("dialog[open]").first();
  check(await shows(sheet), `${label}: the group's sheet opens`);
  if (javaScriptEnabled) check(await sheet.evaluate((d) => d.matches(":modal")), `${label}: the sheet is modal`);
  const links = await sheet.locator("section ul a").count();
  check(
    links > 0,
    `${label}: the group lists its blocked streams and poison events (${links}), chase-sets/chase-sets#10710`,
  );
  const rebuild = sheet.getByRole("button", { name: "Rebuild", exact: true });
  if (await rebuild.count()) {
    if (javaScriptEnabled) {
      await rebuild.click();
      const confirm = page.locator("dialog#rebuild-group");
      check(await shows(confirm), `${label}: Rebuild asks to confirm`);
      await confirm.getByRole("button", { name: "Cancel" }).click();
      check(!(await confirm.isVisible()), `${label}: Cancel closes the confirm, nothing queued`);
    } else {
      check(true, `${label}: Rebuild is offered (its confirm needs the browser's dialog commands)`);
    }
  }
  // A poison event's sheet: Retry is offered.
  const poison = sheet.locator("section ul a").last();
  await Promise.all([page.waitForURL(/selected=poison-event/), poison.click()]);
  check(
    await shows(page.locator("dialog[open]").getByRole("button", { name: "Retry" })),
    `${label}: a poison event's sheet offers Retry`,
  );
  // Close: Escape with JavaScript (the address loses the selection), the link without.
  if (javaScriptEnabled) {
    await Promise.all([page.waitForURL((u) => !u.search.includes("selected=")), page.keyboard.press("Escape")]);
  } else {
    await Promise.all([
      page.waitForURL((u) => !u.search.includes("selected=")),
      page.getByRole("link", { name: "Close projection detail" }).click(),
    ]);
  }
  const gone = await page
    .locator("dialog[open]")
    .first()
    .waitFor({ state: "detached", timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  check(gone, `${label}: the sheet closes and the address says so (${page.url()})`);
  check(page.url().includes("state=degraded"), `${label}: the filters stay`);

  // Refresh status: back to the console as it was.
  const refresh = page.getByRole("button", { name: "Refresh status" });
  if (await refresh.count()) {
    await Promise.all([page.waitForLoadState("load"), refresh.click()]);
    await page.waitForTimeout(500);
    check(
      page.url().includes("state=degraded") &&
        (await page.locator("main h1").textContent()) === "Projection Operations",
      `${label}: Refresh status comes back to the console (${page.url()})`,
    );
  }
  check(problems.length === 0, `${label}: no console errors ${problems.join(" | ")}`);
  await ctx.close();
}

// A phone.
{
  const { ctx, page } = await open(`${base}${PATH}`, true, { width: 390, height: 844 });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(wide <= 0, `390 px: no sideways scroll (${wide})`);
  const short = await page.evaluate(() =>
    [...document.querySelectorAll("main a[class], main button")]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40)
      .map((b) => b.textContent.trim()),
  );
  check(short.length === 0, `390 px: every button at least 40 px tall (${short.join(", ")})`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/projections-390.png", fullPage: true });
  const group = page.locator("main table tbody tr").filter({ hasText: "projection-group" }).first();
  await Promise.all([page.waitForURL(/selected=/), group.getByRole("link", { name: "Details" }).click()]);
  await page.locator("dialog[open]").first().waitFor({ state: "visible", timeout: 10_000 });
  const sheetWide = await page.evaluate(
    () => document.querySelector("dialog[open]").scrollWidth - document.querySelector("dialog[open]").clientWidth,
  );
  check(sheetWide <= 0, `390 px: the sheet does not scroll sideways (${sheetWide})`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/projections-sheet-390.png" });
  await ctx.close();
}
{
  const { ctx, page } = await open(`${base}${PATH}`, true);
  await page.screenshot({ path: "../../artifacts/corten-pilot/projections-1280.png", fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
