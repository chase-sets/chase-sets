import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string; display_name: string | null; name: string | null }>;
  membership: Readonly<{ membership_id: string; role_key: string }>;
  user: Readonly<{ user_id: string; display_name: string | null; primary_email: string | null }>;
}>;

type UserSnapshot = Readonly<{
  user_id: string;
  display_name: string;
  primary_email: string | null;
  status: string;
}>;

type MembershipSnapshot = Readonly<{
  membership_id: string;
  user_id: string;
  user_display_name: string | null;
  user_primary_email: string | null;
  account_id: string;
  account_display_name: string | null;
  account_name: string | null;
  role_key: string;
  status: string;
}>;

test.describe("access admin users and memberships", () => {
  test("operator can review user and membership detail surfaces @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access/users", "/access/sign-in");
    await expectPageOk(page, "/access/users");
    await expectAdminPageReady(page, { heading: "Users" });

    const actor = await getCurrentActorDisplay(page);
    const accountHeading = actor.account.display_name ?? actor.account.name ?? actor.account.account_id;
    const user = await getUserSnapshot(page, actor.user.user_id);
    await page.goto(`/access/users/${user.user_id}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(
      new RegExp(`/access/accounts/${actor.account.account_id}\\?tab=team&user=${user.user_id}$`),
    );
    await expectAdminPageReady(page, { heading: accountHeading });
    await expect(page.getByText(user.user_id)).toBeVisible();
    await expect(page.getByText(userStatusLabel(user.status)).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Update Profile" })).toBeVisible();
    await expect(page.getByRole("button", { name: user.status === "active" ? "Suspend" : "Reactivate" })).toBeVisible();

    await expectPageOk(page, "/access/memberships");
    await expectAdminPageReady(page, { heading: "Memberships" });

    const membership = await getMembershipSnapshot(page, actor.membership.membership_id);
    await page.goto(`/access/memberships/${membership.membership_id}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(
      new RegExp(`/access/accounts/${membership.account_id}\\?tab=team&membership=${membership.membership_id}$`),
    );
    await expectAdminPageReady(page, { heading: accountHeading });
    const membershipRow = page.getByRole("row").filter({ hasText: membershipUserLabel(membership) });
    await expect(membershipRow.getByText(membershipRoleLabel(membership.role_key), { exact: true })).toBeVisible();
    await expect(membershipRow.getByText(membershipStatusLabel(membership.status), { exact: true })).toBeVisible();
    await expect(membershipRow.getByLabel("Role")).toHaveValue(membership.role_key);
    await expect(membershipRow.getByRole("button", { name: "Change Role" })).toBeVisible();
    await expect(
      membershipRow.getByRole("button", { name: membership.status === "active" ? "Revoke" : "Reinstate" }),
    ).toBeVisible();
  });
});

async function getCurrentActorDisplay(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

async function getUserSnapshot(page: Page, userId: string) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/users/${userId}`);
  expect(response.status(), "current actor user detail should be readable").toBe(200);
  return (await response.json()) as UserSnapshot;
}

async function getMembershipSnapshot(page: Page, membershipId: string) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/memberships/${membershipId}`);
  expect(response.status(), "current actor membership detail should be readable").toBe(200);
  return (await response.json()) as MembershipSnapshot;
}

function membershipUserLabel(membership: MembershipSnapshot) {
  return membership.user_display_name ?? membership.user_primary_email ?? membership.user_id;
}

function userStatusLabel(value: string) {
  const labels: Readonly<Record<string, string>> = {
    active: "Active",
    suspended: "Suspended",
  };
  const label = labels[value];
  expect(label, `user status ${value} should have a visible label`).toBeDefined();
  return label!;
}

function membershipRoleLabel(value: string) {
  const labels: Readonly<Record<string, string>> = {
    "platform-admin": "Platform administrator",
    owner: "Owner",
    manager: "Manager",
    fulfillment: "Fulfillment",
    viewer: "Viewer",
  };
  const label = labels[value];
  expect(label, `membership role ${value} should have a visible label`).toBeDefined();
  return label!;
}

function membershipStatusLabel(value: string) {
  const labels: Readonly<Record<string, string>> = {
    active: "Active",
    revoked: "Revoked",
  };
  const label = labels[value];
  expect(label, `membership status ${value} should have a visible label`).toBeDefined();
  return label!;
}
