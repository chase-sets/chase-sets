import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

const demoAccountId = "acc_seed_demo_account";
const commercialTermsProjectionName = "platform-policy-document-projection";

test.describe("commerce admin commercial terms", () => {
  test("operator manages fee schedules and commercial agreements @admin-commerce", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/commerce/terms", "/access/sign-in");
    const suffix = Date.now().toString(36);
    await expectScheduleOverlapValidation(page, suffix);
    await createInactiveScheduleAndInspectHistory(page, suffix);
    await createInactiveAgreementAndInspectHistory(page, suffix);
  });
});

// The schedules and agreements admin surfaces were unified onto a single
// /commerce/terms home page. Creating or revising a term happens in an
// in-place edit sheet; a successful write redirects back to /commerce/terms
// with the created term selected (and a fresh-write receipt token), so the
// sheet reopens on the new record's revision history.

async function openCommercialTermsHome(page: Page) {
  await expectPageOk(page, "/commerce/terms");
  await expectAdminPageReady(page, { heading: "Commercial Terms" });
}

async function expectScheduleOverlapValidation(page: Page, suffix: string) {
  await openCommercialTermsHome(page);

  const effectiveFrom = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000 + Math.random() * 10_000_000_000);
  const effectiveUntil = new Date(effectiveFrom.getTime() + 1_000);
  const activeLabel = `E2E overlap baseline ${suffix}`;

  const baselineForm = await openCreateScheduleSheet(page);
  await baselineForm.getByLabel("Account type").selectOption("business");
  await baselineForm.getByLabel("Label").fill(activeLabel);
  await baselineForm.getByLabel("Status").selectOption("active");
  await baselineForm.getByLabel("Effective from").fill(effectiveFrom.toISOString());
  await baselineForm.getByLabel("Effective until").fill(effectiveUntil.toISOString());
  await baselineForm.getByRole("button", { name: "Save schedule", exact: true }).click();

  const createUrl = await waitForCommercialTermsWrite(page, "schedule");
  await waitForCommercialTermsProjection(page, createUrl, {
    projectionName: commercialTermsProjectionName,
    label: `create overlap baseline schedule ${activeLabel}`,
  });

  await openCommercialTermsHome(page);
  const overlapForm = await openCreateScheduleSheet(page);
  await overlapForm.getByLabel("Account type").selectOption("business");
  await overlapForm.getByLabel("Label").fill(`E2E overlapping business schedule ${suffix}`);
  await overlapForm.getByLabel("Status").selectOption("active");
  await overlapForm.getByLabel("Effective from").fill(effectiveFrom.toISOString());
  await overlapForm.getByLabel("Effective until").fill(effectiveUntil.toISOString());
  await overlapForm.getByRole("button", { name: "Save schedule", exact: true }).click();

  await expect(page.getByText(/already covers that account type and effective window/i)).toBeVisible();
}

async function createInactiveScheduleAndInspectHistory(page: Page, suffix: string) {
  const label = `E2E inactive schedule ${suffix}`;
  await openCommercialTermsHome(page);

  const form = await openCreateScheduleSheet(page);
  await form.getByLabel("Account type").selectOption("enterprise");
  await form.getByLabel("Label").fill(label);
  await fillCommercialTermsFeeFields(form, {
    marketplaceSalesFeePercentageBps: "640",
    marketplaceSalesFeeFixedAmount: "0.02",
    shippingAllowancePercentageBps: "450",
  });
  await form.getByLabel("Status").selectOption("inactive");
  await form.getByLabel("Effective from").fill("2027-01-01T00:00:00.000Z");
  await form.getByLabel("Effective until").fill("2027-12-31T00:00:00.000Z");
  await form.getByRole("button", { name: "Save schedule", exact: true }).click();

  const createUrl = await waitForCommercialTermsWrite(page, "schedule");
  await waitForCommercialTermsProjection(page, createUrl, {
    projectionName: commercialTermsProjectionName,
    label: `create commercial terms schedule ${label}`,
  });

  await reopenCommercialTerm(page, "schedule", createUrl);
  await expectCommercialTermRevisionHistory(page);
}

async function createInactiveAgreementAndInspectHistory(page: Page, suffix: string) {
  const label = `E2E inactive agreement ${suffix}`;
  await openCommercialTermsHome(page);

  const form = await openCreateAgreementSheet(page);
  await form.getByLabel("Account", { exact: true }).selectOption(demoAccountId);
  await form.getByLabel("Label").fill(label);
  await fillCommercialTermsFeeFields(form, {
    marketplaceSalesFeePercentageBps: "690",
    marketplaceSalesFeeFixedAmount: "0.03",
    shippingAllowancePercentageBps: "425",
  });
  await form.getByLabel("Status").selectOption("inactive");
  await form.getByLabel("Effective from").fill("2027-01-01T00:00:00.000Z");
  await form.getByLabel("Effective until").fill("2027-12-31T00:00:00.000Z");
  await form.getByRole("button", { name: "Save account override", exact: true }).click();

  const createUrl = await waitForCommercialTermsWrite(page, "agreement");
  await waitForCommercialTermsProjection(page, createUrl, {
    projectionName: commercialTermsProjectionName,
    label: `create commercial agreement ${label}`,
  });

  await reopenCommercialTerm(page, "agreement", createUrl);
  await expectCommercialTermRevisionHistory(page);
}

async function openCreateScheduleSheet(page: Page): Promise<Locator> {
  await page.getByRole("link", { name: "Create schedule", exact: true }).click();
  const form = scheduleCreateForm(page);
  await expect(form.getByRole("button", { name: "Save schedule", exact: true })).toBeVisible();
  return form;
}

async function openCreateAgreementSheet(page: Page): Promise<Locator> {
  await page.getByRole("link", { name: "Create account override", exact: true }).click();
  const form = agreementCreateForm(page);
  await expect(form.getByRole("button", { name: "Save account override", exact: true })).toBeVisible();
  return form;
}

function scheduleCreateForm(page: Page): Locator {
  return page.locator("form").filter({ has: page.getByRole("button", { name: "Save schedule", exact: true }) });
}

function agreementCreateForm(page: Page): Locator {
  return page.locator("form").filter({ has: page.getByRole("button", { name: "Save account override", exact: true }) });
}

async function waitForCommercialTermsWrite(page: Page, kind: "schedule" | "agreement"): Promise<URL> {
  await page.waitForURL(
    (url) => url.pathname === "/commerce/terms" && url.searchParams.has(kind) && url.search.includes("afterWrite"),
    { timeout: 30_000 },
  );
  return new URL(page.url());
}

async function reopenCommercialTerm(page: Page, kind: "schedule" | "agreement", createUrl: URL) {
  const id = createUrl.searchParams.get(kind);
  expect(id, `created ${kind} id should be present in the post-write url`).toBeTruthy();
  await page.goto(`/commerce/terms?${kind}=${encodeURIComponent(id!)}`, { waitUntil: "domcontentloaded" });
}

async function expectCommercialTermRevisionHistory(page: Page) {
  await expect(page.getByText("Revision history")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/created/i).first()).toBeVisible();
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
