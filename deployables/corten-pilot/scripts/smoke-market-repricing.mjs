// Reads and writes the Seller Desk's repricing page pilot in a browser as marketplace's seed seller,
// with JavaScript and without it, against the real platform API: the policies against the API's
// list, the halt against the API's (engaged through its confirmation and released again), and the
// editor: Create opens it at its address, the account's currency and floor are filled in, Preview
// starts a dry run of the compiled preset, the result arrives (relayed live with JavaScript, read
// again without it) with the API's counts, Activate is on for that run, and a changed setting
// turns it off and says why. It never activates a policy: an active policy would reprice the
// sandbox's listings. The dry runs it starts stay unused. Then the editor at 390 px.
// Usage: node scripts/smoke-market-repricing.mjs [pilot-url] [state-file] [api-url]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  stateFile = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const screen = `${base}/account/desk/repricing`;
const policies = `${api}/api/marketplace/account/repricing-policies`;
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
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

async function hydrated(page, javaScriptEnabled) {
  if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
}

/** The dry run's part once it finished: relayed with JavaScript, read again without it. */
async function finished(page, javaScriptEnabled) {
  const done = page.locator('[data-repricing-run="completed"], [data-repricing-run="failed"]');
  if (javaScriptEnabled) {
    await done.waitFor();
    return;
  }
  for (let i = 0; i < 10 && (await done.count()) === 0; i++) {
    await page.waitForTimeout(1000);
    await page.reload();
  }
}

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems } = await context(javaScriptEnabled);
  const answer = await page.goto(screen);
  check(answer?.status() === 200, `${label}: the page answers 200 (${answer?.status()})`);
  await hydrated(page, javaScriptEnabled);
  check(
    (await page.locator("h1").textContent())?.trim() === "Repricing policies",
    `${label}: the page renders in the shell`,
  );
  const list = await (await page.request.get(policies)).json();
  const rows = await page.locator("[data-repricing-policy]").count();
  const empty = await page.locator('[data-repricing-policies-empty="true"]').count();
  check(
    list.length === 0 ? empty === 1 : rows === list.length,
    `${label}: the API's policies (${list.length}), each a row (${rows}) or the empty state`,
  );

  // The halt: engaged through its confirmation, then released the same way.
  const halt = await (await page.request.get(`${policies}/halt`)).json();
  const banner = page.locator("[data-repricing-halt]");
  check(
    (await banner.getAttribute("data-repricing-halt")) === (halt.engaged ? "engaged" : "released"),
    `${label}: the halt is the API's (${halt.engaged})`,
  );
  if (javaScriptEnabled && !halt.engaged) {
    await page.getByRole("switch", { name: "Halt all repricing" }).click();
    const dialog = page.getByRole("dialog", { name: "Halt all repricing?" });
    check(await dialog.isVisible(), `${label}: the switch asks first`);
    await Promise.all([page.waitForURL(screen), dialog.getByRole("button", { name: "Halt repricing" }).click()]);
    await page.locator('[data-repricing-halt="engaged"]').waitFor();
    check(
      (await (await page.request.get(`${policies}/halt`)).json()).engaged === true,
      `${label}: the halt is engaged`,
    );
    check((await page.getByText("Repricing is halted").count()) === 1, `${label}: the page says repricing is halted`);
    await page.getByRole("switch", { name: "Halt all repricing" }).click();
    await Promise.all([
      page.waitForURL(screen),
      page.getByRole("dialog").getByRole("button", { name: "Release halt" }).click(),
    ]);
    await page.locator('[data-repricing-halt="released"]').waitFor();
    check(
      (await (await page.request.get(`${policies}/halt`)).json()).engaged === false,
      `${label}: the halt is released again`,
    );
  }

  // The editor: Create opens it at its address with the account's currency and floor.
  await page.getByRole("link", { name: "Create repricing policy" }).click();
  await page.waitForURL(/create=1/);
  await hydrated(page, javaScriptEnabled);
  const prerequisites = await (await page.request.get(`${policies}/authoring-prerequisites`)).json();
  const currency = await page.locator('select[name="currency"], input[name="currency"]').inputValue();
  const one = prerequisites.listingCurrencyCodes.length === 1 ? prerequisites.listingCurrencyCodes[0] : "";
  check(currency === one, `${label}: the currency is the account's one (${currency})`);
  const floor = await page.locator('select[name="floor"]').inputValue();
  check(
    floor === (prerequisites.hasCostBasis ? "cost-basis-plus-margin" : "absolute"),
    `${label}: the floor starts from the cost basis (${floor})`,
  );
  const scope = await page.request.post(`${policies}/scope-preview`, {
    data: { scope: { kind: "all-listings" }, excludedListingIds: [] },
  });
  const matching = (await scope.json()).matching;
  check(
    (await page.locator('[data-repricing-scope="true"] dd').first().textContent())?.trim() === String(matching),
    `${label}: the scope matches the API's ${matching}`,
  );

  // A strategy chosen applies at once with a script, and by Apply without one. With a script the
  // GET swaps the page in place: the window that chose it is still there.
  if (javaScriptEnabled)
    await page.evaluate(() => {
      /** @type {any} */ (window).__smokeSameWindow = true;
    });
  await page.locator('select[name="preset"]').selectOption("beat-lowest");
  if (!javaScriptEnabled) await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/preset=beat-lowest/);
  // The runtime moves to the address before it swaps the page in: wait for the new page.
  await page.locator('input[name="from"][value="beat-lowest"]').waitFor({ state: "attached" });
  await hydrated(page, javaScriptEnabled);
  check(
    (await page.locator('input[name="name"]').inputValue()) === "Beat the lowest listing",
    `${label}: a new strategy brings its name`,
  );
  if (javaScriptEnabled) {
    check(
      await page.evaluate(() => /** @type {any} */ (window).__smokeSameWindow === true),
      `${label}: and applies in place, without loading the page`,
    );
  }
  check((await page.locator('input[name="knob"]').inputValue()) === "2", `${label}: and its undercut`);
  const amount = page.locator('input[name="fallback"], input[name="amount"]');
  await amount.fill("1.00");
  await page.getByRole("button", { name: "Preview policy" }).click();
  await page.waitForURL(/dryRun=/);
  await page.locator("[data-repricing-run]").waitFor({ state: "attached" });
  await hydrated(page, javaScriptEnabled);
  const id = new URL(page.url()).searchParams.get("dryRun");
  await finished(page, javaScriptEnabled);
  const run = await (await page.request.get(`${policies}/dry-runs/${encodeURIComponent(id)}`)).json();
  check(run.status === "completed", `${label}: the dry run completed (${run.status})`);
  check(
    run.body.rules[0].directive.offset.percent === -2 &&
      run.body.rules[0].directive.anchorChain[0].source === "lowest-competing-ask",
    `${label}: the API ran the compiled preset`,
  );
  const changed = await page.locator('[data-repricing-changed="true"]').textContent();
  check(
    changed?.trim() === String(run.summary?.outcomes?.changed ?? 0),
    `${label}: the changed count is the API's (${changed})`,
  );
  check(await page.locator('[data-repricing-activate="true"]').isEnabled(), `${label}: Activate is on for this run`);

  // A setting changed after the preview: the run no longer previews it.
  await page.locator('input[name="knob"]').fill("3");
  if (javaScriptEnabled) await page.locator('input[name="knob"]').dispatchEvent("change");
  else await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/knob=3/);
  await page
    .locator('[data-repricing-stale="true"]')
    .waitFor({ state: "attached" })
    .catch(() => {});
  await hydrated(page, javaScriptEnabled);
  check(
    (await page.locator('[data-repricing-stale="true"]').count()) === 1,
    `${label}: the page says the settings changed since the preview`,
  );
  check(await page.locator('[data-repricing-activate="true"]').isDisabled(), `${label}: and Activate is off`);
  check(problems.length === 0, `${label}: no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// A phone, the editor with a result.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${screen}?create=1`);
  await hydrated(page, true);
  await page.locator('input[name="fallback"], input[name="amount"]').fill("1.00");
  await page.getByRole("button", { name: "Preview policy" }).click();
  await page.waitForURL(/dryRun=/);
  await page.locator("[data-repricing-run]").waitFor({ state: "attached" });
  await finished(page, true);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const columns = await page
    .locator("[data-repricing-editor] > div:last-child")
    .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  check(columns === 1, `the editor is one column on a phone (${columns})`);
  const headers = await page
    .locator("table thead")
    .evaluateAll((heads) => heads.filter((h) => h.getBoundingClientRect().height > 1).length);
  check(headers === 0, `each table is a card per row (${headers} header rows shown)`);
  const small = await page
    .locator("main a, main button, main select, main input:not([type=checkbox]):not([type=hidden])")
    .evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 44)
        .map((el) => el.textContent?.trim() || el.getAttribute("name")),
    );
  check(small.length === 0, `every control is at least 44 px tall (${small.join(", ") || "all"})`);
  const weak = await page.locator("main a, main button").evaluateAll((els) => {
    const rgb = (value) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]) =>
      [r, g, b]
        .map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    return els
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => ({ text: el.textContent?.trim(), style: getComputedStyle(el) }))
      .filter(({ style }) => (rgb(style.backgroundColor)[3] ?? 1) > 0 && style.backgroundColor !== "rgba(0, 0, 0, 0)")
      .map(({ text, style }) => {
        const [a, b] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))].sort((x, y) => y - x);
        return { text, ratio: (a + 0.05) / (b + 0.05) };
      })
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ text, ratio }) => `${text} ${ratio.toFixed(2)}:1`);
  });
  check(
    weak.length === 0,
    `every button's text is readable on its background (${weak.join(", ") || "all at least 4.5:1"})`,
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
