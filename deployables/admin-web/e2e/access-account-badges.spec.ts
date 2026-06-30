import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const accountBadgeKeys = ["founding-account", "manual-payout-review", "trusted-seller"] as const;
type AccountBadgeKey = (typeof accountBadgeKeys)[number];

const accountBadgeLabels: Record<AccountBadgeKey, string> = {
  "founding-account": "Founding Account",
  "manual-payout-review": "Manual Payout Review",
  "trusted-seller": "Trusted Seller",
};

type AccountSnapshot = Readonly<{
  account_id: string;
  display_name: string;
  badges: readonly string[];
}>;

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string }>;
}>;

test.describe("access admin account badges", () => {
  test("operator assigns and removes every supported account badge @admin-access", async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/access/accounts", "/access/sign-in");
    await expectPageOk(page, "/access/accounts");
    await expectAdminPageReady(page, { heading: "Accounts" });

    const actor = await getCurrentActorDisplay(page);
    const accountId = actor.account.account_id;
    const initialAccount = await waitForAccountSnapshot(page, accountId, () => true);
    const initialBadges = new Set(initialAccount.badges);

    await page.goto(`/access/accounts/${accountId}`, { waitUntil: "domcontentloaded" });
    await expectAdminPageReady(page, { heading: initialAccount.display_name });

    try {
      for (const badgeKey of accountBadgeKeys) {
        const initiallyAssigned = initialBadges.has(badgeKey);
        await exerciseBadgeToggle(page, accountId, badgeKey, initiallyAssigned);
      }
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

async function exerciseBadgeToggle(
  page: Page,
  accountId: string,
  badgeKey: AccountBadgeKey,
  initiallyAssigned: boolean,
) {
  const label = accountBadgeLabels[badgeKey];

  if (initiallyAssigned) {
    await clickBadgeAction(page, `Remove ${label} badge`);
    await waitForAccountSnapshot(page, accountId, ({ badges }) => !badges.includes(badgeKey));
    await page.reload({ waitUntil: "domcontentloaded" });
    await clickBadgeAction(page, `Assign ${label} badge`);
    await waitForAccountSnapshot(page, accountId, ({ badges }) => badges.includes(badgeKey));
    await page.reload({ waitUntil: "domcontentloaded" });
    return;
  }

  await clickBadgeAction(page, `Assign ${label} badge`);
  await waitForAccountSnapshot(page, accountId, ({ badges }) => badges.includes(badgeKey));
  await page.reload({ waitUntil: "domcontentloaded" });
  await clickBadgeAction(page, `Remove ${label} badge`);
  await waitForAccountSnapshot(page, accountId, ({ badges }) => !badges.includes(badgeKey));
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function clickBadgeAction(page: Page, name: string) {
  await page.getByRole("button", { name }).click();
}

async function restoreAccountBadges(page: Page, accountId: string, initialBadges: ReadonlySet<string>) {
  for (const badgeKey of accountBadgeKeys) {
    const shouldBeAssigned = initialBadges.has(badgeKey);
    const current = await waitForAccountSnapshot(page, accountId, () => true);
    if (shouldBeAssigned === current.badges.includes(badgeKey)) {
      continue;
    }

    const origin = new URL(page.url()).origin;
    const response = shouldBeAssigned
      ? await page.request.post(`${origin}/api/identity/accounts/${accountId}/badges`, { data: { badgeKey } })
      : await page.request.delete(`${origin}/api/identity/accounts/${accountId}/badges/${badgeKey}`);
    expect(response.ok(), `restore ${badgeKey} response should be successful`).toBe(true);
    await waitForAccountSnapshot(page, accountId, ({ badges }) => shouldBeAssigned === badges.includes(badgeKey));
  }
}
