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
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/\/catalog\/integrations$/);
    await expect(
      page.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeVisible();
    await expectVisibleText(page, "Catalog control plane");
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
    await expect(page.locator('a[href="/catalog/integrations/release"]').first()).toBeVisible();

    await expect(page.getByRole("button", { name: /Pull provider data/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
    // The daily route is now an explicit, linear three-stage flow. The ordered
    // stepper and the stage controls name each stage so "where do I run a sync /
    // create items?" is answerable at a glance. These labels render in the always-
    // visible stepper (and the stage controls), independent of which stage is open.
    await expectVisibleText(page, "Run sync");
    await expectVisibleText(page, "Review changes");
    await expectVisibleText(page, "Create / update items");
    await expect(page.getByRole("textbox", { name: /JSON/i })).toHaveCount(0);
    await expect(page.getByText(/Old integrations surface/i)).toHaveCount(0);

    // #1748 acceptance gate (criterion 1): the daily route is the DEFAULT landing, not a
    // detour. The supporting surfaces (providers/governance/release) each carry a single
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

    // Health triage now lives on the real /catalog/integrations/release surface route.
    await expectPageOk(
      page,
      "/catalog/integrations/release?providerKey=tcgdex&section=triage&filter.status=changed&selectedObservationIds=obs_001",
    );
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/catalog\/integrations\/release\?.*section=triage/);
    // The release surface is the nested "Release health and evidence" child, so its
    // side-nav link is current and the Import child still links back to the daily route.
    await expect(page.locator('a[href="/catalog/integrations/release"]').first()).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator('a[href="/catalog/integrations"]').first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 900 });
    // The page-local workflow nav and its mobile combobox are gone; cross-surface
    // navigation is the admin shell's responsibility now.
    await expect(page.getByRole("navigation", { name: "Catalog control plane workflows" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Choose Catalog workflow" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Pull provider data/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Preview promotion/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Integration health triage" })).toBeVisible();
    // The release surface stacks three workspaces but renders the "Back to import
    // workbench" affordance exactly once, in the surface header (no longer once per
    // stacked workspace), so this no longer needs a .first() disambiguator.
    const releaseBackLinks = page.getByRole("link", { name: "Back to import workbench" });
    await expect(releaseBackLinks).toHaveCount(1);
    await expect(releaseBackLinks).toHaveAttribute("href", /\/catalog\/integrations(\?|$)/);
    await expect(page.getByRole("heading", { name: "Import to promotion workbench" })).toHaveCount(0);
    // The release surface stacks all three of its workspaces, so audit evidence is
    // already rendered alongside health triage; its workspace heading stays visible.
    await expect(page.getByRole("heading", { name: "Audit and release evidence" })).toBeVisible();
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

    // The compact daily health signal deep-links into health triage on the release
    // surface. Land on that exact deep-link shape — including a stale/unknown
    // profileVersion (the shape a missing/invalid-profile blocker carries) — and confirm
    // the release loader recovers from the backend's 404 into the absent-authoring-model
    // state and renders (HTTP < 400) rather than surfacing a 500.
    await expectPageOk(
      page,
      "/catalog/integrations/release?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3A3%3Abase%3Abase1&profileVersion=2026.06.04&section=triage",
    );
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/catalog\/integrations\/release\?.*section=triage/);
    await expect(page.getByRole("heading", { name: "Integration health triage" })).toBeVisible();
  });
});
