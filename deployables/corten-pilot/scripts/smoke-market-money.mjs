// Reads the Seller Desk money page pilot in a browser as marketplace's seed seller, with JavaScript
// and without it, against the real platform API, and compares it with Settlement's own answers and
// with marketplace's page: the wallet's balance, the blocked payouts (Settlement's answer with the
// payouts), one row per payout and per wallet movement in the API's order, and
// Request a payout off while payout setup is unfinished. It previews a typed $5.00 (a preview writes
// nothing) and checks Settlement's reasons and Confirm off; opens a payout's breakdown and closes it
// with Escape; and asks for an adjustment the account does not have. Then the page at 390 px.
// It never confirms a payout or runs a status check.
// Usage: node scripts/smoke-market-money.mjs [pilot-url] [state-file] [marketplace-url] [api-url]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  stateFile = "../../artifacts/corten-pilot/marketplace-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const money = `${base}/account/desk/money`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport) {
  const ctx = await browser.newContext({
    storageState: stateFile,
    javaScriptEnabled,
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** What Settlement answers the seller. */
async function settlement(page, path) {
  const answer = await page.request.get(`${api}/api/settlement${path}`);
  return answer.ok() ? answer.json() : null;
}

const usd = (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems } = await context(javaScriptEnabled);
  const answer = await page.goto(money);
  check(answer?.status() === 200, `${label}: the page answers 200 (${answer?.status()})`);
  if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent())?.trim() === "Money", `${label}: the page renders in the shell`);
  const wallet = await settlement(page, "/wallet");
  const summary = await settlement(page, "/payouts");
  const payouts = summary?.items ?? [];
  const entries = (await settlement(page, "/wallet/entries"))?.items ?? [];
  const figures = await page.locator("dl dd").allTextContents();
  check(
    figures[0]?.trim() === usd(wallet.available_balance_amount),
    `${label}: the balance is Settlement's (${figures[0]})`,
  );
  check(figures[1]?.includes(usd(wallet.pending_balance_amount)), `${label}: and what is pending (${figures[1]})`);
  const settled = (summary?.blocked_payouts ?? []).map((p) => p.payout_id);
  const blocked = await page
    .locator("[data-blocked-payout]")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-blocked-payout")));
  check(
    JSON.stringify(blocked) === JSON.stringify(settled),
    `${label}: the blocked payouts, as Settlement answers them (${blocked.join(", ") || "none"})`,
  );
  const rows = await page
    .locator("[data-payout]")
    .evaluateAll((items) => items.map((i) => i.getAttribute("data-payout")));
  check(
    JSON.stringify(rows) === JSON.stringify(payouts.map((p) => p.payout_id)),
    `${label}: a row per payout, in the API's order (${rows.length})`,
  );
  const activity = await page
    .getByRole("heading", { name: "Wallet activity" })
    .locator("xpath=..")
    .locator("li")
    .count();
  check(
    activity === Math.max(entries.length, 0),
    `${label}: a row per wallet movement (${activity} of ${entries.length})`,
  );
  const ready = summary?.availability?.can_request === true;
  const preview = page.getByRole("button", { name: "Preview payout" });
  check(
    (await preview.isDisabled()) === !ready,
    `${label}: Request a payout is ${ready ? "on" : "off while payout setup is unfinished"}`,
  );
  if (!ready) {
    check((await page.getByText("Why this payout is unavailable").count()) > 0, `${label}: and says why`);
    check(
      (await page.getByText("Finish payout setup", { exact: true }).count()) > 0,
      `${label}: payout setup needs attention`,
    );
  }
  check(problems.length === 0, `${label}: no console errors (${problems.join(" | ")})`);

  // Marketplace's page says the same.
  if (javaScriptEnabled) {
    const theirs = await ctx.newPage();
    await theirs.goto(`${web}/account/desk/money`, { waitUntil: "networkidle", timeout: 120_000 });
    const text = (await theirs.locator("main").innerText()).replace(/\s+/g, " ");
    check(text.includes(usd(wallet.available_balance_amount)), "marketplace's page shows the same balance");
    const count = blocked.length === 1 ? "1 payout needs attention" : `${blocked.length} payouts need attention`;
    check(text.includes(count), `marketplace's page counts the same blocked payouts (${count})`);
    await theirs.close();
  }
  await ctx.close();
}

// A preview of a typed amount, as a form post (the button is off while setup is unfinished): it
// writes nothing, and Settlement's reasons and Confirm off come back.
{
  const { ctx, page, problems } = await context(false);
  await page.goto(money);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/account/desk/money";
    for (const [name, value] of [
      ["intent", "preview-payout"],
      ["amount", "$5.00"],
    ]) {
      const input = Object.assign(document.createElement("input"), { type: "hidden", name, value });
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  });
  await page.waitForLoadState("load");
  const body = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check(body.includes("Confirm payout") && body.includes("$5.00"), "a typed $5.00 is previewed");
  const confirm = page.getByRole("button", { name: "Confirm payout" });
  const allowed = (await page.locator('input[name="amount"][value="5.00"]').count()) > 0;
  check(allowed, "Confirm would send 5.00, as Settlement takes it");
  const reasons = body.includes("Why this payout is unavailable");
  check((await confirm.isDisabled()) === reasons, `Confirm is ${reasons ? "off, with Settlement's reasons" : "on"}`);
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// A payout's breakdown opens without a script's help and closes with Escape; an adjustment the
// account does not have is the page without it.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(money);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const first = page.locator("[data-payout]").first();
  if ((await first.count()) > 0) {
    await first.getByRole("button", { name: "View breakdown" }).click();
    const dialog = first.locator("dialog");
    check(await dialog.isVisible(), "View breakdown opens the payout's breakdown");
    check((await dialog.innerText()).includes("Net payout"), "with what reaches the seller");
    await page.keyboard.press("Escape");
    check(!(await dialog.isVisible()), "Escape closes it");
  }
  const answer = await page.goto(`${money}?drawer=wallet-adjustment&entity=WADJ-NOT-THERE`);
  check(
    answer?.status() === 200 && (await page.locator("dialog[open]").count()) === 0,
    "an adjustment the account has not is the page without it",
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// A phone.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(money);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const columns = await page
    .locator("main dl")
    .first()
    .evaluate((dl) => getComputedStyle(dl).gridTemplateColumns.split(" ").length);
  check(columns === 1, `the figures stack on a phone (${columns} column)`);
  const small = await page
    .locator("main a, main button, main input:not([type=hidden]), main summary")
    .evaluateAll((controls) =>
      controls
        .filter((c) => c.getClientRects().length > 0 && c.getBoundingClientRect().height < 40)
        .map((c) => c.textContent?.trim() || c.getAttribute("name")),
    );
  check(small.length === 0, `every control is at least 40 px tall (${small.join(", ") || "all"})`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/money-390.png", fullPage: true });
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}
{
  const { ctx, page } = await context(true, { width: 1280, height: 900 });
  await page.goto(money);
  await page.screenshot({ path: "../../artifacts/corten-pilot/money-1280.png", fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
