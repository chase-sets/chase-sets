import { expect, test, type APIRequestContext } from "@playwright/test";
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
          { source: "curve-objective", goalId: "fixed-percentile", goalVersion: 1, parameters: { percentile: 50 } },
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
    fixture = await seedSyntheticPricingHealthInputs(pool, { accountId: created.accountId, listingId });
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
    await page.setViewportSize({ width: 360, height: 800 });
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-what-if-360" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-what-if-390" });
    await page.setViewportSize({ width: 820, height: 1180 });
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-what-if-tablet" });
    await captureAccessibilityEvidence({ page, testInfo, surface: "Pricing Health what-if panels" });
    const after = await page.request.get(url);
    expect(await after.json()).toMatchObject({ target: beforeBody.target, whatIf: beforeBody.whatIf });
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
