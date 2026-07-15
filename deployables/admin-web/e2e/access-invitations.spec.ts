import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string; display_name: string | null; name: string | null }>;
}>;

test.describe("access admin invitations", () => {
  test("operator creates and cancels an invitation @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access", "/access/sign-in");
    const actor = await getCurrentActorDisplay(page);
    const accountHeading = actor.account.display_name ?? actor.account.name ?? actor.account.account_id;
    const accountTeamPath = `/access/accounts/${actor.account.account_id}?tab=team`;
    await expectPageOk(page, accountTeamPath);
    await expectAdminPageReady(page, { heading: accountHeading });
    await expect(page.getByRole("heading", { name: "Team memberships" })).toBeVisible();

    const invitationEmail = `admin-access-${Date.now().toString(36)}@example.test`;
    await page.getByRole("button", { name: "Invite Member" }).click();
    const inviteDialog = page.getByRole("dialog", { name: "Invite a team member" });
    await inviteDialog.getByRole("textbox", { name: "Email" }).fill(invitationEmail);
    await inviteDialog.getByLabel("Role").selectOption("viewer");
    await inviteDialog.getByRole("button", { name: "Invite" }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/access/accounts/${actor.account.account_id}` &&
        url.searchParams.get("tab") === "team" &&
        url.search.includes("afterWrite"),
      { timeout: 30_000 },
    );
    const createUrl = new URL(page.url());
    await waitForIdentityInvitationProjection(page, createUrl, `create invitation for ${invitationEmail}`);
    await page.goto(`${createUrl.pathname}${createUrl.search}`, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: accountHeading });
    const invitationRow = page.getByRole("row").filter({ hasText: invitationEmail });
    await expect(invitationRow.getByText("pending", { exact: true })).toBeVisible();
    await invitationRow.getByRole("button", { name: "Cancel" }).click();
    const confirmationDialog = page.getByRole("dialog", { name: `Cancel invitation for ${invitationEmail}?` });
    await expect(confirmationDialog).toBeVisible();
    await confirmationDialog.getByRole("button", { name: "Confirm cancellation" }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/access/accounts/${actor.account.account_id}` &&
        url.searchParams.get("tab") === "team" &&
        url.search.includes("afterWrite"),
      { timeout: 30_000 },
    );
    const cancelUrl = new URL(page.url());
    await waitForIdentityInvitationProjection(page, cancelUrl, `cancel invitation for ${invitationEmail}`);
    await page.goto(`${cancelUrl.pathname}${cancelUrl.search}`, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: accountHeading });
    const cancelledInvitationRow = page.getByRole("row").filter({ hasText: invitationEmail });
    await expect(cancelledInvitationRow.getByText("cancelled", { exact: true })).toBeVisible();
    await expect(cancelledInvitationRow.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  });
});

async function getCurrentActorDisplay(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

async function waitForIdentityInvitationProjection(page: Page, url: URL, label: string) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "identity",
    targetContextName: "identity",
    projectionName: "identity-invitation-projection",
    label,
  });
}
