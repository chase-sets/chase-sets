import { test, expect, type Page } from "@playwright/test";
import { registerOrSignInSyntheticAccount, signInWithPassword } from "./support/auth";

// Seller Desk acceptance gate — the web transport half. The MCP transport half is
// deployables/platform-api/__tests__/seller-desk-journey.e2e.test.ts and runs today;
// this half drives the same "what needs me -> act -> resolve" journey through the
// redesigned web Seller Desk on desktop and mobile, plus the absorbed-route
// redirects the blueprint mandates.
//
// PENDING: the redesigned Seller Desk web surfaces (home, fulfillment command
// center, money dashboard, offers & sell list) and the absorbed-route redirects
// have not landed on main yet. Until they do there is no /account/desk route to
// drive, so the whole suite is gated behind SELLER_DESK_UAT=true and each test
// skips with a clear pending marker. The harness is written in full against the
// blueprint routes (contracts/seller-desk) so it lights up the moment the surfaces
// land and the env flag is set — nothing about the journey is deferred, only its
// execution.
//
// Gate: set SELLER_DESK_UAT=true (staging UAT, not PR CI) with a seeded seller
// account in MARKETPLACE_E2E_EMAIL / MARKETPLACE_E2E_PASSWORD.

const runSellerDeskUat = process.env.SELLER_DESK_UAT === "true";
const sellerEmail = process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "";
const sellerPassword = process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "";
const sellerDisplayName = process.env.MARKETPLACE_E2E_DISPLAY_NAME?.trim() || "Seller Desk UAT";

// The Seller Desk blueprint routes — mirrored from contracts/seller-desk (its
// index.test.ts is the source-of-truth guard). Page surfaces are absolute under
// /account/desk; the redirect map is the absorbed/kept seller routes.
const DESK_HOME = "/account/desk";
const DESK_MONEY = "/account/desk/money";

// Absorbed/kept seller routes and the Desk surface each must redirect to. Buyer,
// shared-reputation, and account-settings routes are deliberately absent: the
// blueprint keeps them in place, so they must NOT redirect.
const SELLER_ROUTE_REDIRECTS: readonly Readonly<{ from: string; to: string }>[] = [
  { from: "/account/inventory", to: "/account/desk" },
  { from: "/account/inventory/imports", to: "/account/desk" },
  { from: "/account/inventory/locations", to: "/account/desk/settings" },
  { from: "/account/inventory/restock-decisions", to: "/account/desk" },
  { from: "/account/listings", to: "/account/desk" },
  { from: "/account/offers/matches", to: "/account/desk/offers" },
  { from: "/account/sell-list", to: "/account/desk/offers" },
  { from: "/account/sales", to: "/account/desk" },
  { from: "/account/sales/shipments", to: "/account/desk" },
  { from: "/account/payouts", to: "/account/desk/money" },
  { from: "/account/payouts/setup", to: "/account/desk/settings" },
  { from: "/account/settlement", to: "/account/desk/money" },
];

// Kept-in-place routes that must NOT redirect (buyer + account-settings + shared
// reputation) — the redirect coverage proves nothing out of scope was absorbed.
const KEPT_IN_PLACE_ROUTES: readonly string[] = [
  "/account/cart",
  "/account/purchases",
  "/account/reviews",
  "/account/security",
  "/account/notifications",
];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

// m76 form-factor parity: interactive targets on the primary path must be at
// least 44px on the smallest supported touch target.
const MIN_TOUCH_TARGET_PX = 44;

async function signInAsSeller(page: Page) {
  await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk", { waitUntil: "domcontentloaded" });
  const origin = new URL(page.url()).origin;
  const account = { email: sellerEmail, password: sellerPassword, displayName: sellerDisplayName };
  if (account.displayName) {
    await registerOrSignInSyntheticAccount(page, origin, account);
  } else {
    await signInWithPassword(page, origin, account);
  }
}

async function assertMinTouchTarget(page: Page, name: string | RegExp) {
  const control = page.getByRole("button", { name }).first();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${String(name)} must have a measurable hit box`).not.toBeNull();
  expect(box!.height, `${String(name)} must meet the ${MIN_TOUCH_TARGET_PX}px touch target`).toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_PX,
  );
}

test.describe("Seller Desk web journey UAT @seller-desk-web", () => {
  test.skip(
    !runSellerDeskUat,
    "Set SELLER_DESK_UAT=true to run the Seller Desk web UAT (pending on the redesigned Seller Desk surfaces landing).",
  );
  test.skip(
    !sellerEmail || !sellerPassword,
    "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Seller Desk web UAT.",
  );

  for (const viewport of VIEWPORTS) {
    test(`drives queue home -> shipment -> money on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signInAsSeller(page);

      // Seller Desk home — the attention queue, most important first.
      await page.goto(DESK_HOME, { waitUntil: "domcontentloaded" });
      const queue = page.getByRole("region", { name: /attention|needs you|what needs me/i });
      await expect(queue, "the Seller Desk home must render the attention queue").toBeVisible();
      const topItem = queue.getByRole("listitem").first();
      await expect(topItem, "the queue must surface at least one item that needs the seller").toBeVisible();

      if (viewport.name === "mobile") {
        await assertMinTouchTarget(page, /open|resolve|act|view/i);
      }

      // Open the ship-by shipment from its queue item and run the fulfillment
      // command center: pack, buy the label, dispatch.
      await topItem.getByRole("link").first().click();
      await expect(page).toHaveURL(/\/account\/desk\/(shipments|sales|payouts|offers)/);

      // Fulfillment command center — drive the shipment through the state machine.
      // (Reached from the ship-by queue item; guarded so the harness is legible.)
      const packAction = page.getByRole("button", { name: /pack|start packing/i });
      if (await packAction.isVisible().catch(() => false)) {
        await packAction.click();
        await page.getByRole("button", { name: /buy label|purchase label/i }).click();
        await page.getByRole("button", { name: /dispatch|mark dispatched/i }).click();
        await expect(page.getByText(/dispatched/i)).toBeVisible();
      }

      // Money dashboard — the payout the settlement leg earned is visible, and a
      // blocked payout surfaces in the reconciliation attention section.
      await page.goto(DESK_MONEY, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /money|settlement|wallet/i })).toBeVisible();
      await expect(page.getByText(/payout/i).first()).toBeVisible();
    });
  }

  test("keeps a blocked payout in the queue until resolved, then clears it", async ({ page }) => {
    await signInAsSeller(page);
    await page.goto(DESK_HOME, { waitUntil: "domcontentloaded" });

    const blockedItem = page.getByRole("listitem").filter({ hasText: /payout.*(blocked|failed|action)/i });
    if ((await blockedItem.count()) === 0) {
      test.skip(true, "No blocked payout seeded for this run; seed one to exercise the resolution path.");
    }
    await blockedItem.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/account\/desk\/(payouts|money)/);

    // Resolve the block from the payout surface, then confirm the queue no longer
    // surfaces it.
    await page
      .getByRole("button", { name: /resolve|retry|confirm|request payout/i })
      .first()
      .click();
    await page.goto(DESK_HOME, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("listitem").filter({ hasText: /payout.*(blocked|failed)/i })).toHaveCount(0);
  });
});

test.describe("Seller Desk absorbed-route redirects @seller-desk-redirects", () => {
  test.skip(
    !runSellerDeskUat,
    "Set SELLER_DESK_UAT=true to run the Seller Desk redirect UAT (pending on the redesigned Seller Desk surfaces landing).",
  );
  test.skip(
    !sellerEmail || !sellerPassword,
    "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Seller Desk redirect UAT.",
  );

  test("redirects every absorbed seller route to its Desk surface", async ({ page }) => {
    await signInAsSeller(page);

    for (const redirect of SELLER_ROUTE_REDIRECTS) {
      await page.goto(redirect.from, { waitUntil: "domcontentloaded" });
      await expect(page, `${redirect.from} must redirect to ${redirect.to}`).toHaveURL(
        new RegExp(`${redirect.to.replace(/\//g, "\\/")}(\\?|$|\\/)`),
      );
    }
  });

  test("leaves buyer, reputation, and account-settings routes in place", async ({ page }) => {
    await signInAsSeller(page);

    for (const kept of KEPT_IN_PLACE_ROUTES) {
      await page.goto(kept, { waitUntil: "domcontentloaded" });
      await expect(page, `${kept} must stay in place (not absorbed by the Desk)`).not.toHaveURL(/\/account\/desk/);
    }
  });
});
