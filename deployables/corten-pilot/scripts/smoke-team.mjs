// The account's team (`/account/team`) in a browser, against the real platform API, as the auth
// seed's demo user (the demo account's owner). WRITES: each run changes the demo account's
// manager (`mbr_seed_support_membership`) to Viewer and back to Manager; the end restores the
// role through the API whatever happened. No invitation is sent.
// - Read: the account's members and invitations, only its own (the pilot's
//   workaround), each with its role and status; at 390 px nothing scrolls sideways and every
//   control is at least 44 px tall; Revoke asks first in a dialog that Cancel closes.
// - With JavaScript: Change Role to Viewer, then the page says it was saved and shows Viewer.
// - Without JavaScript: Change Role back to Manager, the same.
// - A visitor is sent to the pilot's sign-in.
// - No console errors.
// Usage: node scripts/smoke-team.mjs [pilot-url] [demo-state] [api-url]
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  state = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const MEMBER = "mbr_seed_support_membership";
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
const account = session.actor.accountId;
const list = async (kind) => {
  const body = await (await fetch(`${api}/api/identity/${kind}?search=${account}`, { headers: { cookie } })).json();
  return (Array.isArray(body) ? body : (body.items ?? body.data ?? [])).filter((row) => row.account_id === account);
};
const roleOf = async () => (await list("memberships")).find((m) => m.membership_id === MEMBER)?.role_key;
const original = await roleOf();
check(original === "manager", `the demo account's manager is a manager to start with (${original})`);

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
const row = (id) => `li[data-membership="${id}"]`;
/** Whether the member's row comes to say `summary`, as the page reads itself again. */
async function shows(page, summary) {
  for (let i = 0; i < 30; i += 1) {
    if ((await text(page, row(MEMBER)).catch(() => "")).includes(summary)) return true;
    await page.waitForTimeout(1000);
    if (i % 5 === 4) await page.reload().catch(() => {});
  }
  return false;
}
async function settled(role) {
  for (let i = 0; i < 30; i += 1) {
    if ((await roleOf()) === role) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
async function changeRole(page, role) {
  const form = page.locator(`${row(MEMBER)} form`).filter({ has: page.locator('input[value="change-role"]') });
  await form.locator("select").selectOption(role);
  await Promise.all([page.waitForLoadState("load"), form.getByRole("button", { name: "Change Role" }).click()]);
}

try {
  // Read, the layout on a phone, and Revoke's dialog.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account/team`);
    check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
    check((await text(page, "main h1")) === "Team", "the heading is Team");
    const members = await list("memberships");
    const invitations = await list("invitations");
    const shownMembers = await page.$$eval("li[data-membership]", (els) => els.map((e) => e.dataset.membership));
    const shownInvitations = await page.$$eval("li[data-invitation]", (els) => els.map((e) => e.dataset.invitation));
    check(
      shownMembers.length === members.length && members.every((m) => shownMembers.includes(m.membership_id)),
      `every member of the account and no other (${shownMembers.join(", ")})`,
    );
    check(
      shownInvitations.length === invitations.length &&
        invitations.every((i) => shownInvitations.includes(i.invitation_id)),
      `every invitation of the account and no other (${shownInvitations.length})`,
    );
    check((await text(page, row(MEMBER))).includes("Manager · Active"), "the manager's row says Manager · Active");
    const statuses = {
      pending: "Pending",
      accepted: "Accepted",
      cancelled: "Cancelled",
      declined: "Declined",
      expired: "Expired",
    };
    let summaries = true;
    for (const i of invitations) {
      summaries &&= (await text(page, `li[data-invitation="${i.invitation_id}"]`)).includes(statuses[i.status] ?? "?");
    }
    check(summaries, "each invitation says its status");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(overflow <= 0, `nothing scrolls sideways at 390 px (${overflow})`);
    const small = await page.$$eval("main button, main select, main input:not([type=hidden])", (els) =>
      els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 60)),
    );
    check(small.length === 0, `every control is at least 44 px tall (${small.join(" | ")})`);
    await page.locator(row(MEMBER)).getByRole("button", { name: "Revoke" }).click();
    const dialog = page.locator(`${row(MEMBER)} dialog`);
    check(await dialog.evaluate((d) => d.open), "Revoke opens its dialog");
    check((await dialog.innerText()).includes("will lose access"), "the dialog says what a revoke does");
    const dialogFits = await dialog.evaluate((d) => d.getBoundingClientRect().width <= 390);
    check(dialogFits, "the dialog fits a phone");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    check(!(await dialog.evaluate((d) => d.open)), "Cancel closes it, nothing sent");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
  // With JavaScript: Change Role to Viewer.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account/team`);
    await changeRole(page, "viewer");
    check(
      (await text(page, "main [role=status]")).includes("Your change was saved"),
      "with a script, the page says it was saved",
    );
    check(await shows(page, "Viewer · Active"), "and the row shows Viewer");
    check(await settled("viewer"), "Identity has the member as a Viewer");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
  // Without JavaScript: Change Role back to Manager.
  {
    const { ctx, page } = await context({ javaScriptEnabled: false });
    await page.goto(`${base}/account/team`);
    await changeRole(page, "manager");
    check(
      (await text(page, "main [role=status]")).includes("Your change was saved"),
      "without a script, the page says it was saved",
    );
    check(await shows(page, "Manager · Active"), "and the row shows Manager again");
    check(await settled("manager"), "Identity has the member as a Manager again");
    await ctx.close();
  }
  // A visitor.
  {
    const { ctx, page } = await context({ signedIn: false });
    await page.goto(`${base}/account/team`);
    check(new URL(page.url()).pathname.startsWith("/sign-in"), `a visitor is sent to sign in (${page.url()})`);
    await ctx.close();
  }
} finally {
  await browser.close();
  if (original && (await roleOf()) !== original) {
    const res = await fetch(`${api}/api/identity/memberships/${MEMBER}/role`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roleKey: original }),
    });
    console.log(
      `restored the role through the API (${res.status}): ${(await settled(original)) ? "ok" : "STILL NOT RESTORED"}`,
    );
  }
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
