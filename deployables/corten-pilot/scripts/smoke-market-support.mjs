// Reads the Support Request participant page pilot in a browser as marketplace's seed seller, with
// JavaScript and without it, against the real platform API, and compares it with Platform
// Operations' own answer and with marketplace's page: the case's reference, who acts next (the detail
// read's participantPolicy), one timeline entry per moment the API holds, and
// which of the viewer's forms are shown. A case the seller is not on answers 404. Then the page at
// 390 px. It reads only: it never submits a form.
// Usage: node scripts/smoke-market-support.mjs [pilot-url] [state-file] [marketplace-url] [api-url]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  stateFile = "../../artifacts/corten-pilot/marketplace-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
] = process.argv.slice(2);
// The support seed's cases (bounded-contexts/platform-operations/support/seed-support/ids.ts): the
// demo account sells the order they are on.
const cases = [
  "sup_seed_active_product_not_received",
  "sup_seed_self_service_product_damaged",
  "sup_seed_resolved_partial_refund",
];
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

const terminal = (status) => ["resolved", "closed", "cancelled"].includes(status);

/** Who acts next, as the API's participantPolicy says. */
function nextActor(request) {
  return request.participantPolicy?.nextActor ?? null;
}

/** The moments marketplace's timeline shows. */
function moments(request) {
  return (
    1 +
    request.evidence.length +
    request.responses.filter((r) => r.offerId === null).length +
    request.offers.length +
    request.offers.filter((o) => o.decidedAt).length +
    (request.escalated_at ? 1 : 0) +
    (request.resolution ? 1 : 0) +
    (request.closed_at ? 1 : 0)
  );
}

let seen = 0;
for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems } = await context(javaScriptEnabled);
  const session = await (await page.request.get(`${api}/api/auth/session`)).json();
  const account = session.actor?.accountId;
  for (const id of cases) {
    const read = await page.request.get(`${api}/api/marketplace/support-requests/${id}`);
    if (!read.ok()) {
      console.log(`skip ${id}: the API answers ${read.status()} (not seeded here)`);
      continue;
    }
    seen += 1;
    const request = await read.json();
    const role =
      request.buyer_account_id === account ? "buyer" : request.seller_account_id === account ? "seller" : null;
    const answer = await page.goto(`${base}/account/support/${id}`);
    if (!role) {
      check(
        answer?.status() === 404,
        `${label}: ${id}: a case the account is not on is Not found (${answer?.status()})`,
      );
      continue;
    }
    check(answer?.status() === 200, `${label}: ${id}: the page answers 200 (${answer?.status()})`);
    if (javaScriptEnabled) await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
    const reference = request.display_reference || request.support_request_id;
    check((await page.locator("h1").textContent())?.trim() === reference, `${label}: ${id}: titled ${reference}`);
    const next = nextActor(request);
    const title = (await page.locator("#support-next-title").textContent())?.trim();
    const expected = terminal(request.status)
      ? null
      : next === role
        ? "You need to act"
        : next === "support"
          ? "Support is reviewing this case"
          : `Waiting on ${next === "buyer" ? "buyer" : "seller"} until the deadline`;
    check(expected === null || title === expected, `${label}: ${id}: who acts next, as the API says (${title})`);
    const entries = await page.locator("[data-support-moment]").count();
    check(
      entries === moments(request),
      `${label}: ${id}: a timeline entry per moment (${entries} of ${moments(request)})`,
    );
    const forms = await page
      .locator('input[name="intent"]')
      .evaluateAll((inputs) => inputs.map((i) => i.getAttribute("value")));
    const writes = forms.filter((f) => f !== "check-status");
    if (next !== role)
      check(
        writes.length === 0,
        `${label}: ${id}: no forms while it is not the viewer's turn (${writes.join(", ") || "none"})`,
      );
    if (next === role && request.pending_offer)
      check(writes.includes("accept-offer"), `${label}: ${id}: the offer to decide`);
    check(!forms.includes("check-status"), `${label}: ${id}: nothing to check on a fresh read`);

    if (javaScriptEnabled) {
      const theirs = await ctx.newPage();
      await theirs.goto(`${web}/account/support/${id}`, { waitUntil: "networkidle", timeout: 120_000 });
      const text = (await theirs.locator("main").innerText()).replace(/\s+/g, " ");
      check(text.includes(reference), `${id}: marketplace's page is the same case`);
      check(!title || text.includes(title), `${id}: marketplace's page says the same about who acts next`);
      await theirs.close();
    }
  }
  const missing = await page.goto(`${base}/account/support/sup_does_not_exist`);
  check(missing?.status() === 404, `${label}: a case that does not exist is Not found (${missing?.status()})`);
  check(problems.length === 0, `${label}: no console errors (${problems.join(" | ")})`);
  await ctx.close();
}
check(seen > 0, `the seed's cases were read (${seen / 2} of ${cases.length})`);

// A phone.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${base}/account/support/${cases[0]}`);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const small = await page
    .locator("main a, main button, main input:not([type=hidden]), main select, main textarea")
    .evaluateAll((controls) =>
      controls
        .filter((c) => c.getClientRects().length > 0 && c.getBoundingClientRect().height < 40)
        .map((c) => c.textContent?.trim() || c.getAttribute("name")),
    );
  check(small.length === 0, `every control is at least 40 px tall (${small.join(", ") || "all"})`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/support-390.png", fullPage: true });
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}
{
  const { ctx, page } = await context(true, { width: 1280, height: 900 });
  await page.goto(`${base}/account/support/${cases[0]}`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/support-1280.png", fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
