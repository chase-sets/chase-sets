import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { projectSyntheticPricingHealthPolicy, seedSyntheticPricingHealthInputs } from "@chase-sets/pricing/server";
import { captureAccessibilityEvidence, captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const healthApi = "/api/marketplace/account/pricing-health";
const policiesApi = "/api/marketplace/account/repricing-policies";
const listingId = "lst_seed_charizard_base_set_psa_8";
const policyName = "Synthetic Pricing Health browser what-if";
const policyBody = {
  scope: { kind: "listing-set", listingIds: [listingId] },
  excludedListingIds: [],
  maxChangesPerDay: 25,
  rules: [
    {
      conditions: [],
      directive: {
        currencyCode: "USD",
        anchorChain: [
          { source: "curve-objective", goalId: "target-horizon", goalVersion: 1, parameters: { horizonDays: 30 } },
        ],
        offset: { mode: "absolute", amount: "0" },
        floor: { mode: "absolute", amount: "1.00" },
        ceiling: null,
        tolerance: { mode: "absolute", amount: "100000.00" },
        rounding: { mode: "none" },
        maxMovePercent: 10,
        terminal: { kind: "hold" },
      },
    },
  ],
};

async function createPolicy(request: APIRequestContext, pool: PgTransactionalPool) {
  const started = await request.post(`${policiesApi}/dry-runs`, { data: policyBody });
  expect(started.status()).toBe(202);
  const { dryRunId } = await started.json();
  await expect
    .poll(async () => (await (await request.get(`${policiesApi}/dry-runs/${dryRunId}`)).json()).status, {
      timeout: 60_000,
      intervals: [500, 1000, 2000],
    })
    .toBe("completed");
  const created = await request.post(policiesApi, { data: { dryRunId, name: policyName } });
  expect(created.status()).toBe(201);
  const { policyId, accountId } = await created.json();
  expect(typeof policyId).toBe("string");
  await projectSyntheticPricingHealthPolicy(pool, { accountId, policyId });
  return { policyId: policyId as string, accountId: accountId as string };
}

async function traverseSampleTables(page: Page, testInfo: TestInfo) {
  const tables = page.getByTestId("pricing-health-what-if").getByRole("table");
  const tableCount = await tables.count();
  const visitedTables = new Set<number>();
  for (let step = 0; step < 120 && visitedTables.size < tableCount; step += 1) {
    await page.keyboard.press("Tab");
    const index = await tables.evaluateAll((nodes) => nodes.findIndex((node) => node === document.activeElement));
    if (index >= 0) visitedTables.add(index);
  }
  expect(visitedTables.size).toBe(tableCount);
  expect(tableCount).toBeGreaterThanOrEqual(4);
  await testInfo.attach(`what-if-keyboard-${page.viewportSize()!.width}`, {
    body: JSON.stringify({ viewport: page.viewportSize(), tableCount, visitedTables: [...visitedTables] }),
    contentType: "application/json",
  });
}

test("Pricing Health renders preview-only horizon and hurdle panels without mutation @marketplace-seller @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const sandbox = parseEnv(
    readFileSync(
      process.env.CHASE_SETS_SANDBOX_ENV_FILE ?? new URL("../../../.env.sandbox.local", import.meta.url),
      "utf8",
    ),
  );
  const companion = testInfo.config.metadata.catalogDatabaseUrl;
  if (typeof companion !== "string" || companion !== sandbox.DATABASE_URL_CATALOG || !sandbox.DATABASE_URL_PRICING)
    throw new Error("Pricing Health what-if requires the current owned browser sandbox.");
  const pricingUrl = new URL(sandbox.DATABASE_URL_PRICING);
  const catalogUrl = new URL(companion);
  if (
    !["localhost", "127.0.0.1"].includes(pricingUrl.hostname) ||
    pricingUrl.host !== catalogUrl.host ||
    !/^\/cs_[a-z0-9_]+_pricing$/.test(pricingUrl.pathname) ||
    pricingUrl.pathname !== catalogUrl.pathname.replace(/_catalog$/, "_pricing")
  )
    throw new Error("Pricing Health what-if refuses a non-owned database.");
  const pool = createPgPool(pricingUrl.toString(), { max: 1 });
  let created: { policyId: string; accountId: string } | undefined;
  let fixture: Awaited<ReturnType<typeof seedSyntheticPricingHealthInputs>> | undefined;
  try {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk%2Fpricing-health", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
    await expect(page).toHaveURL(/\/account\/desk\/pricing-health(?:\?|$)/);
    created = await createPolicy(page.request, pool);
    fixture = await seedSyntheticPricingHealthInputs(pool, {
      accountId: created.accountId,
      listingId,
      whatIfPortfolios: true,
    });
    const url = `${healthApi}?policyId=${encodeURIComponent(created.policyId)}`;
    const before = await page.request.get(url);
    expect(before.ok()).toBe(true);
    const beforeBody = await before.json();
    expect(beforeBody.target?.policyId).toBe(created.policyId);
    await page.goto(`/account/desk/pricing-health?policyId=${encodeURIComponent(created.policyId)}`);
    await expect(page.getByTestId("pricing-health-page")).toBeVisible();
    await expect(page.getByTestId("pricing-health-what-if")).toBeVisible();
    await expect(page.getByText("Horizon value curve", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Hurdle sweep", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Overall portfolio", { exact: true })).toBeVisible();
    for (const key of ["overall", "ref_synthetic_what_if_a", "ref_synthetic_what_if_b", "__none__"]) {
      const panel = page.getByTestId(`pricing-health-what-if-${key}`);
      await expect(panel.getByRole("img", { name: /Horizon value curve/ })).toBeVisible();
      await expect(panel.getByRole("table").first()).toBeVisible();
    }
    await expect(page.getByText("Synthetic Product Line A", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic Product Line B", { exact: true })).toBeVisible();
    await expect(page.getByText("No product line", { exact: true })).toBeVisible();
    const evidenceRoute = `/account/desk/pricing-health?policyId=${encodeURIComponent(created.policyId)}`;
    await expect(
      page
        .getByTestId("pricing-health-what-if-ref_synthetic_what_if_a")
        .getByText("No Economics snapshot is available for this sweep", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 360, height: 800 });
    await traverseSampleTables(page, testInfo);
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await captureResponsiveEvidence({
      page,
      testInfo,
      claimId: "pricing-health-what-if-360",
      routePath: evidenceRoute,
    });
    await captureAccessibilityEvidence({ page, testInfo, surface: "Pricing Health what-if panels 360x800" });
    await page.setViewportSize({ width: 390, height: 844 });
    await traverseSampleTables(page, testInfo);
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await captureResponsiveEvidence({
      page,
      testInfo,
      claimId: "pricing-health-what-if-390",
      routePath: evidenceRoute,
    });
    await captureAccessibilityEvidence({ page, testInfo, surface: "Pricing Health what-if panels 390x844" });
    await page.setViewportSize({ width: 820, height: 1180 });
    await traverseSampleTables(page, testInfo);
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await captureResponsiveEvidence({
      page,
      testInfo,
      claimId: "pricing-health-what-if-tablet",
      routePath: evidenceRoute,
    });
    await captureAccessibilityEvidence({ page, testInfo, surface: "Pricing Health what-if panels 820x1180" });
    const after = await page.request.get(url);
    const afterBody = await after.json();
    const withoutSnapshotHashes = (body: typeof beforeBody) => ({
      target: body.target,
      whatIf:
        body.whatIf === null
          ? null
          : {
              portfolios: body.whatIf.portfolios.map((portfolio: Record<string, unknown>) =>
                Object.fromEntries(Object.entries(portfolio).filter(([key]) => key !== "snapshotHash")),
              ),
            },
    });
    expect(withoutSnapshotHashes(afterBody)).toEqual(withoutSnapshotHashes(beforeBody));
  } finally {
    if (created) {
      const deleted = await page.request.post(`${policiesApi}/${created.policyId}/delete`);
      expect(deleted.status()).toBe(200);
      await projectSyntheticPricingHealthPolicy(pool, created);
    }
    await fixture?.cleanup();
    await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
  }
});
