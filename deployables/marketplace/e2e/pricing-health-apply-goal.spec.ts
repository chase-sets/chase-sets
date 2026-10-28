import { expect, test, type APIResponse } from "@playwright/test";
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
  target: { policyId: string; name: string; version: number; bodyHash: string } | null;
  comparison: Candidate[];
};

type PolicyState = {
  scope: unknown;
  excludedListingIds: unknown;
  maxChangesPerDay: number | null;
  rules: Array<{ directive: { currencyCode: string; floor: unknown; guardrails: unknown[]; anchorChain: unknown[] } }>;
};

async function readJson<T>(response: Promise<APIResponse>, status: number): Promise<T> {
  const resolved = await response;
  expect(resolved.status()).toBe(status);
  return (await resolved.json()) as T;
}

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
  let haltEngaged = false;
  let applied = false;
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
    const before = await readJson<PolicyState>(page.request.get(`${policiesApi}/${created.policyId}`), 200);
    const beforeHealth = await readJson<HealthResponse>(
      page.request.get(`${healthApi}?policyId=${created.policyId}`),
      200,
    );
    expect(beforeHealth.target?.policyId).toBe(created.policyId);
    expect(beforeHealth.target?.version).toEqual(expect.any(Number));
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
    expect(candidate.targetRevision).toBe(beforeHealth.target!.version);
    expect(candidate.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect((candidate.raised ?? 0) + (candidate.lowered ?? 0)).toBeGreaterThan(0);
    expect(candidate.listingCount).toBe(1);
    expect((candidate.raised ?? 0) + (candidate.lowered ?? 0) + (candidate.held ?? 0)).toBe(candidate.listingCount);
    expect(candidate.currencyCode).toBe("USD");
    expect(candidate.floor).toEqual({ mode: "absolute", amount: "1.00" });
    expect(candidate.guardrails).toEqual([{ kind: "market-evidence-floor", percentOfEstimate: 90 }]);
    // F8 control: the applied candidate must not hold every listing.
    expect(candidate.held).not.toBe(candidate.listingCount);

    const implicitHealth = await readJson<HealthResponse>(page.request.get(healthApi), 200);
    expect(implicitHealth.target?.policyId, "The implicit target is not the created policy.").toBe(created.policyId);
    await page.goto("/account/desk/pricing-health");
    const apply = page.getByRole("button", { name: "Apply goal", exact: true }).first();
    await expect(apply).toBeVisible();

    const haltResponse = await page.request.post(`${policiesApi}/halt`, { data: { engaged: true } });
    expect(haltResponse.status()).toBe(200);
    expect(((await haltResponse.json()) as { engaged: boolean }).engaged).toBe(true);
    haltEngaged = true;

    await apply.focus();
    await page.keyboard.press("Enter");
    const errorDialog = page.getByRole("alertdialog");
    await expect(errorDialog).toBeVisible();
    await errorDialog.getByRole("button", { name: "Apply this goal", exact: true }).click();
    const applyError = page.getByRole("alert").filter({ hasText: "This goal could not be applied" });
    await expect(applyError).toBeVisible();
    const refusedHealth = await readJson<HealthResponse>(
      page.request.get(`${healthApi}?policyId=${created.policyId}`),
      200,
    );
    expect(refusedHealth.target?.version).toBe(beforeHealth.target!.version);
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
    ]) {
      await page.setViewportSize(viewport);
      const retryLink = applyError.getByRole("link", { name: "Retry", exact: true });
      await retryLink.focus();
      await expect(retryLink).toBeFocused();
      await captureAccessibilityEvidence({
        page,
        testInfo,
        surface: `Pricing Goal apply error ${viewport.width}`,
      });
    }
    const releaseHaltResponse = await page.request.post(`${policiesApi}/halt`, { data: { engaged: false } });
    expect(releaseHaltResponse.status()).toBe(200);
    expect(((await releaseHaltResponse.json()) as { engaged: boolean }).engaged).toBe(false);
    haltEngaged = false;
    await page.reload();

    const confirmedApply = page.getByRole("button", { name: "Apply goal", exact: true }).first();
    await expect(confirmedApply).toBeVisible();
    await confirmedApply.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(created.policyId);
    await expect(dialog).toContainText(candidate.goalId);
    await expect(dialog).toContainText(candidate.bodyHash);
    await expect(dialog).toContainText("Unchanged guardrails");
    await expect(dialog).toContainText(
      `Preview movement: raised ${candidate.raised ?? 0}, lowered ${candidate.lowered ?? 0}, held ${candidate.held ?? 0}.`,
    );
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
    ]) {
      await page.setViewportSize(viewport);
      const dialogButtons = dialog.getByRole("button");
      await dialogButtons.first().focus();
      await expect(dialogButtons.first()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialogButtons.nth(1)).toBeFocused();
      await captureAccessibilityEvidence({
        page,
        testInfo,
        surface: `Pricing Goal apply confirmation ${viewport.width}`,
      });
    }
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-apply-confirmation-360" });
    await page.setViewportSize({ width: 390, height: 844 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-apply-confirmation-390" });
    await page.setViewportSize({ width: 820, height: 1180 });
    await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-goal-apply-confirmation-tablet" });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Apply this goal", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pricing goal applied" })).toBeVisible();
    applied = true;

    const after = await readJson<PolicyState>(page.request.get(`${policiesApi}/${created.policyId}`), 200);
    const afterHealth = await readJson<HealthResponse>(
      page.request.get(`${healthApi}?policyId=${created.policyId}`),
      200,
    );
    expect(afterHealth.target?.policyId).toBe(created.policyId);
    expect(afterHealth.target?.version).toBe(beforeHealth.target!.version + 1);
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
    await test.step("pricing-goal-simple-reopen", async () => {
      // The Health integration's editor URL must not expose compiled controls.
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/account/desk/repricing/${created!.policyId}?edit=1`);
        const editor = page.getByTestId("repricing-policy-editor");
        await expect(editor).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveAccessibleName("Edit repricing policy");
        await expect(editor.getByText("Pricing Goal", { exact: true })).toBeVisible();
        await expect(editor.getByRole("combobox", { name: "Policy scope", exact: true })).toBeVisible();
        await expect(editor.getByLabel("Minimum price", { exact: true })).toHaveValue("1.00");
        await expect(editor.getByLabel("Maximum changes per day", { exact: true })).toHaveValue(
          String(after.maxChangesPerDay),
        );
        await expect(page.getByRole("button", { name: "Preview policy", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Save policy", exact: true })).toBeEnabled();
        await expect(editor.getByRole("button", { name: "Open advanced editor", exact: true })).toBeVisible();
        await expect(editor.getByText("Advanced rule editor", { exact: true })).toHaveCount(0);
        await expect(editor.getByLabel("Adjustment (%)", { exact: true })).toHaveCount(0);
        await editor.getByLabel("Policy name", { exact: true }).focus();
        await expect(editor.getByLabel("Policy name", { exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(editor.getByRole("combobox", { name: "Policy scope", exact: true })).toBeFocused();
        await captureAccessibilityEvidence({ page, testInfo, surface: `pricing-goal-simple-reopen-${width}` });
        await testInfo.attach(`pricing-goal-simple-reopen-${width}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      }
      await page.getByRole("button", { name: "Preview policy", exact: true }).click();
      await expect(page.getByTestId("repricing-dry-run-result")).toBeVisible();
      await page.getByLabel("Policy name", { exact: true }).fill("Saved simple Pricing Goal");
      await page.getByRole("button", { name: "Save policy", exact: true }).click();
      await expect(page.getByTestId("repricing-policy-editor")).toHaveCount(0);
      await page.reload();
      await page.getByRole("button", { name: "Edit repricing policy", exact: true }).click();
      await expect(
        page.getByTestId("repricing-policy-editor").getByText("Pricing Goal", { exact: true }),
      ).toBeVisible();
      const reopened = await readJson<PolicyState>(page.request.get(`${policiesApi}/${created!.policyId}`), 200);
      expect(reopened.rules).toEqual(after.rules);
      expect(reopened.scope).toEqual(after.scope);
      expect(reopened.maxChangesPerDay).toEqual(after.maxChangesPerDay);
    });
  } finally {
    try {
      if (haltEngaged) {
        const releaseHaltResponse = await page.request.post(`${policiesApi}/halt`, { data: { engaged: false } });
        expect(releaseHaltResponse.status()).toBe(200);
        expect(((await releaseHaltResponse.json()) as { engaged: boolean }).engaged).toBe(false);
        haltEngaged = false;
      }
      if (created) {
        expect((await page.request.post(`${policiesApi}/${created.policyId}/delete`)).status()).toBe(200);
        if (applied) {
          await expect
            .poll(
              async () => {
                const policies = await readJson<Array<{ policyId: string }>>(page.request.get(policiesApi), 200);
                return policies.some((policy) => policy.policyId === created!.policyId);
              },
              { timeout: 30_000 },
            )
            .toBe(false);
        } else {
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
