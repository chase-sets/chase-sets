// Changes the collector's shipping addresses in a browser, against the real platform API, as the
// auth seed's collector. WRITES: each run adds two synthetic addresses ("Pilot smoke ..."), updates
// one, makes it the default and archives both, then makes the collector's default the default again.
// - Read: the page lists what the Identity API lists; at 390 px nothing scrolls sideways and every
//   control is at least 40 px tall.
// - With JavaScript: Save address, then the page says it was saved and lists it (read after the
//   write); a city sent empty (the input's `required` removed) is the form again with the API's
//   words next to the field; Update address opens its dialog, modal, and saves the new label;
//   Set default moves the Default badge; Archive asks in its dialog, then the address is gone.
// - Without JavaScript: Save address and Archive (the dialog opened by its button's command).
// - No console errors.
// Usage: node scripts/smoke-market-addresses.mjs [pilot-url] [collector-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  state = "../../artifacts/corten-pilot/collector-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = JSON.parse(readFileSync(state, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const session = await (await fetch(`${api}/api/auth/session`, { headers: { cookie } })).json();
const account = session.actor.accountId;
const book = `${api}/api/identity/accounts/${account}/shipping-addresses`;
const list = async () => (await (await fetch(book, { headers: { cookie } })).json()).items;
const before = await list();
const formerDefault = before.find((a) => a.is_default)?.shipping_address_id;
const stamp = Date.now().toString(36);

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: state });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  // The refusal this smoke asks for is a 422, which Chrome logs as a failed load.
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 422") && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
const card = (page, label) => page.locator("li").filter({ has: page.getByText(label, { exact: true }) });
const add = (page) => page.locator("#add-form");
/** Wait until the page shows `text` (or no longer does): a read the API has not caught up with
 * says so and reads itself again (Identity's list lags a write by seconds in the sandbox). */
const until = (page, text, shown = true) =>
  page.waitForFunction(
    ([t, s]) => (document.querySelector("main")?.innerText.includes(t) ?? false) === s,
    [text, shown],
    { timeout: 30_000 },
  );

/** Fill the add form and save it. */
async function save(page, label, fields = {}) {
  const form = add(page);
  await form.getByLabel("Label").fill(label);
  await form.getByLabel("Recipient name").fill("Synthetic Collector");
  await form.getByLabel("Address line 1").fill(fields.line1 ?? "1 Test Way");
  await form.getByLabel("City").fill(fields.city ?? "Austin");
  await form.getByLabel("State").fill("TX");
  await form.getByLabel("Postal code").fill("78701");
  await form.getByRole("button", { name: "Save address" }).click();
}

/** Without a script: whether the page comes to show `text` (or not), as it refreshes itself. */
async function settle(page, text, shown) {
  for (let i = 0; i < 20; i += 1) {
    const now = await main(page).catch(() => null);
    if (now !== null && now.includes(text) === shown) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

// Read, and the layout on a phone.
{
  const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
  const res = await page.goto(`${base}/account/shipping-addresses`);
  check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
  const shown = await page.locator("main li").count();
  check(shown === before.length, `it lists the API's ${before.length} addresses (${shown})`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
  const short = await page.evaluate(() =>
    [...document.querySelectorAll("main input, main select, main button, main a")]
      .filter((e) => e.offsetParent !== null && !e.closest("dialog"))
      .filter((e) => e.getBoundingClientRect().height < 40)
      .map((e) => e.textContent?.trim() || e.getAttribute("name")),
  );
  check(short.length === 0, `every control is at least 40 px tall (${short.join(", ") || "all"})`);
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// With JavaScript.
{
  const { ctx, page, problems } = await context();
  const label = `Pilot smoke ${stamp}`;
  await page.goto(`${base}/account/shipping-addresses`);
  await save(page, label);
  await page.getByText("Your change was saved").waitFor();
  await until(page, label);
  check((await card(page, label).count()) === 1, "Save address: the page says it was saved and lists it");

  await page.evaluate(() => document.querySelector("#add-form input[name=city]")?.removeAttribute("required"));
  await save(page, `${label} refused`, { city: "" });
  await page.getByText("City is required.").waitFor();
  const invalid = await add(page).locator("input[name=city]").getAttribute("aria-invalid");
  check(invalid === "true", "a city sent empty is the form again with the API's words next to it");

  const mine = card(page, label);
  await mine.getByRole("button", { name: "Update address" }).click();
  const dialog = mine.locator("dialog").first();
  const modal = await dialog.evaluate((d) => d.matches(":modal"));
  check(modal, "Update address opens its dialog, modal");
  await dialog.getByLabel("Label").fill(`${label} updated`);
  await dialog.getByRole("button", { name: "Update address" }).click();
  await page.getByText("Your change was saved").waitFor();
  await until(page, `${label} updated`);
  check((await card(page, `${label} updated`).count()) === 1, "Update address saves the new label");

  const updated = card(page, `${label} updated`);
  await updated.getByRole("button", { name: "Set default" }).click();
  await page.waitForFunction(
    (l) =>
      [...document.querySelectorAll("main li")].some(
        (li) => li.innerText.includes(l) && li.innerText.includes("Default"),
      ),
    `${label} updated`,
    { timeout: 30_000 },
  );
  const defaults = (await list()).filter((a) => a.is_default).map((a) => a.label);
  check(
    defaults.length === 1 && defaults[0] === `${label} updated`,
    `Set default moves the Default badge (${defaults.join(", ")})`,
  );

  await card(page, `${label} updated`).getByRole("button", { name: "Archive" }).click();
  const confirm = card(page, `${label} updated`).locator("dialog").nth(1);
  await confirm.getByRole("button", { name: "Archive" }).click();
  await until(page, `${label} updated`, false);
  check(!(await main(page)).includes(`${label} updated`), "Archive asks in its dialog, then the address is gone");
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  const label = `Pilot smoke ${stamp} plain`;
  await page.goto(`${base}/account/shipping-addresses`);
  await save(page, label);
  await page.waitForURL(/saved=/);
  // A list the API has not caught up with refreshes itself (`ReadAgain`'s meta refresh).
  const found = await settle(page, label, true);
  check(found, "without JavaScript, Save address loads the page with the address");
  await card(page, label).getByRole("button", { name: "Archive" }).click();
  await card(page, label).locator("dialog").nth(1).getByRole("button", { name: "Archive" }).click();
  await page.waitForURL(/saved=/);
  const gone = await settle(page, label, false);
  check(gone, "without JavaScript, Archive asks in its dialog and the address is gone");
  await ctx.close();
}

// The collector's default, as it was.
if (formerDefault) {
  const res = await fetch(`${book}/${formerDefault}/default`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: "{}",
  });
  check(res.ok, `the collector's default is ${formerDefault} again (${res.status})`);
}

await browser.close();
console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
