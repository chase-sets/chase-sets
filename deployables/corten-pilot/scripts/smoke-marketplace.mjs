// Uses the storage-locations pilot in a browser as marketplace's seed seller, with JavaScript and
// without it, against the real platform API: the pilot's own check, create, save, a write whose
// answer is lost (confirmed from the browser's record on the next page), a record for a write that
// was never sent (uncertain: writes off until it is discarded), and archive. It writes to the dev
// sandbox's data.
// Usage: node scripts/smoke-marketplace.mjs [pilot-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

const [base = "http://localhost:7792", stateFile = "../../artifacts/corten-pilot/marketplace-state.json"] =
  process.argv.slice(2);
const list = `${base}/account/inventory/locations`;
const stamp = Date.now().toString(36);
const text = {
  ready: "Inventory changes are ready.",
  confirmed: "The original Inventory change is confirmed.",
  uncertain:
    "The Inventory result is uncertain. Check the original result or contact support before making another change.",
  pending: "Storage locations are still updating",
};
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

// After a write the page waits for the write's projection, and says the list is still updating
// when the API's wait runs out. Do what it asks.
let pending = 0;
async function settled(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
  const start = Date.now();
  while ((await page.getByText(text.pending).count()) && Date.now() - start < 90_000) {
    pending += 1;
    await page.waitForTimeout(2_000);
    await page.reload();
  }
}

const status = (page) => page.locator('[role="status"]').first().textContent();
const card = (page, name) =>
  page.locator("li", { has: page.locator(".location-card__name", { hasText: new RegExp(`^${name}$`) }) });

/** Fills a location form's required fields. */
async function fill(form, name, code) {
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Ship-from code").fill(code);
  await form.getByLabel("Ship-from name").fill("Smoke Seller");
  await form.getByLabel("Ship-from line 1").fill("1 Smoke Way");
  await form.getByLabel("Ship-from city").fill("Austin");
  await form.getByLabel("Ship-from state").fill("TX");
  await form.getByLabel("Ship-from postal code").fill("78701");
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
  check((await page.locator("h1").textContent()) === "Storage Locations", "the list renders in the shell");
  check((await status(page)) === text.ready, "nothing to confirm on a fresh page");

  const create = page.locator("#create-form");
  await fill(create, `Smoke ${stamp}`, `SMK-${stamp}`);
  await create.getByLabel("Ship-from city").fill("   ");
  await create.getByRole("button", { name: "Create location" }).click();
  await page.locator("#create-form-ship_from_city-error").waitFor();
  check(
    (await page.locator("#create-form-ship_from_city-error").textContent()) === "Enter a value.",
    "the pilot's check names its field, patched in",
  );
  check(page.url() === list, "a refusal does not navigate");
  check(
    (await create.getByLabel("Name", { exact: true }).inputValue()) === `Smoke ${stamp}`,
    "typed values survive the patch",
  );

  await create.getByLabel("Ship-from city").fill("Austin");
  await create.getByRole("button", { name: "Create location" }).click();
  await page.waitForURL(/attempt=/);
  await settled(page);
  check((await status(page)) === text.confirmed, "create redirects and the list confirms the attempt");
  check(
    (await card(page, `Smoke ${stamp}`).count()) === 1,
    "the new location is listed on the same read (read after write)",
  );
  const left = await page.evaluate(() =>
    Object.keys(sessionStorage).filter((k) => k.startsWith("inventory-mutation/v1:")),
  );
  check(left.length === 0, `the confirmed attempt is forgotten${left.length ? `: ${left}` : ""}`);

  const saved = card(page, `Smoke ${stamp}`).locator("form").first();
  await saved.getByLabel("Name", { exact: true }).fill(`Smoke ${stamp} saved`);
  await saved.getByRole("button", { name: "Save location" }).click();
  await page.waitForURL(/family=location-update/);
  await settled(page);
  check((await card(page, `Smoke ${stamp} saved`).count()) === 1, "a save shows after the redirect");

  // The answer to a save is lost: the API applies it, the browser never hears back.
  const lost = card(page, `Smoke ${stamp} saved`).locator("form").first();
  await lost.getByLabel("Description").fill(`lost answer ${stamp}`);
  let sent = 0;
  await page.route("**/account/inventory/locations/*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent += 1;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await lost.getByRole("button", { name: "Save location" }).click();
  await page.waitForTimeout(1_500);
  await page.unroute("**/account/inventory/locations/*");
  check(sent >= 1, `the save reached the API (${sent} sent)`);
  const kept = await page.evaluate(() =>
    sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.endsWith(":location-update")) ?? ""),
  );
  check(kept !== null, "the browser kept the write's record");
  await page.goto(list);
  await page.waitForURL(/attempt=/);
  await settled(page);
  check((await status(page)) === text.confirmed, "the next page checks the record and confirms the write applied");
  check(
    (await card(page, `Smoke ${stamp} saved`).getByText(`lost answer ${stamp}`).count()) >= 1,
    "the lost save is in the list, applied once",
  );

  // A record for a write that never reached the API: its result cannot be known.
  const remember = await page.locator("#create-form").getAttribute("data-on");
  const [, account, user] = remember.match(/remember\(\$e,"([^"]*)","([^"]*)"/) ?? [];
  const id = (await card(page, `Smoke ${stamp} saved`).locator("form").first().getAttribute("id")).replace(
    /^location-form-/,
    "",
  );
  await page.evaluate(
    ({ account, user, id, attempt }) =>
      sessionStorage.setItem(
        `inventory-mutation/v1:${encodeURIComponent(account)}:location-update`,
        JSON.stringify({
          version: 1,
          attemptId: attempt,
          accountId: account,
          actorUserId: user,
          family: "location-update",
          targetId: id,
          createdAt: new Date().toISOString(),
        }),
      ),
    { account, user, id, attempt: randomUUID() },
  );
  await page.goto(list);
  await page.waitForURL(/attempt=/);
  await settled(page);
  check((await status(page)) === text.uncertain, "an unknown attempt is uncertain");
  const createButton = page.locator("#create-form").getByRole("button", { name: "Create location" });
  check(await createButton.isDisabled(), "writes are off while it is uncertain");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Discard recovery metadata" }).click();
  await page.waitForURL((u) => !u.searchParams.has("attempt"));
  await settled(page);
  check(
    (await status(page)) === text.ready && (await createButton.isEnabled()),
    "discarding the record turns writes back on",
  );

  await card(page, `Smoke ${stamp} saved`).getByRole("button", { name: "Archive location" }).click();
  await page.waitForURL(/family=location-archive/);
  await settled(page);
  check(
    (await card(page, `Smoke ${stamp} saved`).locator(".location-card__pill").textContent()) === "Archived",
    "archive shows the location archived",
  );

  // The browser logs every 4xx and 5xx answer: the pilot's refusal (422) and the lost answer are expected.
  const real = problems.filter(
    (p) => !p.includes("status of 422") && !/ERR_CONNECTION_RESET|Failed to fetch|NetworkError/.test(p),
  );
  check(real.length === 0, `no console errors${real.length ? `: ${real.join(" | ")}` : ""}`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(list);
  check((await page.locator("h1").textContent()) === "Storage Locations", "the list renders without JavaScript");
  const create = page.locator("#create-form");
  await fill(create, `Smoke ${stamp} plain`, `SMP-${stamp}`);
  await create.getByLabel("Ship-from state").fill(" ");
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    create.getByRole("button", { name: "Create location" }).click(),
  ]);
  check(refused.status() === 422, "a refused post answers 422 with the whole page");
  check(
    (await page.locator("#create-form-ship_from_state-error").textContent()) === "Enter a value.",
    "with the field's message",
  );
  await page.locator("#create-form").getByLabel("Ship-from state").fill("TX");
  await page.locator("#create-form").getByRole("button", { name: "Create location" }).click();
  await page.waitForURL(/attempt=/);
  await settled(page);
  check(
    (await status(page)) === text.confirmed,
    "a post redirects and the server confirms the attempt without a script",
  );
  await card(page, `Smoke ${stamp} plain`).getByRole("button", { name: "Archive location" }).click();
  await page.waitForURL(/family=location-archive/);
  await settled(page);
  check(
    (await card(page, `Smoke ${stamp} plain`).locator(".location-card__pill").textContent()) === "Archived",
    "archive works without JavaScript",
  );
  await ctx.close();
}

await browser.close();
console.log(`${failures ? `${failures} failed` : "all passed"}; ${pending} "still updating" answers refreshed`);
process.exit(failures ? 1 : 0);
