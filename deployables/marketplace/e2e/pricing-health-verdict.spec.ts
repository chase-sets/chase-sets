import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { projectSyntheticPricingHealthPolicy, seedSyntheticPricingHealthInputs } from "@chase-sets/pricing/server";
import { formatMoney } from "@chase-sets/localization";
import { captureAccessibilityEvidence, captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const api = "/api/marketplace/account/pricing-health";
const policiesApi = "/api/marketplace/account/repricing-policies";
const listingId = "lst_seed_charizard_base_set_psa_8";
const prefix = "Synthetic Pricing Health browser";
const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
];
const body = {
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

async function createPolicy(request: APIRequestContext, pool: PgTransactionalPool, createdIds: string[], name: string) {
  const start = await request.post(`${policiesApi}/dry-runs`, { data: body });
  expect(start.status()).toBe(202);
  const { dryRunId } = await start.json();
  await expect
    .poll(async () => (await (await request.get(`${policiesApi}/dry-runs/${dryRunId}`)).json()).status, {
      timeout: 60_000,
      intervals: [500, 1000, 2000],
    })
    .toBe("completed");
  const created = await request.post(policiesApi, { data: { dryRunId, name } });
  expect(created.status()).toBe(201);
  const { policyId, accountId } = await created.json();
  expect(typeof policyId).toBe("string");
  createdIds.push(policyId);
  await projectSyntheticPricingHealthPolicy(pool, { accountId, policyId });
  await expect
    .poll(async () =>
      (await (await request.get(policiesApi)).json()).some((p: { policyId: string }) => p.policyId === policyId),
    )
    .toBe(true);
  return policyId as string;
}

async function usableAtEveryViewport(page: Page, visibleText: string) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("pricing-health-page")).toBeVisible();
    await expect(page.getByText(visibleText, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    expect(
      await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    const buttons = page.getByTestId("pricing-health-page").getByRole("button");
    for (const button of await buttons.all()) {
      const bounds = await button.boundingBox();
      if (bounds) expect(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1).toBe(true);
    }
  }
}

test("mounted Pricing Health reads a nonempty stored verdict and disclosed cohort at mobile and tablet sizes @marketplace-seller @browser-e2e-seed", async ({
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
    throw new Error("Pricing Health requires the current owned browser sandbox.");
  const pricingUrl = new URL(sandbox.DATABASE_URL_PRICING);
  const catalogUrl = new URL(companion);
  if (
    !["localhost", "127.0.0.1"].includes(pricingUrl.hostname) ||
    pricingUrl.host !== catalogUrl.host ||
    !/^\/cs_[a-z0-9_]+_pricing$/.test(pricingUrl.pathname) ||
    pricingUrl.pathname !== catalogUrl.pathname.replace(/_catalog$/, "_pricing")
  )
    throw new Error("Pricing Health fixture refuses a non-owned database.");
  const pool = createPgPool(pricingUrl.toString(), { max: 1 });
  const created: string[] = [];
  let fixture: Awaited<ReturnType<typeof seedSyntheticPricingHealthInputs>> | undefined;
  try {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk%2Frepricing");
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
    await expect(page).toHaveURL(/\/account\/desk\/repricing(?:\?|$)/);
    // Shared seller suite is serial. Remove only this spec's interrupted policies.
    const existing = await (await page.request.get(policiesApi)).json();
    for (const policy of existing.filter((p: { name: string }) => p.name?.startsWith(prefix))) {
      expect((await page.request.post(`${policiesApi}/${policy.policyId}/delete`)).status()).toBe(200);
      await projectSyntheticPricingHealthPolicy(pool, { accountId: policy.accountId, policyId: policy.policyId });
    }
    await expect
      .poll(
        async () =>
          (await (await page.request.get(policiesApi)).json()).filter((p: { status: string }) => p.status === "active")
            .length,
      )
      .toBe(0);
    await page.getByRole("link", { name: "Pricing Health", exact: true }).click();
    await usableAtEveryViewport(page, "No active repricing policy");
    await expect(page.getByRole("link", { name: "Create repricing policy", exact: true })).toBeVisible();

    const policyId = await createPolicy(page.request, pool, created, `${prefix} incumbent`);
    await page.reload();
    await usableAtEveryViewport(page, "No verdict for this policy revision yet");
    await expect(page.getByRole("button", { name: "Compute verdict", exact: true })).toBeVisible();
    expect((await (await page.request.get(api)).json()).health).toBeNull();
    await createPolicy(page.request, pool, created, `${prefix} second`);
    await page.reload();
    await usableAtEveryViewport(page, "Select an active policy to see its verdict");
    await page.getByRole("combobox", { name: "Active policy", exact: true }).selectOption(policyId);
    await page.getByRole("button", { name: "Show verdict", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("policyId") === policyId);
    expect((await page.request.get(`${api}?policyId=rpp_synthetic_foreign`)).status()).toBe(404);

    const ownedPolicy = await page.request.get(`${policiesApi}/${policyId}`);
    expect(ownedPolicy.status()).toBe(200);
    const { accountId } = await ownedPolicy.json();
    expect(typeof accountId).toBe("string");
    fixture = await seedSyntheticPricingHealthInputs(pool, { accountId, listingId });
    await page.getByRole("button", { name: "Compute verdict", exact: true }).click();
    await expect(page.getByTestId("pricing-health-summary")).toBeVisible({ timeout: 60_000 });
    const response = await page.request.get(`${api}?policyId=${policyId}`);
    expect(response.status()).toBe(200);
    const stored = await response.json();
    expect(stored.target.policyId).toBe(policyId);
    expect(stored.health.currencies.USD.modeledValueAmount).toBe(fixture.expected.modeledValueAmount);
    expect(stored.health.currencies.USD.expectedSales).toEqual({
      listingCount: 0.6321205588285577,
      valueAmount: fixture.expected.expectedSalesValueAmount,
    });
    // Both exact values come through the real loader. No route interception or summary injection.
    await expect(page.getByTestId("health-s2")).toHaveText(formatMoney(fixture.expected.modeledValueAmount, "USD"));
    await expect(page.getByTestId("health-s6")).toHaveText(
      `0.6321 listings; ${formatMoney(fixture.expected.expectedSalesValueAmount, "USD")}`,
    );
    await expect(page.getByTestId("forecast-grade-panel")).toContainText("Sold share");
    await expect(page.getByTestId("forecast-grade-panel")).toContainText("across all sellers using this goal version");
    await usableAtEveryViewport(page, "S2 Modeled value");
    await page.setViewportSize(viewports[0]!);
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-populated-0" });
    await page.setViewportSize(viewports[1]!);
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-populated-1" });
    await page.setViewportSize(viewports[2]!);
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-populated-2" });
    await captureAccessibilityEvidence({ page, testInfo, surface: "Pricing Health populated platform grades" });

    // Separate synthetic presentation controls mutate only this spec's retained
    // snapshot, after the nonempty real-worker/live-loader proof above.
    await pool.query(
      "UPDATE pricing_forecast_grades SET grade=jsonb_set(grade, '{count}', '29') WHERE model='synthetic-pricing-health-e2e'",
    );
    await page.reload();
    await usableAtEveryViewport(page, "No graded cohort yet");
    const undisclosed = (await (await page.request.get(`${api}?policyId=${policyId}`)).json()).grades.find(
      (grade: { model: string }) => grade.model === "synthetic-pricing-health-e2e",
    );
    expect(undisclosed.status).toBe("undisclosed");
    expect(JSON.stringify(undisclosed)).not.toMatch(/count|soldShare|expectedShare|brier|deciles/i);
    await pool.query(
      "UPDATE pricing_forecast_grades SET grade=jsonb_set(grade, '{count}', '30') WHERE model='synthetic-pricing-health-e2e'",
    );
    const empty = { ...stored.health, population: { listingCount: 0, unitCount: 0 }, currencies: {} };
    await pool.query("UPDATE pricing_repricing_dry_runs SET health=$2::jsonb WHERE dry_run_id=$1", [
      stored.run.dryRunId,
      JSON.stringify(empty),
    ]);
    await page.reload();
    await usableAtEveryViewport(page, "No listings in the captured policy scope");
    const noModeled = structuredClone(stored.health);
    const usd = noModeled.currencies.USD;
    usd.coverage = {
      ...usd.coverage,
      listingCount: 0,
      unitCount: 0,
      listingRatio: 0,
      unitRatio: 0,
      missingReasons: { "no-curve": 1 },
      boundStatusCount: 0,
    };
    usd.curveAge = { newestAgeDays: null, oldestAgeDays: null, staleCount: 0 };
    usd.expectedWait = { medianDays: null, p90Days: null };
    usd.expectedSales = { listingCount: 0, valueAmount: "0.00" };
    usd.profitPerDay = {
      ...usd.profitPerDay,
      value: null,
      cycleDays: null,
      economicsListingCount: 0,
      unavailableReason: "no-modeled-listings",
    };
    usd.capitalTurn = {
      ...usd.capitalTurn,
      value: null,
      cycleDays: null,
      dailyReturnHurdle: null,
      unavailableReason: "no-modeled-listings",
    };
    await pool.query("UPDATE pricing_repricing_dry_runs SET health=$2::jsonb WHERE dry_run_id=$1", [
      stored.run.dryRunId,
      JSON.stringify(noModeled),
    ]);
    await page.reload();
    await usableAtEveryViewport(page, "No modeled listings in this currency");
    await pool.query("UPDATE pricing_repricing_dry_runs SET health=$2::jsonb WHERE dry_run_id=$1", [
      stored.run.dryRunId,
      JSON.stringify(stored.health),
    ]);

    // Hold the genuine request, not its payload, to exercise the route's loading state.
    const dataRoute = /\/account\/desk\/pricing-health\.data(?:\?|$)/;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(dataRoute, async (route) => {
      await held;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: "Show verdict", exact: true }).click({ noWaitAfter: true });
      await usableAtEveryViewport(page, "Loading Pricing Health");
    } finally {
      release();
      await page.unroute(dataRoute);
    }
    await expect(page.getByTestId("pricing-health-summary")).toBeVisible();

    // A synthetic future-eligible request holds the computing presentation.
    // This is not worker execution evidence; the completed run above is.
    const pendingId = `synthetic-health-pending-${Date.now()}`;
    await pool.query(
      `INSERT INTO pricing_repricing_dry_runs
      (dry_run_id, seller_account_id, replacing_policy_id, body, body_hash, status, requested_at, updated_at)
      SELECT $2, seller_account_id, replacing_policy_id, body, body_hash, 'queued', now(), now()
      FROM pricing_repricing_dry_runs WHERE dry_run_id=$1`,
      [stored.run.dryRunId, pendingId],
    );
    await pool.query(
      `INSERT INTO pricing_repricing_dry_run_jobs
      (job_id, job_kind, status, payload, created_at, updated_at, next_eligible_at)
      SELECT $2, job_kind, 'queued', jsonb_set(payload, '{dryRunId}', to_jsonb($2::text)), now(), now(), now()+interval '1 day'
      FROM pricing_repricing_dry_run_jobs WHERE job_id=$1`,
      [stored.run.dryRunId, pendingId],
    );
    try {
      await page.reload();
      await usableAtEveryViewport(page, "Computing verdict. The last completed snapshot stays visible.");
    } finally {
      await pool.query("DELETE FROM pricing_repricing_dry_run_jobs WHERE job_id=$1", [pendingId]);
      await pool.query("DELETE FROM pricing_repricing_dry_runs WHERE dry_run_id=$1", [pendingId]);
    }

    const outageDocument = "pol_synthetic_pricing_health_outage";
    await pool.query(
      `INSERT INTO platform_policy_documents
      (document_id, policy_key, context_name, schema_summary, status, value, effective_from, created_at, updated_at)
      VALUES ($1, 'pricing.forecast-ledger', 'pricing', 'synthetic invalid-source control', 'active', '{"horizonsDays":[]}', now(), now(), now())`,
      [outageDocument],
    );
    try {
      await page.reload();
      await usableAtEveryViewport(page, "Pricing Health is unavailable");
    } finally {
      await pool.query("DELETE FROM platform_policy_documents WHERE document_id=$1", [outageDocument]);
    }
  } finally {
    try {
      for (const policyId of created) {
        const deleted = await page.request.post(`${policiesApi}/${policyId}/delete`);
        expect(deleted.status()).toBe(200);
        const policy = await deleted.json();
        await projectSyntheticPricingHealthPolicy(pool, { accountId: policy.accountId, policyId });
      }
      await expect
        .poll(
          async () =>
            (await (await page.request.get(policiesApi)).json()).filter(
              (p: { status: string }) => p.status === "active",
            ).length,
        )
        .toBe(0);
    } finally {
      try {
        await fixture?.cleanup();
      } finally {
        await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
      }
    }
  }
});
