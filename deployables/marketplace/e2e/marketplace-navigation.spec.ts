import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

// #9551: owner-manifest navigation for the seeded owner seller, whose permissions cover every
// Marketplace contribution. The unit parity and active matrices live in app/routes/layout.test.tsx.
const accountPath = "/account";
const notificationsPath = "/account/notifications";
const sellingChildren = ["Inventory", "Import", "Restock", "Listings", "Offer Matches", "Sales", "Shipping"];
const accountDestinations = [
  ["Payment methods", "/account/payment-methods"],
  ["Security", "/account/security"],
  ["Consent History", "/account/consents"],
] as const;

async function openAccountAt(page: Page, viewport: Readonly<{ width: number; height: number }>) {
  await page.setViewportSize(viewport);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await signInWithPassword(page, new URL(page.url()).origin, marketplaceBrowserE2eSellerCredentials());
  await page.goto(accountPath, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/account$/);
}

function topNav(page: Page) {
  return page.getByRole("navigation", { name: "Primary navigation" });
}

function bottomNav(page: Page) {
  return page.locator("nav.fixed.inset-x-0.bottom-0");
}

// Every rendered navigation control must sit inside the viewport and show its whole label.
async function expectUnclipped(region: Locator, testInfo: TestInfo, name: string) {
  const controls = await region.evaluate((root) =>
    [...root.querySelectorAll("a, button, summary")]
      .filter((element) => element.closest("details:not([open]) > div") === null && element.checkVisibility())
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          label: element.textContent?.trim() ?? "",
          left: box.left,
          right: box.right,
          width: box.width,
          overflow: element.scrollWidth - element.clientWidth,
        };
      }),
  );
  const viewportWidth = region.page().viewportSize()!.width;
  await testInfo.attach(`${name}-control-geometry`, {
    body: JSON.stringify({ viewportWidth, controls }, null, 2),
    contentType: "application/json",
  });
  expect(controls.length).toBeGreaterThan(0);
  expect(
    controls.filter((control) => control.width <= 0 || control.left < 0 || control.right > viewportWidth + 0.5),
    `${name} controls outside the viewport`,
  ).toEqual([]);
  expect(
    controls.filter((control) => control.overflow > 1),
    `${name} clipped labels`,
  ).toEqual([]);
}

async function expectNotificationsRoute(page: Page) {
  await expect(page).toHaveURL(new RegExp(`${notificationsPath}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function expectPopulatedBottomNav(page: Page, testInfo: TestInfo, viewportWidth: number) {
  const bottom = bottomNav(page);
  await expect(bottom).toBeVisible();
  for (const label of ["Browse", "Alerts", "Seller money"]) {
    await expect(bottom.getByRole("link", { name: label, exact: true }), label).toBeVisible();
  }
  await expect(bottom.getByRole("link", { name: /^Buy Cart/ })).toBeVisible();
  await expect(bottom.getByRole("link", { name: "Seller money", exact: true })).toHaveAttribute(
    "href",
    "/account/desk/money",
  );
  const topLevel = await bottom.evaluate(
    (root) =>
      [...root.querySelectorAll("a, details")].filter((element) => !element.parentElement?.closest("details")).length,
  );
  expect(topLevel, "Marketplace packs the bottom bar to five items").toBe(5);
  await expectUnclipped(bottom, testInfo, `bottom-nav-${viewportWidth}`);
}

async function expectBottomNavInteractions(page: Page) {
  const bottom = bottomNav(page);
  const sell = bottom.locator("details > summary").filter({ hasText: "Sell" });
  const sellGroup = bottom.locator("details").filter({ has: sell });
  await sell.click();
  await expect(sellGroup).toHaveAttribute("open", "");
  for (const label of sellingChildren) {
    await expect(sellGroup.getByRole("link", { name: label, exact: true }), label).toBeVisible();
  }
  await sell.click();
  await expect(sellGroup).not.toHaveAttribute("open", "");
  await sell.focus();
  await page.keyboard.press("Enter");
  await expect(sellGroup).toHaveAttribute("open", "");
  await expect(sell).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sellGroup).not.toHaveAttribute("open", "");

  await page.getByRole("button", { name: "Account menu" }).click();
  const accountMenu = page.getByRole("dialog", { name: "Account menu" });
  for (const [label, href] of accountDestinations) {
    await expect(accountMenu.getByRole("link", { name: label, exact: true }), label).toHaveAttribute("href", href);
  }
  await page.keyboard.press("Escape");
  await expect(accountMenu).toHaveCount(0);

  await bottom.getByRole("link", { name: "Alerts", exact: true }).click();
  await expectNotificationsRoute(page);

  await page.goto(accountPath, { waitUntil: "domcontentloaded" });
  await bottom.getByRole("link", { name: "Alerts", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expectNotificationsRoute(page);
}

test.describe("marketplace owner navigation", () => {
  test("records Marketplace owner navigation at 1280x900 @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await openAccountAt(page, { width: 1280, height: 900 });
    const top = topNav(page);
    await expect(top).toBeVisible();
    for (const label of [
      "Browse",
      "Purchases",
      "Seller Desk",
      "Sell List",
      "Pricing",
      "Channels",
      "Seller money",
      "Support",
      "Sessions",
      "Connected agents",
      "Notifications",
    ]) {
      await expect(top.getByRole("link", { name: label, exact: true }), label).toBeVisible();
    }
    await expect(top.getByRole("link", { name: "Seller money", exact: true })).toHaveAttribute(
      "href",
      "/account/desk/money",
    );
    await expect(top.getByRole("link", { name: /^Buy Cart/ })).toBeVisible();
    await expectUnclipped(top, testInfo, "top-nav-1280");
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-navigation-desktop-1280" });

    const sell = top.getByRole("button", { name: "Sell", exact: true });
    await sell.click();
    await expect(sell).toHaveAttribute("aria-expanded", "true");
    const sellPopup = page.locator(`[id="${await sell.getAttribute("aria-controls")}"]`);
    for (const label of sellingChildren) {
      await expect(sellPopup.getByRole("link", { name: label, exact: true }), label).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(sell).toHaveAttribute("aria-expanded", "false");
    await expect(sell).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sell).toHaveAttribute("aria-expanded", "true");
    await expect(sellPopup.getByRole("link", { name: "Inventory", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sell).toBeFocused();

    await page.getByRole("button", { name: "Account menu" }).click();
    const accountMenu = page.getByRole("menu", { name: "Account menu" });
    for (const [label, href] of accountDestinations) {
      await expect(accountMenu.getByRole("menuitem", { name: label, exact: true }), label).toHaveAttribute(
        "href",
        href,
      );
    }
    await page.keyboard.press("Escape");
    await expect(accountMenu).toHaveCount(0);

    await top.getByRole("link", { name: "Notifications", exact: true }).click();
    await expectNotificationsRoute(page);
    await expect(top.getByRole("link", { name: "Notifications", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto(accountPath, { waitUntil: "domcontentloaded" });
    await top.getByRole("link", { name: "Notifications", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expectNotificationsRoute(page);
  });

  test("records Marketplace owner navigation at 360x800 @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await openAccountAt(page, { width: 360, height: 800 });
    await expectPopulatedBottomNav(page, testInfo, 360);
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-navigation-mobile-360" });
    await expectBottomNavInteractions(page);
  });

  test("records Marketplace owner navigation at 390x844 @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await openAccountAt(page, { width: 390, height: 844 });
    await expectPopulatedBottomNav(page, testInfo, 390);
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-navigation-mobile-390" });
    await expectBottomNavInteractions(page);
  });
});
