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

async function expectVisibleText(page: Page, text: string) {
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
}

test.describe("catalog admin integrations", () => {
  test("signed-in catalog operator sees the rebuilt primary import-to-promotion workbench @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateCatalogAdmin(page);
    await expectPageOk(page, "/catalog/integrations");
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/\/catalog\/integrations$/);
    await expect(
      page.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeVisible();
    await expectVisibleText(page, "Catalog control plane");
    await expectVisibleText(page, "Import to promotion workbench");
    await expectVisibleText(page, "Primary workflow");
    await expectVisibleText(page, "Unblock provider data");
    await expectVisibleText(page, "Govern and recover");
    await expectVisibleText(page, "Verify release evidence");

    await expect(page.getByRole("button", { name: /Pull provider data/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Choose provider, unit, scope, and profile/i }).first()).toBeVisible();
    await expect(
      page.getByRole("cell", { name: /Pull provider data through a durable import/i }).first(),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: /Review Source Observations/i }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Preview Catalog promotion impact/i }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Promote into Catalog Items/i }).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: /JSON/i })).toHaveCount(0);
    await expect(page.getByText(/Old integrations surface/i)).toHaveCount(0);

    const retiredListResponse = await page.goto(["/catalog", "source-observations"].join("/"), {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    expect(retiredListResponse?.status() ?? 0).toBeGreaterThanOrEqual(400);
    await expect(page.getByRole("heading", { name: "Source Observations" })).toHaveCount(0);

    await expectPageOk(
      page,
      "/catalog/integrations?providerKey=tcgdex&section=triage&filter.status=changed&selectedObservationIds=obs_001",
    );
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/catalog\/integrations\?.*section=triage/);
    await expect(page.getByRole("link", { name: /Health triage/i })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: /Import to promotion workbench/i })).toHaveAttribute(
      "href",
      /section=workbench/,
    );

    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.getByRole("navigation", { name: "Catalog control plane workflows" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Choose Catalog workflow" })).toHaveValue("health-triage");
    await expect(page.getByRole("button", { name: /Pull provider data/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Integration health triage" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to import workbench" })).toHaveAttribute(
      "href",
      /section=workbench/,
    );
    await expect(page.getByRole("heading", { name: "Import to promotion workbench" })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Choose Catalog workflow" }).selectOption("audit-evidence");
    await expect(page).toHaveURL(/\/catalog\/integrations\?.*section=evidence/);
    await expect(page).toHaveURL(/returnPath=/);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
