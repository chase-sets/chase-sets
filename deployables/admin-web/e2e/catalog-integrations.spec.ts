import { expect, test, type Page } from "@playwright/test";

const configuredCatalogAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const configuredCatalogAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const catalogAdminAccount = {
  email: configuredCatalogAdminEmail || "demo@chasesets.test",
  password: configuredCatalogAdminPassword || "demo1234",
};
const skipDeployedAdminE2e =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true" &&
  (configuredCatalogAdminEmail.length === 0 || configuredCatalogAdminPassword.length === 0);
const authApiTimeoutMs = 90_000;
const pageReadyTimeoutMs = 90_000;

async function expectPageOk(page: Page, path: string) {
  const deadline = Date.now() + pageReadyTimeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (response && response.status() < 400) {
        return;
      }
      lastError = new Error(response ? `${path} returned HTTP ${response.status()}` : `${path} returned no response`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await page.waitForTimeout(1_000);
  }

  throw lastError ?? new Error(`${path} did not become ready`);
}

async function addSessionCookie(page: Page, origin: string, sessionToken: string) {
  await page.context().addCookies([
    {
      name: "chase_sets_session",
      value: sessionToken,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);

  const sessionCookie = (await page.context().cookies(origin)).find((cookie) => cookie.name === "chase_sets_session");
  expect(sessionCookie, "browser context should store the auth session cookie").toBeTruthy();
}

async function authenticateCatalogAdmin(page: Page) {
  await expectPageOk(page, "/catalog/sign-in?returnTo=%2Fcatalog%2Fintegrations");
  const origin = new URL(page.url()).origin;
  const deadline = Date.now() + authApiTimeoutMs;
  let response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: catalogAdminAccount.email,
      password: catalogAdminAccount.password,
    },
  });

  while ([502, 503, 504].includes(response.status()) && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
      data: {
        email: catalogAdminAccount.email,
        password: catalogAdminAccount.password,
      },
    });
  }

  expect(response.status(), "catalog admin password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "catalog admin sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
}

async function expectProfileAction(page: Page, name: RegExp) {
  await expect(page.getByRole("button", { name }).filter({ visible: true }).first()).toBeVisible();
}

async function expectVisibleText(page: Page, text: string) {
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
}

async function openProfileDialog(page: Page, buttonName: RegExp, dialogName: string | RegExp) {
  const button = page.getByRole("button", { name: buttonName }).filter({ visible: true }).first();
  const dialog = page.getByRole("dialog", { name: dialogName });

  await expect(button).toBeVisible();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await button.click();
    try {
      await expect(dialog).toBeVisible({ timeout: 1_000 });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await page.waitForTimeout(500);
    }
  }
}

async function clickDialogFooterButton(page: Page, dialogName: string | RegExp, buttonName: string) {
  const dialog = page.getByRole("dialog", { name: dialogName });
  await dialog.getByRole("button", { name: buttonName }).filter({ hasText: buttonName }).click();
  await expect(dialog).toBeHidden();
}

test.describe("catalog admin integrations", () => {
  test("signed-in catalog operator can review provider profile management controls @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateCatalogAdmin(page);
    await expectPageOk(page, "/catalog/integrations");

    await expect(page).toHaveURL(/\/catalog\/integrations$/);
    await expect(page.getByRole("heading", { name: "Catalog Integrations" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Provider Profile Review" }).first()).toBeVisible();
    await expectVisibleText(page, "Inspect executable provider profile versions");
    await expectVisibleText(page, "TCGdex");
    await expectVisibleText(page, "2026.06.03");

    await expectProfileAction(page, /^Dry run$/i);
    await expectProfileAction(page, /^Clone$/i);
    await expectProfileAction(page, /^Edit JSON$/i);
    await expectProfileAction(page, /^Compare$/i);
    await expectProfileAction(page, /^Evidence$/i);
    await expectProfileAction(page, /^Activate$/i);
    await expectProfileAction(page, /^Deprecate$/i);
    await expectProfileAction(page, /^Rollback$/i);
    await expectProfileAction(page, /^Retire$/i);

    await openProfileDialog(page, /^Compare$/i, "Compare active profile");
    await expect(page.getByRole("textbox", { name: "Candidate profile JSON" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Active profile JSON" })).toBeVisible();
    await clickDialogFooterButton(page, "Compare active profile", "Close");

    await openProfileDialog(page, /^Edit JSON$/i, "Edit profile JSON");
    await expect(page.getByRole("textbox", { name: "Profile JSON" })).toBeVisible();
    await clickDialogFooterButton(page, "Edit profile JSON", "Cancel");

    await openProfileDialog(page, /^Evidence$/i, "Migration evidence");
    await expect(page.getByRole("textbox", { name: "Evidence" })).toBeVisible();
    await clickDialogFooterButton(page, "Migration evidence", "Cancel");

    await openProfileDialog(page, /^Dry run$/i, /dry-run$/i);
    await expect(page.getByRole("textbox", { name: "Fixture Payload JSON" })).toBeVisible();
  });
});
