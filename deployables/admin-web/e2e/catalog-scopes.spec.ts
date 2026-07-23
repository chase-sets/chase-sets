import { expect, test } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import {
  authenticateAdmin,
  dataTableRoot,
  expectAdminPageReady,
  expectMinimumTouchTarget,
  expectPageOk,
  MOBILE_VIEWPORT,
  skipDeployedAdminE2e,
  TABLET_VIEWPORT,
} from "./support/admin-e2e";

const SKIP_REASON = "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.";

// The canonical Scope Record list is the primary
// entry into the catalog control plane. These checks assert the surface renders
// with its filter controls and that each scope row opens its own Scope Detail
// journey — without depending on any particular seeded scope, so the test is
// stable across seed states for ordinary route behavior (an empty registry
// renders the empty state instead of rows). Manifest-designated responsive
// evidence below deliberately fails closed unless its named bootstrap fixture
// has populated the exact card/table target.
test.describe.serial("catalog admin scopes", () => {
  test("signed-in catalog operator lands on the scope-first list with domain / language / status filters @catalog-admin-scopes @catalog-admin-integrations", async ({
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

  test("a scope row opens that scope's own Scope Detail journey @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }) => {
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
    await expect(page.getByRole("heading", { name: "Coverage matrix" })).toBeVisible();
    await expect(page.getByText("Catalog scope sync", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Review changes/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create \/ update items/ })).toBeVisible();
  });

  test("Scope Detail journey starts from populated cards at 390px @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    await captureResponsiveEvidence({ page, testInfo, claimId: "catalog-scope-cards-mobile" });

    const scopeCards = page.locator("main div[role='list']");
    await scopeCards.locator(":scope > [role='listitem']").first().getByRole("link", { name: "View" }).click();

    await expect(page.getByRole("heading", { name: "Coverage matrix" })).toBeVisible();
    await expect(page.getByText("Catalog scope sync", { exact: true })).toBeVisible();
  });

  test("scope-first landing renders a populated table at 820px @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    await captureResponsiveEvidence({ page, testInfo, claimId: "catalog-scope-table-tablet" });
  });

  test("scope landing's table collapses to cards at mobile width and is restored at tablet width, with a 44px row action @catalog-admin-scopes", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await page.setViewportSize(MOBILE_VIEWPORT);
    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    // The scope registry is deterministically nonempty in a freshly
    // bootstrapped browser-e2e sandbox (the sibling "a scope row opens..."
    // test above proves rows exist without hitting its empty-registry skip),
    // so this table/card assertion does not need a count()-gated fallback.
    const scopeListTable = page.getByRole("table");
    const scopeListRoot = dataTableRoot(page);
    await expect(scopeListTable).toBeHidden();
    const firstRowView = scopeListRoot.getByRole("listitem").first().getByRole("link", { name: "View" });
    await expect(firstRowView).toBeVisible();
    await expectMinimumTouchTarget(firstRowView, "mobile scope-landing row View action");

    await page.setViewportSize(TABLET_VIEWPORT);
    await expect(scopeListTable).toBeVisible();
  });
});
