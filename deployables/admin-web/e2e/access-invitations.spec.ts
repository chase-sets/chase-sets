import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const demoAccountId = "acc_seed_demo_account";

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

    const invitationEmail = `admin-access-${Date.now().toString(36)}@example.test`;
    await page.getByRole("textbox", { name: "Account" }).fill(demoAccountId);
    await page.getByRole("textbox", { name: "Email" }).fill(invitationEmail);
    await page.getByLabel("Role").selectOption("viewer");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/access\/invitations(?:\?|$)/);

    const { detailLink, invitationId } = await waitForInvitationListRow(page, invitationEmail);
    await detailLink.click();

    await expect(page).toHaveURL(new RegExp(`/access/invitations/${invitationId}(?:\\?|$)`));
    await expectAdminPageReady(page, { heading: invitationEmail });
    await expect(page.getByText("pending").first()).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/access/invitations/${invitationId}(?:\\?|$)`));
    await expectCancelledInvitation(page, invitationId);
  });
});

async function waitForInvitationListRow(page: Page, invitationEmail: string) {
  const detailLinks = page.locator(`tr:has-text("${invitationEmail}") a[href^="/access/invitations/ivt_"]`);
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
    .toMatch(/^\/access\/invitations\/ivt_/);

  const href = visibleHref ?? "";
  const detailLink = page.locator(`a[href="${href}"]:visible`).first();
  const invitationId = href.split("/").pop();
  expect(invitationId, "created invitation row should link to a detail page").toBeTruthy();

  return { detailLink, invitationId: invitationId! };
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

async function expectCancelledInvitation(page: Page, invitationId: string) {
  await waitForInvitationStatus(page, invitationId, "cancelled");
  await expect(page.getByText("cancelled").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
}
