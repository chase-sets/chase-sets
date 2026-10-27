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
type CandidateDiagnostic = Pick<
  {
    goalId: string;
    goalVersion: number;
    dryRunId: string;
    status: string;
    requestedAt: string;
    completedAt: string | null;
  },
  "goalId" | "goalVersion" | "dryRunId" | "status" | "requestedAt" | "completedAt"
>;
type PricingHealthResponse = {
  target: { policyId: string } | null;
  goals: readonly { goalId: string; goalVersion: number; parameters: Readonly<Record<string, number>> }[];
  comparison: readonly (CandidateDiagnostic & {
    targetPolicyId: string;
    listingCount: number | null;
    raised: number | null;
    lowered: number | null;
    held: number | null;
    bodyHash: string;
  })[];
};

test("compare eligible Pricing Goals over the entire selected policy without mutation @marketplace-seller @browser-e2e-seed", async ({
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
  let setupRun: unknown = null;
  let candidateRuns: CandidateDiagnostic[] = [];
  let comparisonSucceeded = false;
  const attachDiagnostics = async () => {
    await testInfo.attach("pricing-health-compare-setup.json", {
      body: Buffer.from(JSON.stringify(setupRun, null, 2)),
      contentType: "application/json",
    });
    for (const [index, candidate] of candidateRuns.entries())
      await testInfo.attach(`pricing-health-compare-candidate-${index + 1}.json`, {
        body: Buffer.from(JSON.stringify(candidate, null, 2)),
        contentType: "application/json",
      });
  };
  const drainCandidates = async () => {
    if (!created) return;
    // Five-goal head-12 budget reserves 4 seconds per outstanding candidate.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ status: string }>(
        `SELECT status FROM pricing_repricing_dry_runs WHERE seller_account_id=$1 AND replacing_policy_id=$2
         AND status IN ('queued','running')`,
        [created.accountId, created.policyId],
      );
      if (result.rows.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Pricing Goal comparison candidates did not drain before cleanup.");
  };
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
    setupRun = { dryRunId, requestedAt: new Date().toISOString() };
    await expect
      .poll(async () => (await (await page.request.get(`${policiesApi}/dry-runs/${dryRunId}`)).json()).status, {
        timeout: 45_000,
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
    const disclosure = page.getByRole("button", { name: "Advanced controls and provenance", exact: true }).first();
    await disclosure.focus();
    await expect(disclosure).toBeFocused();
    await page.keyboard.press("Enter");
    const parameter = page.getByTestId("pricing-health-goal-picker").locator('input[type="number"]').first();
    await expect(parameter).toBeVisible();
    const bounds = await parameter.evaluate((node) => ({
      value: Number((node as HTMLInputElement).value),
      min: Number((node as HTMLInputElement).min),
      max: Number((node as HTMLInputElement).max),
    }));
    const editedValue = bounds.value < bounds.max ? bounds.value + 1 : bounds.value - 1;
    await parameter.fill(String(editedValue));
    await expect
      .poll(() => new URL(page.url()).searchParams.get("goals"))
      .toMatch(new RegExp(`\\"${editedValue}\\"|:${editedValue}(?:[,}])`));
    const editedGoals = JSON.parse(new URL(page.url()).searchParams.get("goals")!) as Array<{
      goalId: string;
      goalVersion: number;
      parameters: Record<string, number>;
    }>;
    expect(editedGoals.some((goal) => Object.values(goal.parameters).includes(editedValue))).toBe(true);
    const compare = page.getByRole("button", { name: "Compare goals", exact: true });
    await expect(compare).toBeVisible();
    await compare.focus();
    await expect(compare).toBeFocused();
    await page.keyboard.press("Enter");
    const read = async () => {
      const goals = new URL(page.url()).searchParams.get("goals");
      const query = new URLSearchParams({ policyId: created!.policyId });
      if (goals) query.set("goals", goals);
      return (await (await page.request.get(`${healthApi}?${query}`)).json()) as PricingHealthResponse;
    };
    const first = await read();
    // 45 s setup + <=75 s candidates (5 × 12 s) + 30 s UI/axe/responsive + 20 s drain + canonical navigation = 170 s < 180 s.
    const candidateDeadline = Date.now() + Math.min(75_000, Math.max(45_000, first.goals.length * 12_000));
    let completed: PricingHealthResponse;
    while (Date.now() < candidateDeadline) {
      completed = await read();
      candidateRuns = (completed.comparison ?? []).map((row) => ({
        goalId: row.goalId,
        goalVersion: row.goalVersion,
        dryRunId: row.dryRunId,
        status: row.status,
        requestedAt: row.requestedAt,
        completedAt: row.completedAt,
      }));
      const failed = completed.comparison.find(
        (row: PricingHealthResponse["comparison"][number]) => row.status === "failed",
      );
      if (failed) {
        await attachDiagnostics();
        throw new Error(`Pricing Goal candidate ${failed.goalId}@${failed.goalVersion} failed.`);
      }
      if (
        completed.goals.length > 0 &&
        completed.comparison.length === completed.goals.length &&
        completed.comparison.every((row: { status: string }) => row.status === "completed")
      ) {
        comparisonSucceeded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!comparisonSucceeded) {
      await attachDiagnostics();
      throw new Error("Pricing Goal comparison exceeded its measured candidate budget.");
    }
    completed = await read();
    expect(completed.comparison.length).toBeGreaterThan(0);
    expect(completed.goals.some((goal) => Object.values(goal.parameters).includes(editedValue))).toBe(true);
    let movement = 0;
    for (const row of completed.comparison) {
      expect(row.targetPolicyId).toBe(created.policyId);
      expect(row).not.toHaveProperty("scopeLabel");
      expect(row.listingCount).toBe(1);
      expect((row.raised ?? 0) + (row.lowered ?? 0) + (row.held ?? 0)).toBe(row.listingCount);
      expect(row.bodyHash).toMatch(/^[a-f0-9]{64}$/);
      movement += (row.raised ?? 0) + (row.lowered ?? 0);
    }
    expect(movement).toBeGreaterThan(0);
    // The mounted route must observe every worker completion without an explicit page reload.
    const comparison = page.getByTestId("pricing-health-goal-comparison");
    await expect(comparison.getByRole("cell", { name: "Completed", exact: true })).toHaveCount(completed.goals.length, {
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Compute verdict", exact: true })).toBeEnabled({ timeout: 15_000 });
    expect(await (await page.request.get(`${policiesApi}/${created.policyId}`)).json()).toEqual(before);
    const implicitTarget = await (await page.request.get(healthApi)).json();
    expect(implicitTarget.target?.policyId, "The implicit target is not the created policy.").toBe(created.policyId);
    const editedGoal = editedGoals.find((goal) => Object.values(goal.parameters).includes(editedValue));
    expect(editedGoal).toBeDefined();
    const editedCandidate = completed.comparison.find(
      (row) => row.goalId === editedGoal!.goalId && row.goalVersion === editedGoal!.goalVersion,
    );
    expect(editedCandidate?.dryRunId).toBeTruthy();
    const defaultReadback = (await (
      await page.request.get(`${healthApi}?policyId=${encodeURIComponent(created.policyId)}`)
    ).json()) as PricingHealthResponse;
    expect(defaultReadback.comparison.some((row) => row.dryRunId === editedCandidate!.dryRunId)).toBe(false);
    const defaultCompletedCount = defaultReadback.comparison.filter((row) => row.status === "completed").length;
    await page.goto("/account/desk/pricing-health");
    await expect(comparison.getByRole("cell", { name: "Completed", exact: true })).toHaveCount(defaultCompletedCount, {
      timeout: 15_000,
    });
    const computeVerdict = page.getByRole("button", { name: "Compute verdict", exact: true });
    await expect(computeVerdict).toBeEnabled();
    await expect(computeVerdict).toHaveCSS("opacity", "1");
    const viewports = [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const overflow = await page.getByTestId("pricing-health-page").evaluate((node) => {
        const page = node as HTMLElement;
        const offenders = Array.from(page.querySelectorAll<HTMLElement>("*")).flatMap((element) => {
          const rect = element.getBoundingClientRect();
          return rect.right > page.clientWidth
            ? [
                {
                  tag: element.tagName.toLowerCase(),
                  testid: element.dataset.testid ?? null,
                  role: element.getAttribute("role"),
                  width: rect.width,
                },
              ]
            : [];
        });
        return { scrollWidth: page.scrollWidth, clientWidth: page.clientWidth, offenders };
      });
      if (overflow.scrollWidth > overflow.clientWidth + 1) {
        await testInfo.attach(`pricing-goal-comparison-overflow-${viewport.width}.json`, {
          body: Buffer.from(JSON.stringify(overflow.offenders, null, 2)),
          contentType: "application/json",
        });
      }
      expect(
        overflow.scrollWidth,
        `Pricing Health page horizontal overflow at ${viewport.width}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      await captureAccessibilityEvidence({ page, testInfo, surface: `Pricing Goal comparison ${viewport.width}` });
    }
    await page.setViewportSize({ width: 360, height: 800 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-comparison-360" });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-parameters-360" });
    await page.setViewportSize({ width: 390, height: 844 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-comparison-390" });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-parameters-390" });
    await page.setViewportSize({ width: 820, height: 1180 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-comparison-tablet" });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-parameters-tablet" });
  } finally {
    try {
      if (!comparisonSucceeded) await attachDiagnostics();
      try {
        await drainCandidates();
      } finally {
        if (created) {
          expect((await page.request.post(`${policiesApi}/${created.policyId}/delete`)).status()).toBe(200);
          await projectSyntheticPricingHealthPolicy(pool, created);
        }
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
