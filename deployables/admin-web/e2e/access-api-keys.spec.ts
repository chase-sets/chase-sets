import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const demoUserId = "usr_seed_demo_user";

type ApiKeySnapshot = Readonly<{
  api_key_id: string;
  name: string;
  key_prefix: string;
  status: string;
}>;

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
    await page.getByRole("textbox", { name: "User" }).fill(demoUserId);
    await page.getByRole("textbox", { name: "Name" }).fill(apiKeyName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/access\/api-keys(?:\?|$)/);

    const created = await waitForApiKeyListRow(page, apiKeyName);
    await created.detailLink.click();
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${created.apiKeyId}(?:\\?|$)`));
    await expectAdminPageReady(page, { heading: apiKeyName });
    await expect(page.getByText("active").first()).toBeVisible();

    const beforeRotate = await waitForApiKeySnapshot(page, created.apiKeyId, ({ status }) => status === "active");
    await page.getByRole("button", { name: "Rotate" }).click();
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${created.apiKeyId}(?:\\?|$)`));
    const afterRotate = await waitForApiKeySnapshot(
      page,
      created.apiKeyId,
      ({ key_prefix: keyPrefix }) => keyPrefix !== beforeRotate.key_prefix,
    );
    expect(afterRotate.status).toBe("active");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: apiKeyName });
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${created.apiKeyId}(?:\\?|$)`));
    await expectRevokedApiKey(page, created.apiKeyId, apiKeyName);
  });
});

async function waitForApiKeyListRow(page: Page, apiKeyName: string) {
  const detailLinks = page.locator(`tr:has-text("${apiKeyName}") a[href^="/access/api-keys/key_"]`);
  let visibleHref: string | null = null;
  await expect
    .poll(
      async () => {
        for (let index = 0; index < (await detailLinks.count()); index += 1) {
          const candidate = detailLinks.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            visibleHref = await candidate.getAttribute("href");
            return visibleHref;
          }
        }

        if (!visibleHref) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        }

        return visibleHref;
      },
      { timeout: 45_000 },
    )
    .toMatch(/^\/access\/api-keys\/key_/);

  const href = visibleHref ?? "";
  const detailLink = page.locator(`a[href="${href}"]:visible`).first();
  const apiKeyId = href.split("/").pop();
  expect(apiKeyId, "created API key row should link to a detail page").toBeTruthy();

  return { detailLink, apiKeyId: apiKeyId! };
}

async function waitForApiKeySnapshot(page: Page, apiKeyId: string, predicate: (snapshot: ApiKeySnapshot) => boolean) {
  const origin = new URL(page.url()).origin;
  let snapshot: ApiKeySnapshot | null = null;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${origin}/api/identity/api-keys/${apiKeyId}`);
        if (response.status() !== 200) {
          return false;
        }

        snapshot = (await response.json()) as ApiKeySnapshot;
        return predicate(snapshot);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
    )
    .toBe(true);

  expect(snapshot, "API key snapshot should be available").toBeTruthy();
  return snapshot!;
}

async function expectRevokedApiKey(page: Page, apiKeyId: string, apiKeyName: string) {
  await waitForApiKeySnapshot(page, apiKeyId, ({ status }) => status === "revoked");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectAdminPageReady(page, { heading: apiKeyName });
  await expect(page.getByText("revoked").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Rotate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
}
