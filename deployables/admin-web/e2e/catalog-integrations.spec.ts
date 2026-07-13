import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminWebHydrated,
  expectPageOk,
  expectVisibleText,
  skipDeployedAdminE2e,
} from "./support/admin-e2e";

async function clickUntilDisclosureExpanded(trigger: Locator, expanded: boolean) {
  const expectedValue = String(expanded);

  await expect
    .poll(
      async () => {
        if ((await trigger.getAttribute("aria-expanded")) !== expectedValue) {
          await trigger.click();
        }

        return trigger.getAttribute("aria-expanded");
      },
      { timeout: 10_000 },
    )
    .toBe(expectedValue);
}

type CatalogStreamProbeResult = Readonly<{
  status: number;
  contentType: string;
  textStart: string;
  error: string | null;
}>;

async function probeCatalogStreamEndpoint(page: Page, path: string): Promise<CatalogStreamProbeResult> {
  return page.evaluate(async (streamPath) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("stream probe timeout"), 5_000);

    try {
      const response = await window.fetch(streamPath, {
        credentials: "include",
        headers: { Accept: "text/event-stream, application/json" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const textStart = contentType.includes("text/event-stream") ? "" : (await response.text()).slice(0, 240);
      return { status: response.status, contentType, textStart, error: null };
    } catch (error) {
      return {
        status: 0,
        contentType: "",
        textStart: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }, path);
}

function expectControlledCatalogStreamProbe(path: string, result: CatalogStreamProbeResult) {
  expect(result.error, `${path} should resolve headers before the probe timeout`).toBeNull();
  if (result.status === 200) {
    expect(result.contentType, `${path} should open as an event stream`).toContain("text/event-stream");
    return;
  }

  expect([401, 403, 404], `${path} should return a controlled auth/not-found response`).toContain(result.status);
  expect(result.contentType, `${path} should not return host HTML`).toContain("application/json");
  expect(result.textStart, `${path} should not return an HTML fallback`).not.toMatch(/<!doctype html|<html/i);
  expect(() => JSON.parse(result.textStart || "{}"), `${path} should return JSON`).not.toThrow();
}

async function expectAliasReviewWorkspaceIfPresent(page: Page) {
  const aliasReviewHeading = page.getByRole("heading", { name: "Alias review" }).first();
  const aliasReviewRendered = await aliasReviewHeading.isVisible({ timeout: 30_000 }).catch(() => false);
  if (!aliasReviewRendered) {
    return;
  }

  await expect(aliasReviewHeading).toBeVisible();
  await expect(page.getByText("Needs review").first()).toBeVisible();
  await expect(page.getByText("Auto-accept eligible").first()).toBeVisible();
  await expect(page.getByText("Alias coverage").first()).toBeVisible();
  await expect(page.locator('[data-alias-review-coverage="true"]').first()).toBeVisible();

  const aliasReviewTable = page.getByRole("table", { name: "Alias review" });
  await expect(aliasReviewTable).toBeVisible();
  const candidateRow = aliasReviewTable
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Evidence" }) })
    .first();
  if (!(await candidateRow.isVisible().catch(() => false))) {
    await expect(page.getByText("No alias candidates").first()).toBeVisible();
    return;
  }

  await candidateRow.getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByText("Auto-accept").first()).toBeVisible();
  await expect(page.getByText("Warnings").first()).toBeVisible();
  await page.keyboard.press("Escape");

  const reviewCommands = candidateRow.locator("[data-alias-review-command]");
  await expect
    .poll(
      async () =>
        (await reviewCommands.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-alias-review-command")).filter(Boolean),
        )) as string[],
      { timeout: 10_000 },
    )
    .toEqual(expect.arrayContaining([expect.stringMatching(/^(accept|reject|defer|revoke|auto-accept)$/)]));
}

test.describe.serial("catalog admin integrations", () => {
  test("catalog job streams open or fail with controlled JSON responses @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations", "/access/sign-in");
    await expectPageOk(page, "/catalog/integrations");

    for (const path of [
      "/api/catalog/source-observations/integration-jobs/job_admin_e2e_missing/events",
      "/api/catalog/source-observations/bulk-jobs/job_admin_e2e_missing/events",
    ]) {
      expectControlledCatalogStreamProbe(path, await probeCatalogStreamEndpoint(page, path));
    }
  });

  test("signed-in catalog operator sees the rebuilt primary import-to-promotion workbench @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations", "/access/sign-in");
    await expectPageOk(page, "/catalog/integrations");
    // #1970: the daily loader now DEFERS the source-option fan-out and the
    // supplementary alias-review behind streamed Suspense boundaries, so the shell,
    // metric strip, and 3-stage flow paint before those resolve. Do NOT wait for
    // "networkidle" around the streaming boundary — the document streams in chunks
    // as the deferred promises settle, and a wait that assumes a fully-idle network
    // can race the streamed flush. Assert the shell paints first with an explicit
    // visibility wait on the always-synchronous heading.
    await expect(page).toHaveURL(/\/catalog\/integrations$/);
    await expect(
      page.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeVisible();
    await expectAdminWebHydrated(page);
    await expectVisibleText(page, "Catalog control plane");
    // #1970: when the selected provider profile declares source-option groups, the
    // deferred source-options status panel streams in after first paint. The default
    // provider is seed-dependent, so only assert the panel when this route context
    // actually renders one.
    const sourceOptionsPanel = page.getByText("Source options").first();
    if (await sourceOptionsPanel.count()) {
      await expect(sourceOptionsPanel).toBeVisible({ timeout: 30_000 });
    }
    // The supplementary alias-review workspace also streams behind its own boundary,
    // but its content is data-dependent (it resolves to nothing when there are no
    // alias candidates for the scope). Assert it only when it actually rendered, so
    // the test never assumes the seed carries alias candidates.
    await expectAliasReviewWorkspaceIfPresent(page);
    // The daily surface does not render a page-local "Import to promotion
    // workbench" label. The workbench identity is carried by the heading
    // (asserted above) and the linear three-stage flow ("Run sync" / "Review
    // changes" / "Create / update items", asserted below).
    // Cross-surface navigation now lives in the admin shell side nav as a nested
    // "Integrations" group, not a page-local "Catalog control plane workflows" nav.
    await expect(page.getByRole("navigation", { name: "Catalog control plane workflows" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Integrations" }).first()).toBeVisible();
    // The daily route is the group's Import child, so its side-nav link is current and
    // the sibling surface routes are reachable as nested children.
    await expect(page.locator('a[href="/catalog/integrations"]').first()).toHaveAttribute("aria-current", "page");
    await expect(page.locator('a[href="/catalog/integrations/providers"]').first()).toBeVisible();
    await expect(page.locator('a[href="/catalog/integrations/governance"]').first()).toBeVisible();
    await expect(page.locator('a[href="/catalog/integrations/health"]').first()).toBeVisible();

    await expect(page.getByRole("button", { name: "Apply context" })).toHaveCount(0);
    // #1973: "choosing what to import" lives in a collapsible "Step 0" import-context
    // bar ahead of the three-stage flow. Its trigger names the step and toggles the
    // provider/unit/guided-scope form. The seed daily route lands with the bar open
    // (its apply control "Select source scope" is reachable), so collapsing then
    // re-expanding it exercises the edit round trip. The toggle is pure client state
    // — it must NOT navigate (the URL is unchanged) and must NOT full-reload. Do not
    // wait for networkidle around it; assert the form's visibility transitions
    // directly with explicit waits.
    const importContextBar = page.locator("[data-catalog-import-context-bar='true']");
    const contextBarTrigger = importContextBar.getByRole("button", { name: /Step 0 · Choose import scope/ });
    const importProviderSelect = importContextBar.getByRole("combobox", { name: "Provider" });
    await expect(contextBarTrigger).toBeVisible();
    await expect(contextBarTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(importContextBar.getByRole("button", { name: "Select source scope" })).toBeVisible();
    const urlBeforeToggle = page.url();
    // Collapse to the one-line summary: the form's provider select hides.
    await clickUntilDisclosureExpanded(contextBarTrigger, false);
    await expect(importProviderSelect).toBeHidden();
    // Edit: re-expand to the form. The apply control returns, proving the round trip.
    await clickUntilDisclosureExpanded(contextBarTrigger, true);
    await expect(importProviderSelect).toBeVisible();
    await expect(importContextBar.getByRole("button", { name: "Select source scope" })).toBeVisible();
    // No navigation happened: collapse/expand never touched the URL or reloaded.
    expect(page.url()).toBe(urlBeforeToggle);
    // The daily route is now an explicit, linear three-stage flow. The ordered
    // stepper and the stage controls name each stage so "where do I run a sync /
    // create items?" is answerable at a glance. These labels render in the always-
    // visible stepper (and the stage accordion triggers), independent of which
    // stage is open.
    await expectVisibleText(page, "Run sync");
    await expectVisibleText(page, "Review changes");
    await expectVisibleText(page, "Create / update items");
    // The primary actions are not duplicated in the
    // shell header. Each action lives once in its owning stage. The header carries
    // only the per-surface return affordance (none on the daily route). Open each
    // owning stage and confirm its single canonical action; the run-sync stage is
    // the default landing when there is nothing to review yet.
    await page.getByRole("button", { name: "Run sync" }).first().click();
    const catalogSyncCommand = page.locator('form[data-catalog-primary-workbench-command="start-catalog-sync"]');
    await expect(catalogSyncCommand.getByRole("button", { name: "Start Catalog sync" })).toBeVisible();

    // #1969: an import-context change is now a fetcher-scoped CLIENT navigation,
    // not a full-document GET reload. The provider/unit/scope selects submit on
    // change and revalidate only the affected slices, so the open stage and the
    // mounted page survive. Re-select the provider's current value (a guaranteed,
    // seed-independent context submit) and confirm the "Run sync" stage stays open
    // — its Catalog sync action remains visible — and the URL is unchanged.
    // A pre-#1969 full reload would re-run the loader and reset to the default
    // stage, dropping the open Catalog sync action. Do NOT wait for
    // networkidle: the change triggers a streamed/deferred revalidation that may
    // never settle the network; assert the stage button's continued visibility
    // directly.
    const providerSelect = page.getByRole("combobox", { name: "Provider" });
    if (await providerSelect.count()) {
      const currentProvider = await providerSelect.first().inputValue();
      await providerSelect.first().selectOption(currentProvider);
      await expect(page).toHaveURL(/\/catalog\/integrations(\?|$)/);
      await expect(catalogSyncCommand.getByRole("button", { name: "Start Catalog sync" })).toBeVisible();
    }

    // #1974: the selected-record command surface is the canonical BulkActionBar /
    // BulkActionPanel (no hand-rolled WorkbenchDetailPanel selection block). Open the
    // "Review changes" stage and, IF the seed holds a selectable Source Observation,
    // select its row checkbox and prove the bulk bar surfaces the consolidated command
    // taxonomy: primary "Preview promotion", secondary "Defer" / "Clear selection", and
    // the destructive reason-required "Reject" behind a BulkActionPanel trigger that opens
    // a reason input. This is data-dependent (an empty review queue renders no selectable
    // rows), so every assertion is guarded on a row actually being selectable — the test
    // never assumes a non-empty seed.
    await page.getByRole("button", { name: "Review changes" }).first().click();
    const reviewRowCheckbox = page.getByRole("row").getByRole("checkbox");
    if (await reviewRowCheckbox.count()) {
      await reviewRowCheckbox.first().check();
      // The bar replaces the old hand-rolled panel: its primary/secondary commands and
      // the reject panel trigger are now the only selection-command affordances.
      await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Defer" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Clear selection" }).first()).toBeVisible();
      // #1975: selection now has a single, URL-backed source of truth. Checking a row
      // persists it straight to the URL via a client GET navigation (no full reload,
      // no hand-rolled "Save context" round-trip), so the selection survives in-place
      // revalidation and round-trips to the pager / deep links. The write is a replace
      // navigation, so poll the URL rather than asserting it synchronously; do NOT wait
      // for networkidle (the revalidation may defer-stream and never settle).
      await expect.poll(() => new URL(page.url()).searchParams.get("selectedObservationIds")).not.toBeNull();
      // Reject is reason-required, so it lives behind a panel trigger rather than inline.
      const rejectPanelTrigger = page.getByRole("button", { name: "Reject…" });
      await expect(rejectPanelTrigger.first()).toBeVisible();
      await rejectPanelTrigger.first().click();
      await expect(page.getByRole("textbox", { name: /Reject reason/i }).first()).toBeVisible();
      await page.keyboard.press("Escape");
      // "Clear selection" tears the bar back down, proving it is selection-scoped.
      await page.getByRole("button", { name: "Clear selection" }).first().click();
      await expect(page.getByRole("button", { name: /Preview promotion/i })).toHaveCount(0);
      // Clearing flows through the same single URL write: the durable selection is
      // dropped from the URL too (no orphaned selectedObservationIds left behind).
      await expect.poll(() => new URL(page.url()).searchParams.get("selectedObservationIds")).toBeNull();
    }

    // #2600: the review stage is candidate-first. Open a merged candidate's evidence
    // sheet (IF the seed has candidate rows) and prove operators see source comparison,
    // field provenance, and proposed reference/Product mapping without any raw JSON
    // entry path. Source Observation evidence remains available as a supporting
    // disclosure below and is asserted separately when rows exist.
    const mergeCandidateReviewHeading = page.getByRole("heading", { name: "Merged candidate review" });
    if (await mergeCandidateReviewHeading.count()) {
      await expect(mergeCandidateReviewHeading.first()).toBeVisible({ timeout: 30_000 });
      const candidateEvidenceTrigger = page
        .getByRole("table", { name: "Merged candidate review" })
        .getByRole("button", { name: "Evidence" });
      if (await candidateEvidenceTrigger.count()) {
        await candidateEvidenceTrigger.first().click();
        await expect(page.getByText("Source comparison").first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("Field provenance").first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("Proposed references and Product mapping").first()).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByText(/raw JSON/i)).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
    }

    const supportingSourceObservationEvidence = page.getByRole("button", { name: "Source Observation evidence" });
    if (await supportingSourceObservationEvidence.count()) {
      const sourceObservationEvidenceTriggerState = await supportingSourceObservationEvidence
        .first()
        .getAttribute("aria-expanded");
      if (sourceObservationEvidenceTriggerState !== "true") {
        await supportingSourceObservationEvidence.first().click();
      }
      await expect(page.getByRole("heading", { name: "Source Observation review" }).first()).toBeVisible({
        timeout: 30_000,
      });

      // #1971: Source Observation rows still ship slim rows; a row's deep evidence
      // is lazy-loaded via the per-observation evidence endpoint only when the
      // supporting row's sheet opens. This path is data-dependent, so it is guarded
      // on a Source Observation table row actually rendering.
      const sourceObservationEvidenceTrigger = page
        .getByRole("table", { name: "Source Observation review" })
        .getByRole("button", { name: "Evidence" });
      if (await sourceObservationEvidenceTrigger.count()) {
        await sourceObservationEvidenceTrigger.first().click();
        await expect(page.getByText("Source URL").first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("Normalized facts").first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/raw JSON/i)).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
    } else {
      await expect(page.getByText(/raw JSON/i)).toHaveCount(0);
    }

    await page.getByRole("button", { name: "Create / update items" }).first().click();
    await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: /JSON/i })).toHaveCount(0);
    await expect(page.getByText(/Old integrations surface/i)).toHaveCount(0);
  });

  test("scope-first admin journey: map a scope, sync it, edit and bulk-promote a candidate, and hand off to draft Catalog Items @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    // This journey walks the m88 scope-first admin path end to end: pick/confirm a
    // canonical sync scope, start a Catalog sync for it, review and edit a merged
    // candidate, bulk-promote reviewed Source Observations, and land on the draft
    // Catalog Items handoff. Every step that depends on seeded provider data stays
    // conditional (mirrors the rest of this file) — the merge-group e2e seed does
    // not currently populate Source Observations, so a hard assertion here would
    // repeat the poisoned-seed-contract incident this suite already guards
    // against. The composition/wiring assertions (scope selector present, stage
    // reachable, handoff route resolves) stay unconditional because they hold
    // regardless of seed volume.
    await authenticateAdmin(page, "/catalog/integrations", "/access/sign-in");
    await expectPageOk(page, "/catalog/integrations");
    await expectAdminWebHydrated(page);

    await test.step("Map / confirm the sync scope", async () => {
      const importContextBar = page.locator("[data-catalog-import-context-bar='true']");
      await expect(importContextBar.getByRole("combobox", { name: "Provider" })).toBeVisible();
      const unitSelect = importContextBar.getByRole("combobox", { name: "Unit" });
      if (await unitSelect.count()) {
        await expect(unitSelect.first()).toBeVisible();
      }
      // The scope-mapping affordance is either the guided select group (sourced
      // from synced provider source options, when the selected provider declares
      // option kinds) or the transitional free-text scope box — exactly one of
      // the two renders per provider. Either shape satisfies "a scope can be
      // mapped from this bar", so assert their union rather than assuming which
      // one the seed-selected provider declares.
      const guidedScopeGroup = page.getByRole("group", {
        name: /scope/i,
      });
      const scopeFreeTextInput = importContextBar.getByRole("textbox", { name: /scope/i });
      await expect(guidedScopeGroup.or(scopeFreeTextInput).first()).toBeVisible();
      await expect(importContextBar.getByRole("button", { name: "Select source scope" })).toBeVisible();
    });

    await test.step("Sync scope", async () => {
      await page.getByRole("button", { name: "Run sync" }).first().click();
      const catalogSyncCommand = page.locator('form[data-catalog-primary-workbench-command="start-catalog-sync"]');
      await expect(catalogSyncCommand.getByRole("button", { name: "Start Catalog sync" })).toBeVisible();
    });

    await test.step("Edit a merge candidate", async () => {
      await page.getByRole("button", { name: "Review changes" }).first().click();
      const mergeCandidateReviewHeading = page.getByRole("heading", { name: "Merged candidate review" });
      if (!(await mergeCandidateReviewHeading.count())) {
        return;
      }
      await expect(mergeCandidateReviewHeading.first()).toBeVisible({ timeout: 30_000 });
      const candidateTable = page.getByRole("table", { name: "Merged candidate review" });
      const updateCandidateButton = candidateTable.getByRole("button", { name: "Update" });
      if (await updateCandidateButton.count()) {
        // The per-candidate "Update" action is the edit affordance for a merged
        // candidate; it is reason-gated (a command form, not a bare link), so
        // proving it is present and enabled is the composition-level assertion —
        // the reason/command-body wiring is covered at the vitest layer.
        await expect(updateCandidateButton.first()).toBeVisible();
      }
    });

    await test.step("Bulk promote reviewed observations", async () => {
      const reviewRowCheckbox = page.getByRole("row").getByRole("checkbox");
      if (!(await reviewRowCheckbox.count())) {
        return;
      }
      await reviewRowCheckbox.first().check();
      // The bulk bar's "Preview promotion" is the promote command for the
      // selection (`CommandFormButton intent="preview-promotion"`, a real form
      // submit, not a client-side dialog). Assert the selection round-tripped to
      // the URL and the command is wired (visible, and either actionably enabled
      // or carrying its accessible denial reason) without submitting it — the
      // merge-group seed does not carry promotable observations, so actually
      // submitting here would exercise an unseeded write path rather than the
      // composition seam this suite owns. The full submit -> promoted-candidate
      // path is covered by the vitest merge-candidate-promotion-planner and
      // primary-workbench-admin-contracts suites.
      await expect.poll(() => new URL(page.url()).searchParams.get("selectedObservationIds")).not.toBeNull();
      const previewPromotionButton = page.getByRole("button", { name: /Preview promotion/i }).first();
      await expect(previewPromotionButton).toBeVisible();
      const previewPromotionEnabled = await previewPromotionButton.isEnabled();
      if (!previewPromotionEnabled) {
        await expect(previewPromotionButton).toHaveAttribute("aria-label", /.+/);
      }
    });

    await test.step("Verify draft Catalog Items handoff", async () => {
      await page.getByRole("button", { name: "Create / update items" }).first().click();
      await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
      // The handoff seam from the promotion stage into the separate Catalog Items
      // area, filtered to the drafts this scope's sync would have created. It must
      // resolve (HTTP < 400) even before any draft exists yet for this provider.
      await expectPageOk(page, "/catalog/catalog-items?source=tcgdex");
      await expect(page).toHaveURL(/\/catalog\/catalog-items\?source=tcgdex/);
    });
  });

  test("catalog operator can page review results and reach catalog item handoff @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations", "/access/sign-in");
    await expectPageOk(page, "/catalog/integrations");

    // #1966: the Source Observation review queue paginates past the first 25 rows. The
    // pager is a GET navigation that moves a durable reviewOffset cursor in the URL while
    // preserving provider/filters/selection, so the second page is reachable by carrying
    // reviewOffset=25 (alongside provider context + a current selection) and the daily
    // loader re-reads it to fetch that page. The deep-linked page must load (HTTP < 400),
    // round-trip the cursor, and keep the selection — proving the queue is navigable and
    // the count badge maps to a reachable list rather than a fixed 25-row dead end.
    await expectPageOk(
      page,
      "/catalog/integrations?providerKey=tcgdex&filter.status=changed&selectedObservationIds=obs_001&reviewOffset=25",
    );
    const reviewPageTwoUrl = new URL(page.url());
    expect(reviewPageTwoUrl.pathname).toBe("/catalog/integrations");
    expect(reviewPageTwoUrl.searchParams.get("reviewOffset")).toBe("25");
    expect(reviewPageTwoUrl.searchParams.get("providerKey")).toBe("tcgdex");
    expect(reviewPageTwoUrl.searchParams.get("selectedObservationIds")).toBe("obs_001");
    // The cursor round-trip above already proves the second page is reachable (the loader
    // reads reviewOffset and re-fetches that window). The pager itself is data-dependent:
    // when the environment holds more than one page of in-scope observations it renders, and
    // page 2 exposes a "Previous page" affordance so the queue is bidirectionally navigable;
    // when the environment holds a single page the pager is correctly absent (no dead-end
    // disabled controls). Assert the back-affordance only when the pager actually rendered, so
    // the test does not assume a seed volume greater than one page.
    const reviewPreviousPageLink = page.getByRole("link", { name: "Previous page" });
    if (await reviewPreviousPageLink.count()) {
      await expect(reviewPreviousPageLink.first()).toBeVisible();
    }
    // Return to the canonical daily route for the remaining assertions.
    await expectPageOk(page, "/catalog/integrations");

    // #1748 acceptance gate (criterion 1): the daily route is the DEFAULT landing, not a
    // detour. The supporting surfaces (providers/governance/health) each carry a single
    // "Back to import workbench" return affordance; the daily route itself must NOT — there
    // is nowhere "up" from the primary job. This is the explicit deliberate-detour property:
    // daily is home, the supporting surfaces are reached on purpose and always offer a way
    // back (the per-surface back-links are asserted on each surface below).
    await expect(page.getByRole("link", { name: "Back to import workbench" })).toHaveCount(0);

    // The Create / update stage deep-links into the separate Catalog Items area,
    // filtered to the just-created/updated drafts for the provider (?source=). That
    // target must load gracefully — even for an unknown provider, the filtered list
    // renders an empty result (HTTP < 400), never a 500. This is the integration ->
    // catalog-items handoff seam from #1746.
    //
    // Do NOT wait for "networkidle" here: the Catalog Items list subscribes to a
    // realtime patch stream (useCatalogRealtimeRevalidation -> subscribeRealtimePatches),
    // an open SSE connection that keeps the network perpetually active, so networkidle
    // never settles. expectPageOk already awaits domcontentloaded and asserts HTTP < 400,
    // which is exactly what this handoff seam needs to prove.
    await expectPageOk(page, "/catalog/catalog-items?source=tcgdex");
    await expect(page).toHaveURL(/\/catalog\/catalog-items\?source=tcgdex/);
    await expectPageOk(page, "/catalog/catalog-items?source=not-a-real-provider");

    const retiredListResponse = await page.goto(["/catalog", "source-observations"].join("/"), {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    expect(retiredListResponse?.status() ?? 0).toBeGreaterThanOrEqual(400);
    await expect(page.getByRole("heading", { name: "Source Observations" })).toHaveCount(0);
  });

  test("catalog operator can inspect integration health triage @catalog-admin-integrations", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations/health", "/access/sign-in");

    // Health triage now lives on the real /catalog/integrations/health surface route.
    await expectPageOk(
      page,
      "/catalog/integrations/health?providerKey=tcgdex&section=triage&filter.status=changed&selectedObservationIds=obs_001",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/health\?.*section=triage/);
    // The health surface is the nested "Integration health" child, so its
    // side-nav link is current and the Import child still links back to the daily route.
    await expect(page.locator('a[href="/catalog/integrations/health"]').first()).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator('a[href="/catalog/integrations"]').first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 900 });
    // There is no page-local workflow nav or mobile combobox; cross-surface
    // navigation is the admin shell's responsibility.
    await expect(page.getByRole("navigation", { name: "Catalog control plane workflows" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Choose Catalog workflow" })).toHaveCount(0);
    // The primary "Pull provider data" / "Preview promotion" actions are not
    // duplicated in the shell header, so the supporting surfaces (this is the
    // health surface) do not surface them — they live only in the daily flow's
    // owning stages, asserted on the daily route above.
    await expect(page.getByRole("button", { name: /Pull provider data/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Preview promotion/i })).toHaveCount(0);
    const healthTriageRegion = page.getByRole("region", { name: "Integration health triage" });
    await expect(healthTriageRegion).toBeVisible();
    for (const queryKey of [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "import-job-progress-summary",
      "audit-evidence-timeline",
    ]) {
      await expect(healthTriageRegion.getByText(queryKey).first()).toBeVisible();
    }
    await expect(healthTriageRegion.getByText("Read model").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("Ingestion unit").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("Catalog semantic").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("Provider transport").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("Provider adapter").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("Adapter capabilities").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("API").first()).toBeVisible();
    await expect(healthTriageRegion.getByText("Payload").first()).toBeVisible();
    await expect(
      healthTriageRegion.getByText(/No active or failed import jobs|Import job|Active jobs/i).first(),
    ).toBeVisible();
    // The health surface stacks three workspaces but renders the "Back to import
    // workbench" affordance exactly once, in the surface header (not once per
    // stacked workspace), so this needs no .first() disambiguator.
    const healthBackLinks = page.getByRole("link", { name: "Back to import workbench" });
    await expect(healthBackLinks).toHaveCount(1);
    await expect(healthBackLinks).toHaveAttribute("href", /\/catalog\/integrations(\?|$)/);
    await expect(page.getByRole("heading", { name: "Import to promotion workbench" })).toHaveCount(0);
    // The health surface stacks all three of its workspaces, so the audit timeline is
    // already rendered alongside health triage; its workspace heading stays visible.
    const auditEvidenceWorkspace = page.locator('[data-catalog-audit-evidence-workspace="true"]');
    await expect(auditEvidenceWorkspace).toBeVisible();
    await expect(page.getByRole("heading", { name: "Audit timeline" })).toBeVisible();
    await expect(auditEvidenceWorkspace.getByRole("heading", { name: "Evidence links" })).toBeVisible();
    await expect(auditEvidenceWorkspace.getByText("source payload body download")).toBeVisible();
    await expect(auditEvidenceWorkspace.getByText("operator identity expansion")).toBeVisible();
    // Return to the desktop side nav for the remaining surface assertions.
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test("catalog operator can inspect provider setup readiness @catalog-admin-integrations", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations/providers", "/access/sign-in");

    // The provider-setup surface hosts profile authoring and validation readiness as a
    // single coherent setup route, off the daily flow. Carry a full working set in and
    // confirm setup -> return-to-daily round-trips provider/unit/scope/profileVersion.
    // The deep-linked profileVersion here (2026.06.04) is a stale/unknown version — the
    // exact shape a missing/invalid-profile blocker deep-links so an operator can author
    // it. The providers loader must recover from the backend's 404 for that version into
    // the absent-authoring-model state and render (HTTP < 400), not surface a 500.
    await expectPageOk(
      page,
      "/catalog/integrations/providers?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.04",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/providers\?/);
    // Both provider-setup workspaces render, stacked on the one providers route. Their
    // headings are structural (information-architecture metadata) and render in the
    // absent-authoring-model state, so they do not depend on the stale version resolving.
    await expectVisibleText(page, "Provider profile authoring");
    await expectVisibleText(page, "Validation readiness");
    // The providers surface is the nested "Provider setup" child, so its side-nav link is current.
    await expect(page.locator('a[href="/catalog/integrations/providers"]').first()).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The setup workspaces are not part of the daily route's content/navigation: the daily
    // import-to-promotion workspace heading does not render on the providers surface.
    await expect(page.getByRole("heading", { name: "Import to promotion workbench" })).toHaveCount(0);
    // Return-to-daily preserves the full working set on the base /catalog/integrations route.
    // The providers surface renders its single header "Back to import workbench" affordance
    // once (not per stacked workspace); when the deep-linked profile version is stale
    // the profile-authoring empty state also offers a return path, so take the header link
    // (first in DOM order) explicitly.
    const backToDailyHref = await page
      .getByRole("link", { name: "Back to import workbench" })
      .first()
      .getAttribute("href");
    const backToDailyUrl = new URL(backToDailyHref ?? "", new URL(page.url()).origin);
    expect(backToDailyUrl.pathname).toBe("/catalog/integrations");
    expect(backToDailyUrl.searchParams.has("section")).toBe(false);
    expect(backToDailyUrl.searchParams.get("providerKey")).toBe("tcgdex");
    expect(backToDailyUrl.searchParams.get("unitKey")).toBe("tcgdex:pokemon:card:import");
    expect(backToDailyUrl.searchParams.get("importScope")).toBe("en:3:base:base1");
    expect(backToDailyUrl.searchParams.get("profileVersion")).toBe("2026.06.04");

    // A resolving provider profile exposes the read-only authoring lifecycle without
    // submitting commands: operators can clone, inspect typed section editors, review
    // dry-run/readiness evidence, and see the guarded activation command from one setup
    // surface.
    await expectPageOk(
      page,
      "/catalog/integrations/providers?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.03",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/providers\?/);
    const providerProfileWorkspace = page.locator("[data-catalog-profile-authoring-workspace='true']");
    await expect(providerProfileWorkspace).toBeVisible();
    await expect(providerProfileWorkspace.getByRole("button", { name: "Create draft" })).toBeVisible();
    await expect(
      providerProfileWorkspace.locator('form[data-catalog-primary-workbench-command="clone-provider-profile"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        page.locator('form[data-catalog-primary-workbench-command="update-provider-profile-section"]').count(),
      )
      .toBeGreaterThan(0);

    const validationWorkspace = page.locator("[data-catalog-validation-readiness-workspace='true']");
    await expect(validationWorkspace).toBeVisible();
    await expect(validationWorkspace.getByRole("heading", { name: "Provider readiness" })).toBeVisible();
    await expect(validationWorkspace.getByRole("heading", { name: "Dry-run evidence" })).toBeVisible();
    await expect(validationWorkspace.getByRole("heading", { name: "Activation readiness" })).toBeVisible();
    await expect(validationWorkspace.getByRole("heading", { name: "Activation decision" })).toBeVisible();
    await expect(page.locator('form[data-catalog-validation-evidence-form="true"]')).toHaveCount(1);
    await expect(page.locator('form[data-catalog-activate-profile-form="true"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Save migration evidence" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate profile" })).toBeVisible();
  });

  test("catalog operator can inspect governance and lifecycle controls @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/integrations/governance", "/access/sign-in");

    // The governance-and-recovery surface hosts conflict resolution, lifecycle recovery,
    // and governance controls as rare, privileged ops off the daily route. The daily flow's
    // slim denied/stopped indicator deep-links here (section=controls) carrying return
    // context. Land on that exact deep-link shape — including a stale/unknown profileVersion,
    // the shape a missing/invalid-profile blocker carries — and confirm the governance loader
    // recovers from the backend's 404 into the absent-authoring-model state and renders
    // (HTTP < 400) rather than surfacing a 500.
    await expectPageOk(
      page,
      "/catalog/integrations/governance?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.04&section=controls",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/governance\?/);
    // All three govern-and-recover workspaces render, stacked on the one governance route.
    await expectVisibleText(page, "Conflict resolution");
    await expectVisibleText(page, "Lifecycle recovery");
    await expectVisibleText(page, "Governance controls");
    // The governance surface is the nested "Governance" child, so its side-nav link is current.
    await expect(page.locator('a[href="/catalog/integrations/governance"]').first()).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The full RBAC / kill-switch / observability panel lives here, not on the daily route.
    await expect(page.getByRole("heading", { name: "RBAC action matrix" })).toBeVisible();
    // The governance surface stacks three workspaces but renders the "Back to import
    // workbench" affordance exactly once, in the surface header; it preserves the working set.
    const governanceBackLinks = page.getByRole("link", { name: "Back to import workbench" });
    await expect(governanceBackLinks).toHaveCount(1);
    const backFromGovernanceHref = await governanceBackLinks.getAttribute("href");
    const backFromGovernanceUrl = new URL(backFromGovernanceHref ?? "", new URL(page.url()).origin);
    expect(backFromGovernanceUrl.pathname).toBe("/catalog/integrations");
    expect(backFromGovernanceUrl.searchParams.has("section")).toBe(false);
    expect(backFromGovernanceUrl.searchParams.get("providerKey")).toBe("tcgdex");

    // Magic provider imports stay production-signoff gated in production-like admin
    // environments. Deep-link the governance surface directly so the E2E proves the
    // disabled-import control instead of relying on whatever provider the default
    // daily route selected.
    await expectPageOk(
      page,
      "/catalog/integrations/governance?providerKey=scryfall&unitKey=scryfall%3Amtg%3Asingle-card%3Areference-data&section=controls",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/governance\?.*providerKey=scryfall/);
    const governanceControls = page.locator("[data-catalog-governance-controls-workspace='true']");
    await expect(governanceControls).toBeVisible();
    await expect(governanceControls.getByRole("cell", { name: /imports-disabled/i }).first()).toBeVisible();
    await expect(
      governanceControls
        .getByRole("cell", {
          name: /Catalog integration imports are disabled for the configured provider scope\./i,
        })
        .first(),
    ).toBeVisible();
    const magicProductionSignoffRow = governanceControls
      .getByRole("row")
      .filter({ hasText: "magic-production-signoff-required" });
    if (await magicProductionSignoffRow.count()) {
      await expect(magicProductionSignoffRow.first()).toBeVisible();
      await expect(
        magicProductionSignoffRow
          .first()
          .getByRole("cell", {
            name: /Magic production sync requires recorded provider-data signoff and interface-only staging UAT evidence\./i,
          })
          .first(),
      ).toBeVisible();
    }

    // With a resolving profile selected, lifecycle recovery renders the rollback,
    // deprecate, and retire command forms with confirmation and complete-removal evidence.
    // The test deliberately does not submit the forms.
    await expectPageOk(
      page,
      "/catalog/integrations/governance?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.03&section=lifecycle",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/governance\?.*section=lifecycle/);
    const lifecycleWorkspace = page.locator("[data-catalog-lifecycle-recovery-workspace='true']");
    await expect(lifecycleWorkspace).toBeVisible();
    await expect(lifecycleWorkspace.getByRole("heading", { name: "Rollback profile" })).toBeVisible();
    await expect(lifecycleWorkspace.getByRole("heading", { name: "Deprecate profile" })).toBeVisible();
    await expect(lifecycleWorkspace.getByRole("heading", { name: "Retire profile" })).toBeVisible();
    await expect(lifecycleWorkspace.getByText("Retirement removes the profile behavior")).toBeVisible();
    await expect(
      lifecycleWorkspace.getByText(/Retiring a provider profile removes its mapping and promotion behavior/i),
    ).toBeVisible();
    await expect(page.locator('form[data-catalog-lifecycle-command="rollback"]')).toHaveCount(1);
    await expect(page.locator('form[data-catalog-lifecycle-command="deprecate"]')).toHaveCount(1);
    await expect(page.locator('form[data-catalog-lifecycle-command="retire"]')).toHaveCount(1);
    for (const operation of ["rollback", "deprecate", "retire"] as const) {
      const lifecycleCommand = page.locator(`form[data-catalog-lifecycle-command="${operation}"]`).first();
      await expect(lifecycleCommand.locator('input[name="_intent"]')).toHaveValue(`${operation}-provider-profile`);
      await expect(lifecycleCommand.locator('input[name="providerKey"]')).toHaveValue("tcgdex");
      await expect(lifecycleCommand.locator('input[name="unitKey"]')).toHaveValue("tcgdex:pokemon:card:import");
      await expect(lifecycleCommand.locator('input[name="importScope"]')).toHaveValue("en:3:base:base1");
      await expect(lifecycleCommand.locator('input[name="profileVersion"]')).toHaveValue("2026.06.03");
      await expect(lifecycleCommand.locator('input[name="selectedObservationIds"]')).toHaveValue("");
      await expect(lifecycleCommand.locator('input[name="jobId"]')).toHaveValue("");
      await expect(lifecycleCommand.locator('input[name="promotionPreviewId"]')).toHaveValue("");
    }
    await expect(page.getByLabel(/I confirm rollback profile impact and audit evidence/i)).toBeVisible();
    await expect(page.getByLabel(/I confirm deprecate profile impact and audit evidence/i)).toBeVisible();
    await expect(
      page.getByLabel(/I confirm retirement removes this provider profile behavior entirely/i),
    ).toBeVisible();

    // The compact daily health signal deep-links into health triage on the health
    // surface. Land on that exact deep-link shape — including a stale/unknown
    // profileVersion (the shape a missing/invalid-profile blocker carries) — and confirm
    // the health loader recovers from the backend's 404 into the absent-authoring-model
    // state and renders (HTTP < 400) rather than surfacing a 500.
    await expectPageOk(
      page,
      "/catalog/integrations/health?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.04&section=triage",
    );
    await expect(page).toHaveURL(/\/catalog\/integrations\/health\?.*section=triage/);
    await expect(page.getByRole("heading", { name: "Integration health triage" })).toBeVisible();
  });
});
