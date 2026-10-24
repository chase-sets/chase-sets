import { expect, test } from "@playwright/test";
import { signInWithPassword } from "./support/auth";

const evidenceListingId = process.env.MARKETPLACE_E2E_EVIDENCE_LISTING_ID?.trim();
const configuredEmail = process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "";
const configuredPassword = process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "";

test.describe("marketplace Sell List offer evidence", () => {
  test("gates seller checkout while required evidence is unmet @marketplace-checkout", async ({ page }) => {
    test.skip(
      !evidenceListingId,
      "Requires a seeded seller account whose Sell List offer points at an incomplete evidence listing.",
    );
    test.skip(
      !configuredEmail || !configuredPassword,
      "Requires MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD for the seeded seller account.",
    );

    await page.goto("/sign-in?returnTo=%2Faccount%2Fsell-list", { waitUntil: "domcontentloaded" });
    const origin = new URL(page.url()).origin;
    await signInWithPassword(page, origin, { email: configuredEmail, password: configuredPassword });

    await page.goto("/account/sell-list", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /^Sell List$/i })).toBeVisible();
    await expect(page.getByText(evidenceListingId!, { exact: true })).toBeVisible();
    await expect(page.getByText("Evidence needs action").first()).toBeVisible();
    await expect(page.getByText("Required listing evidence").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add photo" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to seller checkout" })).toBeDisabled();
  });
});
