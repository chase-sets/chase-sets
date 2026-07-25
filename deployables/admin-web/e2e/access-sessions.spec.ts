import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminWebHydrated, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

type SessionSnapshot = Readonly<{
  session_id: string;
  user_id: string;
  user_display_name?: string | null;
  user_primary_email?: string | null;
  account_id: string;
  account_display_name?: string | null;
  account_name?: string | null;
  available_account_ids: readonly string[];
  authentication_method: string;
  status: string;
  expires_at: string;
}>;

type SessionListResponse = Readonly<{
  items: readonly SessionSnapshot[];
}>;

test.describe("access admin sessions", () => {
  test("operator can inspect the active session without mutating it @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access/sessions", "/access/sign-in");
    await expectPageOk(page, "/access/sessions");
    await expectAdminWebHydrated(page);
    await expect(page.getByRole("main").getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();

    const session = await getActiveSession(page);

    await page.goto(`/access/sessions/${session.session_id}`, { waitUntil: "domcontentloaded" });
    await expectAdminWebHydrated(page);
    await expect(page.getByText(`${sessionUserLabel(session)} session`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(session.session_id)).toBeVisible();
    await expect(page.getByText(session.authentication_method).first()).toBeVisible();
    await expect(page.getByText(session.expires_at).first()).toBeVisible();
    await expect(page.getByLabel("Active Account")).toHaveValue(session.account_id);
    await expect(page.getByRole("button", { name: "Switch Account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  });
});

async function getActiveSession(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/auth/sessions?limit=50&offset=0`);
  expect(response.status(), "sessions list should be readable").toBe(200);
  const body = (await response.json()) as SessionListResponse;
  const session = body.items.find((item) => item.status === "active");
  expect(session, "at least one active admin session should exist").toBeTruthy();
  return session!;
}

function sessionUserLabel(session: SessionSnapshot) {
  return session.user_display_name ?? session.user_primary_email ?? session.user_id;
}
