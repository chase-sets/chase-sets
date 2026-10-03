// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogIntegrationRecentJobSummary } from "../../contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  profileReview,
  sourceObservationScope,
} from "../../primary-workbench-test-fixtures";
import { CatalogProviderDetailPage } from "./provider-detail-page";
import { catalogProviderDetailHref } from "./provider-detail-links";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CatalogProviderDetailPage", () => {
  it("renders provider identity, the active profile, clone draft, and version history on one page", () => {
    const profile = profileReview({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      active: true,
      lifecycle: "active",
      referenceCount: 3,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&profileVersion=2026.06.04",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(
      <CatalogProviderDetailPage
        readModel={readModel}
        providerRefreshSchedules={[
          {
            providerKey: "tcgdex",
            scheduleEnabled: true,
            manualOnly: false,
            creditAware: false,
            intervalMs: 21_600_000,
            paused: false,
            pausedBy: null,
            nextRunAt: "2026-07-14T18:00:00.000Z",
            lastRunCompletedAt: "2026-07-14T12:00:00.000Z",
            lastRunStatus: "succeeded",
            lastRunError: null,
          },
        ]}
      />,
    );

    // Identity header.
    expect(screen.getAllByText("tcgdex").length).toBeGreaterThan(0);
    // Active profile overview (reused ProfileOverviewEvidence).
    expect(screen.getByRole("heading", { name: "Profile overview" })).toBeTruthy();
    expect(screen.getAllByText("tcgdex-pokemon-card").length).toBeGreaterThan(0);

    // Clone-draft form posts back to this page (never /catalog/integrations/providers).
    const cloneForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="provider-profile.clone"]',
    );
    expect(cloneForm).toBeTruthy();
    expect(new URL(cloneForm!.getAttribute("action") ?? "", "https://admin.example").pathname).toBe(
      "/catalog/providers/tcgdex",
    );
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("provider-profile.clone");

    // Version history table with the active profile listed.
    expect(screen.getByRole("heading", { name: "Profile candidates" })).toBeTruthy();
    expect(screen.getAllByText(/tcgdex-pokemon-card@2026.06.04/).length).toBeGreaterThan(0);
    expect(screen.getByText("Scheduled source-option refresh")).toBeTruthy();
    expect(screen.getByText(/Last run: Succeeded/)).toBeTruthy();
    const runNowForm = document
      .querySelector<HTMLInputElement>('input[name="_intent"][value="run-provider-refresh"]')
      ?.closest("form");
    const action = new URL(runNowForm?.getAttribute("action") ?? "", "https://admin.example");
    expect(action.pathname).toBe("/catalog/providers/tcgdex");
    expect(action.searchParams.get("profileVersion")).toBe("2026.06.04");
  });

  it("renders rollback/deprecate/retire as row-level lifecycle actions that submit back to this page", () => {
    const profile = profileReview({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      active: true,
      lifecycle: "active",
      referenceCount: 0,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&profileVersion=2026.06.04",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogProviderDetailPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Deprecate profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retire profile" })).toBeTruthy();

    const deprecateForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="deprecate"]');
    expect(deprecateForm).toBeTruthy();
    expect(new URL(deprecateForm!.getAttribute("action") ?? "", "https://admin.example").pathname).toBe(
      "/catalog/providers/tcgdex",
    );
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "provider-profile.deprecate",
    );
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04");
  });

  it("renders credential and transport readiness on the header from health-triage evidence", () => {
    const baseOverview = controlPlaneOverview();
    const profile = profileReview({ providerKey: "tcgdex", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: baseOverview,
      canManageCatalog: true,
    });

    render(<CatalogProviderDetailPage readModel={readModel} />);

    // The header renders inline instead of forcing a detour to the retired
    // standalone health-triage workspace. The page title and the header module
    // both name the provider, so at least two headings render "tcgdex".
    expect(screen.getAllByRole("heading", { name: "tcgdex" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getByText("Catalog semantic readiness")).toBeTruthy();
    expect(screen.getByText("Provider transport readiness")).toBeTruthy();
    expect(screen.getAllByText("Freshness").length).toBeGreaterThan(0);
    expect(screen.queryByText(/health-triage/i)).toBeNull();
  });

  it("shows an empty state when no provider is selected", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogProviderDetailPage readModel={readModel} />);

    expect(screen.getByText("No provider selected")).toBeTruthy();
  });

  it("renders the command-feedback banner in place after a redirect back from a command", () => {
    const profile = profileReview({ providerKey: "tcgdex", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(
      <CatalogProviderDetailPage
        readModel={readModel}
        commandFeedback={{ status: "success", intent: "provider-profile.activate", result: "profile-activated" }}
      />,
    );

    expect(screen.getAllByText(/activat/i).length).toBeGreaterThan(0);
  });
});

describe("CatalogProviderDetailPage Operator session section", () => {
  function providerReadModel(providerKey: string) {
    return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: `https://admin.example/catalog/providers/${providerKey}?providerKey=${providerKey}`,
      scopes: { items: [sourceObservationScope({ provider_key: providerKey })], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ providerKey, active: true, lifecycle: "active" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });
  }

  it("mounts the section on TCGplayer only when the route supplies an Operator session key", () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);

    render(
      <CatalogProviderDetailPage readModel={providerReadModel("tcgplayer")} operatorSessionKey="actor|location" />,
    );

    expect(screen.getByRole("heading", { name: "Operator session" })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/catalog/operator-session", expect.objectContaining({ method: "GET" }));
  });

  it.each([
    ["TCGplayer without a key", "tcgplayer", null],
    ["another provider with a key", "tcgdex", "actor|location"],
  ])("omits the section for %s", (_label, providerKey, operatorSessionKey) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    render(
      <CatalogProviderDetailPage readModel={providerReadModel(providerKey)} operatorSessionKey={operatorSessionKey} />,
    );

    expect(screen.queryByRole("heading", { name: "Operator session" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("CatalogProviderDetailPage TCGplayer recent-job inspection", () => {
  type JobResult = NonNullable<CatalogIntegrationRecentJobSummary["result"]>;
  const tcgplayerUnitKey = "tcgplayer:pokemon:single-card:source-observation-import";

  function providerJob(
    jobId: string,
    overrides: Partial<CatalogIntegrationRecentJobSummary> = {},
  ): CatalogIntegrationRecentJobSummary {
    return integrationJobSummary({
      jobId,
      providerKey: "tcgplayer",
      unitKey: tcgplayerUnitKey,
      importScope: "en:3:base",
      profileSnapshot: null,
      operatorStatus: "completed",
      phase: "completed",
      completed: 24,
      total: 24,
      summary: `Import ${jobId}`,
      ...overrides,
    });
  }

  function jobResult(overrides: Partial<JobResult> = {}): JobResult {
    return {
      requested: 24,
      imported: 1,
      observed: 20,
      reapplied: 0,
      skipped: 3,
      failed: 1,
      outcomeCount: 24,
      redactedFailureReasons: [],
      usage: { actualRequestCount: 6, pageCount: 2, cacheHitCount: 4, cacheMissCount: 1 },
      ...overrides,
    };
  }

  function providerJobsReadModel(
    jobs: readonly CatalogIntegrationRecentJobSummary[],
    providerKey = "tcgplayer",
    overviewOverrides: Parameters<typeof controlPlaneOverview>[0] = {},
  ) {
    const overview = controlPlaneOverview(overviewOverrides);
    return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: `https://admin.example/catalog/providers/${providerKey}?providerKey=${providerKey}`,
      scopes: { items: [sourceObservationScope({ provider_key: providerKey })], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ providerKey, active: true, lifecycle: "active" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          generatedAt: overview.generatedAt,
          units: [...new Set(jobs.map((job) => job.unitKey ?? tcgplayerUnitKey))].map((unitKey) => ({
            unitKey,
            recentJobs: jobs.filter((job) => (job.unitKey ?? tcgplayerUnitKey) === unitKey),
          })),
        },
      },
      canManageCatalog: true,
    });
  }

  function recentJobs(): HTMLElement {
    const section = document.querySelector<HTMLElement>('[data-catalog-provider-recent-jobs="true"]');
    expect(section).toBeTruthy();
    return section!;
  }

  // DataTable renders every row twice (phone card, then desktop table); both
  // disclosure triggers must report the same controlled state.
  function jobTriggers(jobId: string): HTMLElement[] {
    const triggers = within(recentJobs()).getAllByRole("button", { name: new RegExp(`^${jobId}Import ${jobId}$`) });
    expect(triggers).toHaveLength(2);
    return triggers;
  }

  // Closed panels stay mounted (and hidden), so visibility is part of every
  // assertion; the trigger only names its panel in aria-controls while open.
  function jobPanel(trigger: HTMLElement): HTMLElement {
    const panel = Array.from(within(recentJobs()).getAllByRole("region", { hidden: true })).find(
      (region) => region.getAttribute("aria-labelledby") === trigger.id,
    );
    expect(panel).toBeTruthy();
    if (trigger.getAttribute("aria-expanded") === "true") {
      expect(trigger.getAttribute("aria-controls")).toBe(panel!.id);
    }
    return panel!;
  }

  function expectJobOpen(jobId: string, open: boolean) {
    for (const trigger of jobTriggers(jobId)) {
      expect(trigger.getAttribute("aria-expanded")).toBe(String(open));
      expect(jobPanel(trigger).hidden).toBe(!open);
    }
  }

  // The value shown for one labelled fact in a job's visible disclosure,
  // asserted identical across the phone card and desktop table.
  function factValue(jobId: string, label: string): string {
    const values = jobTriggers(jobId).map((trigger) => {
      const panel = jobPanel(trigger);
      expect(panel.hidden).toBe(false);
      return within(panel).getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "";
    });
    expect(values[0]).toBe(values[1]);
    return values[0]!;
  }

  function visibleFactsText(jobId: string): string {
    return jobTriggers(jobId)
      .map((trigger) => jobPanel(trigger))
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.textContent ?? "")
      .join(" ");
  }

  it("expands one job in place, leaves its neighbour closed, and closing restores the compact row", async () => {
    const user = userEvent.setup();
    render(
      <CatalogProviderDetailPage
        readModel={providerJobsReadModel([
          providerJob("job-a", { createdAt: "2026-06-09T02:00:00.000Z", startedAt: null, result: jobResult() }),
          providerJob("job-b", {
            createdAt: "2026-06-09T01:00:00.000Z",
            startedAt: null,
            result: jobResult({ observed: 7 }),
          }),
        ])}
      />,
    );

    expectJobOpen("job-a", false);
    expectJobOpen("job-b", false);

    await user.click(jobTriggers("job-a")[0]!);

    expectJobOpen("job-a", true);
    expectJobOpen("job-b", false);
    expect(factValue("job-a", "Progress")).toBe("Operator: Completed24/24 work units, 100% complete");
    expect(factValue("job-a", "Failure groups")).toBe("None");
    expect(factValue("job-a", "Observed observations")).toBe("20");
    expect(factValue("job-a", "Skipped")).toBe("3");
    expect(factValue("job-a", "Failures")).toBe("1");
    expect(factValue("job-a", "Provider usage")).toBe("Requests: 6Pages: 2Cache: 4 hits, 1 misses");
    expect(visibleFactsText("job-b")).toBe("");

    // The desktop-table trigger closes the same shared disclosure.
    await user.click(jobTriggers("job-a")[1]!);

    expectJobOpen("job-a", false);
    expectJobOpen("job-b", false);
    const table = within(recentJobs()).getByRole("table");
    const jobARow = within(table)
      .getByRole("button", { name: /^job-aImport job-a$/ })
      .closest("tr")!;
    expect(within(jobARow).getByText("Completed")).toBeTruthy();
    expect(within(jobARow).getByText("en:3:base")).toBeTruthy();
  });

  it("keeps the existing compact job cell for providers other than TCGplayer", () => {
    render(
      <CatalogProviderDetailPage
        readModel={providerJobsReadModel(
          [
            integrationJobSummary({
              jobId: "tcgdex-job",
              operatorStatus: "completed",
              phase: "completed",
              result: jobResult(),
            }),
          ],
          "tcgdex",
        )}
      />,
    );

    const section = recentJobs();
    expect(within(section).getAllByText("tcgdex-job").length).toBe(2);
    expect(section.querySelector("[aria-expanded]")).toBeNull();
    expect(section.querySelector("[data-catalog-provider-job-disclosure]")).toBeNull();
    expect(within(section).queryByText("Observed observations")).toBeNull();
  });

  const unavailableFacts = {
    observed: "Unavailable",
    skipped: "Unavailable",
    failed: "Unavailable",
    usage: "Unavailable",
  };

  it.each([
    {
      name: "queued with no retained result",
      job: { operatorStatus: "queued", phase: "enqueued", completed: 0, total: 24, result: null },
      progress: "Operator: Queued0/24 work units, 0% complete",
      failures: "None",
      ...unavailableFacts,
    },
    {
      name: "running with no retained result",
      job: { operatorStatus: "running", phase: "processing", completed: 6, total: 24, result: null },
      progress: "Operator: Running6/24 work units, 25% complete",
      failures: "None",
      ...unavailableFacts,
    },
    {
      name: "completed with real zero counters",
      job: {
        result: jobResult({
          observed: 0,
          skipped: 0,
          failed: 0,
          usage: { actualRequestCount: 0, pageCount: 0, cacheHitCount: 0, cacheMissCount: 0 },
        }),
      },
      progress: "Operator: Completed24/24 work units, 100% complete",
      failures: "None",
      observed: "0",
      skipped: "0",
      failed: "0",
      usage: "Requests: 0Pages: 0Cache: 0 hits, 0 misses",
    },
    {
      name: "completed durable job with partial operator status and null usage counters",
      job: {
        operatorStatus: "partial",
        phase: "completed",
        completed: 18,
        total: 24,
        result: jobResult({
          observed: 18,
          skipped: 4,
          failed: 2,
          usage: { actualRequestCount: null, pageCount: 3, cacheHitCount: null, cacheMissCount: 2 },
        }),
      },
      progress: "Operator: Partial18/24 work units, 75% complete",
      failures: "Partial provider data (6)",
      observed: "18",
      skipped: "4",
      failed: "2",
      usage: "Requests: UnavailablePages: 3",
    },
    {
      name: "failed with a retained result and missing usage",
      job: {
        operatorStatus: "failed",
        phase: "failed",
        completed: 12,
        total: 24,
        result: jobResult({ observed: 10, skipped: 0, failed: 2, usage: null }),
      },
      progress: "Operator: Failed12/24 work units, 50% complete",
      failures: "Durable import failed (12)",
      observed: "10",
      skipped: "0",
      failed: "2",
      usage: "Unavailable",
    },
    {
      name: "the same failed job without a retained result",
      job: { operatorStatus: "failed", phase: "failed", completed: 12, total: 24, result: null },
      progress: "Operator: Failed12/24 work units, 50% complete",
      failures: "Durable import failed (12)",
      ...unavailableFacts,
    },
    {
      name: "cancelled",
      job: { operatorStatus: "cancelled", phase: "processing", completed: 6, total: 24, result: null },
      progress: "Operator: Cancelled6/24 work units, 25% complete",
      failures: "Operator cancelled (1)",
      ...unavailableFacts,
    },
    {
      name: "stale",
      job: { operatorStatus: "stale", phase: "processing", completed: 6, total: 24, result: null },
      progress: "Operator: Stale6/24 work units, 25% complete",
      failures: "Stale replay checkpoint (1)",
      ...unavailableFacts,
    },
    {
      name: "retried",
      job: { operatorStatus: "retried", phase: "processing", completed: 6, total: 24, result: null },
      progress: "Operator: Retried6/24 work units, 25% complete",
      failures: "None",
      ...unavailableFacts,
    },
  ] satisfies readonly {
    name: string;
    job: Partial<CatalogIntegrationRecentJobSummary>;
    progress: string;
    failures: string;
    observed: string;
    skipped: string;
    failed: string;
    usage: string;
  }[])("shows honest retained facts for a job that is $name", async (expected) => {
    const user = userEvent.setup();
    render(<CatalogProviderDetailPage readModel={providerJobsReadModel([providerJob("job-a", expected.job)])} />);

    await user.click(jobTriggers("job-a")[0]!);

    expect(factValue("job-a", "Progress")).toBe(expected.progress);
    expect(factValue("job-a", "Failure groups")).toBe(expected.failures);
    expect(factValue("job-a", "Observed observations")).toBe(expected.observed);
    expect(factValue("job-a", "Skipped")).toBe(expected.skipped);
    expect(factValue("job-a", "Failures")).toBe(expected.failed);
    expect(factValue("job-a", "Provider usage")).toBe(expected.usage);
    if (expected.job.operatorStatus) {
      expect(visibleFactsText("job-a")).not.toContain("Completed");
    }
  });

  it("never shows one job's counters inside another job's disclosure", async () => {
    const user = userEvent.setup();
    render(
      <CatalogProviderDetailPage
        readModel={providerJobsReadModel([
          providerJob("job-a", { result: jobResult({ observed: 111, skipped: 112, failed: 113 }) }),
          providerJob("job-b", { result: null }),
        ])}
      />,
    );

    await user.click(jobTriggers("job-a")[0]!);
    await user.click(jobTriggers("job-b")[0]!);

    expectJobOpen("job-a", true);
    expectJobOpen("job-b", true);
    expect(factValue("job-a", "Observed observations")).toBe("111");
    expect(factValue("job-b", "Observed observations")).toBe("Unavailable");
    expect(visibleFactsText("job-b")).not.toMatch(/11[123]/);
  });

  it("keeps an open disclosure on its job ID across reordered, replaced, and steady refreshes", async () => {
    const user = userEvent.setup();
    const jobA = (observed: number) =>
      providerJob("job-a", { createdAt: "2026-06-09T02:00:00.000Z", startedAt: null, result: jobResult({ observed }) });
    const jobB = (createdAt: string) =>
      providerJob("job-b", { createdAt, startedAt: null, result: jobResult({ observed: 7 }) });
    const { rerender } = render(
      <CatalogProviderDetailPage readModel={providerJobsReadModel([jobA(5), jobB("2026-06-09T01:00:00.000Z")])} />,
    );

    await user.click(jobTriggers("job-a")[0]!);
    expect(within(recentJobs()).getAllByRole("button")[0]!.textContent).toMatch(/^job-aImport/);

    // Job B moves ahead of job A and job A's retained facts change: the open
    // disclosure follows job A's ID, not the first row position.
    rerender(
      <CatalogProviderDetailPage readModel={providerJobsReadModel([jobA(9), jobB("2026-06-09T03:00:00.000Z")])} />,
    );
    expect(within(recentJobs()).getAllByRole("button")[0]!.textContent).toMatch(/^job-bImport/);
    expectJobOpen("job-a", true);
    expectJobOpen("job-b", false);
    expect(factValue("job-a", "Observed observations")).toBe("9");

    // Closing and re-delivering the same snapshot does not reopen it.
    await user.click(jobTriggers("job-a")[1]!);
    rerender(
      <CatalogProviderDetailPage readModel={providerJobsReadModel([jobA(9), jobB("2026-06-09T03:00:00.000Z")])} />,
    );
    expectJobOpen("job-a", false);

    // A job that leaves the retained window closes and stays closed if its ID returns.
    await user.click(jobTriggers("job-a")[0]!);
    rerender(<CatalogProviderDetailPage readModel={providerJobsReadModel([jobB("2026-06-09T03:00:00.000Z")])} />);
    expect(within(recentJobs()).queryAllByRole("button", { name: /^job-aImport job-a$/ })).toHaveLength(0);
    rerender(
      <CatalogProviderDetailPage readModel={providerJobsReadModel([jobA(9), jobB("2026-06-09T03:00:00.000Z")])} />,
    );
    expectJobOpen("job-a", false);

    // A provider change closes it too, even when the same job ID comes back.
    await user.click(jobTriggers("job-a")[0]!);
    rerender(<CatalogProviderDetailPage readModel={providerJobsReadModel([], "tcgdex")} />);
    rerender(
      <CatalogProviderDetailPage readModel={providerJobsReadModel([jobA(9), jobB("2026-06-09T03:00:00.000Z")])} />,
    );
    expectJobOpen("job-a", false);
    expectJobOpen("job-b", false);
  });

  it("toggles from the keyboard and reports aria-expanded", async () => {
    const user = userEvent.setup();
    render(<CatalogProviderDetailPage readModel={providerJobsReadModel([providerJob("job-a")])} />);

    jobTriggers("job-a")[0]!.focus();
    await user.keyboard("{Enter}");
    expectJobOpen("job-a", true);
    await user.keyboard(" ");
    expectJobOpen("job-a", false);
  });

  it("renders only named job facts and sends no request when a disclosure opens or closes", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const consoleSpies = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const baseOverview = controlPlaneOverview();
    const tcgdexReadiness = baseOverview.providerReadiness.providers[0]!;
    const readModel = providerJobsReadModel(
      [
        {
          ...providerJob("job-a", {
            result: jobResult({ redactedFailureReasons: ["CANARY_EXCLUDED_FAILURE_REASON"] }),
          }),
          rawError: "CANARY_RAW_ERROR",
        } as CatalogIntegrationRecentJobSummary,
      ],
      "tcgplayer",
      {
        providerReadiness: {
          generatedAt: baseOverview.generatedAt,
          providers: [
            {
              ...tcgdexReadiness,
              providerKey: "tcgplayer",
              adapterKey: "tcgplayer",
              readiness: "blocked",
              apiReachability: {
                status: "blocked",
                diagnosticCodes: ["provider-unreachable"],
                message: "CANARY_TRANSPORT_MESSAGE",
              },
            },
          ],
        },
      },
    );

    render(
      <CatalogProviderDetailPage
        readModel={readModel}
        operatorSessionKey="actor|location"
        providerRefreshSchedules={[
          {
            providerKey: "tcgplayer",
            scheduleEnabled: true,
            manualOnly: false,
            creditAware: true,
            intervalMs: 21_600_000,
            paused: false,
            pausedBy: null,
            nextRunAt: "2026-07-14T18:00:00.000Z",
            lastRunCompletedAt: null,
            lastRunStatus: null,
            lastRunError: null,
          },
        ]}
      />,
    );

    // Existing composition is untouched: the session panel made its one read
    // and the schedule panel still renders.
    expect(screen.getByRole("heading", { name: "Operator session" })).toBeTruthy();
    expect(screen.getByText("Scheduled source-option refresh")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    const formsBefore = document.querySelectorAll("form").length;

    await user.click(jobTriggers("job-a")[0]!);
    expect(factValue("job-a", "Failure groups")).toMatch(/^Provider transport .+ \(1\)$/);
    await user.click(jobTriggers("job-a")[0]!);
    await user.click(jobTriggers("job-a")[1]!);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("form").length).toBe(formsBefore);
    expect(recentJobs().querySelector("form")).toBeNull();
    const recentJobsText = recentJobs().textContent ?? "";
    for (const canary of ["CANARY_EXCLUDED_FAILURE_REASON", "CANARY_RAW_ERROR", "CANARY_TRANSPORT_MESSAGE"]) {
      expect(recentJobsText).not.toContain(canary);
    }
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("CANARY");
    }
  });
});

describe("catalogProviderDetailHref", () => {
  it("builds a path-param href with no returnPath/section detour state", () => {
    const href = catalogProviderDetailHref("tcgdex", { profileVersion: "2026.06.04" });
    const url = new URL(href, "https://admin.example");

    expect(url.pathname).toBe("/catalog/providers/tcgdex");
    expect(url.searchParams.get("profileVersion")).toBe("2026.06.04");
    expect(url.searchParams.has("returnPath")).toBe(false);
    expect(url.searchParams.has("section")).toBe(false);
  });

  it("falls back to the bare providers path when no provider is selected", () => {
    expect(catalogProviderDetailHref(null)).toBe("/catalog/providers");
  });

  it("percent-encodes the provider key path segment", () => {
    const href = catalogProviderDetailHref("tcg dex");
    expect(href).toBe("/catalog/providers/tcg%20dex");
  });
});
