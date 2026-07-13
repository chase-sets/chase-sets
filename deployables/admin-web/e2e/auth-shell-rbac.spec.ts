import { expect, test, type Page } from "@playwright/test";
import { expectAdminWebHydrated, skipDeployedAdminE2e } from "./support/admin-e2e";

const configuredAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() || "demo@chasesets.test";
const configuredAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() || "demo1234";
const pageReadyTimeoutMs = 90_000;
const adminSectionNames = ["Access", "Catalog", "Commerce", "Growth", "Support", "Platform"] as const;
const authenticatedReturnTo = "/access/accounts";

test.describe("admin auth shell and session", () => {
  for (const signInPath of ["/access/sign-in", "/catalog/sign-in"] as const) {
    test(`operator signs in through ${signInPath}, sees admin shell, and signs out @admin-auth`, async ({ page }) => {
      test.setTimeout(150_000);
      test.skip(
        skipDeployedAdminE2e,
        "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
      );

      await page.context().clearCookies();
      await signInThroughVisiblePasswordForm(page, signInPath, authenticatedReturnTo);
      await expectAuthenticatedAdminShell(page);
      await signOutThroughAdminShell(page);
      await expectProtectedAdminRouteRequiresSignIn(page);
    });
  }

  test("operator sees mobile shell navigation and account actions after sign-in @admin-auth", async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().clearCookies();
    await signInThroughVisiblePasswordForm(page, "/access/sign-in", authenticatedReturnTo);
    await expectAuthenticatedAdminShell(page);
    await expectMobileAdminShell(page);
    await signOutThroughAdminShell(page);
    await expectProtectedAdminRouteRequiresSignIn(page);
  });
});

async function signInThroughVisiblePasswordForm(page: Page, signInPath: string, returnTo: string) {
  await page.goto(`${signInPath}?returnTo=${encodeURIComponent(returnTo)}`, {
    waitUntil: "domcontentloaded",
    timeout: pageReadyTimeoutMs,
  });

  await expect
    .poll(
      async () => {
        if (await isAuthenticatedAdminShellVisible(page)) {
          return true;
        }

        const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
        if (await passwordInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await passwordInput.fill(configuredAdminPassword);
          await page.getByRole("button", { name: /^sign in$/i }).click();
          await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
          return false;
        }

        const passwordChoice = page.getByRole("radio", { name: /^Password$/ }).first();
        if (
          (await passwordChoice.isVisible({ timeout: 1_000 }).catch(() => false)) &&
          !(await passwordChoice.isChecked().catch(() => false))
        ) {
          await passwordChoice.click();
          return false;
        }

        const emailInput = page.getByRole("textbox", { name: /email|phone/i });
        if (await emailInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await emailInput.fill(configuredAdminEmail);
          await page.getByRole("button", { name: /^continue$/i }).click();
        }

        return false;
      },
      { intervals: [250, 500, 1_000], timeout: pageReadyTimeoutMs },
    )
    .toBe(true);
}

async function expectAuthenticatedAdminShell(page: Page) {
  await expectAdminWebHydrated(page);
  await expect
    .poll(
      async () => {
        for (const sectionName of adminSectionNames) {
          if (
            await page
              .getByRole("link", { name: sectionName })
              .first()
              .isVisible()
              .catch(() => false)
          ) {
            return true;
          }
        }

        return page
          .getByLabel("Admin menu")
          .isVisible()
          .catch(() => false);
      },
      { timeout: pageReadyTimeoutMs },
    )
    .toBe(true);

  const origin = new URL(page.url()).origin;
  const actorResponse = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(actorResponse.status(), "signed-in admin shell should expose the current actor display").toBe(200);
}

async function expectMobileAdminShell(page: Page) {
  if (
    await page
      .getByRole("heading", { name: "Admin sections" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.goto(authenticatedReturnTo, { waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs });
    await expectAuthenticatedAdminShell(page);
  }

  const mobileLocalNav = page.locator("nav.fixed.inset-x-0.bottom-0");
  await expect(mobileLocalNav.getByRole("link", { name: "Accounts" })).toBeVisible({ timeout: pageReadyTimeoutMs });

  await page.getByLabel("Admin menu").click();

  for (const sectionName of adminSectionNames) {
    await expect(page.getByRole("link", { name: sectionName }).first()).toBeVisible();
  }

  await page.getByRole("button", { name: "Account menu" }).last().click();
  const accountMenu = page.getByRole("menu", { name: "Account menu" }).last();
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByRole("menuitem", { name: "Switch account" })).toHaveAttribute(
    "href",
    "/access/account-select",
  );
  await expect(accountMenu.getByRole("menuitem", { name: "Sessions" })).toHaveAttribute("href", "/access/sessions");
  await expect(accountMenu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
}

async function signOutThroughAdminShell(page: Page) {
  await Promise.all([
    page.waitForURL(/\/access\/sign-in(?:\?|$)/, { timeout: pageReadyTimeoutMs }),
    page
      .locator('form[action="/access/sign-out"]')
      .first()
      .evaluate((form: HTMLFormElement) => form.submit()),
  ]);
}

async function expectProtectedAdminRouteRequiresSignIn(page: Page) {
  await page.goto("/catalog", { waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs });
  await expect(page).toHaveURL(/\/access\/sign-in(?:\?|$)/, { timeout: pageReadyTimeoutMs });
}

async function isAuthenticatedAdminShellVisible(page: Page) {
  if (/\/(?:access|catalog)\/sign-in(?:\?|$)/.test(new URL(page.url()).pathname)) {
    return false;
  }

  return page
    .locator("html")
    .getAttribute("data-admin-web-hydrated", { timeout: 1_000 })
    .then(
      (value) => value === "true",
      () => false,
    );
}
