import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectAdminWebHydrated,
  expectPageOk,
  skipDeployedAdminE2e,
} from "./support/admin-e2e";

test.describe("catalog admin modeling", () => {
  test("signed-in catalog operator can inspect dimensions and open the create model dialog @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");
    await expect(page).toHaveURL(/\/catalog\/dimensions(?:\?|$)/);
    await expectAdminPageReady(page, { heading: "Dimensions" });

    await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
    await page.getByRole("button", { name: /More filters/ }).click();
    await expect(page.getByRole("combobox", { name: "Value kind" })).toBeVisible();
    await page.getByRole("button", { name: "Close filters" }).click();
    await expect(page.locator('a[href="/catalog/dimensions"]').first()).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: "New Dimension" }).click();
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Key" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Description" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Value kind" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toHaveCount(0);

    const firstViewLink = page.getByRole("link", { name: "View" }).first();
    if (await firstViewLink.count()) {
      await firstViewLink.click();
      await expect(page).toHaveURL(/\/catalog\/dimensions\/[^/?]+(?:\?|$)/);
      await expectAdminWebHydrated(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Options").first()).toBeVisible();
      await expect(page.getByText("Value kind").first()).toBeVisible();
      await expect(page.getByText("Dimensions").first()).toBeVisible();
    }
  });

  test("signed-in catalog operator creates and activates a draft dimension @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    const uniqueSuffix = Date.now().toString(36);
    const dimensionKey = `e2e-dimension-${uniqueSuffix}`;
    const dimensionName = `E2E Dimension ${uniqueSuffix}`;

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");
    await expectAdminPageReady(page, { heading: "Dimensions" });

    await page.getByRole("button", { name: "New Dimension" }).click();
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toBeVisible();
    await page.getByRole("textbox", { name: "Key" }).fill(dimensionKey);
    await page.getByRole("textbox", { name: "Name" }).fill(dimensionName);
    await page.getByRole("textbox", { name: "Description" }).fill("Created by admin catalog modeling E2E.");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toHaveCount(0);

    const row = await waitForDimensionRow(page, dimensionKey);
    await row.getByRole("link", { name: "View" }).click();
    await expect(page).toHaveURL(/\/catalog\/dimensions\/dim_[^/?]+(?:\?|$)/);
    await expectAdminWebHydrated(page);
    await expect(page.getByRole("heading", { name: dimensionName })).toBeVisible();
    await expectDimensionStatus(page, "draft");

    await page.getByRole("button", { name: "Activate" }).click();
    await expectDimensionStatus(page, "active");
  });
});

async function waitForDimensionRow(page: Page, dimensionKey: string) {
  const search = page.getByRole("textbox", { name: "Search" });
  const row = page.getByRole("row").filter({ hasText: dimensionKey }).first();
  await expect
    .poll(
      async () => {
        await search.fill(dimensionKey).catch(() => undefined);
        if (await row.isVisible().catch(() => false)) {
          return true;
        }

        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await expectAdminWebHydrated(page).catch(() => undefined);
        return row.isVisible().catch(() => false);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 60_000 },
    )
    .toBe(true);

  return row;
}

async function expectDimensionStatus(page: Page, status: "active" | "draft") {
  await expect
    .poll(
      async () => {
        const visible = await page
          .getByText(status, { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          return true;
        }

        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await expectAdminWebHydrated(page).catch(() => undefined);
        return page
          .getByText(status, { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 60_000 },
    )
    .toBe(true);
}
