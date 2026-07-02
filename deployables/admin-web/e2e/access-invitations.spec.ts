import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

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
    await expect(page).toHaveURL(/\/access\/invitations\/ivt_[^/?]+(?:\?|$)/);
    const invitationId = new URL(page.url()).pathname.split("/").pop();
    if (!invitationId) {
      throw new Error("Created invitation route should include the new invitation id.");
    }
    await expect(page).toHaveURL(new RegExp(`/access/invitations/${invitationId}(?:\\?|$)`));
    await expectAdminPageReady(page, { heading: invitationEmail });
    await expect(page.getByText("pending").first()).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/access/invitations/${invitationId}(?:\\?|$)`));
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

async function expectCancelledInvitation(page: Page, invitationId: string, invitationEmail: string) {
  await waitForInvitationStatus(page, invitationId, "cancelled");
  await expectAdminPageReady(page, { heading: invitationEmail });
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
}
