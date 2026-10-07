import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createPgPool, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { authenticateAdmin, expectAdminWebHydrated, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const SKIP_REASON = "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.";
const PROVIDER_DETAIL_PATH = "/catalog/providers/tcgplayer";
const UNIT_KEY = "tcgplayer:lorcana:sealed-product:source-observation-import";
const OPERATOR_CANCELLED_MESSAGE = "Operator cancelled provider import job.";
const CANARY_FAILURE_REASON = "E2E_CANARY_EXCLUDED_FAILURE_REASON";
const CANARY_RAW_ERROR = "E2E_CANARY_RAW_JOB_ERROR";

type ResolvedActor = Readonly<{ tenantId: string; userId: string; accountId: string }>;
type SeededJobs = Readonly<{ partial: string; failed: string; cancelled: string }>;

// Recent jobs on Provider detail are read by the SSR loader from the durable
// job store, so browser routing cannot stage them. Each test seeds its own
// terminal (never queued/running, so no worker claims them) TCGplayer job rows
// under unique synthetic IDs for the signed-in actor, asserts only those IDs,
// and deletes them afterwards.
test.describe.serial("catalog provider job diagnostics", () => {
  for (const viewport of [
    { name: "phone", width: 390, height: 664, branch: "card" },
    { name: "desktop", width: 1280, height: 900, branch: "table" },
  ] as const) {
    test(`inspects retained TCGplayer job outcomes in place on ${viewport.name} @catalog-admin-integrations`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(180_000);
      test.skip(skipDeployedAdminE2e, SKIP_REASON);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const consoleMessages: string[] = [];
      page.on("console", (message) => consoleMessages.push(message.text()));

      await authenticateAdmin(page, PROVIDER_DETAIL_PATH, "/access/sign-in");
      const actor = await currentActor(page);
      const jobs = await seedTerminalJobs(testInfo, actor);
      try {
        await expectPageOk(page, PROVIDER_DETAIL_PATH);
        await expectAdminWebHydrated(page);
        const recentJobs = page.locator('[data-catalog-provider-recent-jobs="true"]');
        await expect(recentJobs).toBeVisible();

        const partial = await visibleDisclosureTrigger(recentJobs, jobs.partial, viewport.branch);
        const failed = await visibleDisclosureTrigger(recentJobs, jobs.failed, viewport.branch);
        const cancelled = await visibleDisclosureTrigger(recentJobs, jobs.cancelled, viewport.branch);
        for (const trigger of [partial, failed, cancelled]) {
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
        }

        const requests: string[] = [];
        page.on("request", (request) => {
          if (request.method() !== "GET" || ["fetch", "xhr", "document"].includes(request.resourceType())) {
            requests.push(`${request.method()} ${request.url()}`);
          }
        });

        await partial.focus();
        await page.keyboard.press("Enter");
        await expect(partial).toHaveAttribute("aria-expanded", "true");
        await expect(failed).toHaveAttribute("aria-expanded", "false");
        const partialPanel = await openPanel(page, partial);
        await expectFact(partialPanel, "Progress", ["Operator: Partial", "3/3 work units, 100% complete"]);
        await expectFact(partialPanel, "Failure groups", ["Partial provider data (1)"]);
        await expectFact(partialPanel, "Observed observations", ["40"], true);
        await expectFact(partialPanel, "Skipped", ["1"], true);
        await expectFact(partialPanel, "Failures", ["1"], true);
        await expectFact(partialPanel, "Provider usage", ["Requests: 5", "Pages: 2", "Cache: 3 hits, 2 misses"]);
        await expect(partialPanel).not.toContainText("Completed");

        await failed.focus();
        await page.keyboard.press("Enter");
        await expect(failed).toHaveAttribute("aria-expanded", "true");
        const failedPanel = await openPanel(page, failed);
        await expectFact(failedPanel, "Progress", ["Operator: Failed", "1/3 work units, 33% complete"]);
        await expectFact(failedPanel, "Failure groups", ["Durable import failed (2)"]);
        await expectFact(failedPanel, "Observed observations", ["Unavailable"], true);
        await expectFact(failedPanel, "Provider usage", ["Unavailable"], true);
        await expect(failedPanel).not.toContainText("40");

        await cancelled.focus();
        await page.keyboard.press("Enter");
        const cancelledPanel = await openPanel(page, cancelled);
        await expectFact(cancelledPanel, "Progress", ["Operator: Cancelled"]);
        await expectFact(cancelledPanel, "Failure groups", ["Operator cancelled (1)"]);

        for (const panel of [partialPanel, failedPanel, cancelledPanel]) {
          await expectWithinViewport(page, panel);
        }
        await expectNoHorizontalPageOverflow(page);
        await testInfo.attach(`provider-job-diagnostics-${viewport.name}.png`, {
          body: await recentJobs.screenshot(),
          contentType: "image/png",
        });

        for (const trigger of [partial, failed, cancelled]) {
          await trigger.focus();
          await page.keyboard.press("Space");
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
        }
        await expect(partialPanel).toBeHidden();

        expect(requests, "opening and closing job disclosures must not send requests").toEqual([]);
        await expect(page.locator("body")).not.toContainText(CANARY_FAILURE_REASON);
        await expect(page.locator("body")).not.toContainText(CANARY_RAW_ERROR);
        expect(consoleMessages.filter((message) => message.includes("E2E_CANARY"))).toEqual([]);
      } finally {
        await deleteSeededJobs(testInfo, Object.values(jobs));
      }
    });
  }
});

async function currentActor(page: Page): Promise<ResolvedActor> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/auth/session`);
  expect(response.status(), "the signed-in admin session should resolve").toBe(200);
  const body = (await response.json()) as { actor?: Partial<ResolvedActor> };
  const { tenantId, userId, accountId } = body.actor ?? {};
  if (!tenantId || !userId || !accountId) {
    throw new Error("The signed-in admin session did not resolve an actor.");
  }
  return { tenantId, userId, accountId };
}

// The phone card list and the desktop table both render every row; the
// assertion must own the branch that is visible at this viewport.
async function visibleDisclosureTrigger(
  recentJobs: Locator,
  jobId: string,
  branch: "card" | "table",
): Promise<Locator> {
  const disclosure = recentJobs.locator(`[data-catalog-provider-job-disclosure="${jobId}"]`);
  await expect(disclosure).toHaveCount(2);
  const visible = disclosure.filter({ visible: true });
  await expect(visible).toHaveCount(1);
  const branchContainer = branch === "card" ? '[role="list"]' : "table";
  await expect(
    recentJobs.locator(branchContainer).locator(`[data-catalog-provider-job-disclosure="${jobId}"]`),
  ).toBeVisible();
  const trigger = visible.getByRole("button", { name: new RegExp(`^${jobId}`) });
  await expect(trigger).toBeVisible();
  return trigger;
}

async function openPanel(page: Page, trigger: Locator): Promise<Locator> {
  const triggerId = await trigger.getAttribute("id");
  expect(triggerId, "the disclosure trigger should carry an id").toBeTruthy();
  const panel = page.locator(`[role="region"][aria-labelledby="${triggerId}"]`);
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-controls", (await panel.getAttribute("id")) ?? "");
  return panel;
}

async function expectFact(panel: Locator, label: string, values: readonly string[], exact = false) {
  const term = panel.locator("dt", { hasText: new RegExp(`^${label}$`) });
  await expect(term).toBeVisible();
  const value = term.locator("xpath=following-sibling::dd[1]");
  await expect(value).toBeVisible();
  if (exact) {
    await expect(value).toHaveText(values.join(""));
    return;
  }
  for (const text of values) {
    await expect(value).toContainText(text);
  }
}

async function expectWithinViewport(page: Page, panel: Locator) {
  const overflowing = await panel.evaluate((element) => {
    const width = window.innerWidth;
    return Array.from(element.querySelectorAll("dt, dd"))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && (rect.left < -1 || rect.right > width + 1))
      .map((rect) => `${Math.round(rect.left)}..${Math.round(rect.right)} of ${width}`);
  });
  expect(overflowing, `labels and values stay inside the ${page.viewportSize()?.width}px viewport`).toEqual([]);
}

async function expectNoHorizontalPageOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, "the page must not scroll horizontally").toBeLessThanOrEqual(innerWidth);
}

function catalogDatabaseUrl(testInfo: TestInfo): string {
  const url = testInfo.config.metadata.catalogDatabaseUrl;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("catalog-provider-job-diagnostics requires the Catalog E2E database target.");
  }
  return url;
}

async function withCatalogPool(testInfo: TestInfo, work: (pool: PgTransactionalPool) => Promise<void>) {
  const pool = createPgPool(catalogDatabaseUrl(testInfo), { max: 1 });
  try {
    await work(pool);
  } finally {
    await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
  }
}

async function seedTerminalJobs(testInfo: TestInfo, actor: ResolvedActor): Promise<SeededJobs> {
  const suffix = randomUUID().slice(0, 8);
  const jobs: SeededJobs = {
    partial: `e2e-provider-job-partial-${suffix}`,
    failed: `e2e-provider-job-failed-${suffix}`,
    cancelled: `e2e-provider-job-cancelled-${suffix}`,
  };
  if (process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true") {
    throw new Error("catalog-provider-job-diagnostics seeds its own rows and needs the local E2E database.");
  }

  const eventContext = {
    tenantId: actor.tenantId,
    audit: { performedByUserId: actor.userId, forAccountId: actor.accountId },
    trace: {},
  };
  const payload = {
    action: "import",
    scope: { provider: "tcgplayer", ingestionUnitKey: UNIT_KEY },
    syncRunId: null,
    profileSnapshot: null,
    reapplyProfileMode: null,
  };
  const rows = [
    {
      jobId: jobs.partial,
      status: "completed",
      progress: { phase: "completed", completed: 3, total: 3, currentName: null, status: null },
      result: {
        requested: 3,
        imported: 2,
        observed: 40,
        reapplied: 0,
        skipped: 1,
        failed: 1,
        outcomes: [
          {
            providerKey: "tcgplayer",
            languageCode: "en",
            expansionId: "e2e-provider-job-diagnostics",
            status: "failed",
            observed: 40,
            reapplied: 0,
            reason: CANARY_FAILURE_REASON,
            providerUsageEvidence: { actualRequestCount: 5, pageCount: 2, cacheHitCount: 3, cacheMissCount: 2 },
          },
        ],
      },
      errorMessage: null,
    },
    {
      jobId: jobs.failed,
      status: "failed",
      progress: { phase: "failed", completed: 1, total: 3, currentName: null, status: null },
      result: null,
      errorMessage: CANARY_RAW_ERROR,
    },
    {
      jobId: jobs.cancelled,
      status: "failed",
      progress: { phase: "failed", completed: 0, total: 3, currentName: null, status: null },
      result: null,
      errorMessage: OPERATOR_CANCELLED_MESSAGE,
    },
  ];

  await withCatalogPool(testInfo, (pool) =>
    withPgTransaction(pool, async (db) => {
      for (const row of rows) {
        await db.query(
          `INSERT INTO catalog_source_observation_integration_durable_jobs (
             job_id, job_kind, status, payload, progress, result, error_message, event_context,
             attempt_count, next_eligible_at, created_at, started_at, completed_at, updated_at
           ) VALUES ($1, 'import', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb,
                     1, now(), now(), now(), now(), now())`,
          [
            row.jobId,
            row.status,
            JSON.stringify(payload),
            JSON.stringify(row.progress),
            row.result === null ? null : JSON.stringify(row.result),
            row.errorMessage,
            JSON.stringify(eventContext),
          ],
        );
      }
    }),
  );

  return jobs;
}

async function deleteSeededJobs(testInfo: TestInfo, jobIds: readonly string[]) {
  await withCatalogPool(testInfo, (pool) =>
    withPgTransaction(pool, async (db) => {
      await db.query("DELETE FROM catalog_source_observation_integration_durable_jobs WHERE job_id = ANY($1)", [
        jobIds,
      ]);
    }),
  );
}
