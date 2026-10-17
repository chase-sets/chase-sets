// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogImportContextBar } from "./admin-control-plane/import-to-promotion/import-context-bar";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
} from "./primary-workbench-read-model";
import { controlPlaneOverview, profileReview } from "./primary-workbench-test-fixtures";

const submissions: Array<{ params: string; options: Record<string, unknown> }> = [];
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    // Stable identity, like react-router 7.15.0's memoized useSubmit.
    useSubmit: () => stableSubmit,
  };
});
function stableSubmit(target: unknown, options: Record<string, unknown> = {}) {
  {
    const params =
      target instanceof URLSearchParams
        ? target.toString()
        : target instanceof HTMLFormElement
          ? new URLSearchParams(new FormData(target) as never).toString()
          : String(target);
    submissions.push({ params, options });
  }
}

const unitKey = "scrydex:lorcana:single-card:source-observation-import";
const walkPath = `/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(
  unitKey,
)}&expansionId=TFC&expansionName=The+First+Chapter`;

function readModel(path: string) {
  const requestUrl = `https://admin.example${path}`;
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
        parentDiagnosticText: "Scrydex Lorcana card option queries require a selected set.",
      },
    ],
  });
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl,
    scopes: [],
    profiles: [profile],
    cacheOnly: true,
  });
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    controlPlaneOverview: controlPlaneOverview(),
    sourceOptionPages: requests.map((request) =>
      request.queryKind === "cards"
        ? {
            request,
            error: {
              status: 503,
              code: "catalog_provider_option_query_unavailable",
              message: "empty",
              rolloutBlocked: false,
            },
          }
        : {
            request,
            response: {
              items: [
                {
                  value: "TFC",
                  label: "The First Chapter",
                  providerKey: "scrydex",
                  queryKind: "sets",
                  description: null,
                  parentValue: null,
                  imageUrl: null,
                  aliases: [],
                  metadata: {},
                },
              ],
              total: 1,
              count: 1,
              page: { cursor: null, nextCursor: null, limit: 25, hasMore: false },
              cache: {
                status: "fresh",
                source: "cache",
                cacheKey: "sha256:sets",
                fetchedAt: "2026-06-09T00:00:00.000Z",
                expiresAt: "2026-06-09T00:15:00.000Z",
                staleUntil: "2026-06-10T00:00:00.000Z",
                cacheOnly: true,
                forceRefresh: false,
                degraded: false,
                diagnostics: [],
              },
            },
          },
    ),
    canManageCatalog: true,
  });
}

afterEach(() => {
  cleanup();
  submissions.length = 0;
});

describe("Catalog import context bar Card force refresh", () => {
  it("renders the real Card row with an enabled Force refresh that submits the exact cards intent", () => {
    window.history.replaceState(null, "", walkPath);
    const model = readModel(walkPath);
    render(<CatalogImportContextBar readModel={model} />);
    const row = document.querySelector('[data-source-option-page="cards"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    const force = within(row!).getByRole("button", { name: /force refresh/i, hidden: true });
    expect((force as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(force);
    const params = new URLSearchParams(submissions[0]!.params);
    expect(params.get("sourceOptionAction")).toBe("force-refresh");
    expect(params.get("sourceOptionQueryKind")).toBe("cards");
  });

  it("disables Card actions only when the route has no expansionId", () => {
    const path = walkPath.replace("&expansionId=TFC", "");
    window.history.replaceState(null, "", path);
    render(<CatalogImportContextBar readModel={readModel(path)} />);
    const row = document.querySelector('[data-source-option-page="cards"]') as HTMLElement;
    const buttons = within(row).getAllByRole("button", { hidden: true }) as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("strips a resolved Card force intent exactly once with replace", async () => {
    const intentPath = `${walkPath}&sourceOptionAction=force-refresh&sourceOptionQueryKind=cards`;
    window.history.replaceState(null, "", intentPath);
    const model = readModel(intentPath);
    const deferred = Promise.resolve(model.sourceOptions);
    const view = render(<CatalogImportContextBar readModel={model} deferredSourceOptions={deferred} />);
    await act(async () => {
      await deferred;
    });
    view.rerender(<CatalogImportContextBar readModel={model} deferredSourceOptions={deferred} />);
    await act(async () => {
      await deferred;
    });
    expect(submissions).toHaveLength(1);
    const params = new URLSearchParams(submissions[0]!.params);
    expect(params.has("sourceOptionAction")).toBe(false);
    expect(params.has("sourceOptionQueryKind")).toBe(false);
    expect(params.get("expansionId")).toBe("TFC");
    expect(submissions[0]!.options).toMatchObject({ method: "get", replace: true, action: "/catalog/integrations" });
  });

  it("does not strip while the forced slice is unresolved, or after unmount", async () => {
    const intentPath = `${walkPath}&sourceOptionAction=force-refresh&sourceOptionQueryKind=cards`;
    window.history.replaceState(null, "", intentPath);
    const model = readModel(intentPath);
    let resolve: (value: typeof model.sourceOptions) => void = () => undefined;
    const deferred = new Promise<typeof model.sourceOptions>((done) => {
      resolve = done;
    });
    const view = render(<CatalogImportContextBar readModel={model} deferredSourceOptions={deferred} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(submissions).toHaveLength(0);
    view.unmount();
    resolve(model.sourceOptions);
    await act(async () => {
      await deferred;
    });
    expect(submissions).toHaveLength(0);
  });

  it("leaves non-Card per-row force intents untouched (pre-existing behavior)", async () => {
    const intentPath = `${walkPath}&sourceOptionAction=force-refresh&sourceOptionQueryKind=sets`;
    window.history.replaceState(null, "", intentPath);
    const model = readModel(intentPath);
    const deferred = Promise.resolve(model.sourceOptions);
    render(<CatalogImportContextBar readModel={model} deferredSourceOptions={deferred} />);
    await act(async () => {
      await deferred;
    });
    expect(submissions).toHaveLength(0);
  });
});
