import { expect, test, type Page } from "@playwright/test";

// Charter scope: this spec owns the sell-handoff composition wiring real browsers
// exercise on the decomposed `checkout/sell/session/:sessionId` route -- SSR of the
// guest seller-checkout surface, the readiness redirect chain entry point, and the
// recovery prompt that renders instead of a root error when a visitor lands without
// a prepared Sell List. It does NOT re-test checkout readiness/sell-list domain
// logic, which the vitest sell-checkout-session route + readiness suites own.
//
// Reaching a fully "ready" signed-in sale review requires a connected payout
// account, a non-empty Sell List, and a fresh readiness snapshot whose lifecycle the
// vitest suites already prove end to end; re-staging that through the browser would
// duplicate domain coverage and add a flaky multi-step fixture. The launch risk e2e
// is positioned to catch here is the SSR/redirect composition, which this spec covers.
//
// CI lane: tagged @marketplace-checkout so the change-scope `marketplace_checkout`
// suite (selected for checkout routes and root browser-runtime changes) runs it.
// Playwright auto-discovers this file via the marketplace testMatch glob.

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
  return response!;
}

test.describe("marketplace sell checkout session", () => {
  test("guest sell-checkout session SSRs the seller recovery surface instead of a root error @marketplace-checkout", async ({
    page,
  }) => {
    // A signed-out visitor with no anonymous Sell List is the deterministic seed-free
    // composition state: the decomposed route must render the guest seller-checkout
    // page (200) with the missing-sell-list recovery prompt, never the marketplace
    // root error boundary.
    const response = await expectPageOk(page, "/checkout/sell/session/chk_e2e_sell_handoff");

    expect(response.status(), "guest sell-checkout should SSR a normal page response").toBe(200);
    await expect(page.getByRole("heading", { name: /^Review sale checkout$/i }).first()).toBeVisible();
    await expect(page.getByText(/Seller checkout/i).first()).toBeVisible();
    await expect(page.getByText(/Sell List access expired/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Review Sell List$/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("the sell readiness redirect chain entry point resolves to a safe surface @marketplace-checkout", async ({
    page,
  }) => {
    // The sell handoff routes a seller through the readiness gate before a session
    // becomes payable. #1535 moved the buy counterpart to /checkout/buy/readiness;
    // assert the sell readiness entry point composes without a server error and
    // hands an unauthenticated visitor to a safe authenticated-entry surface rather
    // than crashing the redirect chain.
    const response = await page.goto("/checkout/sell/readiness", { waitUntil: "domcontentloaded" });
    expect(response, "sell readiness entry should return a response").not.toBeNull();
    expect(response!.status(), "sell readiness redirect chain should not be a server error").toBeLessThan(500);
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });
});
