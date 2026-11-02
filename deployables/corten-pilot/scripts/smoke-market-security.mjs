// The collector's security page (`/account/security`) in a browser, against the real platform API, as
// the auth seed's collector. WRITES: each run creates two synthetic API keys ("Pilot smoke <stamp>"),
// rotates one, and revokes both (a revoked key stays in Identity as a record); it changes the
// collector's given name to a synthetic one and back. The end revokes any key the run left active
// and restores the names through the API, whatever happened. No secret is ever printed.
// - Read: the page shows what Identity has (the names, the sign-in methods, the keys); at 390 px
//   nothing scrolls sideways and every control is at least 44 px tall.
// - With JavaScript: Create API Key answers with its secret once, `no-store`, at the page's own
//   address; Copy copies it; reloading sends the same attempt again, and the page says the secret
//   cannot be shown again; Rotate shows a new secret; Revoke asks first and the key reads Revoked;
//   Update Profile saves and is put back; a key name of spaces is not sent.
// - Without JavaScript: Create API Key shows the secret with no Copy, and Revoke still works.
// - A visitor is sent to the pilot's sign-in, back to /account/security.
// - No console errors.
// Usage: node scripts/smoke-market-security.mjs [pilot-url] [collector-state] [api-url]
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
const userId = session.actor.userId;
const userUrl = `${api}/api/identity/users/${userId}`;
const readUser = async () => (await fetch(userUrl, { headers: { cookie } })).json();
const keys = async () =>
  ((await (await fetch(`${api}/api/identity/api-keys`, { headers: { cookie } })).json()).items ?? []).filter(
    (k) => k.user_id === userId,
  );
const original = await readUser();
const before = new Set((await keys()).map((k) => k.api_key_id));
const stamp = Date.now().toString(36);
const first = `Pilot smoke ${stamp}`;
const second = `Pilot smoke ${stamp} nojs`;
const givenSynthetic = `Pilot ${stamp}`;
const methodWords = {
  password: "Password",
  "magic-link": "Magic link",
  passkey: "Passkey",
  "sms-code": "SMS code",
  "social-login": "Social login",
  google: "Google login",
  facebook: "Facebook login",
};

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, signedIn = true } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, ...(signedIn ? { storageState: state } : {}) });
  if (javaScriptEnabled) await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
const secret = (page) =>
  page
    .locator("main pre code")
    .innerText({ timeout: 2000 })
    .catch(() => "");
const posted = (page) =>
  page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/account/security");
/** Whether the key named `name` comes to read `status` on the page, as the page reads itself again. */
async function reads(page, name, status) {
  for (let i = 0; i < 30; i += 1) {
    const row = page.locator("main li", { hasText: name });
    if ((await row.count()) === 1 && (await row.innerText()).includes(status)) return true;
    await page.waitForTimeout(1000);
    await page.goto(`${base}/account/security`);
  }
  return false;
}
/** Whether Identity's user comes to have `given` as its given name. */
async function settled(given) {
  for (let i = 0; i < 30; i += 1) {
    if ((await readUser()).given_name === given) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

try {
  // Read, and the layout on a phone.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account/security`);
    check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
    check((await page.title()) === "Security | Marketplace", `the title (${await page.title()})`);
    const text = await main(page);
    const methods = original.auth_methods.map((m) => methodWords[m] ?? m).join(", ");
    check(
      text.includes(`Enabled Methods ${original.auth_methods.length} ${methods}`),
      `the sign-in methods (${methods})`,
    );
    check(
      (await page.getByLabel("Display Name").inputValue()) === original.display_name,
      "Update Profile has the display name",
    );
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main input:not([type=hidden]), main select, main button, main a")]
        .filter((e) => e.offsetParent !== null)
        .filter((e) => e.getBoundingClientRect().height < 44)
        .map((e) => e.textContent?.trim() || e.getAttribute("name")),
    );
    check(short.length === 0, `every control is at least 44 px tall (${short.join(", ") || "all"})`);
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // With JavaScript.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account/security`);
    const create = page.locator("main form", { has: page.getByRole("button", { name: "Create API Key" }) });
    await create.getByLabel("API Key Name").fill("   ");
    await create.getByRole("button", { name: "Create API Key" }).click();
    await page.waitForTimeout(500);
    const blocked = await create.getByLabel("API Key Name").evaluate((i) => i.validity.patternMismatch);
    check(blocked && page.url() === `${base}/account/security`, "a key name of spaces is not sent");

    await create.getByLabel("API Key Name").fill(first);
    const answer = posted(page);
    await create.getByRole("button", { name: "Create API Key" }).click();
    const res = await answer;
    await page.getByText("API key secret created").waitFor();
    check(
      res.status() === 200 && (res.headers()["cache-control"] ?? "").includes("no-store"),
      `the create is answered 200 with no-store (${res.status()}, ${res.headers()["cache-control"]})`,
    );
    check(page.url() === `${base}/account/security`, "the secret's page is the page's own address, with nothing in it");
    const issued = await secret(page);
    check(issued.length > 12, "the page shows the full secret");
    const copy = page.getByRole("button", { name: "Copy" });
    check(await copy.isVisible(), "with the script, Copy is shown");
    await copy.click();
    await page
      .getByRole("button", { name: "Copied" })
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check(copied === issued, "Copy put the secret on the clipboard");

    await page.reload();
    await page.waitForLoadState();
    const again = await main(page);
    check(
      !(await secret(page)) && again.includes("its secret cannot be recovered"),
      "a reload sends the same attempt and says the secret cannot be shown again",
    );
    await page
      .getByRole("link", { name: "I have stored this secret" })
      .click()
      .catch(() => page.goto(`${base}/account/security`));
    await page.waitForLoadState();
    check(
      page.url() === `${base}/account/security` && !(await secret(page)),
      "leaving the secret loads the page without it",
    );
    check(await reads(page, first, "Active"), "the new key reads Active");

    const row = page.locator("main li", { hasText: first });
    await row.getByRole("button", { name: "Rotate" }).click();
    await page.getByText("API key secret rotated").waitFor();
    const rotated = await secret(page);
    check(rotated.length > 12 && rotated !== issued, "Rotate shows a new secret");
    await page.goto(`${base}/account/security`);

    const revoke = page.locator("main li", { hasText: first });
    await revoke.getByRole("button", { name: "Revoke", exact: true }).click();
    const dialog = page.getByRole("dialog");
    check((await dialog.isVisible()) && (await dialog.innerText()).includes(`Revoke ${first}?`), "Revoke asks first");
    await dialog.getByRole("button", { name: "Confirm revoke" }).click();
    await page.waitForURL(/saved=/);
    check(await reads(page, first, "Revoked"), "the key comes to read Revoked");

    const profile = page.locator("main form", { has: page.getByRole("button", { name: "Update Profile" }) });
    await profile.getByLabel("Given Name").fill(givenSynthetic);
    await profile.getByRole("button", { name: "Update Profile" }).click();
    await page.getByText("Your change was saved").waitFor();
    check(await settled(givenSynthetic), "Update Profile saves the given name");
    await page.goto(`${base}/account/security`);
    await page
      .locator("main form", { has: page.getByRole("button", { name: "Update Profile" }) })
      .getByLabel("Given Name")
      .fill(original.given_name);
    await page.getByRole("button", { name: "Update Profile" }).click();
    await page.getByText("Your change was saved").waitFor();
    check(await settled(original.given_name), "and puts it back");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    await page.goto(`${base}/account/security`);
    const create = page.locator("main form", { has: page.getByRole("button", { name: "Create API Key" }) });
    await create.getByLabel("API Key Name").fill(second);
    await create.getByRole("button", { name: "Create API Key" }).click();
    await page.waitForLoadState();
    check(
      (await main(page)).includes("API key secret created") && (await secret(page)).length > 12,
      "without a script, the create shows the secret",
    );
    check(!(await page.getByRole("button", { name: "Copy" }).isVisible()), "and no Copy it could not work");
    await page.goto(`${base}/account/security`);
    check(await reads(page, second, "Active"), "the second key reads Active");
    const row = page.locator("main li", { hasText: second });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const opens = await dialog.isVisible().catch(() => false);
    check(opens, "without a script, Revoke still opens its dialog (the browser's command=show-modal)");
    if (opens) {
      await dialog.getByRole("button", { name: "Confirm revoke" }).click();
      await page.waitForLoadState();
      check(await reads(page, second, "Revoked"), "and the key comes to read Revoked");
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // A visitor.
  {
    const { ctx, page } = await context({ signedIn: false });
    await page.goto(`${base}/account/security`);
    const at = new URL(page.url());
    check(
      at.origin + at.pathname === `${base}/sign-in` && at.searchParams.get("returnTo") === "/account/security",
      `a visitor signs in on the pilot, back to /account/security (${at.pathname}${at.search})`,
    );
    await ctx.close();
  }
} finally {
  for (const key of await keys()) {
    if (before.has(key.api_key_id) || key.status !== "active") continue;
    const res = await fetch(`${api}/api/identity/api-keys/${key.api_key_id}/revoke`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: "{}",
    });
    console.log(`revoked a key the run left active through the API (${res.status})`);
  }
  const now = await readUser();
  if (
    now.display_name !== original.display_name ||
    now.given_name !== original.given_name ||
    now.family_name !== original.family_name
  ) {
    const res = await fetch(userUrl, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        displayName: original.display_name,
        givenName: original.given_name,
        familyName: original.family_name,
      }),
    });
    console.log(`restored the names through the API (${res.status})`);
  }
  await browser.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
