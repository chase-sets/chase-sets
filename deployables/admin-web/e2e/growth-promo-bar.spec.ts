import { expect, test } from "@playwright/test";
import { authenticateAdmin, expectAdminWebHydrated, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

test.describe("growth admin promo bar", () => {
  test("operator creates and activates a promo bar message @admin-growth", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/growth/promo-bar", "/access/sign-in");
    await expectPageOk(page, "/growth/promo-bar");
    await expect(page).toHaveURL(/\/growth\/promo-bar$/);
    await expect(page.getByRole("heading", { name: "Promo Bar" })).toBeVisible();
    await expectAdminWebHydrated(page);

    const uniqueSuffix = Date.now().toString(36);
    const title = `E2E promo ${uniqueSuffix}`;
    const description = `Growth admin e2e message ${uniqueSuffix}`;
    const createForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Create message" }) });

    let activated = false;
    try {
      await createForm.getByLabel("Title", { exact: true }).fill(title);
      await createForm.getByLabel("Description", { exact: true }).fill(description);
      await createForm.getByLabel("Link", { exact: true }).fill("/selling");
      await createForm.getByLabel("Link label", { exact: true }).fill("Review selling");
      await createForm.getByLabel("Tone", { exact: true }).selectOption("success");
      await createForm.getByLabel("Display order", { exact: true }).fill("1");
      await createForm.locator('input[name="isActive"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        input.checked = false;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await createForm.getByRole("button", { name: "Create message" }).click();

      await expect(page.getByText("Promo bar message created.")).toBeVisible();
      const createdRow = page.getByRole("row").filter({ hasText: title });
      await expect(createdRow).toBeVisible();
      await expect(createdRow.getByText("Inactive").first()).toBeVisible();

      await createdRow.getByRole("button", { name: "Activate" }).click();
      activated = true;

      await expect(page.getByText("Promo bar message activated.")).toBeVisible();
      const activatedRow = page.getByRole("row").filter({ hasText: title });
      await expect(activatedRow.getByText("Active").first()).toBeVisible();
      await expect(activatedRow.getByRole("button", { name: "Deactivate" })).toBeVisible();
    } finally {
      if (activated) {
        const activatedRow = page.getByRole("row").filter({ hasText: title });
        await expect(activatedRow.getByRole("button", { name: "Deactivate" })).toBeVisible();
        await activatedRow.getByRole("button", { name: "Deactivate" }).click();
        await expect(page.getByText("Promo bar message deactivated.")).toBeVisible();
      }
    }
  });
});
