// Uses the catalog lists' bulk changes in a browser as a signed-in platform admin, with
// JavaScript and without it, against the real platform API: two new draft dimensions are
// selected (a box, select all, Clear Selection), previewed, activated as a bulk job the list's
// dialog follows to its result; a third one created in another tab redraws the rows without
// losing a checked box; then every match is previewed by filter and deprecated without
// JavaScript (the draft is skipped). It writes to the dev sandbox's data.
// Usage: node scripts/smoke-bulk.mjs [pilot-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [base = "http://localhost:7790", stateFile = "../../artifacts/corten-pilot/admin-state.json"] =
  process.argv.slice(2);
const stamp = Date.now().toString(36);
const prefix = `bulk_${stamp}`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

// After a write the page waits for the write's projection; when the API's freshness wait runs
// out it answers "preparing" (503) and asks for a refresh. Do what it asks, for up to 90 s.
let pending = 0;
async function settled(page) {
  const start = Date.now();
  while ((await page.getByText("Refresh in a moment").count()) && Date.now() - start < 90_000) {
    pending += 1;
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

async function context(javaScriptEnabled) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

const list = `${base}/catalog/dimensions?search=${prefix}`;
const count = (page) => page.locator("#catalog-bulk output").textContent();
const box = (page, key) => page.getByRole("row", { name: new RegExp(key) }).getByRole("checkbox");

// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  for (const part of ["a", "b"]) {
    await page.goto(`${base}/catalog/dimensions`);
    await navigated(page);
    await page.getByRole("button", { name: "New Dimension" }).click();
    const create = page.locator("#catalog-create-dialog");
    await create.getByLabel("Key").fill(`${prefix}_${part}`);
    await create.getByLabel("Name").fill(`Bulk ${stamp} ${part}`);
    await create.getByRole("button", { name: "Create" }).click();
    await page.waitForURL((u) => u.searchParams.get("done") === "created");
    await navigated(page);
  }
  // The list may lag the creates (the projection): read it until both rows are in.
  for (let i = 0; i < 30; i += 1) {
    await page.goto(list);
    await navigated(page);
    if ((await page.getByRole("row", { name: new RegExp(prefix) }).count()) === 2) break;
    await page.waitForTimeout(2_000);
  }
  check((await page.getByRole("row", { name: new RegExp(prefix) }).count()) === 2, "the two new dimensions are listed");
  check((await count(page)) === "2 matching Dimensions", "the bar counts what the filters match");
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  const clear = page.getByRole("button", { name: "Clear Selection" });
  const all = page.getByRole("checkbox", { name: "Select all rows" });
  check(await preview.isDisabled(), "Preview waits for a checked row");
  check(!(await clear.isVisible()) && (await all.isVisible()), "the script shows select-all and hides Clear Selection");

  let requests = 0;
  const counting = () => (requests += 1);
  page.on("request", counting);
  await box(page, `${prefix}_a`).check();
  check((await count(page)) === "1 Dimensions selected", "a checked row is counted");
  check(await all.evaluate((b) => /** @type {HTMLInputElement} */ (b).indeterminate), "select-all is mixed");
  check(await preview.isEnabled(), "and Preview is enabled");
  await all.check();
  check(
    (await box(page, `${prefix}_b`).isChecked()) && (await count(page)) === "2 Dimensions selected",
    "select-all checks every row",
  );
  await page.getByLabel("Action").selectOption("deprecate");
  await clear.click();
  check(
    !(await box(page, `${prefix}_a`).isChecked()) && (await count(page)) === "2 matching Dimensions",
    "Clear Selection clears the rows",
  );
  check((await page.getByLabel("Action").inputValue()) === "deprecate", "and keeps the action");
  page.off("request", counting);
  check(requests === 0, `selecting made no request (${requests})`);

  await all.check();
  await page.getByLabel("Action").selectOption("activate");
  await preview.click();
  const dialog = page.locator("#catalog-bulk-preview");
  await dialog.locator(".dialog__title").waitFor();
  check(await dialog.evaluate((d) => d.matches(":modal")), "the preview is a modal dialog");
  check((await dialog.locator(".dialog__title").textContent()) === "Bulk Activate Preview", "for the action");
  check(
    (await dialog.locator(".dialog__description").textContent()) === "2 ready, 0 blocked.",
    "the API's preview: both drafts are ready",
  );
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await page.waitForURL((u) => u.searchParams.has("job"));
  await navigated(page);
  const job = page.locator("#catalog-bulk-job");
  check(await job.evaluate((d) => d.matches(":modal")), "the confirm opens the job's dialog");
  await page.waitForFunction(
    () => document.querySelector("#catalog-bulk-status")?.textContent?.includes("succeeded"),
    null,
    { timeout: 90_000 },
  );
  check(
    (await job.locator("#catalog-bulk-status .preview-dialog__summary").first().textContent()) ===
      "2 succeeded, 0 skipped, 0 failed.",
    "the job's dialog follows it to its result",
  );
  check(
    !(await page.locator("#catalog-bulk-status").textContent())?.includes("of 2 processed"),
    "with the result in place of the progress",
  );
  await job.getByRole("button", { name: "Close" }).click();
  await page.waitForFunction(
    (p) =>
      [...document.querySelectorAll("#catalog-rows tbody tr")].filter(
        (r) => r.textContent?.includes(p) && r.textContent.includes("active"),
      ).length === 2,
    prefix,
    { timeout: 60_000 },
  );
  check(true, "the live list shows both active");

  // A live change redraws the rows and the bar: a box the user checked keeps its mark, and the
  // counts follow (a third dimension, created in another tab).
  await box(page, `${prefix}_a`).check();
  const other = await ctx.newPage();
  await other.goto(`${base}/catalog/dimensions`);
  await navigated(other);
  await other.getByRole("button", { name: "New Dimension" }).click();
  const create = other.locator("#catalog-create-dialog");
  await create.getByLabel("Key").fill(`${prefix}_c`);
  await create.getByLabel("Name").fill(`Bulk ${stamp} c`);
  await create.getByRole("button", { name: "Create" }).click();
  await other.waitForURL((u) => u.searchParams.get("done") === "created");
  await other.close();
  await page.waitForFunction(() => document.querySelectorAll('#catalog-rows [name="ids"]').length === 3, null, {
    timeout: 60_000,
  });
  check(await box(page, `${prefix}_a`).isChecked(), "a checked box keeps its mark through a live redraw");
  check((await count(page)) === "1 Dimensions selected", "and the count is taken again");
  check(
    await page
      .getByRole("checkbox", { name: "Select all rows" })
      .evaluate((b) => /** @type {HTMLInputElement} */ (b).indeterminate),
    "select-all is mixed again",
  );
  await box(page, `${prefix}_a`).uncheck();
  check((await count(page)) === "3 matching Dimensions", "the redrawn bar counts the new match");
  // A "preparing" answer is a 503 the console reports; those were refreshed above.
  const real = problems.filter((p) => !(pending && p.includes("status of 503")));
  check(real.length === 0, `no script errors (${real.join(" | ")})`);
  await ctx.close();
}

// Without JavaScript: every record the filter matches, previewed and deprecated.
{
  const { ctx, page } = await context(false);
  await page.goto(list);
  await settled(page);
  check(
    await page.getByRole("checkbox", { name: "Select all rows" }).isHidden(),
    "without JavaScript select-all is hidden",
  );
  await page.getByLabel("Action").selectOption("deprecate");
  await page.getByRole("button", { name: "Preview matching items" }).click();
  await page.waitForLoadState();
  const dialog = page.locator("#catalog-bulk-preview");
  check((await dialog.getAttribute("open")) !== null, "the preview is the list with its dialog drawn open");
  check(
    (await dialog.locator(".dialog__description").textContent()) === "2 ready, 1 blocked.",
    "the two active dimensions are ready, the draft blocked",
  );
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await page.waitForURL((u) => u.searchParams.has("job"));
  for (
    let i = 0;
    i < 45 && !(await page.locator("#catalog-bulk-status").textContent())?.includes("succeeded");
    i += 1
  ) {
    await page.waitForTimeout(2_000);
    await page.reload();
  }
  check(
    (await page.locator("#catalog-bulk-status .preview-dialog__summary").first().textContent()) ===
      "2 succeeded, 1 skipped, 0 failed.",
    "the job's page shows its result on a reload",
  );
  await ctx.close();
}

await browser.close();
console.log(`${failures ? `${failures} failed` : "all passed"}; ${pending} "preparing" answers refreshed`);
process.exit(failures ? 1 : 0);
