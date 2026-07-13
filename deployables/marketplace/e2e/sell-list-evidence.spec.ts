import { expect, test } from "@playwright/test";
import { registerOrSignInSyntheticAccount, signInWithPassword } from "./support/auth";

const evidenceListingId = process.env.MARKETPLACE_E2E_EVIDENCE_LISTING_ID?.trim();
const configuredEmail = process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "";
const configuredPassword = process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "";

test.describe("marketplace Sell List offer evidence", () => {
  test("gates seller checkout while required evidence is unmet @marketplace-checkout", async ({ page }, testInfo) => {
    test.skip(
      !evidenceListingId,
      "Requires a seeded seller account whose Sell List offer points at an incomplete evidence listing.",
    );
    test.skip(
      Boolean(configuredEmail) !== Boolean(configuredPassword),
      "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD must be configured together.",
    );

    await page.goto("/sign-in?returnTo=%2Faccount%2Fsell-list", { waitUntil: "domcontentloaded" });
    const origin = new URL(page.url()).origin;
    const account = configuredEmail
      ? {
          email: configuredEmail,
          password: configuredPassword,
          displayName: "Marketplace evidence E2E account",
          shouldRegister: false,
        }
      : {
          email: `evidence-${testInfo.workerIndex}-${testInfo.retry}@chasesets.test`,
          password: `evidence-${testInfo.workerIndex}-${testInfo.retry}`,
          displayName: "Marketplace evidence E2E account",
          shouldRegister: true,
        };

    if (account.shouldRegister) {
      await registerOrSignInSyntheticAccount(page, origin, account);
    } else {
      await signInWithPassword(page, origin, account);
    }

    await page.goto("/account/sell-list", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /^Sell List$/i })).toBeVisible();
    await expect(page.getByText(evidenceListingId!, { exact: true })).toBeVisible();
    await expect(page.getByText("Evidence needs action").first()).toBeVisible();
    await expect(page.getByText("Required listing evidence").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add photo" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to seller checkout" })).toBeDisabled();
  });
});
