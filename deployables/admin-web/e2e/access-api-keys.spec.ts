import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

test.describe("access admin api keys", () => {
  test("operator creates, rotates, and revokes an API key @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access/api-keys", "/access/sign-in");
    await expectPageOk(page, "/access/api-keys");
    await expectAdminPageReady(page, { heading: "API Keys" });

    const apiKeyName = `Admin access QA ${Date.now().toString(36)}`;
    await page.getByRole("combobox", { name: "User" }).click();
    await page.getByRole("option").first().click();
    await page.getByRole("textbox", { name: "Name" }).fill(apiKeyName);
    await clickApiKeySecretAction(page, {
      buttonName: "Create",
      responseUrlIncludes: "/access/api-keys",
      status: 201,
    });
    await expect(page).toHaveURL(/\/access\/api-keys(?:\?|$)/);
    await expectAdminPageReady(page, { heading: "API Keys" });
    const createdSecret = await expectOneTimeSecretPanel(page, "API key secret created");

    const detailHref = await page.getByRole("link", { name: "View key" }).getAttribute("href");
    expect(detailHref, "Created API key reveal should link to the persisted key detail.").toMatch(
      /^\/access\/api-keys\/key_[^/?]+$/,
    );
    const apiKeyId = detailHref!.split("/").pop()!;
    await page.getByRole("link", { name: "View key" }).click();
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${apiKeyId}(?:\\?|$)`));
    await expectAdminPageReady(page, { heading: apiKeyName });
    await expect(page.getByText("active").first()).toBeVisible();
    await expect(page.getByText(createdSecret, { exact: true })).toHaveCount(0);

    await clickApiKeySecretAction(page, {
      buttonName: "Rotate",
      responseUrlIncludes: `/access/api-keys/${apiKeyId}`,
      status: 200,
    });
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${apiKeyId}(?:\\?|$)`));
    const rotatedSecret = await expectOneTimeSecretPanel(page, "API key secret rotated");

    await page.goto(`/access/api-keys/${apiKeyId}`, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: apiKeyName });
    await expect(page.getByText("active").first()).toBeVisible();
    await expect(page.getByText(rotatedSecret, { exact: true })).toHaveCount(0);

    const revokeUrl = await clickApiKeyRedirectAction(page, apiKeyId, "Revoke");
    await waitForIdentityApiKeyProjection(page, revokeUrl, `revoke API key ${apiKeyId}`);
    await page.goto(revokeUrl.pathname, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: apiKeyName });
    await expect(page.getByText("revoked").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  });
});

async function clickApiKeySecretAction(
  page: Page,
  options: Readonly<{
    buttonName: "Create" | "Rotate";
    responseUrlIncludes: string;
    status: number;
  }>,
) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.request().method() === "POST" && candidate.url().includes(options.responseUrlIncludes),
    ),
    page.getByRole("button", { name: options.buttonName }).click(),
  ]);
  expect(response.status(), `${options.buttonName} form post should return one-time secret`).toBe(options.status);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
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

async function clickApiKeyRedirectAction(page: Page, apiKeyId: string, name: "Revoke") {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" && candidate.url().includes(`/access/api-keys/${apiKeyId}`),
    ),
    page.getByRole("button", { name }).click(),
  ]);
  expect(response.status(), `${name} form post should redirect successfully`).toBeLessThan(400);
  await page.waitForURL((url) => url.pathname === `/access/api-keys/${apiKeyId}` && url.search.includes("afterWrite"), {
    timeout: 30_000,
  });
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
