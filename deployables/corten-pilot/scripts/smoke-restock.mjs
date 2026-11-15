// Uses the restock decisions pilot in a browser as marketplace's seed seller, with JavaScript and
// without it, against the real platform API: the pending decisions as the API lists them, a
// decision sent for a stale version (the API refuses it; the form comes back at the current
// version), a record for a write that was never sent (uncertain: writes off until it is
// discarded), and the page at 390 px. It records no decision: the sandbox has one pending decision
// (the seed's returned shipment), which a restock or write-off would use up. The router tests
// check an applied decision against a stand-in API. Today the API refuses every decision on the
// seeded one ("Restock decision not found."), so the stale-version
// steps check the refusal the API sends, whichever it is.
// Usage: node scripts/smoke-restock.mjs [pilot-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

const [base = "http://localhost:7792", stateFile = "../../artifacts/corten-pilot/marketplace-state.json"] =
  process.argv.slice(2);
const list = `${base}/account/inventory/restock-decisions`;
const text = {
  ready: "Inventory changes are ready.",
  uncertain:
    "The Inventory result is uncertain. Check the original result or contact support before making another change.",
};
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const status = (page) => page.locator('[role="status"]').first().textContent();
/** After a navigation: Corten swaps the page in after the URL changes. */
async function settled(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
}
const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport) {
  const ctx = await browser.newContext({
    storageState: stateFile,
    javaScriptEnabled,
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** The API's pending decisions, as the page's data client reads them. */
async function listed(page) {
  const answer = await page.request.get(list, { headers: { accept: "application/json" } });
  return (await answer.json()).data.decisions;
}

// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(list);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent()) === "Restock Decisions", "the page renders in the shell");
  check((await status(page)) === text.ready, "nothing to confirm on a fresh page");
  const decisions = await listed(page);
  const cards = page.locator("li[data-decision]");
  check(decisions.length > 0, `the API has pending decisions (${decisions.length})`);
  check(
    (await cards.evaluateAll((li) => li.map((l) => l.getAttribute("data-decision")))).join() ===
      decisions.map((d) => d.decision_id).join(),
    "one card per decision, in the API's order",
  );
  const first = decisions[0];
  const card = cards.first();
  const shown = await card.textContent();
  check(shown.includes(first.item_title ?? first.item_id), `the item (${first.item_title})`);
  check(
    /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC/.test(shown),
    `when, as marketplace writes it (${shown.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}[^U]*UTC/)?.[0]})`,
  );
  check(
    (await card.getByRole("link", { name: `View order ${first.order_id}` }).getAttribute("href"))?.endsWith(
      `/account/sales/${first.order_id}`,
    ) ?? false,
    "the order links to marketplace's sale",
  );

  // A decision sent for a version the API no longer has.
  const writeOff = card.locator('form[action$="/write-off"]');
  await writeOff.getByLabel("Damage note").fill("smoke: stale version");
  await writeOff.locator('input[name="expected_version"]').evaluate((input) => {
    input.value = "999";
  });
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    writeOff.getByRole("button", { name: "Write off" }).click(),
  ]);
  check(refused.status() === 422, `the API refuses it (${refused.status()})`);
  const message = card.locator('form[action$="/write-off"] .form-error');
  await message.waitFor();
  check(
    (await message.textContent()).length > 0,
    `with the API's message on the form ("${await message.textContent()}")`,
  );
  check(page.url() === list, "the refusal is patched in; the page does not navigate");
  check(
    (await card.locator('form[action$="/write-off"] input[name="expected_version"]').inputValue()) ===
      String(first.version),
    `the form comes back at the current version (${first.version})`,
  );
  check((await card.getByLabel("Damage note").inputValue()) === "smoke: stale version", "the note stays");
  check(
    (await listed(page)).some((d) => d.decision_id === first.decision_id),
    "the decision is still pending",
  );
  const left = await page.evaluate(() =>
    Object.keys(sessionStorage).filter((k) => k.startsWith("inventory-mutation/v1:")),
  );
  check(left.length === 0, `the refused attempt is forgotten${left.length ? `: ${left}` : ""}`);

  // A record for a write that never reached the API: its result cannot be known.
  const remember = await card.locator('form[action$="/restock"]').getAttribute("data-on");
  const [, account, user] = remember.match(/remember\(\$e,"([^"]*)","([^"]*)"/) ?? [];
  await page.evaluate(
    ({ account, user, id, attempt }) =>
      sessionStorage.setItem(
        `inventory-mutation/v1:${encodeURIComponent(account)}:restock-record`,
        JSON.stringify({
          version: 1,
          attemptId: attempt,
          accountId: account,
          actorUserId: user,
          family: "restock-record",
          targetId: id,
          createdAt: new Date().toISOString(),
        }),
      ),
    { account, user, id: first.decision_id, attempt: randomUUID() },
  );
  await page.goto(list);
  await page.waitForURL(/family=restock-record/);
  await settled(page);
  check((await status(page)) === text.uncertain, "an unknown restock attempt is uncertain");
  const restock = page.locator("li[data-decision]").first().getByRole("button", { name: "Restock" });
  check(await restock.isDisabled(), "writes are off while it is uncertain");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Discard recovery metadata" }).click();
  await page.waitForURL((u) => !u.searchParams.has("attempt"));
  await settled(page);
  const after = await status(page);
  check(
    after === text.ready && (await restock.isEnabled()),
    `discarding the record turns writes back on ("${after}", ${page.url()})`,
  );

  // The browser logs every 4xx and 5xx answer: the refusal (422) is expected.
  const real = problems.filter((p) => !p.includes("status of 422"));
  check(real.length === 0, `no console errors${real.length ? `: ${real.join(" | ")}` : ""}`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(list);
  check((await page.locator("h1").textContent()) === "Restock Decisions", "the page renders without JavaScript");
  const restock = page.locator("li[data-decision]").first().locator('form[action$="/restock"]');
  await restock.locator('input[name="expected_version"]').evaluate((input) => {
    input.value = "999";
  });
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    restock.getByRole("button", { name: "Restock" }).click(),
  ]);
  check(refused.status() === 422, "a refused post answers 422 with the whole page");
  check(
    (await page.locator('li[data-decision] form[action$="/restock"] .form-error').count()) === 1,
    "with the API's message on the form",
  );
  check((await page.locator("li[data-decision]").count()) > 0, "and the decisions");
  await ctx.close();
}

// A phone.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(list);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 0, `the page does not scroll sideways at 390 px (${over} px over)`);
  const stacked = await page
    .locator("li[data-decision]")
    .first()
    .evaluate((li) => {
      const [a, b] = [...li.querySelectorAll("form")].map((f) => f.getBoundingClientRect());
      return b.top >= a.bottom;
    });
  check(stacked, "the two forms stack");
  const outside = await page
    .locator("li[data-decision]")
    .first()
    .evaluate((li) => {
      const box = li.getBoundingClientRect();
      return [...li.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > box.right + 0.5)
        .map((el) => `<${el.localName} class="${el.className}">`);
    });
  check(
    outside.length === 0,
    `nothing in the card runs past its edge${outside.length ? `: ${outside.slice(0, 4).join(" ")}` : ""}`,
  );
  await page.screenshot({ path: "../../artifacts/corten-pilot/restock-390.png", fullPage: true });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
