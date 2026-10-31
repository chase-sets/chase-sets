// Uses the pilot in a browser as a signed-in platform admin, with JavaScript and without it,
// against the real platform API: the list, the sheet, preview, create (refused by the API, by the
// pilot's checks, then accepted), revise, clone, activate and retire. It writes to the dev
// sandbox's data.
// Usage: node scripts/smoke.mjs [pilot-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [base = "http://localhost:7790", stateFile = "../../artifacts/corten-pilot/admin-state.json"] =
  process.argv.slice(2);
const list = `${base}/commerce/postage-policies`;
const stamp = Date.now().toString(36);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

// After a write, the page waits for the write's projection; when the API's freshness wait runs
// out it answers "preparing" (503), as admin-web does, and asks for a refresh. Do what it asks.
// Activation can take tens of seconds to project in the dev sandbox; admin-web's own e2e test
// polls for up to 90 s, so this does too.
let pending = 0;
const waits = [];
async function settled(page) {
  const start = Date.now();
  while ((await page.getByText("Refresh in a moment").count()) && Date.now() - start < 90_000) {
    pending += 1;
    await page.waitForTimeout(2_000);
    await page.reload();
  }
  if (Date.now() - start > 500) waits.push(`${Math.round((Date.now() - start) / 1000)}s`);
}

// With JavaScript a redirect is a Navigation API navigation: the address changes first and the
// page follows, so wait for the navigation to finish before reading the old or the new page.
async function navigated(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
}

async function sheetTitled(page, label) {
  await navigated(page);
  await page.waitForFunction(
    (label) =>
      document.querySelector("dialog[open] h2")?.textContent === label ||
      document.body.textContent.includes("Refresh in a moment"),
    label,
  );
  await settled(page);
  return (await page.locator("dialog[open] h2").textContent()) === label;
}

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

// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(list);
  await settled(page);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent()) === "Postage Policies", "the list renders in the shell");
  check(
    (await page.locator('nav a[aria-current="page"]').textContent()) === "Postage Policies",
    "the commerce nav marks the page",
  );

  const create = page.locator("#create-form");
  await create.getByLabel("Label", { exact: true }).fill(`Smoke ${stamp}`);
  await create.getByLabel("Effective until").fill("2000-01-01T00:00:00.000Z");
  await create.getByRole("button", { name: "Create draft" }).click();
  await create.locator(".form-error").waitFor();
  check(
    (await create.locator(".form-error").textContent()) === "Effective until must be after effective from.",
    "the API's refusal is the form's message, patched in",
  );
  check(page.url() === list, "a refusal does not navigate");

  await create.getByLabel("Effective until").fill("");
  await create.getByLabel("Max letter units").evaluate((input) => {
    input.removeAttribute("required");
    /** @type {HTMLInputElement} */ (input).value = "";
  });
  await create.getByRole("button", { name: "Create draft" }).click();
  await page.locator("#create-form-max_letter_units-error").waitFor();
  check(
    (await page.locator("#create-form-max_letter_units-error").textContent()) === "Enter a value.",
    "the pilot's check names its field",
  );
  check(
    await page.evaluate(() => document.activeElement?.getAttribute("name") === "max_letter_units"),
    "focus moves to it",
  );
  check(
    (await page.getByLabel("Label", { exact: true }).first().inputValue()) === `Smoke ${stamp}`,
    "typed values survive the patch",
  );

  await create.getByLabel("Max letter units").fill("8");
  await create.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/policy=.*after_write=/);
  check(await sheetTitled(page, `Smoke ${stamp}`), "create lands on the new draft's sheet");
  const sheet = page.locator("dialog[open]").first();
  check(await sheet.evaluate((d) => d.matches(":modal")), "the sheet is modal with JavaScript");
  const drafts = await page.locator("section", { hasText: "Drafts awaiting activation" }).first().textContent();
  check(drafts.includes(`Smoke ${stamp}`), "the drafts table lists it on the same read (read after write)");

  const before = page.url();
  await sheet.getByRole("button", { name: "Preview result" }).click();
  await page.locator("#preview-result").getByText("Packages:").waitFor();
  check(page.url() === before, "preview patches its result in place");

  const revise = page.locator("#revise-form");
  await revise.getByLabel("Label", { exact: true }).fill(`Smoke ${stamp} revised`);
  await revise.getByRole("button", { name: "Save revision" }).click();
  await page.waitForURL((u) => u.href !== before);
  check(await sheetTitled(page, `Smoke ${stamp} revised`), "a revision shows on the sheet after the redirect");

  await page.locator("#activate-form").getByRole("button", { name: "Activate" }).click();
  const confirm = page.locator("#activate-dialog");
  await confirm.waitFor();
  check(await confirm.evaluate((d) => d.matches(":modal")), "activate asks first (command=show-modal, no script)");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  check(!(await confirm.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)), "cancel closes the question");
  const revised = page.url();
  await page.locator("#activate-form").getByRole("button", { name: "Activate" }).click();
  await confirm.getByRole("button", { name: "Activate" }).click();
  await page.waitForURL((u) => u.href !== revised);
  const titled = await sheetTitled(page, `Smoke ${stamp} revised`);
  const badge = titled ? await page.locator("dialog[open] .badge__pill").first().textContent() : null;
  check(
    badge === "active",
    `activation shows the policy active${badge === "active" ? "" : ` (titled ${titled}, badge ${badge}, ${page.url()}, ${(await page.locator("main").textContent())?.slice(0, 300)})`}`,
  );

  await page.keyboard.press("Escape");
  await page.waitForURL((u) => !u.searchParams.has("policy"));
  await navigated(page);
  check(!(await page.locator("dialog[open]").count()), "Escape closes the sheet through its link");
  await page
    .getByRole("row", { name: new RegExp(`Smoke ${stamp} revised`) })
    .getByRole("link", { name: "Open" })
    .click();
  await page.locator("dialog[open]").waitFor();

  const clone = page.locator("#clone-form");
  await clone.getByLabel("Draft label").fill(`Smoke ${stamp} rollback`);
  await clone.getByRole("button", { name: "Clone as rollback draft" }).click();
  check(await sheetTitled(page, `Smoke ${stamp} rollback`), "clone lands on the rollback draft");
  const cloned = page.url();
  await page.locator("#retire-form").getByRole("button", { name: "Retire" }).click();
  await page.locator("#retire-dialog").getByRole("button", { name: "Retire" }).click();
  await page.waitForURL((u) => u.href !== cloned);
  await sheetTitled(page, `Smoke ${stamp} rollback`);
  check(
    (await page.locator("dialog[open] .badge__pill").first().textContent()) === "retired",
    "retiring the rollback draft shows it retired",
  );
  // The browser logs every 4xx and 5xx answer: the two refused creates (422) and any "preparing"
  // answers (503) are expected.
  const refusals = problems.filter((p) => p.includes("status of 422")).length;
  const real = problems.filter(
    (p) => !(p.includes("status of 422") && refusals <= 2) && !(pending && p.includes("status of 503")),
  );
  check(real.length === 0, `no console errors${real.length ? `: ${real.join(" | ")}` : ""}`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(list);
  check((await page.locator("h1").textContent()) === "Postage Policies", "the list renders without JavaScript");
  await page.getByRole("link", { name: "Open" }).first().click();
  const sheet = page.locator("dialog[open]");
  await sheet.waitFor();
  check(
    !(await sheet.evaluate((d) => d.matches(":modal"))),
    "the sheet is an open, non-modal dialog without JavaScript",
  );
  const create = page.locator("#create-form");
  await create.getByLabel("Effective until").fill("2000-01-01T00:00:00.000Z");
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    create.getByRole("button", { name: "Create draft" }).click(),
  ]);
  check(response.status() === 422, "a refused post answers 422 with the whole page");
  check(
    (await page.locator("#create-form .form-error").textContent()) === "Effective until must be after effective from.",
    "with the API's message on the form",
  );
  await page.goto(`${list}?policy=opp_seed_default`);
  await page.locator("dialog[open]").getByRole("link", { name: "Close policy details" }).click();
  check(!(await page.locator("dialog[open]").count()), "the close link closes the sheet");
  await ctx.close();
}

await browser.close();
console.log(
  `${failures ? `${failures} failed` : "all passed"}; ${pending} "preparing" answers refreshed${waits.length ? ` (waits: ${waits.join(", ")})` : ""}`,
);
process.exit(failures ? 1 : 0);
