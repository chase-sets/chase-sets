// Uses the buy checkout pilot in a browser as marketplace's seed collector, against the real
// platform API, on a buy-now session the collector started (Buy this listing on the Lugia):
// - With JavaScript and without it: the page answers 200 with the session's lines; the payable
//   total and the checkout fee are Payments' quote for what the form sends (read from the API
//   with the same amount, credit and method); Update totals writes the saved address and the
//   shipping option to the session (read back from the API) and comes back after its receipt.
// - With JavaScript: Update totals is offered once a choice changes (the shipping option, which
//   is written; the next run changes it back), and the page says the totals need a refresh.
// - At 390 px one column, nothing scrolls sideways, the bottom bar holds Pay now, every control
//   is at least 44 px tall; at 1280 px the summary sits beside the form.
// It never presses Pay now: in the sandbox that reserves the Lugia listing the other smokes use and
// starts a payment. It writes the session's review (its address, shipping and the opt-in).
// Usage: node scripts/smoke-market-checkout.mjs [pilot-url] [session-id] [state] [api-url]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  id = "chk_80da81ad06e8b158cbf368daa0c2c7ca",
  stateFile = "../../artifacts/corten-pilot/collector-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const screen = `${base}/checkout/buy/session/${id}`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

const money = (amount) =>
  `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const field = (page, name) => page.locator(`#checkout-form [name="${name}"]`).first().inputValue();
const session = async (page) =>
  (
    await page.request.get(`${api}/api/marketplace/account/checkout-sessions/${id}`, {
      headers: { "chase-sets-read-target-context": "checkout" },
    })
  ).json();

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems } = await context(javaScriptEnabled);
  const answer = await page.goto(screen);
  check(answer?.status() === 200, `${label}: the page answers 200 (${answer?.status()})`);
  if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent())?.trim() === "Checkout", `${label}: the page renders in the shell`);
  const before = await session(page);
  const lines = before.lines ?? [];
  const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check(
    lines.length > 0 && lines.every((l) => main.includes(l.itemTitle)),
    `${label}: the session's lines (${lines.map((l) => l.itemTitle).join(", ")})`,
  );

  // The total is Payments' quote for what the form sends.
  const amount = before.fulfillment_preview_snapshot?.totals?.totalAmount;
  const credit = await field(page, "requestedBalanceCreditAmount");
  const method = await field(page, "paymentMethodCategory");
  const query = new URLSearchParams({
    amount,
    currencyCode: "usd",
    requestedBalanceCreditAmount: credit,
    paymentMethodCategory: method,
  });
  const quote = await (
    await page.request.get(`${api}/api/marketplace/account/checkout/preview-status?${query}`)
  ).json();
  const fee = quote.marketplace_checkout_fee ?? {};
  check(
    Boolean(quote.marketplace_checkout_fee),
    `${label}: Payments quotes what the form sends (${query}: ${JSON.stringify(quote).slice(0, 200)})`,
  );
  check(
    main.includes(`Checkout service fee ${money(fee.marketplace_checkout_fee_amount)}`),
    `${label}: the fee is Payments' quote (${fee.marketplace_checkout_fee_amount} by ${method})`,
  );
  check(
    main.includes(`Payable total ${money(fee.total_amount)}`),
    `${label}: the payable total is Payments' (${fee.total_amount})`,
  );
  check(
    (await field(page, "marketplaceCheckoutFeeQuoteFingerprint")) === fee.quote_fingerprint,
    `${label}: the form carries the quote's fingerprint`,
  );

  // Update totals: the address and shipping written to the session, the page read after them.
  // With a script it is offered once a choice changes (the totals are then stale): shipping is
  // opened for editing and set to the other option, then back to standard on the next run.
  if (javaScriptEnabled) {
    check(
      !(await page.locator('#checkout-form button[value="refresh-checkout-preview"]').first().isVisible()),
      `${label}: Update totals waits for a change`,
    );
    await page.goto(`${screen}?edit=shipping`);
    await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
    const current = before.shipping_option ?? "standard";
    const choice = page.locator('#checkout-form select[name="shippingOption"]');
    const next = await choice.evaluate(
      (s, current) => [...s.options].map((o) => o.value).find((v) => v !== current),
      current,
    );
    await choice.selectOption(next);
    await page
      .locator("[data-checkout][data-stale]")
      .waitFor({ timeout: 5_000 })
      .catch(() => null);
    check(
      (await page.locator("[data-checkout][data-stale]").count()) === 1,
      `${label}: a changed choice marks the totals stale`,
    );
    check(
      await page.getByText("Totals need refresh").first().isVisible(),
      `${label}: and says the totals need a refresh`,
    );
  } else {
    check(
      await page.locator('#checkout-form button[value="refresh-checkout-preview"]').first().isVisible(),
      `${label}: Update totals is offered`,
    );
  }
  const postal = await field(page, "shippingPostalCode");
  const option = await page.locator('#checkout-form [name="shippingOption"]').last().inputValue();
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(screen), {
    timeout: 30_000,
  });
  await page
    .locator('#checkout-form button[value="refresh-checkout-preview"]')
    .filter({ visible: true })
    .first()
    .click();
  const wrote = await posted.catch(() => null);
  check(
    Boolean(wrote) && [204, 303].includes(wrote.status()),
    `${label}: Update totals posts to the pilot (${wrote?.status()})`,
  );
  await page.waitForURL(/afterWrite=/, { timeout: 30_000 }).catch(() => null);
  check(page.url().includes("afterWrite="), `${label}: and comes back after its receipt`);
  // While the API catches up with the write, the page says it is preparing and reads itself again.
  const preparing = await page.locator('[data-recovery="Preparing"]').count();
  await page
    .locator("[data-checkout]")
    .waitFor({ timeout: 45_000 })
    .catch(() => null);
  check(
    (await page.locator("[data-checkout]").count()) === 1,
    `${label}: the checkout opens once the API has the write${preparing ? " (it said it was preparing first)" : ""}`,
  );
  const sent = new URLSearchParams(wrote?.request().postData() ?? "");
  check(
    sent.get("shippingOption") === option,
    `${label}: the form sent shipping ${sent.get("shippingOption")} (${option} on screen)`,
  );
  // The API's own read is not read after the write; give its projection a moment.
  let after = await session(page);
  for (let i = 0; i < 10 && after.shipping_option !== option; i++) {
    await page.waitForTimeout(500);
    after = await session(page);
  }
  check(
    after.shipping_address?.postalCode === postal && after.shipping_option === option,
    `${label}: the session has the address (${after.shipping_address?.postalCode}) and shipping (${after.shipping_option})`,
  );
  const shown = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const label2 = option === "standard" ? "Standard insured" : option === "expedited" ? "Expedited" : "Priority";
  check(
    shown.includes(label2),
    `${label}: the page read after the write shows ${label2}${shown.includes(label2) ? "" : `: ${shown.slice(0, 600)}`}`,
  );
  check((await page.locator("[data-checkout-error]").count()) === 0, `${label}: no refusal on the page`);

  check(problems.length === 0, `${label}: no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Layout.
for (const [width, height] of [
  [1280, 900],
  [390, 844],
]) {
  const { ctx, page, problems } = await context(true, { width, height });
  await page.goto(screen);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const layout = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll(
      "main a, main button, main select, main input:not([type=hidden]), main summary",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const target = el.matches("input[type=checkbox], input[type=radio]") ? (el.closest("label") ?? el) : el;
      const h = target.getBoundingClientRect().height;
      if (h < 44)
        small.push(
          `${el.tagName} ${(el.textContent || el.getAttribute("name") || "").trim().slice(0, 30)} ${Math.round(h)}`,
        );
    }
    const visible = (sel) =>
      [...document.querySelectorAll(sel)].some(
        (e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== "none",
      );
    const form = document.querySelector("#checkout-form")?.getBoundingClientRect();
    const aside = [...document.querySelectorAll("aside")]
      .find((a) => getComputedStyle(a).display !== "none")
      ?.getBoundingClientRect();
    const bar = [...document.querySelectorAll('button[form="checkout-form"][value="confirm-checkout"]')].find(
      (b) => b.getBoundingClientRect().height > 0,
    );
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small,
      beside: Boolean(form && aside && aside.left >= form.right - 1),
      barOnScreen: Boolean(
        bar &&
        bar.getBoundingClientRect().bottom <= innerHeight &&
        getComputedStyle(bar.closest("div,section,footer") ?? bar).position !== "static",
      ),
      summaryDetails: visible("details"),
    };
  });
  check(layout.overflow <= 0, `${width} px: nothing scrolls sideways (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `${width} px: every control is at least 44 px tall${layout.small.length ? `: ${layout.small.join("; ")}` : ""}`,
  );
  if (width >= 1024) {
    check(layout.beside, `${width} px: the summary sits beside the form`);
  } else {
    check(!layout.beside && layout.summaryDetails, `${width} px: one column, the summary folded above the form`);
    check(layout.barOnScreen, `${width} px: Pay now is in the bar at the bottom of the screen`);
  }
  check(problems.length === 0, `${width} px: no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
