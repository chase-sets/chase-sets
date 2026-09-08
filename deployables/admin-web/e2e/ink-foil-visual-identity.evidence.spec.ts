import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { authenticateAdmin, expectAdminPageReady, expectPageOk } from "./support/admin-e2e";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<"light" | "dark", Record<string, { candidate: string }>>;
const route = "/platform/projections/reference";
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;

async function assertAdminWorkbench(page: Page, mode: "light" | "dark") {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: mode });
  await authenticateAdmin(page, route, "/access/sign-in");
  await expectPageOk(page, route);
  await expectAdminPageReady(page, { heading: "Projection settings and reference" });

  // A real projection group with a Details action is required. Empty-state
  // table rows, hidden DOM and an authenticated shell alone are not proof.
  const row = page
    .locator("main tbody tr")
    .filter({ has: page.getByRole("link", { name: "Details", exact: true }) })
    .first();
  await expect(row).toBeVisible();
  await expect(row.locator("td").first()).not.toHaveText("");
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  const cta = page.getByRole("button", { name: "Apply filters", exact: true });
  await expect(cta).toBeVisible();
  await cta.scrollIntoViewIfNeeded();
  await expect(cta).toBeInViewport();

  const observed = await cta.evaluate((action) => {
    const heading = document.querySelector("h1")!;
    return {
      background: getComputedStyle(document.body).backgroundColor,
      foreground: getComputedStyle(heading).color,
      ctaBackground: getComputedStyle(action).backgroundColor,
      ctaForeground: getComputedStyle(action).color,
      displayFont: getComputedStyle(heading).fontFamily,
    };
  });
  const expected = {
    background: rgb(fixture[mode]["--background"]!.candidate),
    foreground: rgb(fixture[mode]["--foreground"]!.candidate),
    ctaBackground: rgb(fixture[mode]["--primary"]!.candidate),
    ctaForeground: rgb(fixture[mode]["--primary-foreground"]!.candidate),
  };
  console.log(`admin workbench (${mode}): ${JSON.stringify({ observed, expected })}`);
  expect(observed).toMatchObject(expected);
  expect(observed.displayFont.replaceAll('"', "").startsWith("Space Grotesk")).toBe(true);
}

test.describe("Ink & Foil admin workbench", () => {
  test("records populated admin workbench light @admin-platform", async ({ page }, testInfo) => {
    await assertAdminWorkbench(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-admin-workbench-light" });
  });
  test("records populated admin workbench dark @admin-platform", async ({ page }, testInfo) => {
    await assertAdminWorkbench(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-admin-workbench-dark" });
  });
});
