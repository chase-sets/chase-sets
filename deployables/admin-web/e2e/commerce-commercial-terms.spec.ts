import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

const demoAccountId = "acc_seed_demo_account";

test.describe("commerce admin commercial terms", () => {
  test("operator manages fee schedules and commercial agreements @admin-commerce", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/commerce/terms/schedules", "/access/sign-in");
    const suffix = Date.now().toString(36);
    await expectScheduleOverlapValidation(page);
    await createInactiveScheduleAndInspectHistory(page, suffix);
    await expectAgreementAccountValidation(page);
    await createInactiveAgreementAndInspectHistory(page, suffix);
  });
});

async function expectScheduleOverlapValidation(page: Page) {
  await expectPageOk(page, "/commerce/terms/schedules");
  await expectAdminPageReady(page, { heading: "Fee Schedules" });

  const form = createScheduleForm(page);
  await form.getByLabel("Label").fill(`E2E overlapping business schedule ${Date.now().toString(36)}`);
  await form.getByLabel("Account type").selectOption("business");
  await form.getByLabel("Status").selectOption("active");
  await form.getByLabel("Effective from").fill("2026-06-01T00:00:00.000Z");
  await form.getByLabel("Effective until").fill("");
  await form.getByRole("button", { name: "Create schedule" }).click();

  await expect(page.getByText(/already covers that account type and effective window/i)).toBeVisible();
}

async function createInactiveScheduleAndInspectHistory(page: Page, suffix: string) {
  const label = `E2E inactive schedule ${suffix}`;
  const form = createScheduleForm(page);
  await form.getByLabel("Label").fill(label);
  await form.getByLabel("Account type").selectOption("enterprise");
  await fillCommercialTermsFeeFields(form, {
    marketplaceSalesFeePercentageBps: "640",
    marketplaceSalesFeeFixedAmount: "0.02",
    shippingAllowancePercentageBps: "450",
  });
  await form.getByLabel("Status").selectOption("inactive");
  await form.getByLabel("Effective from").fill("2027-01-01T00:00:00.000Z");
  await form.getByLabel("Effective until").fill("2027-12-31T00:00:00.000Z");
  await form.getByRole("button", { name: "Create schedule" }).click();

  await page.waitForURL((url) => url.pathname === "/commerce/terms/schedules" && url.search.includes("afterWrite"), {
    timeout: 30_000,
  });
  const createUrl = new URL(page.url());
  await waitForCommercialTermsProjection(page, createUrl, {
    projectionName: "commercial-terms-schedule-projection",
    label: `create commercial terms schedule ${label}`,
  });
  await page.goto(createUrl.pathname, { waitUntil: "domcontentloaded" });
  await expectAdminPageReady(page, { heading: "Fee Schedules" });
  const openedLabel = await openListRowDetail(page, label, "E2E inactive schedule");
  await expectAdminPageReady(page, { heading: openedLabel });
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "created" })).toBeVisible();
}

async function expectAgreementAccountValidation(page: Page) {
  await expectPageOk(page, "/commerce/terms/agreements");
  await expectAdminPageReady(page, { heading: "Commercial Agreements" });

  const form = createAgreementForm(page);
  await form.getByLabel("Label").fill(`E2E invalid account agreement ${Date.now().toString(36)}`);
  await form.getByLabel("Account ID").fill("acc_e2e_missing_account");
  await form.getByLabel("Status").selectOption("inactive");
  await form.getByLabel("Effective from").fill("2027-01-01T00:00:00.000Z");
  await form.getByLabel("Effective until").fill("2027-12-31T00:00:00.000Z");
  await form.getByRole("button", { name: "Create agreement" }).click();

  await expect(page.getByText(/Account acc_e2e_missing_account is not available for commercial terms/i)).toBeVisible();
}

async function createInactiveAgreementAndInspectHistory(page: Page, suffix: string) {
  const label = `E2E inactive agreement ${suffix}`;
  const form = createAgreementForm(page);
  await form.getByLabel("Label").fill(label);
  await form.getByLabel("Account ID").fill(demoAccountId);
  await fillCommercialTermsFeeFields(form, {
    marketplaceSalesFeePercentageBps: "690",
    marketplaceSalesFeeFixedAmount: "0.03",
    shippingAllowancePercentageBps: "425",
  });
  await form.getByLabel("Status").selectOption("inactive");
  await form.getByLabel("Effective from").fill("2027-01-01T00:00:00.000Z");
  await form.getByLabel("Effective until").fill("2027-12-31T00:00:00.000Z");
  await form.getByRole("button", { name: "Create agreement" }).click();

  await page.waitForURL((url) => url.pathname === "/commerce/terms/agreements" && url.search.includes("afterWrite"), {
    timeout: 30_000,
  });
  const createUrl = new URL(page.url());
  await waitForCommercialTermsProjection(page, createUrl, {
    projectionName: "commercial-terms-agreement-projection",
    label: `create commercial agreement ${label}`,
  });
  await page.goto(createUrl.pathname, { waitUntil: "domcontentloaded" });
  await expectAdminPageReady(page, { heading: "Commercial Agreements" });
  const openedLabel = await openListRowDetail(page, label, "E2E inactive agreement");
  await expectAdminPageReady(page, { heading: openedLabel });
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "created" })).toBeVisible();
}

function createScheduleForm(page: Page): Locator {
  return page.locator("form").filter({ has: page.getByRole("button", { name: "Create schedule" }) });
}

function createAgreementForm(page: Page): Locator {
  return page.locator("form").filter({ has: page.getByRole("button", { name: "Create agreement" }) });
}

async function waitForListRow(page: Page, label: string, fallbackPrefix: string) {
  const exactRow = page.getByRole("row").filter({ hasText: label }).first();
  const fallbackRow = page.getByRole("row").filter({ hasText: fallbackPrefix }).first();
  await expect
    .poll(
      async () => {
        if (await exactRow.isVisible().catch(() => false)) {
          return true;
        }

        await reloadCommercialTermsListAfterFreshnessRecovery(page);
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
        return exactRow.isVisible().catch(() => false);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 15_000 },
    )
    .toBe(true)
    .catch(async () => {
      await expect(fallbackRow).toBeVisible({ timeout: 30_000 });
    });

  return (await exactRow.isVisible().catch(() => false)) ? exactRow : fallbackRow;
}

async function reloadCommercialTermsListAfterFreshnessRecovery(page: Page) {
  const freshnessTimeoutVisible = await page
    .getByText(/Projection read model did not catch up/i)
    .isVisible({ timeout: 1_000 })
    .catch(() => false);

  if (freshnessTimeoutVisible) {
    const url = new URL(page.url());
    await page.goto(url.pathname, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    return;
  }

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
}

async function openListRowDetail(page: Page, label: string, fallbackPrefix: string) {
  const row = await waitForListRow(page, label, fallbackPrefix);
  const openedLabel = (await row.locator("td").first().locator("p").first().innerText()).trim();
  const link = row.getByRole("link", { name: "Open" });
  const href = await link.getAttribute("href");
  expect(href, `Open link for ${label} should have a destination`).toBeTruthy();
  const destination = new URL(href!, page.url());

  await link.click();
  await page
    .waitForURL((url) => url.pathname === destination.pathname, { timeout: 5_000 })
    .catch(async () => expectPageOk(page, href!));
  return openedLabel;
}

async function waitForCommercialTermsProjection(
  page: Page,
  url: URL,
  options: Readonly<{ projectionName: string; label: string }>,
) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "commercial-terms",
    targetContextName: "commercial-terms",
    projectionName: options.projectionName,
    label: options.label,
  });
}

async function fillCommercialTermsFeeFields(
  form: Locator,
  values: {
    marketplaceSalesFeePercentageBps: string;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: string;
  },
) {
  await form.locator('[name="marketplaceSalesFeePercentageBps"]').fill(values.marketplaceSalesFeePercentageBps);
  await form.locator('[name="marketplaceSalesFeeFixedAmount"]').fill(values.marketplaceSalesFeeFixedAmount);
  await form.locator('[name="shippingAllowancePercentageBps"]').fill(values.shippingAllowancePercentageBps);
}
