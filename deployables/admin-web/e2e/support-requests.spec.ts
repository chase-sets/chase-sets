import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

test.describe("support admin requests", () => {
  test("operator reviews support queue and escalates overdue requests @admin-support", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/support/requests", "/access/sign-in");
    await expectPageOk(page, "/support/requests");
    await expect(page).toHaveURL(/\/support\/requests$/);
    await expectAdminPageReady(page, { heading: "Support operations" });

    await expect(page.getByRole("heading", { name: "Operations queue" })).toBeVisible();
    await expect(page.getByText(/Showing \d+ of \d+/).first()).toBeVisible();

    const escalateOverdue = page.getByRole("button", { name: "Escalate overdue" });
    await expect(escalateOverdue).toBeVisible();
    if (
      await page
        .getByText("Support operations API unavailable")
        .isVisible()
        .catch(() => false)
    ) {
      await expect(escalateOverdue).toBeDisabled();
      return;
    }

    await escalateOverdue.click();
    await expect(page).toHaveURL(/\/support\/requests\?/);
    const searchParams = new URL(page.url()).searchParams;
    expect(searchParams.get("escalated")).toMatch(/^\d+$/);
    expect(searchParams.get("skipped")).toMatch(/^\d+$/);
    await expect(page.getByText(/Escalated \d+ overdue requests; skipped \d+\./)).toBeVisible();

    await expectSupportRequestDetailIfPresent(page);
  });
});

async function expectSupportRequestDetailIfPresent(page: Page) {
  const openLink = page.getByRole("link", { name: "Open" }).first();
  if (!(await openLink.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await expect(page.getByText("No requests need support review")).toBeVisible();
    return;
  }

  await openLink.click();
  await expect(page).toHaveURL(/\/support\/requests\/sup_/);
  await expectAdminPageReady(page, { heading: "Support request" });
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operator actions" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to queue" })).toBeVisible();
}
