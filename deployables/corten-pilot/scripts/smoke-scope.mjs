// Uses a scope's page in a browser as a signed-in platform admin, with JavaScript and without it,
// against the real platform API: the scopes list's View opens it, its sections draw from the
// Catalog API, a revoke's reason folds open, Propose mapping's dialog opens and closes, and a
// propose without its unit comes back with the message and writes nothing. When admin-web is up,
// the coverage rows are compared with its page for the same scope. Then a phone's width. It writes
// nothing to the API.
// The rest runs on `scope`, one with mapped providers in the sandbox's seed.
// Usage: node scripts/smoke-scope.mjs [pilot-url] [admin-web-url] [state-file] [scope]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7790",
  adminWeb = "http://localhost:7752",
  stateFile = "../../artifacts/corten-pilot/admin-state.json",
  scope = "ref_seed_set_lorcana_d23_collection",
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
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** The coverage table's rows: provider and state. */
const coverage = (page) =>
  page
    .locator('section[aria-labelledby="scope-coverage"] tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) =>
        Array.from(tr.querySelectorAll("td"), (td) => (td.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, 2),
      ),
    );

let href = "";
// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(`${base}/catalog/scopes`);
  const view = page.locator("table").last().locator("tbody tr").first().getByRole("link", { name: "View" });
  href = (await view.getAttribute("href")) ?? "";
  check(href.startsWith("/catalog/scopes/"), `the list's View is the pilot's scope page (${href})`);
  await view.click();
  await page.waitForURL((u) => u.pathname === href);
  // Corten swaps the page in after the URL changes.
  await page.locator('section[aria-labelledby="scope-journey"]').waitFor();
  const name = await page.locator("h1").textContent();
  check(Boolean(name?.trim()), `the page renders (${name?.trim()})`);
  for (const [id, what] of [
    ["scope-journey", "the journey"],
    ["scope-coverage", "the coverage matrix"],
    ["scope-workspace", "the import-to-promotion link"],
    ["scope-jobs", "the candidate review jobs"],
  ]) {
    check((await page.locator(`section[aria-labelledby="${id}"]`).count()) === 1, what);
  }
  check((await page.locator("ol li[data-status]").count()) === 5, "five journey stages");
  href = `/catalog/scopes/${scope}`;
  await page.goto(`${base}${href}`);
  const rows = await coverage(page);
  console.log(`  coverage: ${JSON.stringify(rows)}`);
  const workspace = await page.getByRole("link", { name: "Open the workspace on admin-web" }).getAttribute("href");
  check(workspace === `${adminWeb}${href}`, `the workspace link is admin-web's same page (${workspace})`);

  // A revoke or reject: its reason folds open, nothing is sent.
  const fold = page.locator('section[aria-labelledby="scope-coverage"] details summary').first();
  if (await fold.count()) {
    await fold.click();
    check(
      await page
        .locator('section[aria-labelledby="scope-coverage"] details[open] input[name="reason"]')
        .first()
        .isVisible(),
      "a revoke's reason folds open",
    );
  } else {
    console.log("skip the reason fold: no mapping to revoke or reject");
  }

  // Propose mapping: opens, closes.
  await page.getByRole("button", { name: "Propose mapping" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose mapping" });
  check(await dialog.isVisible(), "Propose mapping opens its dialog");
  await dialog.getByRole("button", { name: "Close" }).click();
  check(!(await dialog.isVisible()), "and closes");

  // A propose without its unit: the page again, the dialog open with the message, no write.
  const answer = await page.request.post(`${base}${href}/coverage/propose`, {
    form: { provider_key: "smoke-provider", unit_key: "", set_id: "", set_name: "", confidence: "manual" },
    headers: { origin: base },
    maxRedirects: 0,
  });
  const text = await answer.text();
  check(
    answer.status() === 422 && text.includes("Enter the provider, the unit"),
    `a propose without its unit is refused before the API (${answer.status()})`,
  );
  check(text.includes('value="smoke-provider"'), "and keeps what was typed");
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);

  // Beside admin-web, when it is up.
  const up = await page.request.get(`${adminWeb}${href}`).then(
    (r) => r.ok(),
    () => false,
  );
  if (up) {
    await page.goto(`${adminWeb}${href}`, { waitUntil: "networkidle" });
    const theirs = await page
      .locator("table")
      .first()
      .locator("tbody tr")
      .evaluateAll((trs) =>
        trs.map((tr) =>
          Array.from(tr.querySelectorAll("td"), (td) => (td.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, 2),
        ),
      );
    check(
      JSON.stringify(theirs) === JSON.stringify(rows),
      `the same coverage rows as admin-web (${JSON.stringify(theirs)})`,
    );
  } else {
    console.log(`skip the comparison: admin-web is not answering at ${adminWeb}`);
  }
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(`${base}${href}`);
  check(
    (await page.locator('section[aria-labelledby="scope-coverage"]').count()) === 1,
    "the page renders without JavaScript",
  );
  const fold = page.locator('section[aria-labelledby="scope-coverage"] details summary').first();
  if (await fold.count()) {
    await fold.click();
    check(
      await page
        .locator('section[aria-labelledby="scope-coverage"] details[open] input[name="reason"]')
        .first()
        .isVisible(),
      "the reason folds open without JavaScript",
    );
  }
  await ctx.close();
}

// A phone's width.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${base}${href}`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `the page does not scroll sideways at 390 px (${wide} px over)`);
  // Each coverage row is a card: its commands are in view, not scrolled out of its table.
  const command = page.locator('section[aria-labelledby="scope-coverage"] tbody details summary').first();
  if (await command.count()) {
    const box = await command.boundingBox();
    check(
      box !== null && box.x >= 0 && box.x + box.width <= 390,
      `a row's Revoke is within the screen at 390 px (${JSON.stringify(box)})`,
    );
  }
  await page.screenshot({ path: "../../artifacts/corten-pilot/scope-390.png", fullPage: true });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
