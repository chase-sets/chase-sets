import { expect, test, type TestInfo } from "@playwright/test";
import { createPgPool, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

const SKIP_REASON = "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.";

// The canonical Scope Record list is the primary
// entry into the catalog control plane. These checks assert the surface renders
// with its filter controls and that each scope row opens its own Scope Detail
// journey — without depending on any particular seeded scope, so the test is
// stable across seed states for ordinary route behavior (an empty registry
// renders the empty state instead of rows). Manifest-designated responsive
// evidence below deliberately fails closed unless its named bootstrap fixture
// has populated the exact card/table target.
test.describe.serial("catalog admin scopes", () => {
  test("signed-in catalog operator lands on the scope-first list with domain / language / status filters @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");

    await expectAdminPageReady(page, { heading: "Scopes" });

    // Primary filters render inline; the extra product-domain and language
    // facets live behind the overflow panel like other catalog list surfaces.
    await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
    await page.getByRole("button", { name: /More filters/ }).click();
    await expect(page.getByRole("combobox", { name: "Product domain" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
    await page.getByRole("button", { name: "Close filters" }).click();

    // The Scopes nav entry is the active surface.
    await expect(page.locator('a[href="/catalog/scopes"]').first()).toHaveAttribute("aria-current", "page");
  });

  test("a scope row opens that scope's own Scope Detail journey @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    const viewLinks = page.getByRole("link", { name: "View" });
    const rowCount = await viewLinks.count();
    test.skip(rowCount === 0, "No scope records seeded in this environment; the landing renders its empty state.");

    const firstView = viewLinks.first();
    await expect(firstView).toHaveAttribute("href", /\/catalog\/scopes\//);
    await firstView.click();

    // Scope Detail is a real per-scope page (its own heading), not a modal detour.
    await expect(page).toHaveURL(/\/catalog\/scopes\/.+/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Coverage matrix" })).toBeVisible();
    await expect(page.getByText("Catalog scope sync", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Review changes/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create \/ update items/ })).toBeVisible();
  });

  test("Scope Detail journey starts from populated cards at 390px @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    await captureResponsiveEvidence({ page, testInfo, claimId: "catalog-scope-cards-mobile" });

    const scopeCards = page.locator("main div[role='list']");
    await scopeCards.locator(":scope > [role='listitem']").first().getByRole("link", { name: "View" }).click();

    await expect(page.getByRole("heading", { name: "Coverage matrix" })).toBeVisible();
    await expect(page.getByText("Catalog scope sync", { exact: true })).toBeVisible();
  });

  test("scope-first landing renders a populated table at 820px @catalog-admin-scopes @catalog-admin-integrations", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes");
    await expectAdminPageReady(page, { heading: "Scopes" });

    await captureResponsiveEvidence({ page, testInfo, claimId: "catalog-scope-table-tablet" });
  });

  test("scope-sync-held-set-entry uploads, resolves, previews exact ids, and confirms @catalog-admin-integrations", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(skipDeployedAdminE2e, SKIP_REASON);

    await authenticateAdmin(page, "/catalog/scopes/sync-batches", "/access/sign-in");
    await expectPageOk(page, "/catalog/scopes/sync-batches");
    await expectAdminPageReady(page, { heading: "Scope Sync Batches" });
    await seedHeldSetScopeSyncScenario(testInfo);

    const header = [
      "TCGplayer Id",
      "Product Line",
      "Set Name",
      "Product Name",
      "Title",
      "Number",
      "Rarity",
      "Condition",
      "TCG Market Price",
      "TCG Direct Low",
      "TCG Low Price With Shipping",
      "TCG Low Price",
      "Total Quantity",
      "Add to Quantity",
      "TCG Marketplace Price",
      "Photo URL",
    ];
    const rows = [
      ["1", "Magic", "Time Spiral"],
      ["2", "Pokemon", "Scarlet & Violet"],
      ["3", "Yu-Gi-Oh!", "Starter Deck: Yugi"],
      ["4", "One Piece Card Game", "Romance Dawn"],
      ["5", "Pokemon Japan", "Japanese Set"],
    ].map(([id, productLine, setName]) =>
      header
        .map((column) =>
          column === "TCGplayer Id"
            ? id
            : column === "Product Line"
              ? productLine
              : column === "Set Name"
                ? setName
                : "ignored",
        )
        .join(","),
    );
    await page.getByLabel("Held-set export CSV").setInputFiles({
      name: "held-sets.csv",
      mimeType: "text/csv",
      buffer: Buffer.from([header.join(","), ...rows].join("\r\n"), "utf8"),
    });
    await page.getByRole("button", { name: "Resolve held sets" }).click();
    await expectAdminPageReady(page, { heading: "Scope Sync Batches" });

    const resolvedTable = page.getByRole("table", { name: "Resolved held sets", exact: true });
    const unresolvedTable = page.getByRole("table", { name: "Unresolved held sets", exact: true });
    await expect(resolvedTable).toBeVisible();
    await expect(unresolvedTable).toContainText("Pokemon Japan / Japanese Set");
    await expect(unresolvedTable).toContainText("product-line-unresolved");
    const resolvedIds = await resolvedTable.locator("tbody tr td:nth-child(2)").allTextContents();
    expect(resolvedIds).toHaveLength(4);
    await expect(unresolvedTable.getByRole("link", { name: "Open unmapped-scope inbox" })).toHaveAttribute(
      "href",
      "/catalog/scope-coverage",
    );

    await page.getByRole("button", { name: "Preview resolved sets" }).click();
    await expectAdminPageReady(page, { heading: "Scope Sync Batches" });
    const previewTable = page.getByRole("table", {
      name: "Bounded Scope Sync Batch preview sample",
      exact: true,
    });
    const previewIds = await previewTable.locator("tbody tr td:nth-child(1)").allTextContents();
    expect(previewIds).toEqual(resolvedIds);
    await expect(page.getByText("0 ready scopes, 4 blocked scopes, 4 provider units.", { exact: true })).toBeVisible();
    const planningBlockerAlerts = page
      .getByRole("alert")
      .filter({ has: page.getByText("scope-planning-blocked", { exact: true }) });
    await expect(
      planningBlockerAlerts.filter({
        has: page.getByText("TCGplayer automation credential/session readiness is missing.", { exact: true }),
      }),
    ).toHaveCount(4);
    await expect(
      planningBlockerAlerts.filter({
        has: page.getByText("TCGplayer automation transport is not configured in this runtime.", { exact: true }),
      }),
    ).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Confirm and enqueue", exact: true })).toHaveCount(0);
  });
});

const heldSetScopeSyncFixtures = [
  {
    scopeRecordId: "scope_e2e_held_set_magic_time_spiral",
    productDomain: "magic",
    scopeKind: "set",
    unitKey: "tcgplayer:mtg:single-card:source-observation-import",
    externalId: "e2e-held-set-magic-time-spiral",
    label: "Time Spiral",
  },
  {
    scopeRecordId: "scope_e2e_held_set_pokemon_scarlet_violet",
    productDomain: "pokemon",
    scopeKind: "expansion",
    unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
    externalId: "e2e-held-set-pokemon-scarlet-violet",
    label: "Scarlet & Violet",
  },
  {
    scopeRecordId: "scope_e2e_held_set_yugioh_starter_yugi",
    productDomain: "yugioh",
    scopeKind: "set",
    unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    externalId: "e2e-held-set-yugioh-starter-yugi",
    label: "Starter Deck: Yugi",
  },
  {
    scopeRecordId: "scope_e2e_held_set_one_piece_romance_dawn",
    productDomain: "one-piece",
    scopeKind: "set",
    unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
    externalId: "e2e-held-set-one-piece-romance-dawn",
    label: "Romance Dawn",
  },
] as const;

async function seedHeldSetScopeSyncScenario(testInfo: TestInfo): Promise<void> {
  if (process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true") return;

  const catalogDatabaseUrl = testInfo.config.metadata.catalogDatabaseUrl;
  if (typeof catalogDatabaseUrl !== "string" || catalogDatabaseUrl.length === 0) {
    throw new Error("scope-sync-held-set-entry requires the Catalog E2E database target.");
  }
  const pool = createPgPool(catalogDatabaseUrl, { max: 1 });
  try {
    await withPgTransaction(pool, async (db) => {
      for (const fixture of heldSetScopeSyncFixtures) {
        await db.query(
          `INSERT INTO catalog_scope_records (
             scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id,
             reference_record_key, name, lifecycle_status
           ) VALUES ($1, $2, $3, $3, $4, $4, $5, 'active')
           ON CONFLICT (scope_record_id) DO UPDATE SET
             product_domain = EXCLUDED.product_domain,
             scope_kind = EXCLUDED.scope_kind,
             reference_type_key = EXCLUDED.reference_type_key,
             reference_record_id = EXCLUDED.reference_record_id,
             reference_record_key = EXCLUDED.reference_record_key,
             name = EXCLUDED.name,
             lifecycle_status = EXCLUDED.lifecycle_status`,
          [
            fixture.scopeRecordId,
            fixture.productDomain,
            fixture.scopeKind,
            `reference-${fixture.scopeRecordId}`,
            fixture.label,
          ],
        );
        await db.query(
          `INSERT INTO catalog_provider_scope_observations (
             provider_key, unit_key, scope_kind, source_query_kind, language_code, external_id, label,
             observation_hash, scan_id, scanned_at
           ) VALUES ('tcgplayer', $1, $2, 'sets', 'en', $3, $4, $5, 'scan-e2e-held-set-scope-sync', now())
           ON CONFLICT (provider_key, unit_key, scope_kind, language_code, external_id) DO UPDATE SET
             source_query_kind = EXCLUDED.source_query_kind,
             label = EXCLUDED.label,
             observation_hash = EXCLUDED.observation_hash,
             scan_id = EXCLUDED.scan_id,
             scanned_at = EXCLUDED.scanned_at`,
          [fixture.unitKey, fixture.scopeKind, fixture.externalId, fixture.label, `hash-${fixture.externalId}`],
        );
        await db.query(
          `INSERT INTO catalog_provider_scope_mappings (
             mapping_id, scope_record_id, provider_key, unit_key, set_id, set_name,
             confidence, review_status, last_actor, last_reason, policy_version, reviewed_at
           ) VALUES ($1, $2, 'tcgplayer', $3, $4, $5, 'exact', 'accepted',
                     'scope-sync-held-set-entry', 'E2E scenario fixture', 'provider-scope-mapping-v1', now())
           ON CONFLICT (mapping_id) DO UPDATE SET
             scope_record_id = EXCLUDED.scope_record_id,
             provider_key = EXCLUDED.provider_key,
             unit_key = EXCLUDED.unit_key,
             set_id = EXCLUDED.set_id,
             set_name = EXCLUDED.set_name,
             confidence = EXCLUDED.confidence,
             review_status = EXCLUDED.review_status,
             last_actor = EXCLUDED.last_actor,
             last_reason = EXCLUDED.last_reason,
             policy_version = EXCLUDED.policy_version,
             reviewed_at = EXCLUDED.reviewed_at,
             updated_at = now()`,
          [
            `mapping-${fixture.scopeRecordId}`,
            fixture.scopeRecordId,
            fixture.unitKey,
            fixture.externalId,
            fixture.label,
          ],
        );
      }
    });
  } finally {
    await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
  }
}
