// Signs a synthetic seed user in through the app's own sign-in page and saves the browser state,
// so the pilot's smoke tests and benchmark run as a real session: admin-web's browser-e2e platform
// admin, marketplace's seed seller (`marketplaceBrowserE2eSeedContract.seller`), or the auth
// seed's collector, whose seeded cart has two lines.
// Usage: node scripts/sign-in.mjs <app-url> <state-file> [admin|marketplace|collector] [--api <platform-api-url>]
// With --api the session comes from the platform API's /api/auth/password-sign-in, as marketplace's
// e2e `signInWithPassword` starts one, so the web host need not be running.
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const apiAt = args.indexOf("--api");
const api = apiAt >= 0 ? args.splice(apiAt, 2)[1] : undefined;
const [base = "http://localhost:7752", stateFile = "artifacts/admin-state.json", app = "admin"] = args;
const users = {
  admin: {
    path: "/access/sign-in?returnTo=%2Fcommerce",
    email: process.env.PILOT_ADMIN_EMAIL ?? "browser-e2e-platform-admin@chasesets.test",
    password: process.env.PILOT_ADMIN_PASSWORD ?? "browser-e2e-platform-admin-password",
  },
  marketplace: {
    path: "/sign-in?returnTo=%2Faccount",
    email: process.env.MARKETPLACE_E2E_SELLER_EMAIL ?? "demo@chasesets.test",
    password: process.env.MARKETPLACE_E2E_SELLER_PASSWORD ?? "demo1234",
  },
  collector: {
    path: "/sign-in?returnTo=%2Faccount%2Fcart",
    email: process.env.PILOT_COLLECTOR_EMAIL ?? "collector@chasesets.test",
    password: process.env.PILOT_COLLECTOR_PASSWORD ?? "collector1234",
  },
};
if (!(app in users)) throw new Error(`unknown app ${app}: admin, marketplace or collector`);
const { path: signInPath, email, password } = users[app];

if (api) {
  const response = await fetch(new URL("/api/auth/password-sign-in", api), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`password sign-in answered ${response.status}`);
  const { sessionToken } = await response.json();
  if (!sessionToken) throw new Error("password sign-in returned no session token");
  const { hostname } = new URL(base);
  const cookie = {
    name: "chase_sets_session",
    value: sessionToken,
    domain: hostname,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  };
  writeFileSync(stateFile, JSON.stringify({ cookies: [cookie], origins: [] }, null, 2));
  console.log(`signed in through ${api}; state in ${stateFile}`);
  process.exit(0);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
// A dev server compiles each page on its first request, which can take most of a minute.
page.setDefaultTimeout(60_000);
await page.goto(`${base}${signInPath}`, { waitUntil: "domcontentloaded", timeout: 240_000 });
const deadline = Date.now() + 240_000;
let signedIn = false;
while (!signedIn && Date.now() < deadline) {
  if ((await context.cookies()).some((c) => c.name === "chase_sets_session")) {
    signedIn = true;
    break;
  }
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
  const passwordChoice = page.getByRole("radio", { name: /^Password$/ }).first();
  const emailInput = page.getByRole("textbox", { name: /email|phone/i }).first();
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  } else if (
    (await passwordChoice.isVisible().catch(() => false)) &&
    !(await passwordChoice.isChecked().catch(() => false))
  ) {
    await passwordChoice.click();
  } else if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await page.getByRole("button", { name: /^continue$/i }).click();
  }
  await page.waitForTimeout(500);
}
if (!signedIn) throw new Error(`no session cookie after signing in at ${page.url()}`);
await page.waitForURL((u) => !u.pathname.includes("sign-in"), { timeout: 120_000 }).catch(() => undefined);
await context.storageState({ path: stateFile });
console.log(`signed in; landed on ${new URL(page.url()).pathname}; state in ${stateFile}`);
await browser.close();
