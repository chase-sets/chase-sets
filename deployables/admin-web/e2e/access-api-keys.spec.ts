import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string; display_name: string | null; name: string | null }>;
  user: Readonly<{ user_id: string }>;
}>;

test.describe("access admin api keys", () => {
  test("operator creates, rotates, and revokes an API key @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access", "/access/sign-in");
    const actor = await getCurrentActorDisplay(page);
    const accountHeading = actor.account.display_name ?? actor.account.name ?? actor.account.account_id;
    const accountApiAccessPath = `/access/accounts/${actor.account.account_id}?tab=api-access`;
    await expectPageOk(page, accountApiAccessPath);
    await expectAdminPageReady(page, { heading: accountHeading });
    await expect(page.getByRole("heading", { name: "API Access" })).toBeVisible();

    const apiKeyName = `Admin access QA ${Date.now().toString(36)}`;
    await page.getByRole("combobox", { name: "User" }).selectOption(actor.user.user_id);
    await page.getByRole("textbox", { name: "Name" }).fill(apiKeyName);
    await clickApiKeySecretAction(page, {
      button: page.getByRole("button", { name: "Create API Key" }),
      responseUrlIncludes: `/access/accounts/${actor.account.account_id}`,
      status: 201,
    });
    const createdSecret = await expectOneTimeSecretPanel(page, "API key secret created");
    await waitForApiKeyInHub(page, actor.account.account_id, apiKeyName);
    await page.goto(accountApiAccessPath, { waitUntil: "domcontentloaded" });
    const apiKeyRow = page.getByRole("row").filter({ hasText: apiKeyName });
    await expect(apiKeyRow).toHaveCount(1);
    await expect(apiKeyRow.getByText("active", { exact: true })).toBeVisible();

    await clickApiKeySecretAction(page, {
      button: apiKeyRow.getByRole("button", { name: "Rotate" }),
      responseUrlIncludes: `/access/accounts/${actor.account.account_id}`,
      status: 200,
    });
    const rotatedSecret = await expectOneTimeSecretPanel(page, "API key secret rotated");

    await page.goto(accountApiAccessPath, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: accountHeading });
    await expect(apiKeyRow.getByText("active", { exact: true })).toBeVisible();
    await expect(page.getByText(createdSecret, { exact: true })).toHaveCount(0);
    await expect(page.getByText(rotatedSecret, { exact: true })).toHaveCount(0);

    const revokeUrl = await clickApiKeyRedirectAction(page, apiKeyRow, apiKeyName, actor.account.account_id);
    await waitForIdentityApiKeyProjection(page, revokeUrl, `revoke API key ${apiKeyName}`);
    await page.goto(`${revokeUrl.pathname}${revokeUrl.search}`, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: accountHeading });
    const revokedApiKeyRow = page.getByRole("row").filter({ hasText: apiKeyName });
    await expect(revokedApiKeyRow.getByText("revoked", { exact: true })).toBeVisible();
    await expect(revokedApiKeyRow.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  });
});

async function getCurrentActorDisplay(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

async function clickApiKeySecretAction(
  page: Page,
  options: Readonly<{
    button: Locator;
    responseUrlIncludes: string;
    status: number;
  }>,
) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.request().method() === "POST" && candidate.url().includes(options.responseUrlIncludes),
    ),
    options.button.click(),
  ]);
  expect(response.status(), "API key form post should return one-time secret").toBe(options.status);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
}

async function waitForApiKeyInHub(page: Page, accountId: string, apiKeyName: string) {
  const origin = new URL(page.url()).origin;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${origin}/api/identity/access-hub/accounts/${accountId}`);
        if (response.status() !== 200) {
          return false;
        }

        const body = (await response.json()) as {
          api_keys?: readonly Readonly<{ name?: string; status?: string }>[];
        };
        return body.api_keys?.some((apiKey) => apiKey.name === apiKeyName && apiKey.status === "active") ?? false;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
    )
    .toBe(true);
}

async function expectOneTimeSecretPanel(page: Page, heading: string) {
  await expect(page.getByText(heading)).toBeVisible();
  await expect(
    page.getByText(
      "Copy this full secret now. It is shown only once and cannot be recovered after you leave or reload this page.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Full secret", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();

  const secretLocator = page.getByText(/^key_[A-Za-z0-9_]{20,}$/).first();
  await expect(secretLocator).toBeVisible();
  const secret = (await secretLocator.textContent())?.trim() ?? "";
  expect(secret, "One-time plaintext secret should include more than the stored prefix").toMatch(
    /^key_[A-Za-z0-9_]{20,}$/,
  );
  return secret;
}

async function clickApiKeyRedirectAction(page: Page, apiKeyRow: Locator, apiKeyName: string, accountId: string) {
  await apiKeyRow.getByRole("button", { name: "Revoke" }).click();
  const confirmationDialog = page.getByRole("dialog", { name: `Revoke ${apiKeyName}?` });
  await expect(confirmationDialog).toBeVisible();

  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" && candidate.url().includes(`/access/accounts/${accountId}`),
    ),
    confirmationDialog.getByRole("button", { name: "Confirm revoke" }).click(),
  ]);
  expect(response.status(), "Revoke form post should redirect successfully").toBeLessThan(400);
  await page.waitForURL(
    (url) =>
      url.pathname === `/access/accounts/${accountId}` &&
      url.searchParams.get("tab") === "api-access" &&
      url.search.includes("afterWrite"),
    { timeout: 30_000 },
  );
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  return new URL(page.url());
}

async function waitForIdentityApiKeyProjection(page: Page, url: URL, label: string) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "identity",
    targetContextName: "identity",
    projectionName: "identity-api-key-projection",
    label,
  });
}
