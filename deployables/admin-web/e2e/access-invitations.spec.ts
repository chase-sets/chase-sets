import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string }>;
}>;

test.describe("access admin invitations", () => {
  test("operator creates and cancels an invitation @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access/invitations", "/access/sign-in");
    await expectPageOk(page, "/access/invitations");
    await expectAdminPageReady(page, { heading: "Invitations" });

    const actor = await getCurrentActorDisplay(page);
    const invitationEmail = `admin-access-${Date.now().toString(36)}@example.test`;
    await page.getByLabel("Account", { exact: true }).selectOption(actor.account.account_id);
    await page.getByRole("textbox", { name: "Email" }).fill(invitationEmail);
    await page.getByLabel("Role").selectOption("viewer");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(
      (url) => /^\/access\/invitations\/ivt_[^/?]+$/.test(url.pathname) && url.search.includes("afterWrite"),
      { timeout: 30_000 },
    );
    const createUrl = new URL(page.url());
    const invitationId = createUrl.pathname.split("/").pop();
    if (!invitationId) {
      throw new Error("Created invitation route should include the new invitation id.");
    }
    await waitForIdentityInvitationProjection(page, createUrl, `create invitation ${invitationId}`);
    await page.goto(createUrl.pathname, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/access/invitations/${invitationId}(?:\\?|$)`));
    await expectAdminPageReady(page, { heading: invitationEmail });
    await expect(page.getByText("pending").first()).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    const confirmationDialog = page.getByRole("dialog", { name: `Cancel invitation for ${invitationEmail}?` });
    await expect(confirmationDialog).toBeVisible();
    await confirmationDialog.getByRole("button", { name: "Confirm cancellation" }).click();
    await page.waitForURL(
      (url) => url.pathname === `/access/invitations/${invitationId}` && url.search.includes("afterWrite"),
      { timeout: 30_000 },
    );
    const cancelUrl = new URL(page.url());
    await waitForIdentityInvitationProjection(page, cancelUrl, `cancel invitation ${invitationId}`);
    await page.goto(cancelUrl.pathname, { waitUntil: "domcontentloaded" });
    await expectCancelledInvitation(page, invitationId, invitationEmail);
  });
});

async function getCurrentActorDisplay(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

async function waitForInvitationStatus(page: Page, invitationId: string, status: "cancelled") {
  const origin = new URL(page.url()).origin;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${origin}/api/identity/invitations/${invitationId}`);
        if (response.status() !== 200) {
          return null;
        }

        const body = (await response.json()) as { status?: string };
        return body.status ?? null;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
    )
    .toBe(status);

  await page.reload({ waitUntil: "domcontentloaded" });
}

async function waitForIdentityInvitationProjection(page: Page, url: URL, label: string) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "identity",
    targetContextName: "identity",
    projectionName: "identity-invitation-projection",
    label,
  });
}

async function expectCancelledInvitation(page: Page, invitationId: string, invitationEmail: string) {
  await waitForInvitationStatus(page, invitationId, "cancelled");
  await expectAdminPageReady(page, { heading: invitationEmail });
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
}
