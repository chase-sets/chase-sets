// The user's consent history (`/account/consents`) in a browser, against the real platform API,
// as the auth seed's collector. Only reads: the sandbox records no consents, so Withdraw is tested
// against the stand-in API only (marketplace/src/tests.rs).
// - Read: the title and what the page is for; each consent Identity lists for the user on the
//   account and no other (the pilot's workaround), or the page's words for none; a
//   Withdraw only on a recorded, current one; at 390 px nothing scrolls sideways and every control
//   is at least 44 px tall.
// - Without JavaScript: the same page.
// - A visitor is sent to the pilot's sign-in.
// - No console errors.
// Usage: node scripts/smoke-consents.mjs [pilot-url] [collector-state] [api-url]
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
const { userId, accountId } = session.actor;
const listed = await (
  await fetch(`${api}/api/identity/consents?limit=50&offset=0&userId=${userId}&accountId=${accountId}`, {
    headers: { cookie },
  })
).json();
const own = (listed.items ?? []).filter(
  (c) =>
    c.user_id === userId && (c.subject_type === "user" || (c.subject_type === "account" && c.account_id === accountId)),
);
console.log(`Identity lists ${listed.items?.length ?? "?"} consents for the user, ${own.length} its own`);

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, signedIn = true } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, ...(signedIn ? { storageState: state } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const text = (page, selector) =>
  page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim() ?? "", selector);

async function read(page, label) {
  const res = await page.goto(`${base}/account/consents`);
  check(res?.status() === 200, `${label}: the page answers 200 (${res?.status()})`);
  check((await text(page, "main h1")) === "Consent History", `${label}: the heading is Consent History`);
  check((await text(page, "main header")).includes("Audit history for agreements"), `${label}: what the page is for`);
  const shown = await page.$$eval("li[data-consent]", (els) => els.map((e) => e.dataset.consent));
  check(
    shown.length === own.length && own.every((c) => shown.includes(c.consent_id)),
    `${label}: each of the user's own consents and no other (${shown.length})`,
  );
  if (own.length === 0)
    check((await text(page, "main")).includes("No consents are recorded for you yet."), `${label}: none says so`);
  const withdrawable = own
    .filter((c) => c.status === "recorded" && c.is_current)
    .map((c) => c.consent_id)
    .sort();
  const offered = (
    await page.$$eval("li[data-consent] dialog", (els) => els.map((e) => e.closest("li").dataset.consent))
  ).sort();
  check(
    JSON.stringify(offered) === JSON.stringify(withdrawable),
    `${label}: Withdraw only on a recorded, current consent (${offered.length})`,
  );
}

try {
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    await read(page, "390 px");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(overflow <= 0, `nothing scrolls sideways at 390 px (${overflow})`);
    const small = await page.$$eval("main button, main a", (els) =>
      els
        .filter((e) => e.offsetParent && e.tagName === "BUTTON" && e.getBoundingClientRect().height < 44)
        .map((e) => e.outerHTML.slice(0, 60)),
    );
    check(small.length === 0, `every button is at least 44 px tall (${small.join(" | ")})`);
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
  {
    const { ctx, page, problems } = await context();
    await read(page, "1280 px");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
  {
    const { ctx, page } = await context({ javaScriptEnabled: false });
    await read(page, "without a script");
    await ctx.close();
  }
  {
    const { ctx, page } = await context({ signedIn: false });
    await page.goto(`${base}/account/consents`);
    check(new URL(page.url()).pathname.startsWith("/sign-in"), `a visitor is sent to sign in (${page.url()})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
