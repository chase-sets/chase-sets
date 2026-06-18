import { expect, test, type Page } from "@playwright/test";

const configuredCatalogAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const configuredCatalogAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const catalogAdminAccount = {
  email: configuredCatalogAdminEmail || "demo@chasesets.test",
  password: configuredCatalogAdminPassword || "demo1234",
};
const skipDeployedAdminE2e =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true" &&
  (configuredCatalogAdminEmail.length === 0 || configuredCatalogAdminPassword.length === 0);
const authApiTimeoutMs = 90_000;
const pageReadyTimeoutMs = 90_000;

async function expectPageOk(page: Page, path: string) {
  const deadline = Date.now() + pageReadyTimeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (response && response.status() < 400) {
        return;
      }
      lastError = new Error(response ? `${path} returned HTTP ${response.status()}` : `${path} returned no response`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await page.waitForTimeout(1_000);
  }

  throw lastError ?? new Error(`${path} did not become ready`);
}

async function addSessionCookie(page: Page, origin: string, sessionToken: string) {
  await page.context().addCookies([
    {
      name: "chase_sets_session",
      value: sessionToken,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);

  const sessionCookie = (await page.context().cookies(origin)).find((cookie) => cookie.name === "chase_sets_session");
  expect(sessionCookie, "browser context should store the auth session cookie").toBeTruthy();
}

async function authenticateCatalogAdmin(page: Page) {
  await expectPageOk(page, "/catalog/sign-in?returnTo=%2Fcatalog%2Fintegrations");
  const origin = new URL(page.url()).origin;
  const deadline = Date.now() + authApiTimeoutMs;
  let response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: catalogAdminAccount.email,
      password: catalogAdminAccount.password,
    },
  });

  while ([502, 503, 504].includes(response.status()) && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
      data: {
        email: catalogAdminAccount.email,
        password: catalogAdminAccount.password,
      },
    });
  }

  expect(response.status(), "catalog admin password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "catalog admin sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
}

async function expectVisibleText(page: Page, text: string) {
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
}

test.describe("catalog admin integrations", () => {
  test("signed-in catalog operator sees the rebuilt primary import-to-promotion workbench @catalog-admin-integrations", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateCatalogAdmin(page);
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
    await expectVisibleText(page, "Catalog control plane");
    // #1970: the deferred source-options status panel streams in after first paint.
    // The seed's tcgdex profile declares source-option groups, so the panel renders
    // once the streamed slice resolves. Assert it EVENTUALLY becomes visible (it is
    // not present at first paint) without asserting any option volume — the seed has
    // ≤25 changed observations and the streamed groups may be cache-only or degraded.
    await expect(page.getByText("Source options").first()).toBeVisible({ timeout: 30_000 });
    // The supplementary alias-review workspace also streams behind its own boundary,
    // but its content is data-dependent (it resolves to nothing when there are no
    // alias candidates for the scope). Assert it only when it actually rendered, so
    // the test never assumes the seed carries alias candidates.
    const aliasReviewHeading = page.getByRole("heading", { name: "Alias review" });
    if (await aliasReviewHeading.count()) {
      await expect(aliasReviewHeading.first()).toBeVisible({ timeout: 30_000 });
    }
    // The rebuilt daily surface no longer renders a page-local "Import to promotion
    // workbench" label; that text was tied to the removed page-local workflow/module
    // nav. The workbench identity is now carried by the heading (asserted above) and the
    // linear three-stage flow ("Run sync" / "Review changes" / "Create / update items",
    // asserted below).
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
    const contextBarTrigger = page.getByRole("button", { name: /Step 0 · Choose import scope/ });
    await expect(contextBarTrigger.first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Select source scope" }).first()).toBeVisible();
    const urlBeforeToggle = page.url();
    // Collapse to the one-line summary: the form's provider select hides.
    await contextBarTrigger.first().click();
    await expect(page.getByRole("combobox", { name: "Provider" })).toBeHidden();
    // Edit: re-expand to the form. The apply control returns, proving the round trip.
    await contextBarTrigger.first().click();
    await expect(page.getByRole("combobox", { name: "Provider" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select source scope" }).first()).toBeVisible();
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
    // #1967 consolidation: the primary actions are no longer duplicated in the
    // shell header. Each action lives once in its owning stage. The header carries
    // only the per-surface return affordance (none on the daily route). Open each
    // owning stage and confirm its single canonical action; the run-sync stage is
    // the default landing when there is nothing to review yet.
    await page.getByRole("button", { name: "Run sync" }).first().click();
    await expect(page.getByRole("button", { name: /Pull provider data/i })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Pull provider data/i }).first()).toBeVisible();

    // #1969: an import-context change is now a fetcher-scoped CLIENT navigation,
    // not a full-document GET reload. The provider/unit/scope selects submit on
    // change and revalidate only the affected slices, so the open stage and the
    // mounted page survive. Re-select the provider's current value (a guaranteed,
    // seed-independent context submit) and confirm the "Run sync" stage stays open
    // — its "Pull provider data" action remains visible — and the URL is unchanged.
    // A pre-#1969 full reload would re-run the loader and reset to the default
    // stage, dropping the open "Pull provider data" action. Do NOT wait for
    // networkidle: the change triggers a streamed/deferred revalidation that may
    // never settle the network; assert the stage button's continued visibility
    // directly.
    const providerSelect = page.getByRole("combobox", { name: "Provider" });
    if (await providerSelect.count()) {
      const currentProvider = await providerSelect.first().inputValue();
      await providerSelect.first().selectOption(currentProvider);
      await expect(page).toHaveURL(/\/catalog\/integrations(\?|$)/);
      await expect(page.getByRole("button", { name: /Pull provider data/i }).first()).toBeVisible();
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

    // #1971: the review list ships slim rows; a row's deep evidence (full normalized
    // facts, duplicate/conflict/audit lists, and the provenance KeyValueList) is
    // lazy-loaded via a useFetcher to the per-observation evidence endpoint only when
    // the row's evidence SideSheet opens. Open the first row's "Evidence" sheet (IF the
    // seed holds a review row) and prove the deep content arrives AFTER open with an
    // explicit visibility wait — never networkidle, which can race the fetcher. Assert
    // the sheet's lazily-loaded provenance ("Source URL") and a deep evidence section
    // ("Normalized facts") become visible, and that no raw provider JSON leaks. This is
    // data-dependent, so it is guarded on an "Evidence" trigger actually rendering.
    const evidenceTrigger = page.getByRole("button", { name: "Evidence" });
    if (await evidenceTrigger.count()) {
      await evidenceTrigger.first().click();
      // The lazily-fetched evidence detail populates the KeyValueList and the deep
      // evidence sections; wait for that fetched content explicitly (it is not present
      // at sheet-open time, only after the fetcher resolves).
      await expect(page.getByText("Source URL").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Normalized facts").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/raw JSON/i)).toHaveCount(0);
      await page.keyboard.press("Escape");
    }

    await page.getByRole("button", { name: "Create / update items" }).first().click();
    await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: /JSON/i })).toHaveCount(0);
    await expect(page.getByText(/Old integrations surface/i)).toHaveCount(0);

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
    await page.waitForLoadState("networkidle");
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
    await page.waitForLoadState("networkidle");

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

    // Health triage now lives on the real /catalog/integrations/health surface route.
    await expectPageOk(
      page,
      "/catalog/integrations/health?providerKey=tcgdex&section=triage&filter.status=changed&selectedObservationIds=obs_001",
    );
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/catalog\/integrations\/health\?.*section=triage/);
    // The health surface is the nested "Integration health" child, so its
    // side-nav link is current and the Import child still links back to the daily route.
    await expect(page.locator('a[href="/catalog/integrations/health"]').first()).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator('a[href="/catalog/integrations"]').first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 900 });
    // The page-local workflow nav and its mobile combobox are gone; cross-surface
    // navigation is the admin shell's responsibility now.
    await expect(page.getByRole("navigation", { name: "Catalog control plane workflows" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Choose Catalog workflow" })).toHaveCount(0);
    // #1967: the primary "Pull provider data" / "Preview promotion" actions are no
    // longer duplicated in the shell header, so the supporting surfaces (this is the
    // health surface) no longer surface them — they live only in the daily flow's
    // owning stages, asserted on the daily route above.
    await expect(page.getByRole("button", { name: /Pull provider data/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Preview promotion/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Integration health triage" })).toBeVisible();
    // The health surface stacks three workspaces but renders the "Back to import
    // workbench" affordance exactly once, in the surface header (no longer once per
    // stacked workspace), so this no longer needs a .first() disambiguator.
    const healthBackLinks = page.getByRole("link", { name: "Back to import workbench" });
    await expect(healthBackLinks).toHaveCount(1);
    await expect(healthBackLinks).toHaveAttribute("href", /\/catalog\/integrations(\?|$)/);
    await expect(page.getByRole("heading", { name: "Import to promotion workbench" })).toHaveCount(0);
    // The health surface stacks all three of its workspaces, so the audit timeline is
    // already rendered alongside health triage; its workspace heading stays visible.
    await expect(page.getByRole("heading", { name: "Audit timeline" })).toBeVisible();
    // Return to the desktop side nav for the remaining surface assertions.
    await page.setViewportSize({ width: 1280, height: 900 });

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
    await page.waitForLoadState("networkidle");
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
    // The setup workspaces are gone from the daily route's content/navigation: the daily
    // import-to-promotion workspace heading does not render on the providers surface.
    await expect(page.getByRole("heading", { name: "Import to promotion workbench" })).toHaveCount(0);
    // Return-to-daily preserves the full working set on the base /catalog/integrations route.
    // The providers surface renders its single header "Back to import workbench" affordance
    // once (no longer per stacked workspace); when the deep-linked profile version is stale
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
    await page.waitForLoadState("networkidle");
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

    // The compact daily health signal deep-links into health triage on the health
    // surface. Land on that exact deep-link shape — including a stale/unknown
    // profileVersion (the shape a missing/invalid-profile blocker carries) — and confirm
    // the health loader recovers from the backend's 404 into the absent-authoring-model
    // state and renders (HTTP < 400) rather than surfacing a 500.
    await expectPageOk(
      page,
      "/catalog/integrations/health?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.04&section=triage",
    );
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/catalog\/integrations\/health\?.*section=triage/);
    await expect(page.getByRole("heading", { name: "Integration health triage" })).toBeVisible();
  });
});
