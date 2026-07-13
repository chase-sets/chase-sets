import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

test.describe("growth admin google shopping and waitlist", () => {
  test("operator reviews Google Shopping gates and waitlist export @admin-growth", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/growth/google-shopping", "/access/sign-in");
    await expectGoogleShoppingOperations(page);
    await expectWaitlistReview(page);
  });
});

async function expectGoogleShoppingOperations(page: Page) {
  await expectPageOk(page, "/growth/google-shopping?filter=failed&limit=25&refreshWindowDays=30");
  await expect(page).toHaveURL(/\/growth\/google-shopping\?/);
  expect(new URL(page.url()).searchParams.get("refreshWindowDays")).toBe("30");
  await expectAdminPageReady(page, { heading: "Google Shopping", headingLevel: 1 });

  await expect(page.getByRole("button", { name: "Dry-run full sync" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dry-run maintenance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dry-run diagnostics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Live full sync gated" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Live maintenance gated" })).toBeDisabled();
  await expect(page.getByText("Live writes gated").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Launch gate #3032" }).first()).toHaveAttribute(
    "href",
    "https://github.com/chase-sets/chase-sets/issues/3032",
  );

  await page.getByLabel("Search").fill("google-shopping");
  await page.getByLabel("Row filter").selectOption("failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/\/growth\/google-shopping\?/);
  await expect(page.getByText("Filter: Failed syncs").first()).toBeVisible();
  await expect(page.getByText("Search: google-shopping").first()).toBeVisible();

  const firstInspectLink = page.getByRole("link", { name: "Inspect" }).first();
  await expect(firstInspectLink, "browser-e2e seed contract requires a failed Google Shopping row").toHaveCount(1);
  await firstInspectLink.click();
  await expect(page.getByRole("button", { name: "Targeted retry gated" })).toBeDisabled();
}

async function expectWaitlistReview(page: Page) {
  await expectPageOk(page, "/growth/waitlist");
  await expect(page).toHaveURL(/\/growth\/waitlist$/);
  await expectAdminPageReady(page, { heading: "Waitlist", headingLevel: 1 });

  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
    "href",
    /\/api\/public-presence\/admin\/waitlist\/export\?limit=100&offset=0/,
  );
  await page.getByLabel("Role").selectOption("sell");
  await page.getByLabel("Interest").selectOption("pricing-tools");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/\/growth\/waitlist\?/);
  expect(new URL(page.url()).searchParams.get("role")).toBe("sell");
  expect(new URL(page.url()).searchParams.get("interest")).toBe("pricing-tools");
  await expect(page.getByLabel("Role")).toHaveValue("sell");
  await expect(page.getByLabel("Interest")).toHaveValue("pricing-tools");

  const exportHref = await page.getByRole("link", { name: "Export CSV" }).getAttribute("href");
  expect(exportHref, "waitlist export link should be present").toBeTruthy();
  const exportResponse = await page.request.get(new URL(exportHref!, page.url()).toString());
  expect([200, 401, 403], "waitlist export returns CSV or a controlled authorization response").toContain(
    exportResponse.status(),
  );
  if (exportResponse.status() === 200) {
    expect(exportResponse.headers()["content-type"] ?? "").toContain("text/csv");
    expect((await exportResponse.text()).split(/\r?\n/)[0]).toContain("email");
  }
}
