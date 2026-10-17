// @vitest-environment jsdom
// Real react-router data router + the real bar strip hook + the real useLiveImportJobs poller (interval
// compressed via its own pollMs option). The loader counts Card force intents it serves; synthetic data only.
import { cleanup, render } from "@testing-library/react";
import { createBrowserRouter, RouterProvider, useLoaderData } from "react-router";
import { describe, expect, it } from "vitest";
import { CatalogImportContextBar } from "./admin-control-plane/import-to-promotion/import-context-bar";
import { shouldRevalidate } from "../../../routes/admin/integrations";
import { useLiveImportJobs } from "./admin-control-plane/import-jobs/use-live-import-jobs";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
} from "./primary-workbench-read-model";
import { controlPlaneOverview, profileReview } from "./primary-workbench-test-fixtures";

const unitKey = "scrydex:lorcana:single-card:source-observation-import";
const walkPath = `/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(
  unitKey,
)}&expansionId=TFC&expansionName=The+First+Chapter`;
const intentPath = `${walkPath}&sourceOptionAction=force-refresh&sourceOptionQueryKind=cards`;

function readModel(requestUrl: string, activeJobCount: number) {
  const profile = profileReview({
    providerKey: "scrydex",
    profileKey: "lorcana-card-print-source-observation",
    profileVersion: "2026.06.23",
    ingestionUnitKey: unitKey,
    active: true,
    lifecycle: "active",
    profile: { providerKey: "scrydex", supportedScopes: ["set-name", "product/card"] },
    supportedScopes: ["set-name", "product/card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "cards",
        queryKeySynonyms: ["card"],
        displayName: "Card",
        scope: "product/card",
        parentScope: "set-name",
        parentRequired: true,
        parentValueKind: "set-id",
        parentDiagnosticText: "Select a set.",
      },
    ],
  });
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl,
    scopes: [],
    profiles: [profile],
    cacheOnly: true,
  });
  const model = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    controlPlaneOverview: controlPlaneOverview(),
    sourceOptionPages: requests.map((request) => ({ request })),
    canManageCatalog: true,
  });
  return { ...model, importJobs: { ...model.importJobs, activeJobCount } };
}

type Data = { model: ReturnType<typeof readModel>; deferredSourceOptions: Promise<unknown> };

function Page({ pollMs }: { pollMs: number }) {
  const data = useLoaderData() as Data;
  // Same hook the daily run-sync stage mounts (import-jobs-module.tsx:70), interval compressed.
  useLiveImportJobs(data.model as never, { pollMs });
  return (
    <CatalogImportContextBar
      readModel={data.model as never}
      deferredSourceOptions={data.deferredSourceOptions as never}
    />
  );
}

async function scenario(input: { activeJobCount: number; pollMs: number; forcedMs: number; observeMs: number }) {
  const served: string[] = [];
  const t0 = Date.now();
  const timeline: Array<[number, string]> = [];
  let forced = 0;
  window.history.replaceState(null, "", walkPath);
  const router = createBrowserRouter([
    {
      path: "/catalog/integrations",
      loader: ({ request }) => {
        const url = new URL(request.url);
        served.push(url.search);
        timeline.push([Date.now() - t0, url.searchParams.get("sourceOptionAction") ?? "-"]);
        const model = readModel(url.toString(), input.activeJobCount);
        const isForce =
          url.searchParams.get("sourceOptionAction") === "force-refresh" &&
          url.searchParams.get("sourceOptionQueryKind") === "cards";
        if (isForce) forced += 1;
        const deferredSourceOptions = isForce
          ? new Promise((resolve) => setTimeout(() => resolve(model.sourceOptions), input.forcedMs))
          : Promise.resolve(model.sourceOptions);
        return { model, deferredSourceOptions };
      },
      element: <Page pollMs={input.pollMs} />,
      shouldRevalidate,
    },
  ]);
  // Browser-like scheduling: outside an act() scope React commits renders/effects in real time, so the
  // strip hook and the poller race exactly as they would in the admin app.
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  render(<RouterProvider router={router} />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The operator's single counted click (same GET navigation SourceOptionRefreshButton submits).
  await router.navigate(intentPath, { replace: true });
  await new Promise((resolve) => setTimeout(resolve, input.observeMs));
  g.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  const finalSearch = window.location.search;
  router.dispose();
  cleanup();
  return {
    ...input,
    forced,
    servedCount: served.length,
    finalSearch,
    stripped: !finalSearch.includes("sourceOptionAction"),
    timeline,
  };
}

describe("Catalog source-option force-refresh revalidation", () => {
  it("control: no active job -> exactly one forced Card request, then the intent is stripped", async () => {
    const r = await scenario({ activeJobCount: 0, pollMs: 50, forcedMs: 200, observeMs: 1000 });
    expect(r.forced).toBe(1);
    expect(r.stripped).toBe(true);
  });

  it("active import job: the live poller re-serves the intent URL while the forced slice is in flight", async () => {
    const r = await scenario({ activeJobCount: 1, pollMs: 50, forcedMs: 200, observeMs: 1000 });
    // Spend-safety expectation from #8461 AC3 / defect-class constraint: exactly one forced request.
    expect(r.forced).toBe(1);
  });

  it("remedy: route shouldRevalidate keeps exactly one forced request and still strips", async () => {
    const r = await scenario({ activeJobCount: 1, pollMs: 50, forcedMs: 200, observeMs: 1000 });
    expect(r.forced).toBe(1);
    expect(r.stripped).toBe(true);
    // Polling after the strip must still reach the loader (live import progress not frozen).
    const afterStrip = r.timeline.filter(([, action]) => action === "-").length;
    expect(afterStrip).toBeGreaterThan(3);
  });

  it("active import job, forced slice faster than the poll interval", async () => {
    const r = await scenario({ activeJobCount: 1, pollMs: 200, forcedMs: 120, observeMs: 1500 });
    expect(r.forced).toBe(1);
  });
});
