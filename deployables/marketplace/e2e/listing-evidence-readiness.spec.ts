import { expect, test } from "@playwright/test";
import { signInWithPassword } from "./support/auth";

const seller = {
  email: process.env.MARKETPLACE_E2E_SELLER_EMAIL?.trim() || "demo@chasesets.test",
  password: process.env.MARKETPLACE_E2E_SELLER_PASSWORD?.trim() || "demo1234",
};

test.describe("seller Listing Evidence readiness", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await signInWithPassword(page, new URL(page.url()).origin, seller);
  });

  test("shows active compliance from server-owned slots @marketplace-seller @browser-e2e-seed", async ({ page }) => {
    await page.goto("/account/listings/lst_seed_charizard_base_set_psa_8", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
    await expect(page.getByText("Evidence ready")).toBeVisible();
    await expect(page.getByText("Required view: front")).toBeVisible();
    await expect(page.getByText("Required view: back")).toBeVisible();
    await expect(page.getByText("Required view: slab")).toBeVisible();
    await expect(page.getByText("Seller-supplied evidence", { exact: true })).toBeVisible();
  });

  test("keeps the draft path available with mobile camera capture @marketplace-seller @browser-e2e-seed", async ({
    page,
  }) => {
    await page.goto("/account/listings/lst_seed_lugia_neo_genesis_draft", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
    await expect(page.getByLabel("Add seller-supplied evidence")).toHaveAttribute("capture", "environment");
    await expect(page.getByRole("button", { name: "Upload evidence" })).toBeVisible();
  });
});
