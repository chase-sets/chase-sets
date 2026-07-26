import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  authenticatePlatformAdmin,
  expectAdminPageReady,
  expectAdminWebHydrated,
  expectPageOk,
  skipDeployedAdminE2e,
} from "./support/admin-e2e";

// #3430: below lg the admin shell renders a sticky section bar carrying a
// current-section trail (all sub-lg widths) and a "Sections" drawer trigger
// (md..lg only) that opens the full section tree as a modal NavigationDrawer.
// These journeys assert the acceptance criteria at the issue's tablet
// viewports: any admin section reachable in <=2 taps without the phone
// bottom-nav More menu, and the current section visible at all times.
//
// The catalog integrations route streams behind Suspense boundaries over SSE —
// never wait for networkidle here; every wait below is an explicit
// element-visible or URL wait.

const tabletViewports = [
  { width: 768, height: 1024 },
  { width: 810, height: 1080 },
] as const;

const sectionBar = (page: Page) => page.locator("[data-admin-section-bar]");
const sectionTrail = (page: Page) => page.getByRole("navigation", { name: "Current section" });
const sectionsTrigger = (page: Page) => page.getByRole("button", { name: "Sections" });
const sectionsDrawer = (page: Page) => page.getByRole("dialog", { name: "Sections" });

async function expectSectionBarPinnedUnderHeader(page: Page) {
  const bar = sectionBar(page);
  await expect(bar).toBeVisible();
  const before = await bar.boundingBox();
  expect(before, "section bar should have a layout box").toBeTruthy();
  // The bar initially follows the rendered primary-nav band; once the page
  // scrolls it pins directly below the 4rem top app bar, spanning the viewport.
  expect(before!.y).toBeGreaterThanOrEqual(60);
  expect(before!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 2);

  // "Visible at all times": scrolling the document must not move the sticky bar.
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect
    .poll(async () => (await bar.boundingBox())?.y ?? Number.NaN, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(60);
  await expect.poll(async () => (await bar.boundingBox())?.y ?? Number.NaN, { timeout: 5_000 }).toBeLessThanOrEqual(68);
  await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe("admin tablet navigation", () => {
  test("tablet operator reaches any catalog section in two taps with a persistent section trail @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations", "/access/sign-in");

    for (const viewport of tabletViewports) {
      await page.setViewportSize(viewport);
      await expectPageOk(page, "/catalog/integrations");
      await expect(page).toHaveURL(/\/catalog\/integrations$/);
      await expect(
        page.getByRole("heading", {
          name: "Pull provider data, review Source Observations, promote Catalog facts",
        }),
      ).toBeVisible();
      await expectAdminWebHydrated(page);

      // AC2: the current-section trail is visible and names the nested location.
      await expectSectionBarPinnedUnderHeader(page);
      const trail = sectionTrail(page);
      await expect(trail).toBeVisible();
      await expect(trail.getByText("Integrations")).toBeVisible();
      await expect(trail.getByText("Import")).toHaveAttribute("aria-current", "page");

      // The phone bottom nav (and its More overflow) plays no part at tablet width.
      await expect(page.locator("nav.fixed").getByText("More")).toBeHidden();

      // AC1: two taps to a different admin section — tap 1 opens the drawer.
      let taps = 0;
      await sectionsTrigger(page).click();
      taps += 1;
      const drawer = sectionsDrawer(page);
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("link", { name: "Integration health" })).toBeVisible();

      await page.screenshot({
        path: `artifacts/visual-evidence/issue-3430/catalog-integrations-${viewport.width}x${viewport.height}-drawer-open.png`,
        fullPage: false,
      });

      // Tap 2 lands on the destination section.
      await drawer.getByRole("link", { name: "Integration health" }).click();
      taps += 1;
      await expect(page).toHaveURL(/\/catalog\/integrations\/health$/);
      expect(taps, "any section must be reachable in <=2 taps").toBeLessThanOrEqual(2);

      // Route selection closes the drawer and the trail re-orients to the new leaf.
      await expect(drawer).toBeHidden();
      await expect(sectionTrail(page).getByText("Integration health")).toHaveAttribute("aria-current", "page");

      await page.screenshot({
        path: `artifacts/visual-evidence/issue-3430/catalog-integrations-health-${viewport.width}x${viewport.height}-after-navigation.png`,
        fullPage: false,
      });
    }
  });

  test("tablet operator keeps section orientation across a support workflow @admin-support", async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await page.setViewportSize(tabletViewports[0]);
    // Platform Feedback is platform-admin-only (see admin-role-matrix.test.ts);
    // the default admin account's "owner" role never renders that drawer link.
    await authenticatePlatformAdmin(page, "/support/requests", "/access/sign-in");
    await expectPageOk(page, "/support/requests");
    await expectAdminPageReady(page, { heading: "Support operations" });

    await expectSectionBarPinnedUnderHeader(page);
    await expect(sectionTrail(page).getByText("Support")).toHaveAttribute("aria-current", "page");

    // Two taps from the requests queue to the Platform Feedback section.
    await sectionsTrigger(page).click();
    const drawer = sectionsDrawer(page);
    await expect(drawer).toBeVisible();
    await page.screenshot({
      path: "artifacts/visual-evidence/issue-3430/support-requests-768x1024-drawer-open.png",
      fullPage: false,
    });
    await drawer.getByRole("link", { name: "Platform Feedback" }).click();
    await expect(page).toHaveURL(/\/support\/platform-feedback/);
    await expect(drawer).toBeHidden();
    await expect(sectionTrail(page).getByText("Platform Feedback")).toHaveAttribute("aria-current", "page");
  });

  test("phone and desktop admin navigation stay unchanged @catalog-admin-integrations", async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations", "/access/sign-in");

    // Phone (<768): bottom nav with More overflow still owns navigation; the
    // drawer trigger must not appear, while the orientation trail may.
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPageOk(page, "/catalog/integrations");
    await expect(
      page.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeVisible();
    await expectAdminWebHydrated(page);
    await expect(sectionsTrigger(page)).toBeHidden();
    await expect(page.locator("nav.fixed").getByText("More")).toBeVisible();
    await expect(sectionTrail(page).getByText("Import")).toHaveAttribute("aria-current", "page");
    await page.screenshot({
      path: "artifacts/visual-evidence/issue-3430/catalog-integrations-390x844-phone.png",
      fullPage: false,
    });

    // Desktop (>=1280): the persistent side nav owns navigation; the section
    // bar and drawer trigger are absent.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeVisible();
    await expect(sectionBar(page)).toBeHidden();
    await expect(sectionsTrigger(page)).toBeHidden();
    await expect(page.locator('a[href="/catalog/integrations"]').first()).toHaveAttribute("aria-current", "page");
    await expect(page.locator('a[href="/catalog/integrations"]').first()).toBeVisible();
    await page.screenshot({
      path: "artifacts/visual-evidence/issue-3430/catalog-integrations-1280x900-desktop.png",
      fullPage: false,
    });
  });
});
