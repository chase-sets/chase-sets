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

type Candidate = {
  goalId: string;
  goalVersion: number;
  dryRunId: string;
  status: string;
  bodyHash: string;
  targetPolicyId: string;
  targetRevision: number;
  listingCount: number | null;
  raised: number | null;
  lowered: number | null;
  held: number | null;
  parameters: Record<string, number>;
  currencyCode: string | null;
  floor: unknown;
  guardrails: unknown[];
};
type HealthResponse = {
  target: { policyId: string; version: number; bodyHash: string } | null;
  comparison: Candidate[];
};

test("applies one compared Pricing Goal with fenced confirmation @marketplace-seller @browser-e2e-seed", async ({
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
    throw new Error("Pricing Goal apply requires the current owned browser sandbox.");
  const pricingUrl = new URL(sandbox.DATABASE_URL_PRICING);
  const catalogUrl = new URL(companion);
  if (
    !["localhost", "127.0.0.1"].includes(pricingUrl.hostname) ||
    pricingUrl.host !== catalogUrl.host ||
    !/^\/cs_[a-z0-9_]+_pricing$/.test(pricingUrl.pathname) ||
    pricingUrl.pathname !== catalogUrl.pathname.replace(/_catalog$/, "_pricing")
  )
    throw new Error("Pricing Goal apply refuses a non-owned database.");
  const pool = createPgPool(pricingUrl.toString(), { max: 1 });
  let created: { policyId: string; accountId: string } | undefined;
  let fixture: Awaited<ReturnType<typeof seedSyntheticPricingHealthInputs>> | undefined;
  try {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk%2Frepricing");
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
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
            guardrails: [{ kind: "market-evidence-floor", percentOfEstimate: 90 }],
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
        timeout: 45_000,
        intervals: [500, 1000, 2000],
      })
      .toBe("completed");
    const response = await page.request.post(policiesApi, {
      data: { dryRunId, name: "Synthetic Pricing Health browser apply" },
    });
    expect(response.status()).toBe(201);
    const policy = await response.json();
    created = { policyId: policy.policyId, accountId: policy.accountId };
    await projectSyntheticPricingHealthPolicy(pool, created);
    fixture = await seedSyntheticPricingHealthInputs(pool, { accountId: created.accountId, listingId });
    const before = await (await page.request.get(`${policiesApi}/${created.policyId}`)).json();
    expect(await (await page.request.post(`${healthApi}/${created.policyId}/compare`)).status()).toBe(202);

    let health: HealthResponse = { target: null, comparison: [] };
    await expect
      .poll(
        async () => {
          health = (await (
            await page.request.get(`${healthApi}?policyId=${created!.policyId}`)
          ).json()) as HealthResponse;
          return (
            health.comparison.length > 0 && health.comparison.every((candidate) => candidate.status === "completed")
          );
        },
        { timeout: 75_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const candidate = health.comparison[0]!;
    expect(candidate.targetPolicyId).toBe(created.policyId);
    expect(candidate.targetRevision).toBe(before.version);
    expect(candidate.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect((candidate.raised ?? 0) + (candidate.lowered ?? 0)).toBeGreaterThan(0);
    expect(candidate.listingCount).toBe(1);
    expect((candidate.raised ?? 0) + (candidate.lowered ?? 0) + (candidate.held ?? 0)).toBe(candidate.listingCount);
    expect(candidate.currencyCode).toBe("USD");
    expect(candidate.floor).toEqual({ mode: "absolute", amount: "1.00" });
    expect(candidate.guardrails).toEqual([{ kind: "market-evidence-floor", percentOfEstimate: 90 }]);
    expect(health.comparison.some((row) => row.held === row.listingCount)).toBe(true);

    await page.goto(`/account/desk/pricing-health?policyId=${created.policyId}`);
    const apply = page.getByRole("button", { name: "Apply goal", exact: true }).first();
    await expect(apply).toBeVisible();
    await apply.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(created.policyId);
    await expect(dialog).toContainText(candidate.goalId);
    await expect(dialog).toContainText(candidate.bodyHash);
    await expect(dialog).toContainText("Unchanged guardrails");
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
    ]) {
      await page.setViewportSize(viewport);
      await captureAccessibilityEvidence({
        page,
        testInfo,
        surface: `Pricing Goal apply confirmation ${viewport.width}`,
      });
    }
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-apply-confirmation-360" });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Apply this goal", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Pricing goal applied");

    const after = await (await page.request.get(`${policiesApi}/${created.policyId}`)).json();
    expect(after.version).toBe(before.version + 1);
    expect(after.scope).toEqual(before.scope);
    expect(after.excludedListingIds).toEqual(before.excludedListingIds);
    expect(after.maxChangesPerDay).toBe(before.maxChangesPerDay);
    expect(after.rules[0].directive.currencyCode).toBe(before.rules[0].directive.currencyCode);
    expect(after.rules[0].directive.floor).toEqual(before.rules[0].directive.floor);
    expect(after.rules[0].directive.guardrails).toEqual(before.rules[0].directive.guardrails);
    expect(after.rules[0].directive.anchorChain).toEqual([
      {
        source: "curve-objective",
        goalId: candidate.goalId,
        goalVersion: candidate.goalVersion,
        parameters: candidate.parameters,
      },
    ]);
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
