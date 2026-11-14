import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { loader } from "../../../routes/admin/scope-sync-batches";
import {
  scrydexCacheCaptureLandingPath,
  scrydexCacheCaptureUnits,
} from "../../scope-sync-batches/domain/scrydex-cache-capture";
import { providerPagesUpperBound } from "../../scope-sync-batches/domain/scrydex-option-refresh";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../ui/primary-workbench-source-options";
import type { CatalogProviderProfileVersionReview as WorkbenchProfileReview } from "../ui/contracts";
import { createScrydexOnePieceProviderAdapter } from "./providers/scrydex/adapter";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import { buildCatalogIntegrationControlPlaneReadiness } from "./governance/catalog-integration-control-plane-readiness";
import { queryProviderIntegrationOptions } from "./providers/provider-option-queries";
import { listCatalogProviderProfileVersionReviews } from "./providers/provider-profile-review";
import { context, mutableProfileStore } from "./route-modules/route-test-harness";
import { loadCatalogIntegrationControlPlaneOverview } from "./route-modules/control-plane-overview-load";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("bounds the whole refresh journey with separate cold adapters: landing, overview, profiles, five forced units", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  const calls: { entry: string; path: string }[] = [];
  const adapters = new Set<ReturnType<typeof createScrydexOnePieceProviderAdapter>>();
  vi.stubGlobal("fetch", () => {
    throw new Error("unrecorded transport forbidden");
  });
  const store = mutableProfileStore();
  function cold(entry: string) {
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: { apiKey: "synthetic-unused-api-key", teamId: "synthetic-unused-team" },
      baseUrl: "https://recording.invalid/onepiece/v1",
      now: () => new Date("2026-11-09T12:00:00.000Z"),
      profileVersions: store,
      fetch: async (request) => {
        const url = new URL(String(request));
        expect(url.hostname).toBe("recording.invalid");
        calls.push({ entry, path: url.pathname });
        if (url.pathname === "/account/v1/usage")
          return Response.json({
            data: {
              credits_remaining: 49_000,
              total_credits_consumed: 1000,
              overage_credits_consumed: 0,
              period_start: "2026-11-01T00:00:00.000Z",
              period_end: "2026-12-01T00:00:00.000Z",
            },
          });
        expect(url.pathname).toMatch(/^\/(onepiece|lorcana)\/v1\/expansions$/);
        expect(url.searchParams.get("page_size")).toBe("100");
        const page = Number(url.searchParams.get("page"));
        expect(page).toBeGreaterThanOrEqual(1);
        expect(page).toBeLessThanOrEqual(10);
        return Response.json({
          data: Array.from({ length: 100 }, (_, index) => ({
            id: `synthetic-${(page - 1) * 100 + index}`,
            name: `Synthetic set ${(page - 1) * 100 + index}`,
            code: `S${(page - 1) * 100 + index}`,
            language_code: "en",
            release_date: "2026-01-01",
          })),
          total_count: 1000,
          page_size: 100,
          page,
        });
      },
    });
    expect(adapters.has(adapter)).toBe(false);
    adapters.add(adapter);
    return new ProviderAdapterRegistry([adapter]);
  }

  cold("landing");
  const landingRequest = new Request(`https://admin.staging.chasesets.com${scrydexCacheCaptureLandingPath}`);
  expect(
    await loader({
      request: landingRequest,
      params: {},
      context: {},
      url: new URL(landingRequest.url),
      pattern: scrydexCacheCaptureLandingPath,
    } satisfies LoaderFunctionArgs),
  ).toEqual({ batch: null, countQuote: null });
  expect(calls).toEqual([]);
  const root = new URL("../../../../../", import.meta.url);
  const runner = await readFile(new URL("scripts/catalog-staging-scrydex-option-refresh.mjs", root), "utf8");
  expect(runner).toContain("scrydexCacheCaptureLandingPath");
  // The root loader is origin-only; the section shell reads identity, never Catalog.
  const rootSource = await readFile(new URL("deployables/admin-web/app/root.tsx", root), "utf8");
  expect(
    rootSource.slice(rootSource.indexOf("export async function loader"), rootSource.indexOf("export function Layout")),
  ).toMatch(/return\s*\{\s*origin: new URL\(request.url\).origin,?\s*\};/);
  const shell = await readFile(new URL("deployables/admin-web/app/admin-section-loader.server.ts", root), "utf8");
  expect(shell).toContain("resolveIdentityShellViewer(createIdentityRequestApiClient");
  expect(shell).not.toMatch(/source-observations|createCatalogRequestApiClient|fetch\(/);

  const overviewRegistry = cold("overview");
  const overview = await loadCatalogIntegrationControlPlaneOverview(
    {
      services: {
        getCatalogIntegrationControlPlaneReadiness: () =>
          buildCatalogIntegrationControlPlaneReadiness(overviewRegistry),
        listRecentIntegrationJobs: async () => [],
        listActiveIntegrationJobs: async () => [],
        listActiveIntegrationJobSnapshot: async () => ({ items: [], completeness: "complete" }),
      },
      profileVersions: store,
    },
    { context, audience: "daily", providerSendWindow: { state: "unavailable" } },
  );
  expect(
    overview.providerReadiness.providers.find((provider) => provider.providerKey === "scrydex")?.usageBudget,
  ).toMatchObject({ creditBalance: 49_000, creditAllowance: 50_000 });
  expect(calls.filter(({ path }) => path === "/account/v1/usage")).toHaveLength(1);

  cold("profiles");
  const profiles = (await listCatalogProviderProfileVersionReviews(store)).map(workbenchProfile);
  expect(calls).toHaveLength(1);
  for (const { unitKey } of scrydexCacheCaptureUnits) {
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: `https://admin.staging.chasesets.com/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}`,
      scopes: [],
      profiles,
      cacheOnly: false,
      limit: 100,
    }).filter(
      (request) => request.scope === "set-name" && request.parentScope === null && request.queryKind === "sets",
    );
    expect(requests).toHaveLength(1);
    const refreshHref = requests[0]?.refreshHref;
    if (typeof refreshHref !== "string") throw new Error(`${unitKey} set-name request has no refresh href`);
    const params = new URL(refreshHref, "https://admin.staging.chasesets.com").searchParams;
    const page = await queryProviderIntegrationOptions(
      {
        providerKey: "scrydex",
        profileKey: params.get("profileKey"),
        ingestionUnitKey: unitKey,
        queryKind: "sets",
        limit: 100,
        forceRefresh: true,
      },
      null,
      null,
      store,
      cold(unitKey),
    );
    expect(page.total).toBe(1000);
    expect(["bypass", "live"]).toContain(page.cache.status);
    expect(page.cache.source).toBe("live");
    expect(calls.filter(({ entry }) => entry === unitKey)).toHaveLength(10);
    expect(calls.filter(({ entry, path }) => entry === unitKey && path === "/account/v1/usage")).toEqual([]);
  }
  expect(adapters.size).toBe(8);
  expect(calls.filter(({ path }) => path === "/account/v1/usage")).toHaveLength(1);
  expect(calls).toHaveLength(51);
  expect(1 + scrydexCacheCaptureUnits.length * providerPagesUpperBound(1000)!).toBe(56);
});

function workbenchProfile(
  review: Awaited<ReturnType<typeof listCatalogProviderProfileVersionReviews>>[number],
): WorkbenchProfileReview {
  const { coveredFlows, liveProviderCallsAllowed, ...fixtures } = review.fixtures;
  if (liveProviderCallsAllowed !== false) throw new Error(`${review.profileKey} fixtures allow live provider calls`);
  return {
    ...review,
    fixtures: { ...fixtures, coveredFlows: [...coveredFlows], liveProviderCallsAllowed },
    capabilities: [...review.capabilities],
    supportedScopes: [...review.supportedScopes],
    languageOptions: [...review.languageOptions],
    sourceOptionKinds: review.sourceOptionKinds.map((kind) => ({
      ...kind,
      queryKeySynonyms: [...kind.queryKeySynonyms],
    })),
    validation: { ...review.validation, diagnostics: [...review.validation.diagnostics] },
  };
}
