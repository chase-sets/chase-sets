import { expect, test, type Page } from "@playwright/test";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
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
    await expect(page.getByText("Support operations API unavailable")).toHaveCount(0);

    await escalateOverdue.click();
    await expect(page).toHaveURL(/\/support\/requests\?/);
    const searchParams = new URL(page.url()).searchParams;
    const escalatedParam = searchParams.get("escalated");
    const skippedParam = searchParams.get("skipped");
    expect(escalatedParam).toMatch(/^\d+$/);
    expect(skippedParam).toMatch(/^\d+$/);
    const escalated = Number(escalatedParam);
    const skipped = Number(skippedParam);
    await expect(page.getByText(`Escalated ${escalated} overdue requests; skipped ${skipped}.`)).toBeVisible();

    await expectSupportRequestDrawer(page, { escalated, skipped });
  });
});

async function expectSupportRequestDrawer(page: Page, escalationResult: { escalated: number; skipped: number }) {
  const openLink = page.getByRole("link", { name: "Open" }).first();
  await expect(openLink).toBeVisible();
  await openLink.click();
  await expect(page).toHaveURL((url) => {
    return url.pathname === "/support/requests" && /^sup_/.test(url.searchParams.get("requestId") ?? "");
  });

  const selectedUrl = new URL(page.url());
  const selectedRequestId = selectedUrl.searchParams.get("requestId");
  expect(selectedUrl.searchParams.get("escalated")).toBe(String(escalationResult.escalated));
  expect(selectedUrl.searchParams.get("skipped")).toBe(String(escalationResult.skipped));
  expect(selectedRequestId).toMatch(/^sup_/);

  const expectedDisplayReference = deriveDisplayReferenceOrRaw(selectedRequestId as `sup_${string}`);
  const requestDrawer = page.getByRole("dialog", { name: expectedDisplayReference });
  await expect(requestDrawer).toBeVisible();
  await expect(requestDrawer.getByText("Recommended action")).toBeVisible();
  await expect(requestDrawer.getByRole("button", { name: /^(Record response|Escalate|Resolve)$/ })).toBeVisible();
  await expect(requestDrawer.getByRole("button", { name: "Close request details" })).toBeVisible();
}
