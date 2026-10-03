import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createPgPool, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const SKIP_REASON = "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.";
const SEED_SKIP_REASON = "The import job status filter journey seeds the local Catalog E2E database.";
const TCGPLAYER_UNIT_KEY = "tcgplayer:pokemon:single-card:source-observation-import";

type CurrentActorDisplay = Readonly<{
  account: Readonly<{ account_id: string }>;
  user: Readonly<{ user_id: string }>;
}>;

type ImportJobStatusFixture = Readonly<{
  scopeRecordId: string;
  scopeName: string;
  expansionId: string;
  partialJobId: string;
  completedJobId: string;
}>;

// The Scope detail loader reads durable import jobs server-side, so this journey
// seeds its own terminal TCGplayer jobs (one completed with a failed outcome, which
// serializes as operator status partial, and one plainly completed) for the signed-in
// operator. Only terminal rows are seeded, so the queued choice is a no-match, and
// assertions stay on this spec's own job IDs because other rows can share the window.
test.describe.serial("catalog import job status filter", () => {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 390, height: 664 },
  ] as const) {
    test(`Scope detail filters TCGplayer import jobs by operator status at ${viewport.width}px @catalog-admin-integrations`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(150_000);
      test.skip(skipDeployedAdminE2e, SKIP_REASON);
      test.skip(process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true", SEED_SKIP_REASON);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
      await expectPageOk(page, "/catalog/scopes");
      await expectAdminPageReady(page, { heading: "Scopes" });

      const actor = await getCurrentActorDisplay(page);
      const fixture = importJobStatusFixture(testInfo, viewport.name);
      const pool = catalogPool(testInfo);
      try {
        await seedImportJobStatusFixture(pool, fixture, actor);

        const path = `/catalog/scopes/${encodeURIComponent(fixture.scopeRecordId)}?source=tcgplayer&section=import-jobs`;
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await expectAdminPageReady(page, { heading: fixture.scopeName, headingLevel: 1 });

        const importModule = page.getByRole("region", { name: "Provider import operations" });
        await expect(importModule).toBeVisible();
        const filter = importModule.locator("[data-catalog-import-job-status-filter]");
        const statusSelect = filter.getByRole("combobox", { name: "Status" });
        await expect(statusSelect).toBeVisible();
        await expect(statusSelect).toHaveValue("all");
        await expect(statusSelect.locator("option")).toHaveText([
          "All statuses",
          "Queued",
          "Running",
          "Stale",
          "Retried",
          "Partial",
          "Failed",
          "Cancelled",
          "Completed",
        ]);

        await expect(visibleJobRow(importModule, fixture.partialJobId)).toHaveCount(1);
        await expect(visibleJobRow(importModule, fixture.completedJobId)).toHaveCount(1);
        await expect(visibleJobRow(importModule, fixture.partialJobId)).toHaveAttribute(
          "data-catalog-import-job-state",
          "completed",
        );
        const loadedTotal = await summaryValue(filter, "Recent jobs");
        expect(Number(loadedTotal)).toBeGreaterThanOrEqual(2);
        await expect(summaryRow(filter, "All statuses")).toHaveText(loadedTotal);
        await expectNoHorizontalOverflow(page);

        // Keyboard: All statuses -> Partial is five options down.
        await statusSelect.focus();
        for (let step = 0; step < 5; step += 1) {
          await page.keyboard.press("ArrowDown");
        }
        await expect(statusSelect).toHaveValue("partial");
        await expect(filter).toHaveAttribute("data-catalog-import-job-status-filter", "partial");
        await expect(visibleJobRow(importModule, fixture.partialJobId)).toHaveCount(1);
        await expect(visibleJobRow(importModule, fixture.completedJobId)).toHaveCount(0);
        await expectEveryVisibleRowHasOperatorStatus(importModule, "partial");
        await expect(summaryRow(filter, "Recent jobs")).toHaveText(loadedTotal);
        await expect(summaryRow(filter, "Partial")).toHaveText(String(await visibleRowCount(importModule)));
        await expectNoHorizontalOverflow(page);

        // Keyboard: Partial -> Queued is four options up; only terminal rows were seeded.
        for (let step = 0; step < 4; step += 1) {
          await page.keyboard.press("ArrowUp");
        }
        await expect(statusSelect).toHaveValue("queued");
        await expect(statusSelect).toBeVisible();
        await expect(visibleJobRow(importModule, fixture.partialJobId)).toHaveCount(0);
        await expect(visibleJobRow(importModule, fixture.completedJobId)).toHaveCount(0);
        await expect(importModule.locator("[data-catalog-import-job-row='true']").filter({ visible: true })).toHaveCount(
          0,
        );
        await expect(importModule.getByText("No Queued found", { exact: true })).toBeVisible();
        await expect(importModule.getByText("Try adjusting your filters.", { exact: true })).toBeVisible();
        await expect(importModule.getByText("No durable import jobs for this context", { exact: true })).toHaveCount(0);
        await expect(summaryRow(filter, "Recent jobs")).toHaveText(loadedTotal);
        await expect(summaryRow(filter, "Queued")).toHaveText("0");
        await expectNoHorizontalOverflow(page);

        // Keyboard: Queued -> All statuses restores every loaded row.
        await page.keyboard.press("ArrowUp");
        await expect(statusSelect).toHaveValue("all");
        await expect(visibleJobRow(importModule, fixture.partialJobId)).toHaveCount(1);
        await expect(visibleJobRow(importModule, fixture.completedJobId)).toHaveCount(1);
        await expect(summaryRow(filter, "All statuses")).toHaveText(loadedTotal);
        await expectNoHorizontalOverflow(page);
      } finally {
        await deleteImportJobStatusFixture(pool, fixture);
        await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
      }
    });
  }
});

function importJobStatusFixture(testInfo: TestInfo, viewportName: string): ImportJobStatusFixture {
  const suffix = `${viewportName}-${testInfo.workerIndex}-${testInfo.retry}-${Date.now().toString(36)}`;
  return {
    scopeRecordId: `scope_e2e_import_status_filter_${suffix}`,
    scopeName: `E2E import status filter ${suffix}`,
    expansionId: `e2e-import-status-filter-${suffix}`,
    partialJobId: `job_e2e_import_status_filter_partial_${suffix}`,
    completedJobId: `job_e2e_import_status_filter_completed_${suffix}`,
  };
}

function catalogPool(testInfo: TestInfo): PgTransactionalPool {
  const catalogDatabaseUrl = testInfo.config.metadata.catalogDatabaseUrl;
  if (typeof catalogDatabaseUrl !== "string" || catalogDatabaseUrl.length === 0) {
    throw new Error("The import job status filter journey requires the Catalog E2E database target.");
  }
  return createPgPool(catalogDatabaseUrl, { max: 1 });
}

async function seedImportJobStatusFixture(
  pool: PgTransactionalPool,
  fixture: ImportJobStatusFixture,
  actor: CurrentActorDisplay,
): Promise<void> {
  const eventContext = JSON.stringify({
    tenantId: "tnt_identity",
    audit: { performedByUserId: actor.user.user_id, forAccountId: actor.account.account_id },
    trace: {},
  });
  const payload = JSON.stringify({
    action: "import",
    syncRunId: null,
    profileSnapshot: null,
    reapplyProfileMode: null,
    scope: {
      provider: "tcgplayer",
      ingestionUnitKey: TCGPLAYER_UNIT_KEY,
      language: "en",
      productLineId: "e2e-import-status-filter",
      setId: fixture.expansionId,
    },
  });

  await withPgTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO catalog_scope_records (
         scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id,
         reference_record_key, name, lifecycle_status
       ) VALUES ($1, 'pokemon', 'product-line', 'product-line', $2, $2, $3, 'active')`,
      [fixture.scopeRecordId, `reference-${fixture.scopeRecordId}`, fixture.scopeName],
    );
    // Back-dated so it never becomes the default provider for other journeys; the
    // `source=tcgplayer` query selects it for this Scope detail journey only.
    await db.query(
      `INSERT INTO catalog_source_observation_integration_scope_summaries (
         provider_key, language_code, product_line_id, series_id, expansion_id, first_observed_at, latest_observed_at
       ) VALUES ('tcgplayer', 'en', 'e2e-import-status-filter', '', $1,
                 '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`,
      [fixture.expansionId],
    );
    await db.query(
      `INSERT INTO catalog_source_observation_integration_durable_jobs (
         job_id, job_kind, status, payload, progress, result, error_message, event_context,
         created_at, started_at, completed_at, updated_at
       ) VALUES
         ($1, 'import', 'completed', $3::jsonb,
          '{"phase":"completed","completed":3,"total":4,"currentName":null,"status":null}'::jsonb,
          $4::jsonb, NULL, $5::jsonb,
          now() - interval '3 minutes', now() - interval '3 minutes', now() - interval '2 minutes', now()),
         ($2, 'import', 'completed', $3::jsonb,
          '{"phase":"completed","completed":4,"total":4,"currentName":null,"status":"imported"}'::jsonb,
          '{"requested":4,"imported":4,"observed":4,"reapplied":0,"skipped":0,"failed":0,"outcomes":[]}'::jsonb,
          NULL, $5::jsonb,
          now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '1 minute', now())`,
      [
        fixture.partialJobId,
        fixture.completedJobId,
        payload,
        JSON.stringify({
          requested: 4,
          imported: 3,
          observed: 3,
          reapplied: 0,
          skipped: 0,
          failed: 1,
          outcomes: [
            {
              providerKey: "tcgplayer",
              languageCode: "en",
              expansionId: fixture.expansionId,
              status: "failed",
              observed: 0,
              reapplied: 0,
              reason: "Synthetic E2E provider failure",
            },
          ],
        }),
        eventContext,
      ],
    );
  });
}

async function deleteImportJobStatusFixture(pool: PgTransactionalPool, fixture: ImportJobStatusFixture): Promise<void> {
  await withPgTransaction(pool, async (db) => {
    await db.query(`DELETE FROM catalog_source_observation_integration_durable_jobs WHERE job_id = ANY($1::text[])`, [
      [fixture.partialJobId, fixture.completedJobId],
    ]);
    await db.query(
      `DELETE FROM catalog_source_observation_integration_scope_summaries
       WHERE provider_key = 'tcgplayer' AND language_code = 'en'
         AND product_line_id = 'e2e-import-status-filter' AND series_id = '' AND expansion_id = $1`,
      [fixture.expansionId],
    );
    await db.query(`DELETE FROM catalog_scope_records WHERE scope_record_id = $1`, [fixture.scopeRecordId]);
  });
}

async function getCurrentActorDisplay(page: Page): Promise<CurrentActorDisplay> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`);
  expect(response.status(), "current actor display should be readable").toBe(200);
  return (await response.json()) as CurrentActorDisplay;
}

// The import table renders a table branch and a card branch; only the branch
// visible at the current width counts as a shown row.
function visibleJobRow(importModule: Locator, jobId: string): Locator {
  return importModule.locator(`[data-catalog-import-job-id="${jobId}"]`).filter({ visible: true });
}

async function visibleRowCount(importModule: Locator): Promise<number> {
  return importModule.locator("[data-catalog-import-job-row='true']").filter({ visible: true }).count();
}

async function expectEveryVisibleRowHasOperatorStatus(importModule: Locator, status: string): Promise<void> {
  const rows = importModule.locator("[data-catalog-import-job-row='true']").filter({ visible: true });
  const statuses = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-catalog-import-job-operator-status")),
  );
  expect(statuses.length).toBeGreaterThan(0);
  expect(new Set(statuses)).toEqual(new Set([status]));
}

function summaryRow(filter: Locator, label: string): Locator {
  return filter.locator("dl > div").filter({ has: filter.page().locator("dt", { hasText: label }) }).locator("dd");
}

async function summaryValue(filter: Locator, label: string): Promise<string> {
  const value = summaryRow(filter, label);
  await expect(value).toBeVisible();
  return ((await value.textContent()) ?? "").trim();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page should not overflow horizontally").toBeLessThanOrEqual(1);
}
