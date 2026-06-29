import { expect, test } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

test.describe("platform admin projection operations", () => {
  test("operator reviews projection console and refreshes status @admin-platform", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/platform/projections", "/access/sign-in");
    await expectPageOk(page, "/platform/projections");
    await expect(page).toHaveURL(/\/platform\/projections$/);
    await expectAdminPageReady(page, { heading: "Projection Operations" });

    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Overview/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Attention/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Operations/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Projection Groups/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Subscriptions/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Blocked Streams/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Workers/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Push wakes/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Diagnostics/ })).toBeVisible();

    await page.getByRole("tab", { name: /Push wakes/ }).click();
    await expect(page.getByRole("link", { name: "Open Grafana wake dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open push-wake runbook" })).toBeVisible();

    await page.getByRole("tab", { name: /Projection Groups/ }).click();
    await page.getByLabel("Search").fill("identity");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/\/platform\/projections\?.*search=identity/);
    await expectAdminPageReady(page, { heading: "Projection Operations" });
    await expect(page.getByText("Search: identity")).toBeVisible();

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page).toHaveURL(/\/platform\/projections\?.*search=identity/);
    await expectAdminPageReady(page, { heading: "Projection Operations" });
  });
});
