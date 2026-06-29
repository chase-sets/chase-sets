import { expect, type Page } from "@playwright/test";

const configuredAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const configuredAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const adminAccount = {
  email: configuredAdminEmail || "demo@chasesets.test",
  password: configuredAdminPassword || "demo1234",
};
const authApiTimeoutMs = 90_000;
const pageReadyTimeoutMs = 90_000;

export const skipDeployedAdminE2e =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true" &&
  (configuredAdminEmail.length === 0 || configuredAdminPassword.length === 0);

export async function expectPageOk(page: Page, path: string) {
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

export async function authenticateAdmin(page: Page, returnToPath: string, signInPath = "/catalog/sign-in") {
  await expectPageOk(page, `${signInPath}?returnTo=${encodeURIComponent(returnToPath)}`);
  const origin = new URL(page.url()).origin;
  const deadline = Date.now() + authApiTimeoutMs;
  let response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: adminAccount.email,
      password: adminAccount.password,
    },
  });

  while ([502, 503, 504].includes(response.status()) && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
      data: {
        email: adminAccount.email,
        password: adminAccount.password,
      },
    });
  }

  expect(response.status(), "admin password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "admin sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
}

export async function expectVisibleText(page: Page, text: string) {
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
}

export async function expectAdminWebHydrated(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
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
