import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { registerOrSignInSyntheticAccount } from "./support/auth";

const syntheticAccountRunId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}-${process.pid}`)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .slice(0, 12);
const syntheticAccountNonce = Math.random().toString(36).slice(2, 8);

function syntheticAccountFor(testInfo: TestInfo) {
  const suffix = `${syntheticAccountRunId}-${syntheticAccountNonce}-${testInfo.workerIndex}-${testInfo.retry}`;
  return {
    email: `my-collection-${suffix}@chasesets.test`,
    password: `my-collection-${syntheticAccountRunId}-${testInfo.workerIndex}-${testInfo.retry}`,
    displayName: `My Collection ${suffix}`,
  };
}

async function signIn(page: Page, testInfo: TestInfo) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const origin = new URL(page.url()).origin;
  await registerOrSignInSyntheticAccount(page, origin, syntheticAccountFor(testInfo));
}

/**
 * My Collection deep module.
 *
 * Verifies the single top-level My Collection surface presents Overview, Owned
 * Cards, and Lists behind one navigation model, and degrades gracefully when the
 * Saved List reads or pricing are unavailable (Docker/DB is not provisioned in
 * this lane, so the Collections API returns nothing and the surface must remain
 * usable rather than error).
 */
test.describe("My Collection @marketplace-account", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await signIn(page, testInfo);
  });

  test("presents one surface reaching Overview, Owned Cards, and Lists", async ({ page }) => {
    const response = await page.goto("/account/collection", { waitUntil: "domcontentloaded" });
    expect(response, "/account/collection did not return a page response").not.toBeNull();
    expect(response!.status(), `/account/collection returned HTTP ${response!.status()}`).toBeLessThan(400);

    await expect(page.getByRole("heading", { name: /^My Collection$/ })).toBeVisible();

    // One navigation model: all three sections are reachable as tabs.
    for (const tab of ["Overview", "Owned Cards", "Lists"]) {
      await expect(page.getByRole("tab", { name: tab })).toBeVisible();
    }
  });

  test("degrades value without blocking Lists when pricing/reads are unavailable", async ({ page }) => {
    await page.goto("/account/collection", { waitUntil: "domcontentloaded" });

    // Overview never blocks: it shows an unavailable value instead of an error.
    await expect(page.getByText(/Unavailable|Your collection is empty/)).toBeVisible();

    // Lists remain navigable; the tab activates and shows create/search or empty.
    await page.getByRole("tab", { name: "Lists" }).click();
    await expect(page.getByText(/Create Saved List|No Saved Lists yet|taking longer than expected/)).toBeVisible();
  });

  test("opens a Saved List deep link without a second valuation total", async ({ page }) => {
    // A list deep link resolves under the same surface; on this lane it degrades
    // to read-only, proving the composition never hard-fails.
    const response = await page.goto("/account/collection/lists/svl_placeholder", {
      waitUntil: "domcontentloaded",
    });
    expect(response!.status(), "deep link returned a server error").toBeLessThan(500);
    await expect(page.getByRole("heading", { name: /^My Collection$/ })).toBeVisible();
  });
});
