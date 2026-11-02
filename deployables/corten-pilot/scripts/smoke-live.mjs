// The catalog lists stay current, as admin-web's do: one tab watches the dimensions list, filtered
// to this run's key prefix; another creates a dimension; the first shows the new row without a
// reload, keeps what was typed in its search box, and the new row's link works. The same for the
// fields list. It writes to the dev sandbox's data, against the real platform API and its
// realtime stream. Also timed: how long the new row takes to appear in the watching tab.
// Usage: node scripts/smoke-live.mjs [pilot-url] [state-file] [watch-url]   (state from
// scripts/sign-in.mjs; watch-url, admin-web's origin for instance, is the list the first tab
// watches, by default the pilot's)
import { chromium } from "@playwright/test";

const [base = "http://localhost:7790", stateFile = "../../artifacts/corten-pilot/admin-state.json", watched = base] =
  process.argv.slice(2);
const pilotWatched = watched === base;
const stamp = Date.now().toString(36);
let failures = 0;

// A record's page right after its create can answer "preparing" (503) until its projection
// catches up; do what it asks, as smoke-catalog.mjs does.
let pending = 0;
async function settled(page) {
  const start = Date.now();
  while ((await page.getByText("Refresh in a moment").count()) && Date.now() - start < 90_000) {
    pending += 1;
    await page.waitForTimeout(2_000);
    await page.reload();
  }
}

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: stateFile });
const problems = [];
const watch = await ctx.newPage();
const other = await ctx.newPage();
for (const page of [watch, other]) {
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 503") && problems.push(m.text()));
}

/** Creates a dimension or field in the other tab through the create dialog. */
async function create(list, button, fill) {
  await other.goto(`${base}${list}`);
  await other.waitForLoadState();
  await other.getByRole("button", { name: button }).click();
  const dialog = other.locator("#catalog-create-dialog");
  await fill(dialog);
  const before = other.url();
  await dialog.getByRole("button", { name: "Create" }).click();
  await other.waitForURL((u) => u.href !== before && u.searchParams.get("done") === "created");
}

for (const kind of ["dimensions", "fields"]) {
  const prefix = `live_${stamp}_${kind[0]}`;
  await watch.goto(`${watched}/catalog/${kind}?search=${prefix}`);
  await watch.waitForLoadState();
  check(
    (await watch.getByRole("row", { name: new RegExp(prefix) }).count()) === 0,
    `${kind}: the watching tab starts with no rows for the run`,
  );
  // Something typed and not applied stays when the rows change.
  if (pilotWatched) await watch.getByRole("searchbox", { name: "Search" }).fill(`${prefix} typed`);
  await watch.waitForTimeout(1_000); // the live stream is open
  const key = `${prefix}_1`;
  const started = Date.now();
  if (kind === "dimensions") {
    await create("/catalog/dimensions", "New Dimension", async (d) => {
      await d.getByLabel("Key").fill(key);
      await d.getByLabel("Name").fill(`Live ${stamp}`);
      await d.getByLabel("Value Kind").selectOption("ordered");
    });
  } else {
    await create("/catalog/fields", "New Field", async (d) => {
      await d.getByLabel("Key").fill(key);
      await d.getByLabel("Name").fill(`Live ${stamp}`);
    });
  }
  const row = watch.getByRole("row", { name: new RegExp(key) });
  const appeared = await row.waitFor({ timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  check(
    appeared,
    `${kind}: the new row appears in the watching tab without a reload (${Date.now() - started} ms after the create was sent)`,
  );
  if (pilotWatched) {
    check(
      (await watch.getByRole("searchbox", { name: "Search" }).inputValue()) === `${prefix} typed`,
      `${kind}: the search box keeps what was typed`,
    );
  }
  const loads = await watch.evaluate(() => performance.getEntriesByType("navigation").length);
  // admin-web is a client-rendered app after its first load, so one navigation entry there too.
  check(loads === 1, `${kind}: no page load happened in the watching tab`);
  if (appeared && pilotWatched) {
    await row.getByRole("link", { name: "View" }).click();
    await watch.waitForURL(new RegExp(`/catalog/${kind}/(dim|fld)_`));
    // A Navigation API navigation: the address changes before the page is swapped in.
    await watch.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
    await settled(watch);
    const heading = await watch.locator("h1").first().textContent();
    check(
      heading === `Live ${stamp}`,
      `${kind}: the live row's link opens the record (${new URL(watch.url()).pathname}: ${heading})`,
    );
  }
}

check(problems.length === 0, `no script errors (${problems.join("; ")})`);
await browser.close();
console.log(`${failures ? `${failures} failed` : "all passed"}; ${pending} "preparing" answers refreshed`);
process.exit(failures ? 1 : 0);
