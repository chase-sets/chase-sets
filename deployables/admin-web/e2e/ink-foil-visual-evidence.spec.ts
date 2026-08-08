import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { authenticatePlatformAdmin, expectAdminPageReady, expectPageOk } from "./support/admin-e2e";

// Ink & Foil visual evidence, admin-web half (#6015 AC-11).
//
// The marketplace half lives in deployables/marketplace/e2e/ink-foil-visual-evidence.spec.ts
// and carries the same rationale: captureResponsiveEvidence supplies the fail-closed
// populated-target guard and the sha256'd screenshot, and the getComputedStyle
// assertions carry the colour and type claim the shared contract structurally cannot
// express.
//
// CI lane: tagged @admin-platform so scripts/run-e2e-suite.mjs collects it by --grep
// against the admin_platform suite in scripts/e2e-suites.mjs.

const INK_FOIL = {
  light: {
    background: "rgb(247, 245, 241)",
    foreground: "rgb(33, 29, 51)",
    primaryToken: "#4845c6",
  },
  dark: {
    background: "rgb(14, 12, 21)",
    foreground: "rgb(242, 239, 250)",
    primaryToken: "#8a97ff",
  },
} as const;

type ColorMode = keyof typeof INK_FOIL;

const workbenchPath = "/platform/projections";

function themeRoot(page: Page) {
  return page.locator("[data-chase-theme]").first();
}

async function forceColorMode(page: Page, mode: ColorMode) {
  const root = themeRoot(page);
  await expect(root).toBeVisible();
  await root.evaluate((element, nextMode) => element.setAttribute("data-color-mode", nextMode), mode);
  await expect(root).toHaveAttribute("data-color-mode", mode);
}

async function assertInkFoilSurfaces(page: Page, mode: ColorMode) {
  const expected = INK_FOIL[mode];
  const root = themeRoot(page);

  await expect(root, `${mode}: page root background must be the mode's --background`).toHaveCSS(
    "background-color",
    expected.background,
  );

  const resolvedPrimary = await root.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--primary").trim(),
  );
  expect(resolvedPrimary, `${mode}: --primary must resolve to the ratified anchor`).toBe(expected.primaryToken);

  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading, `${mode}: the workbench must render a primary heading`).toBeVisible();
  await expect(heading, `${mode}: primary heading colour must be --foreground`).toHaveCSS("color", expected.foreground);

  const headingFontFamily = await heading.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(
    headingFontFamily.replace(/^["']/, ""),
    `${mode}: primary heading must resolve the Space Grotesk display face`,
  ).toMatch(/^Space Grotesk/);
}

test.describe("Ink & Foil visual evidence (admin workbench)", () => {
  test("projection operations workbench carries the Ink & Foil light palette at 1280x900 @admin-platform", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await authenticatePlatformAdmin(page, workbenchPath);
    await expectPageOk(page, workbenchPath);
    await expectAdminPageReady(page, { heading: "Projection Operations" });
    await forceColorMode(page, "light");
    await assertInkFoilSurfaces(page, "light");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-admin-workbench-desktop-light" });
  });

  test("projection operations workbench carries the Ink & Foil dark palette at 1280x900 @admin-platform", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await authenticatePlatformAdmin(page, workbenchPath);
    await expectPageOk(page, workbenchPath);
    await expectAdminPageReady(page, { heading: "Projection Operations" });
    await forceColorMode(page, "dark");
    await assertInkFoilSurfaces(page, "dark");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-admin-workbench-desktop-dark" });
  });
});
