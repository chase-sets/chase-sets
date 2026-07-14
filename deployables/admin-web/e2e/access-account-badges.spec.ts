import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  authenticatePlatformAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromResponse,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

const accountBadgeKeys = ["founding-account", "manual-payout-review", "trusted-seller"] as const;
type AccountBadgeKey = (typeof accountBadgeKeys)[number];
const operatorManagedAccountBadgeKeys = [
  "manual-payout-review",
  "trusted-seller",
] as const satisfies readonly AccountBadgeKey[];

const accountBadgeLabels: Record<AccountBadgeKey, string> = {
  "founding-account": "Founding Account",
  "manual-payout-review": "Manual Payout Review",
  "trusted-seller": "Trusted Seller",
};

type AccountSnapshot = Readonly<{
  account_id: string;
  display_name: string;
  status: string;
  badges: readonly string[];
}>;

type AccountListResponse = Readonly<{
  items: readonly AccountSnapshot[];
  total: number;
  count: number;
}>;

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string }>;
}>;

test.describe("access admin account badges", () => {
  test("operator can inspect account lifecycle controls without mutating account state @admin-access", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access/accounts", "/access/sign-in");
    await expectPageOk(page, "/access/accounts");
    await expectAdminPageReady(page, { heading: "Accounts" });

    const actor = await getCurrentActorDisplay(page);
    const activeAccount = await waitForAccountSnapshot(page, actor.account.account_id, () => true);
    await expectAccountLifecycleControls(page, activeAccount);

    const suspendedAccount = await findAccountByStatus(page, "suspended");
    if (suspendedAccount) {
      await expectAccountLifecycleControls(page, suspendedAccount);
    }

    const closedAccount = await findAccountByStatus(page, "closed");
    if (closedAccount) {
      await expectAccountLifecycleControls(page, closedAccount);
    }
  });

  test("account owner cannot assign or remove operator-managed account badges @admin-access", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true",
      "The local browser-e2e owner fixture is required to verify owner rejection.",
    );

    await authenticateAdmin(page, "/access/accounts", "/access/sign-in");
    const actor = await getCurrentActorDisplay(page);
    const accountId = actor.account.account_id;

    const responses = [
      await page.request.post(`/api/identity/accounts/${accountId}/badges`, {
        data: { badgeKey: "trusted-seller" },
      }),
      await page.request.delete(`/api/identity/accounts/${accountId}/badges/manual-payout-review`),
    ];

    for (const response of responses) {
      expect(response.status(), "account owner badge mutation should be forbidden").toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authorization_forbidden" },
      });
    }
  });

  test("platform admin assigns and removes every operator-managed account badge @admin-access", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticatePlatformAdmin(page, "/access/accounts", "/access/sign-in");
    await expectPageOk(page, "/access/accounts");
    await expectAdminPageReady(page, { heading: "Accounts" });

    const actor = await getCurrentActorDisplay(page);
    const accountId = actor.account.account_id;
    const initialAccount = await waitForAccountSnapshot(page, accountId, () => true);
    const initialBadges = new Set(initialAccount.badges);

    await page.goto(`/access/accounts/${accountId}`, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: initialAccount.display_name });

    try {
      for (const badgeKey of operatorManagedAccountBadgeKeys) {
        await exerciseBadgeToggle(page, accountId, initialAccount.display_name, badgeKey);
      }
      await expect(page.getByRole("button", { name: /Founding Account badge/ })).toHaveCount(0);
    } finally {
      await restoreAccountBadges(page, accountId, initialBadges);
    }
  });
});

async function getCurrentActorDisplay(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

async function findAccountByStatus(page: Page, status: "suspended" | "closed") {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/accounts?status=${status}&limit=5&offset=0`);
  expect(response.status(), `${status} accounts list should be readable`).toBe(200);
  const body = (await response.json()) as AccountListResponse;
  return body.items.find((account) => account.status === status) ?? null;
}

async function waitForAccountSnapshot(
  page: Page,
  accountId: string,
  predicate: (snapshot: AccountSnapshot) => boolean,
) {
  const origin = new URL(page.url()).origin;
  let snapshot: AccountSnapshot | null = null;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${origin}/api/identity/accounts/${accountId}`);
        if (response.status() !== 200) {
          return false;
        }

        snapshot = (await response.json()) as AccountSnapshot;
        return predicate(snapshot);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
    )
    .toBe(true);

  expect(snapshot, "account snapshot should be available").toBeTruthy();
  return snapshot!;
}

async function expectAccountLifecycleControls(page: Page, account: AccountSnapshot) {
  await page.goto(`/access/accounts/${account.account_id}`, { waitUntil: "domcontentloaded" });
  await expectAdminPageReady(page, { heading: account.display_name });
  await expect(page.getByText(account.account_id)).toBeVisible();
  await expect(page.getByText(account.status).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Update Profile" })).toBeVisible();

  if (account.status === "active") {
    await expect(page.getByRole("button", { name: "Suspend" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reactivate" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    return;
  }

  if (account.status === "suspended") {
    await expect(page.getByRole("button", { name: "Suspend" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reactivate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    return;
  }

  if (account.status === "closed") {
    await expect(page.getByRole("button", { name: "Suspend" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reactivate" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
  }
}

async function exerciseBadgeToggle(
  page: Page,
  accountId: string,
  accountDisplayName: string,
  badgeKey: AccountBadgeKey,
) {
  const label = accountBadgeLabels[badgeKey];
  const initiallyAssigned = await readBadgeAssignment(page, label);
  const action = `${initiallyAssigned ? "Remove" : "Assign"} ${label} badge`;

  const actionUrl = await clickBadgeAction(page, action);
  await waitForIdentityAccountProjection(page, actionUrl, `${action} for account ${accountId}`);
  await page.goto(actionUrl.pathname, { waitUntil: "domcontentloaded" });
  await expectAdminPageReady(page, { heading: accountDisplayName });
  await expectBadgeAssignment(page, label, !initiallyAssigned);
}

async function clickBadgeAction(page: Page, name: string) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.request().method() === "POST" && candidate.url().includes("/access/accounts/"),
    ),
    page.getByRole("button", { name }).click(),
  ]);
  expect(response.status(), `${name} form post should redirect successfully`).toBeLessThan(400);
  await page.waitForURL((url) => url.pathname.startsWith("/access/accounts/") && url.search.includes("afterWrite"), {
    timeout: 30_000,
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  return new URL(page.url());
}

async function expectBadgeAction(page: Page, name: string) {
  await expect(page).toHaveURL(/\/access\/accounts\/[^/?]+(?:\?|$)/);
  await expect(page.getByRole("button", { name })).toBeVisible({ timeout: 45_000 });
}

async function expectBadgeAssignment(page: Page, label: string, assigned: boolean) {
  await expectBadgeAction(page, `${assigned ? "Remove" : "Assign"} ${label} badge`);
}

async function readBadgeAssignment(page: Page, label: string) {
  const remove = page.getByRole("button", { name: `Remove ${label} badge` });
  if (await remove.isVisible()) {
    return true;
  }

  const assign = page.getByRole("button", { name: `Assign ${label} badge` });
  if (await assign.isVisible()) {
    return false;
  }

  throw new Error(`No rendered badge action found for ${label}.`);
}

async function restoreAccountBadges(page: Page, accountId: string, initialBadges: ReadonlySet<string>) {
  const current = await waitForAccountSnapshot(page, accountId, () => true);
  let lastResponse: APIResponse | null = null;
  for (const badgeKey of accountBadgeKeys) {
    const shouldBeAssigned = initialBadges.has(badgeKey);
    if (shouldBeAssigned === current.badges.includes(badgeKey)) {
      continue;
    }

    const origin = new URL(page.url()).origin;
    const response = shouldBeAssigned
      ? await page.request.post(`${origin}/api/identity/accounts/${accountId}/badges`, { data: { badgeKey } })
      : await page.request.delete(`${origin}/api/identity/accounts/${accountId}/badges/${badgeKey}`);
    expect(response.ok(), `restore ${badgeKey} response should be successful`).toBe(true);
    lastResponse = response;
  }

  if (lastResponse) {
    await waitForIdentityAccountProjectionFromResponse(page, lastResponse, `restore account badges for ${accountId}`);
  }
}

async function waitForIdentityAccountProjection(page: Page, url: URL, label: string) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "identity",
    targetContextName: "identity",
    projectionName: "identity-account-projection",
    label,
  });
}

async function waitForIdentityAccountProjectionFromResponse(page: Page, response: APIResponse, label: string) {
  await waitForProjectionPositionFromResponse(page, response, {
    sourceContextName: "identity",
    targetContextName: "identity",
    projectionName: "identity-account-projection",
    label,
  });
}
