// Signs the synthetic browser-e2e platform admin in through admin-web's own sign-in page and
// saves the browser state, so the pilot's smoke test and benchmark run as a real staff session.
// Usage: node scripts/sign-in.mjs <admin-web-url> <state-file>
import { chromium } from "@playwright/test";

const [base = "http://localhost:7752", stateFile = "artifacts/admin-state.json"] = process.argv.slice(2);
const email = process.env.PILOT_ADMIN_EMAIL ?? "browser-e2e-platform-admin@chasesets.test";
const password = process.env.PILOT_ADMIN_PASSWORD ?? "browser-e2e-platform-admin-password";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(5_000);
await page.goto(`${base}/access/sign-in?returnTo=%2Fcommerce`, { waitUntil: "domcontentloaded", timeout: 240_000 });
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
  } else if ((await passwordChoice.isVisible().catch(() => false)) && !(await passwordChoice.isChecked().catch(() => false))) {
    await passwordChoice.click();
  } else if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await page.getByRole("button", { name: /^continue$/i }).click();
  }
  await page.waitForTimeout(500);
}
if (!signedIn) throw new Error(`no session cookie after signing in at ${page.url()}`);
await page.waitForURL((u) => !u.pathname.startsWith("/access/sign-in"), { timeout: 120_000 }).catch(() => undefined);
await context.storageState({ path: stateFile });
console.log(`signed in; landed on ${new URL(page.url()).pathname}; state in ${stateFile}`);
await browser.close();
