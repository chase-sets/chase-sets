import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInWithPassword } from "./support/auth";

const shipmentPath = "/account/sales/shipments/shp_seed_label_attached";
const seller = {
  email: process.env.MARKETPLACE_E2E_SELLER_EMAIL?.trim() || "demo@chasesets.test",
  password: process.env.MARKETPLACE_E2E_SELLER_PASSWORD?.trim() || "demo1234",
};

async function shipmentFurniture(page: Page, mode: "light" | "dark") {
  await page.emulateMedia({ colorScheme: mode });
  const theme = page.locator("[data-chase-theme]").first();
  await expect(theme).toBeVisible();
  await theme.evaluate((element, value) => element.setAttribute("data-color-mode", value), mode);
  await expect(theme).toHaveAttribute("data-color-mode", mode);
  const target = page.locator('[data-card-emitter="order-protection"]');
  await expect(target).toHaveCount(1);
  await expect(target).toBeVisible();
  await expect(target.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
  await expect(target).toContainText("1ZSEEDLABELATTACHED");
  await expect(target).toHaveClass("rounded-tokenLg overflow-hidden bg-surface-2 p-4");
  const chrome = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, border: style.borderTopWidth, fill: style.backgroundColor };
  });
  expect(chrome).toMatchObject({ shadow: "none", border: "0px" });
  expect(chrome.fill).not.toBe("rgba(0, 0, 0, 0)");
  return target.ariaSnapshot();
}

test.describe("composed Card shipment intent", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await signInWithPassword(page, new URL(page.url()).origin, seller);
    await page.goto(shipmentPath, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`${shipmentPath}$`));
  });

  test("records seeded shipment furniture mobile @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const light = await shipmentFurniture(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-shipment-mobile-light" });
    const dark = await shipmentFurniture(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-shipment-mobile-dark" });
    expect(dark, "theme must preserve accessible roles, names and order").toBe(light);
    await testInfo.attach("shipment-mobile-accessibility", {
      body: JSON.stringify({ light, dark }),
      contentType: "application/json",
    });
  });

  test("records seeded shipment furniture desktop @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const light = await shipmentFurniture(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-shipment-desktop-light" });
    const dark = await shipmentFurniture(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-shipment-desktop-dark" });
    expect(dark, "theme must preserve accessible roles, names and order").toBe(light);
    await testInfo.attach("shipment-desktop-accessibility", {
      body: JSON.stringify({ light, dark }),
      contentType: "application/json",
    });
  });
});
