// Uses the catalog items list in a browser as a signed-in platform admin, with JavaScript and
// without it, against the real platform API: a draft item is created and found by its id; a
// second one created in another tab is counted by the changes bar, and Reload draws the rows
// again keeping a checked box; the first is tagged by a bulk Merge Tags the list's dialog follows
// to its result; both are removed as drafts. Without JavaScript the list, its folded filters and
// a publish preview by filter work as forms. At a phone's width the page does not scroll
// sideways. It writes to the dev sandbox's data.
// Usage: node scripts/smoke-items.mjs [pilot-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [base = "http://localhost:7790", stateFile = "../../artifacts/corten-pilot/admin-state.json"] =
  process.argv.slice(2);
const stamp = Date.now().toString(36);
const tag = `smoke_${stamp}`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
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

async function navigated(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
  await settled(page);
}

const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  // A 503 is the API's "preparing" after a write, which `settled` reloads through; the stream's
  // drop is refused on purpose (ERR_FAILED).
  page.on(
    "console",
    (m) => m.type() === "error" && !/status of 503|ERR_FAILED/.test(m.text()) && problems.push(m.text()),
  );
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** Creates a draft item from the list's dialog; its id, from the form. */
async function create(page, description) {
  await page.goto(`${base}/catalog/catalog-items`);
  await navigated(page);
  await page.getByRole("button", { name: "New Catalog Item" }).click();
  const dialog = page.locator("#catalog-create-dialog");
  const id = await dialog.locator('input[name="item_id"]').inputValue();
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "created");
  await navigated(page);
  return id;
}

/** The list searched for `text`, read until `rows` rows are in (the projection may lag). */
async function listed(page, text, rows) {
  for (let i = 0; i < 30; i += 1) {
    await page.goto(`${base}/catalog/catalog-items?search=${encodeURIComponent(text)}`);
    await navigated(page);
    if ((await page.locator("#catalog-rows tbody tr").count()) === rows) return true;
    await page.waitForTimeout(2_000);
  }
  return false;
}

const ids = [];
// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  const first = await create(page, `Smoke ${stamp} a`);
  ids.push(first);
  check(/^cat_[0-9A-Z]{26}$/.test(first), `the create form drew an id (${first})`);
  check(await page.getByText("Catalog item created").isVisible(), "the create's toast");
  check(await listed(page, first, 1), "the new item is found by its id (its title)");
  const row = page.getByRole("row", { name: new RegExp(first) });
  check((await row.getByRole("cell").nth(3).textContent()) === "English", "its language is named");
  check((await row.locator(".status-pill__pill").textContent()) === "draft", "it is a draft");

  // The changes bar: an item created in another tab is counted, not drawn.
  const changes = page.locator("#catalog-changes");
  check(await changes.isHidden(), "nothing changed yet: no bar");
  await row.getByRole("checkbox").check();
  const other = await ctx.newPage();
  const second = await create(other, `Smoke ${stamp} b`);
  ids.push(second);
  await changes.getByText(/Catalog Items changed/).waitFor({ timeout: 30_000 });
  check(
    /^\d+ Catalog Items changed$/.test((await changes.locator("span").textContent()) ?? ""),
    "the bar counts the change",
  );
  check((await page.locator("#catalog-rows tbody tr").count()) === 1, "the rows did not move under the user");
  await changes.getByRole("button", { name: "Reload" }).click();
  await changes.waitFor({ state: "hidden" });
  check(page.url().includes(`search=${first}`), "Reload stays on the page (a patch, not a navigation)");
  check(
    await page
      .getByRole("row", { name: new RegExp(first) })
      .getByRole("checkbox")
      .isChecked(),
    "a checked box keeps its mark through Reload",
  );
  check(
    (await page.locator("#catalog-bulk output").textContent()) === "1 Catalog Items selected",
    "the count follows the box",
  );

  // The stream drops (its first answer ends at once, and the retries are refused): the status
  // says since when (its corten-status event), and is live again once the stream comes back.
  const watcher = await ctx.newPage();
  let opened = 0;
  await watcher.route("**/catalog/catalog-items/live**", (route) => {
    opened += 1;
    return opened === 1
      ? route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": open\n\n" })
      : route.abort();
  });
  await watcher.goto(`${base}/catalog/catalog-items`);
  const live = watcher.locator("#catalog-live");
  await watcher.waitForFunction(() => document.querySelector("#catalog-live")?.hasAttribute("stale-since"), null, {
    timeout: 30_000,
  });
  const since = (await live.locator(".live-status__title").textContent()) ?? "";
  check(
    /^Stale since \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM) UTC$/.test(since),
    `a dropped stream says since when (${since})`,
  );
  check(await live.locator(".live-status__stale").isVisible(), "with Reload");
  await watcher.unroute("**/catalog/catalog-items/live**");
  await watcher.waitForFunction(
    () => document.querySelector("#catalog-live")?.getAttribute("status") === "live",
    null,
    { timeout: 60_000 },
  );
  check(await live.locator(".live-status__stale").isHidden(), "and is live again after it reconnects");
  await watcher.close();

  // Remove drafts needs only drafts checked; the edit's value shows for the operations that take it.
  const drafts = page.getByRole("button", { name: "Remove drafts from selected" });
  check(await drafts.isEnabled(), "Remove drafts is enabled while only drafts are checked");
  const tags = page.locator("#catalog-bulk").getByLabel("Tags", { exact: true });
  check(await tags.isHidden(), "the tags input is hidden for a publish");
  await page.locator("#catalog-bulk select").selectOption("mergeTags");
  check(await tags.isVisible(), "and shown for Merge Tags");
  await tags.fill(`${tag}, ${tag}`);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator("#catalog-bulk-preview");
  await preview.getByText("Bulk Merge Tags Preview").waitFor();
  check(await preview.getByText("1 ready, 0 need attention.").isVisible(), "the edit's preview");
  await preview.getByRole("button", { name: "Apply Edit" }).click();
  const job = page.locator("#catalog-bulk-job");
  await job.getByText(/1 updated, 0 skipped, 0 failed\./).waitFor({ timeout: 60_000 });
  check(await job.getByRole("cell", { name: tag, exact: true }).isVisible(), "the job's result shows the tag, once");
  await job.getByRole("button", { name: "Close" }).click();

  // Both drafts, removed.
  check((await listed(page, `Smoke ${stamp}`, 2)) || (await listed(page, first, 1)), "the list again");
  await page.goto(`${base}/catalog/catalog-items?status=draft&tag=${tag}`);
  await navigated(page);
  check((await page.locator("#catalog-rows tbody tr").count()) === 1, "the tag filter finds the tagged item");
  await page.getByRole("checkbox", { name: "Select all rows" }).check();
  await page.getByRole("button", { name: "Remove drafts from selected" }).click();
  await preview.getByText("Remove 1 draft Catalog Items from the grid.").waitFor();
  await preview.getByRole("button", { name: "Remove drafts from selected" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "drafts_removed");
  await navigated(page);
  check(await page.getByText("1 draft Catalog Items removed").isVisible(), "the removal's toast");
  check(problems.length === 0, `no script errors (${problems.join(" | ")})`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  check(await listed(page, ids[1], 1), "the second item is listed without the script");
  check(!(await page.locator("details").getAttribute("open")), "the extra filters are folded");
  await page.locator("summary", { hasText: "More filters" }).click();
  await page.locator('select[name="language"]').selectOption("en");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await navigated(page);
  check(new URL(page.url()).searchParams.get("language") === "en", "the folded filter is applied");
  check((await page.locator("details").getAttribute("open")) !== null, "and opens the fold");
  await page.locator("#catalog-bulk select").selectOption("publish");
  await page.getByRole("button", { name: "Preview matching items" }).click();
  await navigated(page);
  const preview = page.locator("#catalog-bulk-preview");
  check(await preview.getByText("Bulk Publish Preview").isVisible(), "a publish preview by filter, as a page");
  check(
    await preview.getByText(/^Matching drafts: \d+ ready, \d+ need attention\.$/).isVisible(),
    "with the API's counts",
  );
  // Remove the second draft without the script: the server checks it is a draft.
  await page.goto(`${base}/catalog/catalog-items?search=${ids[1]}`);
  await navigated(page);
  await page
    .getByRole("row", { name: new RegExp(ids[1]) })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Remove drafts from selected" }).click();
  await navigated(page);
  await preview.getByRole("button", { name: "Remove drafts from selected" }).click();
  await navigated(page);
  check(new URL(page.url()).searchParams.get("done") === "drafts_removed", "removed without the script");
  await ctx.close();
}

// A phone's width.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${base}/catalog/catalog-items`);
  await navigated(page);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `the page does not scroll sideways at 390 px (${wide} px over)`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/items-390.png", fullPage: false });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
