// Uses the cart pilot in a browser as the auth seed's collector, with JavaScript and without it,
// against the real platform API, beside marketplace's own cart page: the lines, badges, prices and
// total the API returns, the lower-price offer, the checkout forms, and the page at 390 px. With
// --checkout it also sends Check out, which starts a checkout session (a write in the dev
// sandbox), and checks the browser is sent to marketplace's page for it and the API has it. The
// smoke does not load that page: with a saved card, marketplace's checkout starts the payment as
// it loads, which creates orders that hold the cart's listings until their payment deadline.
// With --write it steps a line's quantity up and back down, with JavaScript and without it, each a
// command attempt (a write in the dev sandbox, left as it was found), and checks the page and the API.
// Usage: node scripts/smoke-cart.mjs [pilot-url] [state-file] [marketplace-url] [api-url] [--checkout] [--write]
//   (state from `scripts/sign-in.mjs <pilot-url> <state-file> collector --api <api-url>`)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7792",
  stateFile = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const sendCheckout = process.argv.includes("--checkout");
const sendWrites = process.argv.includes("--write");
const cartUrl = `${base}/account/cart`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const money = (m) =>
  m
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(Number(m.amount))
    : "Priced at checkout";
const labels = {
  ready: "Ready",
  "unassigned-fulfillment": "Needs fulfillment",
  unavailable: "Unavailable",
  "waiting-for-supply": "Waiting for supply",
  changed: "Needs review",
  "shipping-measure-missing": "Shipping measure missing",
  "currency-mismatch": "Needs review",
};
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
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/** What the page shows: each line's id, title, badge, quantity and price, and the total. */
async function shown(page) {
  const lines = await page.locator("li[data-cart-line]").evaluateAll((items) =>
    items.map((li) => ({
      id: li.getAttribute("data-cart-line"),
      title: li.querySelector("p")?.textContent?.trim(),
      reason: li.querySelector("[data-reason]")?.textContent?.trim() ?? null,
      quantity: li.querySelector("[data-quantity]")?.textContent?.trim(),
      price: li.querySelector("[data-price]")?.textContent?.replace(/\s+/g, " ").trim(),
    })),
  );
  const total = (await page.locator("[data-total]").first().textContent())?.trim();
  return { lines, total };
}

// With JavaScript, beside the API's answer.
{
  const { ctx, page, problems } = await context(true);
  const answer = await page.request.get(`${api}/api/marketplace/account/cart`, {
    headers: { "chase-sets-read-target-context": "checkout" },
  });
  check(answer.ok(), `the API reads the collector's cart (${answer.status()})`);
  const cart = await answer.json();
  const response = await page.goto(cartUrl);
  check(response?.status() === 200, `the page answers (${response?.status()})`);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent()) === "Your cart", "the page renders in the shell");
  const { lines, total } = await shown(page);
  check(cart.items.length > 0, `the collector's cart has lines (${cart.items.length})`);
  check(
    lines.length > 0 && lines.length <= cart.items.length,
    `one card per product and fulfillment (${lines.length} for ${cart.items.length} lines)`,
  );
  const outcomes = Object.fromEntries(cart.readiness.loaded.lineOutcomes.map((o) => [o.lineId, o.reason]));
  for (const line of lines) {
    const item = cart.items.find((i) => i.line_id === line.id);
    check(Boolean(item) && item.item_title === line.title, `${line.title}: a line the API returned`);
    check(
      line.reason === labels[outcomes[line.id]],
      `${line.title}: the badge is the API's line outcome (${line.reason}, ${outcomes[line.id]})`,
    );
    check(
      /^(from )?\$[\d,]+\.\d{2}$|^Priced at checkout$/.test(line.price ?? ""),
      `${line.title}: a price (${line.price})`,
    );
  }
  check(total === money(cart.readiness.estimatedSubtotal), `the total is the API's estimated subtotal (${total})`);
  const notice = await page
    .locator('[role="note"]')
    .first()
    .textContent()
    .catch(() => null);
  if (cart.readiness.declined.status === "ready" && cart.readiness.declined.optimization.available) {
    check(
      notice?.includes(`Save ${money(cart.readiness.savings)}`) ?? false,
      `the offer is the API's savings (${notice?.trim().split("\n")[0]})`,
    );
  } else {
    check(!notice?.includes("Save "), "no offer for a cart the API does not offer one");
  }
  const ready = cart.readiness.declined.status === "ready";
  if (ready) {
    // Check out and Use lower price post the offer's decision; the pilot starts the session.
    const forms = await page.locator('form[action$="/account/cart/checkout"]').evaluateAll((all) =>
      all.map((f) => ({
        action: f.action,
        method: f.method,
        fields: Object.fromEntries(new FormData(f)),
        label: f.querySelector("button")?.textContent?.trim(),
      })),
    );
    const optimization = cart.readiness.declined.optimization;
    const checkOut = forms.find((f) => f.label === "Check out");
    check(
      checkOut?.action === `${base}/account/cart/checkout` && checkOut.method === "post",
      "Check out posts to the pilot",
    );
    check(
      optimization.available
        ? checkOut?.fields.offer === "declined" && checkOut.fields.line === optimization.proposedLineId
        : checkOut?.fields.offer === "",
      `with the declined offer, as the API read it (${checkOut?.fields.offer})`,
    );
    const lower = forms.find((f) => f.label === "Use lower price");
    if (cart.readiness.accepted && optimization.available) {
      check(
        lower?.fields.offer === "accepted" && lower.fields.listing === optimization.proposedListingId,
        "Use lower price posts the accepted offer",
      );
    }
  } else {
    const resolve = page.getByRole("link", { name: "Continue to checkout" });
    check(
      (await resolve.getAttribute("href")) === `${web}/checkout/buy/readiness`,
      "a cart that is not ready continues to marketplace's checkout",
    );
  }
  check(
    (await page.getByRole("link", { name: "Keep shopping" }).getAttribute("href")) === `${web}/search`,
    "keep shopping is marketplace's search",
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);

  // Check out goes to the pilot's checkout for the session it started.
  if (sendCheckout && ready) {
    const blocked = [];
    page.on("console", (m) => /Content Security Policy|form-action/i.test(m.text()) && blocked.push(m.text()));
    let landed = null;
    await page.route(`${base}/checkout/buy/session/**`, (route) => {
      landed = new URL(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Checkout</h1>" });
    });
    const posted = page
      .waitForResponse((r) => r.request().method() === "POST" && r.url() === `${base}/account/cart/checkout`, {
        timeout: 30_000,
      })
      .catch(() => null);
    await page.getByRole("button", { name: "Check out" }).click();
    const answer = await posted;
    check(
      Boolean(answer) && [204, 303].includes(answer.status()),
      `the pilot starts the session (${answer?.status()})`,
    );
    await page
      .waitForURL((u) => u.pathname.startsWith("/checkout/buy/session/"), { timeout: 30_000 })
      .catch(() => null);
    const session = landed?.pathname.match(/^\/checkout\/buy\/session\/(chk_[\w-]+)$/)?.[1];
    check(Boolean(session), `and sends the browser to the pilot's checkout for it (${landed?.pathname})`);
    check(Boolean(landed?.searchParams.get("afterWrite")), "with the write's receipt");
    check(blocked.length === 0, `no form-action violation (${blocked.join(" | ")})`);
    if (session) {
      const read = await page.request.get(`${api}/api/marketplace/account/checkout-sessions/${session}`, {
        headers: { "chase-sets-read-target-context": "checkout" },
      });
      const started = read.ok() ? await read.json() : null;
      check(
        started?.source_type === "cart" && started.lines.length === cart.items.length,
        `the API has the session, with the cart's lines (${started?.lines?.length})`,
      );
    }
    await page.unroute(`${base}/checkout/buy/session/**`);
  } else if (sendCheckout) {
    console.log("skip the cart is not ready, so there is no Check out to send");
  }

  // marketplace's own page, when it is running: the same lines, in the same order, and total.
  const webPage = await ctx.newPage();
  const webAnswer = await webPage
    .goto(`${web}/account/cart`, { waitUntil: "load", timeout: 180_000 })
    .catch(() => null);
  if (webAnswer?.ok()) {
    const titles = await webPage
      .locator("[data-marketplace-cart-line]")
      .evaluateAll((items) => items.map((li) => li.querySelector(".line-clamp-2")?.textContent?.trim()));
    check(
      titles.join() === lines.map((l) => l.title).join(),
      `marketplace shows the same lines in the same order (${titles.join(", ")})`,
    );
    const webText = (await webPage.locator("main").innerText()).replace(/\s+/g, " ");
    check(webText.includes(`Estimated total ${total}`), `marketplace shows the same total (${total})`);
  } else {
    console.log(`skip marketplace's cart is not answering at ${web}`);
  }
  await ctx.close();
}

// Without JavaScript: the same page, drawn by the server.
{
  const { ctx, page } = await context(false);
  await page.goto(cartUrl);
  check((await page.locator("h1").textContent()) === "Your cart", "without JavaScript the page is the same");
  check((await page.locator("li[data-cart-line]").count()) > 0, "with its lines");
  await ctx.close();
}

// A quantity step and back, as an attempt each, with JavaScript (the runtime sends the form) and
// without it (the browser does). Only a card that is one line: a merged card's step removes the
// lines merged into it, which the smoke could not put back.
if (sendWrites) {
  for (const javaScriptEnabled of [true, false]) {
    const how = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
    const { ctx, page, problems } = await context(javaScriptEnabled);
    const quantityOf = async (id) => {
      const read = await page.request.get(`${api}/api/marketplace/account/cart`, {
        headers: { "chase-sets-read-target-context": "checkout" },
      });
      return (await read.json()).items.find((i) => i.line_id === id)?.quantity;
    };
    // The cart read after the write may not have caught up: the page then says so and reads
    // itself again (Corten's `Meta::read_again`: the runtime reads it in place, or without
    // JavaScript the browser reloads it) until the line shows `expected`.
    const step = async (id, name, expected) => {
      const before = page.url();
      const card = page.locator(`li[data-cart-line="${id}"]`);
      const posted = page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url() === `${base}/account/cart/quantity`,
      );
      let pending = false;
      const seen = (r) => {
        if (r.url().startsWith(cartUrl) && r.request().method() === "GET" && r.status() === 200)
          r.text().then(
            (html) => html.includes("data-corten-read-again") && (pending = true),
            () => {},
          );
      };
      page.on("response", seen);
      await card.getByRole("button", { name }).click();
      const answer = await posted;
      await page.waitForURL((u) => u.href !== before && u.searchParams.has("after_write"));
      const shown = await card
        .locator("[data-quantity]")
        .filter({ hasText: new RegExp(`^${expected}$`) })
        .waitFor({ timeout: 35_000 })
        .then(() => expected)
        .catch(async () =>
          (await card.count()) ? Number(await card.locator("[data-quantity]").textContent()) : "no card",
        );
      page.off("response", seen);
      if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
      return { status: answer.status(), shown, pending };
    };
    await page.goto(cartUrl);
    if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
    const cards = await page.locator("li[data-cart-line]").evaluateAll((items) =>
      items.map((li) => ({
        id: li.getAttribute("data-cart-line"),
        merged: li.querySelectorAll('form[action$="/account/cart/quantity"] input[name="line_id"]').length,
        quantity: Number(li.querySelector("[data-quantity]")?.textContent),
      })),
    );
    const card = cards.find((c) => c.merged === 1);
    if (!card) {
      console.log(`skip ${how}: every card merges lines`);
      await ctx.close();
      continue;
    }
    const up = await step(card.id, "Increase", card.quantity + 1);
    check([204, 303].includes(up.status), `${how}: Increase is sent as an attempt (${up.status})`);
    check(
      up.shown === card.quantity + 1,
      `${how}: the cart read after it shows ${card.quantity + 1} (${up.shown}${up.pending ? ", after a pending read" : ""})`,
    );
    check((await quantityOf(card.id)) === card.quantity + 1, `${how}: the API has it`);
    const down = await step(card.id, "Decrease", card.quantity);
    check(
      down.shown === card.quantity,
      `${how}: Decrease puts it back to ${card.quantity} (${down.shown}${down.pending ? ", after a pending read" : ""})`,
    );
    check((await quantityOf(card.id)) === card.quantity, `${how}: the API has it back`);
    check(problems.length === 0, `${how}: no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
}

// At 390 px.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(cartUrl);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `the page does not scroll sideways at 390 px (${over} px over)`);
  const bar = await page
    .getByRole("button", { name: "Check out" })
    .or(page.getByRole("link", { name: "Continue to checkout" }))
    .boundingBox();
  check(Boolean(bar) && bar.x >= 0 && bar.x + bar.width <= 390, "checkout fits on the screen");
  const cards = await page
    .locator("li[data-cart-line]")
    .evaluateAll((items) => items.map((li) => li.getBoundingClientRect().right));
  check(
    cards.every((right) => right <= 390),
    "every line fits",
  );
  const controls = await page
    .locator("li[data-cart-line] button")
    .evaluateAll((all) => all.map((b) => b.getBoundingClientRect()));
  check(
    controls.length > 0 && controls.every((r) => r.left >= 0 && r.right <= 390),
    `every line's controls fit (${controls.length})`,
  );
  const small = controls.filter((r) => r.height < 40 || r.width < 40).length;
  check(small === 0, `every control is a comfortable target (${small} under 40 px)`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/cart-390.png", fullPage: true });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
