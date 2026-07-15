import { expect, test } from "@playwright/test";
import {
  authenticatePlatformAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
} from "./support/admin-e2e";

const demoAccountId = "acc_seed_demo_account";
const workbenchPath = `/commerce/wallet-workbench/${demoAccountId}?accountName=Demo%20Account`;

test.describe("commerce admin wallet adjustments", () => {
  test("operator previews exact balance consequences before explicit confirmation @admin-commerce", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticatePlatformAdmin(page, workbenchPath, "/access/sign-in");
    await expectPageOk(page, workbenchPath);
    await expectAdminPageReady(page, { heading: "Wallet for Demo Account" });

    await page.getByLabel("Amount").fill("1.00");
    await page.getByLabel("Reason").selectOption("goodwill-cash-credit");
    await page.getByLabel("Explanation (optional)").fill("Browser acceptance preview");
    await page.getByRole("button", { name: "Request preview" }).click();

    await expect(page.getByText("Available balance before", { exact: true })).toBeVisible();
    await expect(page.getByText("Available balance after", { exact: true })).toBeVisible();
    await expect(page.getByText("Spendable", { exact: true })).toBeVisible();
    await expect(page.getByText("Payoutable", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Confirm & submit" }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Demo Account");
    await expect(confirmation).toContainText("$1.00");
    await expect(confirmation.getByRole("button", { name: "Submit adjustment" })).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("button", { name: "Confirm & submit" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Confirm & submit" })).toBeVisible();
  });
});
