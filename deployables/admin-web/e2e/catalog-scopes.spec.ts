import { expect, test } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const SKIP_REASON = "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.";

// Scope-first landing (#3801): the canonical Scope Record list is the primary
// entry into the catalog control plane. These checks assert the surface renders
// with its filter controls and that each scope row opens its own Scope Detail
// journey — without depending on any particular seeded scope, so the test is
// stable across seed states (an empty registry renders the empty state instead
// of rows).
test.describe.serial("catalog admin scopes", () => {
  test("signed-in catalog operator lands on the scope-first list with domain / language / status filters @catalog-admin-scopes", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");

    await expectAdminPageReady(page, { heading: "Scopes" });

    // Primary filters render inline; the extra product-domain and language
    // facets live behind the overflow panel like other catalog list surfaces.
    await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
    await page.getByRole("button", { name: /More filters/ }).click();
    await expect(page.getByRole("combobox", { name: "Product domain" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
    await page.getByRole("button", { name: "Close filters" }).click();

    // The Scopes nav entry is the active surface.
    await expect(page.locator('a[href="/catalog/scopes"]').first()).toHaveAttribute("aria-current", "page");
  });

  test("a scope row opens that scope's own Scope Detail journey @catalog-admin-scopes", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    const viewLinks = page.getByRole("link", { name: "View" });
    const rowCount = await viewLinks.count();
    test.skip(rowCount === 0, "No scope records seeded in this environment; the landing renders its empty state.");

    const firstView = viewLinks.first();
    await expect(firstView).toHaveAttribute("href", /\/catalog\/scopes\//);
    await firstView.click();

    // Scope Detail is a real per-scope page (its own heading), not a modal detour.
    await expect(page).toHaveURL(/\/catalog\/scopes\/.+/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
