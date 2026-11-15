// Uses the catalog area in a browser as a signed-in platform admin, with JavaScript and without
// it, against the real platform API: a dimension's whole life (create, activate, options added,
// labelled, refused, reordered, revised, deprecated and reactivated, the dimension revised,
// deprecated, archived) and a field's (create, configure, activate), plus the area's stylesheet.
// It writes to the dev sandbox's data.
// Usage: node scripts/smoke-catalog.mjs [pilot-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [base = "http://localhost:7790", stateFile = "../../artifacts/corten-pilot/admin-state.json"] =
  process.argv.slice(2);
const stamp = Date.now().toString(36);
const key = `smoke_${stamp}`;
let failures = 0;
/** Steps the API refused that the pilot answered correctly: reported, never counted as passed. */
const blocked = [];

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

// A redirect with JavaScript is a Navigation API navigation: wait for it to finish.
async function navigated(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
  await settled(page);
}

/** Submits with `click` and waits for the page the write redirects to, which names `done`. */
async function wrote(page, click, done) {
  const before = page.url();
  await click();
  await page.waitForURL((u) => u.href !== before && u.searchParams.get("done") === done);
  await navigated(page);
}

const toast = (page) => page.locator("#ui-toast").textContent();
const browser = await chromium.launch();

async function context(javaScriptEnabled) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

let dimensionUrl = "";

// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  const sheets = [];
  page.on("request", (r) => r.resourceType() === "stylesheet" && sheets.push(new URL(r.url()).pathname));
  await page.goto(`${base}/catalog`);
  await navigated(page);
  check(new URL(page.url()).pathname === "/catalog/dimensions", "the area opens on the dimensions");
  check((await page.locator("h1").textContent()) === "Dimensions", "the list renders in the shell");
  check(
    (await page.locator('nav a[aria-current="page"]').textContent()) === "Dimensions",
    "the catalog's nav marks the page",
  );
  check(
    sheets.some((s) => s.includes("/sections/catalog")),
    "the page links the area's stylesheet",
  );
  check(!sheets.some((s) => s.includes("/sections/commerce")), "and not the postage area's");

  await page.getByRole("button", { name: "New Dimension" }).click();
  const create = page.locator("#catalog-create-dialog");
  check(await create.evaluate((d) => d.matches(":modal")), "New Dimension opens a modal dialog (command=show-modal)");
  await create.getByLabel("Key").fill(key);
  await create.getByLabel("Name").fill(`Smoke ${stamp}`);
  await create.getByLabel("Value Kind").selectOption("ordered");
  await wrote(page, () => create.getByRole("button", { name: "Create" }).click(), "created");
  check((await toast(page)) === "Dimension created", "create comes back with admin-web's toast");

  await page.getByRole("searchbox", { name: "Search" }).fill(key);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForURL((u) => u.searchParams.get("search") === key);
  await navigated(page);
  const row = page.getByRole("row", { name: new RegExp(key) });
  check((await row.count()) === 1, "the filter finds the new dimension (read after write)");
  await row.getByRole("link", { name: "View" }).click();
  await page.waitForURL(/\/catalog\/dimensions\/dim_/);
  await navigated(page);
  dimensionUrl = page.url().split("?")[0];
  check((await page.locator("h1").textContent()) === `Smoke ${stamp}`, "View opens the dimension");

  await wrote(page, () => page.getByRole("button", { name: "Activate" }).click(), "activated");
  check((await toast(page)) === "Dimension activated.", "Activate posts without asking, as admin-web's does");
  check(
    (await page.locator("#catalog-lifecycle .status-pill__pill").textContent()) === "active",
    "the status is active",
  );

  // Add Label posts the form back with a row more; the dialog stays open on it.
  await page.getByRole("button", { name: "Add Option" }).click();
  const add = page.locator("#catalog-add-option-dialog");
  await add.getByLabel("Code").fill("nm");
  await add.getByLabel("Label", { exact: true }).fill("Near mint");
  await add.getByRole("button", { name: "Add Label" }).click();
  await page.waitForFunction(() => document.querySelectorAll('#catalog-add-option [name="label_locale"]').length === 2);
  check(await add.evaluate((d) => d.matches(":modal")), "Add Label draws the form again in the open dialog");
  check((await add.getByLabel("Code").inputValue()) === "nm", "what was typed stays");
  await add.getByLabel("Locale").nth(1).fill("fr");
  await add.getByLabel("Label", { exact: true }).nth(1).fill("Quasi neuf");
  await wrote(page, () => add.getByRole("button", { name: "Add", exact: true }).click(), "option_added");
  check((await toast(page)) === "Option added", "the option is added");

  await page.getByRole("button", { name: "Add Option" }).click();
  await add.getByLabel("Code").fill("nm");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await add.locator(".form-error").waitFor();
  check(
    (await add.locator(".form-error").textContent()) === "Option codes must be unique within a dimension.",
    "the API's refusal is the dialog form's message, patched in",
  );
  await add.getByLabel("Code").fill("lp");
  await add.getByLabel("Numeric Value (optional)").fill("2");
  await wrote(page, () => add.getByRole("button", { name: "Add", exact: true }).click(), "option_added");
  const codes = async () => page.locator("table[aria-label^='Options of'] tbody tr td:first-child").allTextContents();
  check(JSON.stringify(await codes()) === '["nm","lp"]', `both options are listed (${await codes()})`);

  // Reorder. A refusal is the dialog form's message; the Catalog API takes a reorder,
  // so a refusal here fails the run.
  await page.getByRole("button", { name: "Reorder" }).click();
  const reorder = page.locator("#catalog-reorder-dialog");
  const ids = (await reorder.getByLabel("Option IDs").inputValue()).split(", ");
  await reorder.getByLabel("Option IDs").fill([...ids].reverse().join(", "));
  const before = page.url();
  await reorder.getByRole("button", { name: "Save" }).click();
  await Promise.race([
    page.waitForURL((u) => u.href !== before && u.searchParams.get("done") === "reordered"),
    reorder.locator(".form-error").waitFor(),
  ]);
  if (page.url() !== before) {
    await navigated(page);
    check(JSON.stringify(await codes()) === '["lp","nm"]', "Reorder changes the order");
  } else {
    const message = await reorder.locator(".form-error").textContent();
    check(false, `Reorder changes the order (the API refused it: ${message})`);
    await page.keyboard.press("Escape");
  }

  const nm = page.getByRole("row", { name: /^nm / });
  await nm.getByRole("button", { name: "Edit" }).click();
  const edit = page.locator("dialog[open]");
  check((await edit.locator("h2").textContent()) === "Edit nm", "an option's Edit opens its own dialog");
  check((await edit.getByLabel("Locale").nth(1).inputValue()) === "fr", "with its labels");
  await edit.getByLabel("Label", { exact: true }).first().fill("Near Mint");
  await wrote(page, () => edit.getByRole("button", { name: "Save" }).click(), "option_revised");
  check(
    (await page.getByRole("row", { name: /^nm / }).locator("td").nth(1).textContent()) === "Near Mint",
    "the option is revised",
  );

  await wrote(
    page,
    () => page.getByRole("row", { name: /^nm / }).getByRole("button", { name: "Deprecate" }).click(),
    "option_deprecated",
  );
  check((await toast(page)) === "Option deprecated", "the option is deprecated");
  await wrote(
    page,
    () => page.getByRole("row", { name: /^nm / }).getByRole("button", { name: "Reactivate" }).click(),
    "option_reactivated",
  );
  check((await toast(page)) === "Option reactivated", "and reactivated");

  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const revise = page.locator("#catalog-edit-dialog");
  await revise.getByLabel("Name").fill(`Smoke ${stamp} revised`);
  await wrote(page, () => revise.getByRole("button", { name: "Save" }).click(), "revised");
  check((await page.locator("h1").textContent()) === `Smoke ${stamp} revised`, "Edit revises the dimension");

  await page.locator("#catalog-lifecycle").getByRole("button", { name: "Deprecate" }).click();
  const confirm = page.locator("#catalog-lifecycle-deprecate");
  check(await confirm.evaluate((d) => d.matches(":modal")), "Deprecate asks first");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  check(!(await confirm.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)), "Cancel closes the question");
  await page.locator("#catalog-lifecycle").getByRole("button", { name: "Deprecate" }).click();
  await wrote(page, () => confirm.getByRole("button", { name: "Deprecate" }).click(), "deprecated");
  check((await toast(page)) === "Dimension deprecated.", "the dimension is deprecated");
  await page.locator("#catalog-lifecycle").getByRole("button", { name: "Archive" }).click();
  await wrote(
    page,
    () => page.locator("#catalog-lifecycle-archive").getByRole("button", { name: "Archive" }).click(),
    "archived",
  );
  check((await page.locator("#catalog-lifecycle .status-pill__pill").textContent()) === "archived", "and archived");
  check(!(await page.getByRole("button", { name: "Add Option" }).count()), "an archived dimension offers no edits");

  // A field.
  await page.goto(`${base}/catalog/fields`);
  await navigated(page);
  check(
    (await page.locator('nav a[aria-current="page"]').textContent()) === "Fields",
    "the fields list is the catalog nav's Fields",
  );
  await page.getByRole("button", { name: "New Field" }).click();
  const field = page.locator("#catalog-create-dialog");
  await field.getByLabel("Key").fill(key);
  await field.getByLabel("Name").fill(`Smoke field ${stamp}`);
  await field.getByLabel("Filterable").check();
  await wrote(page, () => field.getByRole("button", { name: "Create" }).click(), "created");
  check((await toast(page)) === "Field created", "a field is created");
  await page.getByRole("searchbox", { name: "Search" }).fill(key);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForURL((u) => u.searchParams.get("search") === key);
  await navigated(page);
  await page
    .getByRole("row", { name: new RegExp(key) })
    .getByRole("link", { name: "View" })
    .click();
  await page.waitForURL(/\/catalog\/fields\/fld_/);
  await navigated(page);
  await page.getByRole("button", { name: "Configure" }).click();
  const configure = page.locator("#catalog-edit-dialog");
  check(await configure.getByLabel("Filterable").isChecked(), "Configure starts from the field");
  await configure.getByLabel("Sortable").check();
  await wrote(page, () => configure.getByRole("button", { name: "Save" }).click(), "revised");
  check((await toast(page)) === "Field configured", "the field is configured");
  await wrote(page, () => page.getByRole("button", { name: "Activate" }).click(), "activated");
  check((await toast(page)) === "Field activated.", "and activated");

  // The browser logs every 4xx and 5xx: the refusals (400, 409 or 422 from the API, answered 422)
  // and any "preparing" (503).
  const real = problems.filter((p) => !/status of (400|409|422)/.test(p) && !(pending && p.includes("status of 503")));
  check(real.length === 0, `no console errors${real.length ? `: ${real.join(" | ")}` : ""}`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(`${base}/catalog/dimensions?search=${key}`);
  check((await page.locator("h1").textContent()) === "Dimensions", "the list renders without JavaScript");
  check((await page.getByRole("row", { name: new RegExp(key) }).count()) === 1, "the filter is in the address");
  await page.getByRole("button", { name: "New Dimension" }).click();
  const create = page.locator("#catalog-create-dialog");
  check(await create.evaluate((d) => d.matches(":modal")), "dialogs open without JavaScript (invoker commands)");
  await page.keyboard.press("Escape");

  await page.goto(`${base}/catalog/dimensions`);
  await page.getByRole("button", { name: "New Dimension" }).click();
  await create.getByLabel("Key").fill(`${key}_plain`);
  await create.getByLabel("Name").fill(`Smoke plain ${stamp}`);
  await Promise.all([
    page.waitForURL((u) => u.searchParams.get("done") === "created"),
    create.getByRole("button", { name: "Create" }).click(),
  ]);
  await settled(page);
  check(
    (await toast(page)) === "Dimension created",
    "a create without JavaScript is a redirect with the toast in the page",
  );

  await page.goto(`${base}/catalog/dimensions?search=${key}_plain`);
  await page.getByRole("link", { name: "View" }).click();
  await settled(page);
  await page.getByRole("button", { name: "Add Option" }).click();
  const add = page.locator("#catalog-add-option-dialog");
  await add.getByLabel("Code").fill("nm");
  const [relabel] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    add.getByRole("button", { name: "Add Label" }).click(),
  ]);
  check(relabel.status() === 200, "Add Label without JavaScript answers the page");
  check(
    (await page.locator('#catalog-add-option [name="label_locale"]').count()) === 2,
    "with the dialog open and a row more",
  );
  check((await page.locator("#catalog-add-option-dialog").getAttribute("open")) !== null, "the dialog is drawn open");
  await page.locator("#catalog-add-option").getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "option_added");
  await settled(page);
  await page.getByRole("button", { name: "Add Option" }).click();
  await add.getByLabel("Code").fill("nm");
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    add.getByRole("button", { name: "Add", exact: true }).click(),
  ]);
  check(refused.status() === 422, "a refused post answers 422 with the whole page");
  check(
    (await page.locator("#catalog-add-option .form-error").textContent()) ===
      "Option codes must be unique within a dimension.",
    "with the API's message in the open dialog",
  );
  await ctx.close();
}

await browser.close();
for (const step of blocked) console.log(`BLOCKED ${step}`);
console.log(
  `${failures ? `${failures} failed` : "all passed"}${blocked.length ? `, ${blocked.length} blocked by the API` : ""}; ${pending} "preparing" answers refreshed`,
);
process.exit(failures ? 1 : 0);
