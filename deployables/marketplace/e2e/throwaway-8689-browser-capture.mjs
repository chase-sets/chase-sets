import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import pg from "pg";
import { tsImport } from "tsx/esm/api";
import { ensureWorktreeSandboxEnvironment, buildDockerComposeArgs } from "../../scripts/lib/sandbox.mjs";
import { buildPackageManagerInvocation, terminateProcessTree, runCommand } from "../../scripts/lib/process.mjs";

const root = process.cwd();
const evidence = path.resolve(root, ".tmp/8689-browser");
mkdirSync(evidence, { recursive: true });
const { sandbox, env } = ensureWorktreeSandboxEnvironment({ rootDir: root });
const { signInThroughMarketplaceForm } = await tsImport("../../deployables/marketplace/e2e/support/auth.ts", import.meta.url);
const { marketplaceBrowserE2eSeedContract } = await tsImport("../../deployables/marketplace/e2e/support/seed-contract.ts", import.meta.url);
const invocation = buildPackageManagerInvocation(["run", "dev:browser-e2e"]);
const output = createWriteStream(path.join(evidence, "bootstrap.log"));
const child = spawn(invocation.command, invocation.args, {
  cwd: root,
  env: {
    ...process.env,
    CHASE_SETS_BROWSER_E2E_PROBE: "true",
    NOTIFICATION_EMAIL_PROVIDER: "noop",
    STRIPE_SECRET_KEY: "",
    STRIPE_PUBLISHABLE_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    WORKER_JOB_MAX_CONCURRENT_RUNNERS: "4",
    WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS: "1",
    WORKER_PROJECTION_OPERATION_RUNNER_COUNT: "1",
    WORKER_WAKE_MAX_CONCURRENT_RUNNERS: "1",
    PRICING_RECOMMENDATION_JOB_LANE_COUNT: "4",
    PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "4",
    PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "4",
    CHASE_SETS_BROWSER_E2E_LIFECYCLE_PATH: path.join(evidence, "lifecycle.json"),
    CHASE_SETS_BROWSER_E2E_READINESS_EVIDENCE_PATH: path.join(evidence, "readiness.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });
let browser;
let pool;
let page;
const readback = {
  head: process.env.PROOF_HEAD ?? null,
  controlHead: process.env.CONTROL_HEAD ?? null,
  controlTree: process.env.CONTROL_TREE ?? null,
  targetTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
  sandboxId: sandbox.id,
  origin: sandbox.urls.marketplaceWeb,
  steps: [],
};
const save = () => writeFileSync(path.join(evidence, "readback.json"), JSON.stringify(readback, null, 2));
const rowsQuery = "SELECT recommendation_id, seller_account_id, status, market_price_amount, current_price_amount, recommended_list_amount, lowest_listing_price_amount, highest_offer_price_amount FROM pricing_recommendation_feed WHERE seller_account_id = $1 ORDER BY recommendation_id";
try {
  const deadline = Date.now() + 540_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`dev:browser-e2e exited ${child.exitCode}`);
    try {
      const response = await fetch(`${sandbox.urls.marketplaceWeb}/sign-in`);
      if (response.ok) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error("Browser stack was not ready within the bounded bootstrap observation.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: sandbox.urls.marketplaceWeb, viewport: { width: 1440, height: 1100 } });
  page = await context.newPage();
  await page.goto("/sign-in?returnTo=%2Faccount%2Frepricing");
  const formResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/sign-in"));
  await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSeedContract.seller);
  const response = await formResponse;
  readback.signInFormResponse = { status: response.status(), path: new URL(response.url()).pathname };
  await page.goto("/account/repricing");
  await expect(page.getByRole("heading", { level: 1, name: "Recommendations", exact: true })).toBeVisible();
  readback.steps.push({ step: "signed-in", url: page.url(), heading: await page.locator("h1").innerText() });
  save();

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page).toHaveURL(/jobId=/);
  const refreshJobId = new URL(page.url()).searchParams.get("jobId");
  async function waitJob(id) {
    let job;
    await expect.poll(async () => {
      const result = await page.request.get(`/api/marketplace/account/recommendation-jobs/${id}`);
      expect(result.status()).toBe(200);
      job = await result.json();
      return job.status;
    }, { timeout: 90_000 }).toBe("completed");
    return job;
  }
  const refreshJob = await waitJob(refreshJobId);
  expect(refreshJob.result.proposedCount).toBeGreaterThan(0);
  let recommendations;
  await expect.poll(async () => {
    const result = await page.request.get("/api/marketplace/account/recommendations?limit=100&offset=0");
    expect(result.status()).toBe(200);
    recommendations = await result.json();
    return recommendations.items.filter((row) => row.status === "proposed").length;
  }, { timeout: 90_000 }).toBe(refreshJob.result.proposedCount);
  pool = new pg.Pool({ connectionString: sandbox.contextDatabaseUrls.pricing });
  const accountId = recommendations.items[0]?.seller_account_id;
  expect(accountId).toBe("acc_seed_demo_account");
  const beforeReadModel = (await pool.query(rowsQuery, [accountId])).rows;
  const proposedIds = recommendations.items.filter((row) => row.status === "proposed").map((row) => row.recommendation_id).sort();
  expect(proposedIds).toHaveLength(refreshJob.result.proposedCount);
  const expectedPrices = beforeReadModel.map((row) => ({
    recommendationId: row.recommendation_id,
    values: Object.fromEntries(["market_price_amount", "current_price_amount", "recommended_list_amount", "lowest_listing_price_amount", "highest_offer_price_amount"].map((field) => [field, row[field] === null ? "Not set" : `$${Number(row[field]).toFixed(2)}`])),
  }));
  readback.accountId = accountId;
  readback.refreshJob = refreshJob;
  readback.beforeReadModel = beforeReadModel;
  readback.expectedPrices = expectedPrices;
  readback.steps.push({ step: "refresh-completed", proposedCount: proposedIds.length, recommendationIds: proposedIds });
  await page.waitForURL((url) => url.pathname === "/account/repricing" && !url.search);
  await page.reload();
  const beforeText = await page.locator("main").innerText();
  expect(beforeText).not.toContain("Marketplace error");
  for (const expected of expectedPrices) {
    const rowText = await page.locator(`input[value="${expected.recommendationId}"]`).locator("xpath=ancestor::tr").innerText();
    for (const value of Object.values(expected.values)) expect(rowText).toContain(value);
  }
  readback.before = { text: beforeText };
  await page.screenshot({ path: path.join(evidence, "before-dismissal.png"), fullPage: true });
  save();

  const checkboxes = page.locator('main table:visible input[name="recommendationId"]:enabled');
  await expect(checkboxes).toHaveCount(proposedIds.length);
  for (const checkbox of await checkboxes.all()) await checkbox.locator("xpath=parent::label").click();
  await page.getByRole("button", { name: "Dismiss selected", exact: true }).click();
  const dismissJobId = await page.evaluate(() => new URL(window.location.href).searchParams.get("jobId"));
  expect(dismissJobId).not.toBe(refreshJobId);
  const dismissJob = await waitJob(dismissJobId);
  expect(dismissJob.result.dismissedCount).toBe(proposedIds.length);
  await expect.poll(async () => {
    const result = await page.request.get("/api/marketplace/account/recommendations?limit=100&offset=0");
    expect(result.status()).toBe(200);
    recommendations = await result.json();
    const accountRows = recommendations.items.filter((row) => row.seller_account_id === accountId);
    return accountRows.filter((row) => row.status === "dismissed").map((row) => row.recommendation_id).sort().join(",");
  }, { timeout: 90_000 }).toBe(proposedIds.join(","));
  readback.dismissJob = dismissJob;
  readback.steps.push({ step: "dismiss-completed", dismissedCount: dismissJob.result.dismissedCount, recommendationIds: proposedIds });
  await page.waitForURL((url) => url.pathname === "/account/repricing" && !url.search);
  await page.reload();
  const afterText = await page.locator("main").innerText();
  expect(afterText).not.toContain("Marketplace error");
  const dismissedRows = recommendations.items.filter((row) => row.seller_account_id === accountId && row.status === "dismissed").map((row) => row.recommendation_id).sort();
  expect(dismissedRows).toEqual(proposedIds);
  for (const expected of expectedPrices.filter((entry) => proposedIds.includes(entry.recommendationId))) {
    const rowText = await page.locator(`input[value="${expected.recommendationId}"]`).locator("xpath=ancestor::tr").innerText();
    for (const value of Object.values(expected.values)) expect(rowText).toContain(value);
  }
  readback.after = { text: afterText, dismissedIds: dismissedRows };
  readback.afterReadModel = await pool.query(rowsQuery, [accountId]).then((result) => result.rows);
  readback.steps.push({ step: "reloaded", dismissedIds: dismissedRows, marketplaceError: false });
  await page.screenshot({ path: path.join(evidence, "after-dismissal.png"), fullPage: true });
  await page.locator("main").getByRole("link", { name: "Repricing policies", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/desk\/repricing$/);
  await expect(page.getByRole("heading", { level: 1, name: "Repricing policies", exact: true })).toBeVisible();
  readback.steps.push({ step: "recommendations-to-policies", url: page.url(), heading: await page.locator("h1").innerText() });
  await page.screenshot({ path: path.join(evidence, "policies-destination.png"), fullPage: true });
  await page.locator("main").getByRole("link", { name: "Recommendations", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/repricing$/);
  await expect(page.getByRole("heading", { level: 1, name: "Recommendations", exact: true })).toBeVisible();
  readback.steps.push({ step: "policies-to-recommendations", url: page.url(), heading: await page.locator("h1").innerText() });
  await page.screenshot({ path: path.join(evidence, "recommendations-destination.png"), fullPage: true });
  readback.outcome = "captured";
  save();
  console.log("BROWSER_PROOF captured");
} catch (error) {
  readback.outcome = "not-complete";
  readback.error = error instanceof Error ? error.message : String(error);
  if (page) {
    readback.failureUrl = page.url();
    readback.failureText = await page.locator("body").innerText().catch(() => "unavailable");
    await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  }
  save();
  console.error(readback.error);
  process.exitCode = 1;
} finally {
  await pool?.end();
  await browser?.close();
  terminateProcessTree(child);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await runCommand("docker", [...buildDockerComposeArgs(sandbox), "down"], { env: { ...process.env, ...env }, prefix: "owned-cleanup" });
  output.end();
  console.log("OWNED_STACK_STOPPED");
}
