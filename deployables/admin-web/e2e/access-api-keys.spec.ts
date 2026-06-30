import { expect, test, type Page } from "@playwright/test";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

type ApiKeySnapshot = Readonly<{
  api_key_id: string;
  name: string;
  key_prefix: string;
  status: string;
}>;

type CurrentActorDisplay = Readonly<{
  user: Readonly<{ user_id: string }>;
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

    const actor = await getCurrentActorDisplay(page);
    const apiKeyName = `Admin access QA ${Date.now().toString(36)}`;
    await page.getByRole("textbox", { name: "User" }).fill(actor.user.user_id);
    await page.getByRole("textbox", { name: "Name" }).fill(apiKeyName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/access\/api-keys\/key_[^/?]+(?:\?|$)/);
    const apiKeyId = new URL(page.url()).pathname.split("/").pop();
    if (!apiKeyId) {
      throw new Error("Created API key route should include the new key id.");
    }
    await expectAdminPageReady(page, { heading: apiKeyName });
    await expect(page.getByText("active").first()).toBeVisible();

    const beforeRotate = await waitForApiKeySnapshot(page, apiKeyId, ({ status }) => status === "active");
    await page.getByRole("button", { name: "Rotate" }).click();
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${apiKeyId}(?:\\?|$)`));
    const afterRotate = await waitForApiKeySnapshot(
      page,
      apiKeyId,
      ({ key_prefix: keyPrefix }) => keyPrefix !== beforeRotate.key_prefix,
    );
    expect(afterRotate.status).toBe("active");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: apiKeyName });
    await page.getByRole("button", { name: "Revoke" }).click();
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await expect(page).toHaveURL(new RegExp(`/access/api-keys/${apiKeyId}(?:\\?|$)`));
    await expectRevokedApiKey(page, apiKeyId, apiKeyName);
  });
});

async function getCurrentActorDisplay(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

async function waitForApiKeySnapshot(page: Page, apiKeyId: string, predicate: (snapshot: ApiKeySnapshot) => boolean) {
  const origin = new URL(page.url()).origin;
  let snapshot: ApiKeySnapshot | null = null;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${origin}/api/identity/api-keys/${apiKeyId}`, {
          headers: freshReadHeaders(page),
        });
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

function freshReadHeaders(page: Page) {
  const token = new URL(page.url()).searchParams.get("afterWrite");
  return token
    ? {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: token,
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "identity",
      }
    : undefined;
}
