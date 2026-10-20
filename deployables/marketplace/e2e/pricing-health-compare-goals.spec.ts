import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { closeMultiContextTestPools } from "@chase-sets/bounded-context-runtime/test-support";
import { projectSyntheticPricingHealthPolicy, seedSyntheticPricingHealthInputs } from "@chase-sets/pricing/server";
import { captureAccessibilityEvidence, captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const policiesApi = "/api/marketplace/account/repricing-policies";
const healthApi = "/api/marketplace/account/pricing-health";
const listingId = "lst_seed_charizard_base_set_psa_8";

test("compare eligible Pricing Goals over the entire selected policy without mutation @marketplace-seller @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  const sandbox = parseEnv(
    readFileSync(
      process.env.CHASE_SETS_SANDBOX_ENV_FILE ?? new URL("../../../.env.sandbox.local", import.meta.url),
      "utf8",
    ),
  );
  const companion = testInfo.config.metadata.catalogDatabaseUrl;
  if (typeof companion !== "string" || companion !== sandbox.DATABASE_URL_CATALOG || !sandbox.DATABASE_URL_PRICING)
    throw new Error("Pricing Goal comparison requires the current owned browser sandbox.");
  const pricingUrl = new URL(sandbox.DATABASE_URL_PRICING);
  const catalogUrl = new URL(companion);
  if (
    !["localhost", "127.0.0.1"].includes(pricingUrl.hostname) ||
    pricingUrl.host !== catalogUrl.host ||
    !/^\/cs_[a-z0-9_]+_pricing$/.test(pricingUrl.pathname) ||
    pricingUrl.pathname !== catalogUrl.pathname.replace(/_catalog$/, "_pricing")
  )
    throw new Error("Pricing Goal comparison refuses a non-owned database.");
  const pool = createPgPool(pricingUrl.toString(), { max: 1 });
  let created: { policyId: string; accountId: string } | undefined;
  let fixture: Awaited<ReturnType<typeof seedSyntheticPricingHealthInputs>> | undefined;
  try {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk%2Frepricing");
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
    await expect(page).toHaveURL(/\/account\/desk\/repricing(?:\?|$)/);
    const body = {
      scope: { kind: "listing-set", listingIds: [listingId] },
      excludedListingIds: [],
      maxChangesPerDay: 25,
      rules: [
        {
          conditions: [],
          directive: {
            currencyCode: "USD",
            anchorChain: [{ source: "market-estimate" }],
            offset: { mode: "percent", percent: 5 },
            floor: { mode: "absolute", amount: "1.00" },
            ceiling: null,
            tolerance: { mode: "absolute", amount: "0.01" },
            rounding: { mode: "none" },
            maxMovePercent: 10,
            terminal: { kind: "hold" },
          },
        },
      ],
    };
    const started = await page.request.post(`${policiesApi}/dry-runs`, { data: body });
    expect(started.status()).toBe(202);
    const { dryRunId } = await started.json();
    await expect
      .poll(async () => (await (await page.request.get(`${policiesApi}/dry-runs/${dryRunId}`)).json()).status, {
        timeout: 60_000,
        intervals: [500, 1000, 2000],
      })
      .toBe("completed");
    const response = await page.request.post(policiesApi, {
      data: { dryRunId, name: "Synthetic Pricing Health browser goal comparison" },
    });
    expect(response.status()).toBe(201);
    const policy = await response.json();
    created = { policyId: policy.policyId, accountId: policy.accountId };
    await projectSyntheticPricingHealthPolicy(pool, created);
    fixture = await seedSyntheticPricingHealthInputs(pool, { accountId: created.accountId, listingId });
    const before = await (await page.request.get(`${policiesApi}/${created.policyId}`)).json();
    await page.goto(`/account/desk/pricing-health?policyId=${created.policyId}`);
    const compare = page.getByRole("button", { name: "Compare goals", exact: true });
    await expect(compare).toBeVisible();
    await compare.focus();
    await expect(compare).toBeFocused();
    await page.keyboard.press("Enter");
    const read = async () => await (await page.request.get(`${healthApi}?policyId=${created!.policyId}`)).json();
    await expect
      .poll(
        async () => {
          const data = await read();
          return (
            data.goals.length > 0 &&
            data.comparison.length === data.goals.length &&
            data.comparison.every((row: { status: string }) => row.status === "completed")
          );
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const completed = await read();
    expect(completed.comparison.length).toBeGreaterThan(0);
    let movement = 0;
    for (const row of completed.comparison) {
      expect(row.targetPolicyId).toBe(created.policyId);
      expect(row.scopeLabel).toBe("Entire selected policy candidate scope");
      expect(row.listingCount).toBe(1);
      expect(row.raised + row.lowered + row.held).toBe(row.listingCount);
      expect(row.bodyHash).toMatch(/^[a-f0-9]{64}$/);
      movement += row.raised + row.lowered;
    }
    expect(movement).toBeGreaterThan(0);
    // The mounted route must observe worker completion without an explicit page reload.
    await expect(page.getByTestId("pricing-health-goal-comparison")).toContainText("completed");
    expect(await (await page.request.get(`${policiesApi}/${created.policyId}`)).json()).toEqual(before);
    const viewports = [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const disclosure = page.getByRole("button", { name: "Advanced controls and provenance", exact: true }).first();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await disclosure.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(
        await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
      await captureAccessibilityEvidence({ page, testInfo, surface: `Pricing Goal comparison ${viewport.width}` });
      await disclosure.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    }
    const disclosure = page.getByRole("button", { name: "Advanced controls and provenance", exact: true }).first();
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await page.setViewportSize({ width: 360, height: 800 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-comparison-360" });
    await page.setViewportSize({ width: 390, height: 844 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-comparison-390" });
    await page.setViewportSize({ width: 820, height: 1180 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-comparison-tablet" });
  } finally {
    try {
      if (created) {
        expect((await page.request.post(`${policiesApi}/${created.policyId}/delete`)).status()).toBe(200);
        await projectSyntheticPricingHealthPolicy(pool, created);
      }
    } finally {
      try {
        await fixture?.cleanup();
      } finally {
        await closeMultiContextTestPools({ pricing: pool });
      }
    }
  }
});
