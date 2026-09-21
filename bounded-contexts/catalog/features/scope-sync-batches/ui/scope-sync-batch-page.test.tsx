// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ScopeSyncBatchPage } from "./scope-sync-batch-page";
import ScopeSyncBatchesRoute from "../../../routes/admin/scope-sync-batches";

describe("Scope Sync Batch admin page", () => {
  it("renders blocked preview evidence before confirmation", () => {
    renderPage(
      <ScopeSyncBatchPage
        batch={null}
        error={null}
        heldSetResolution={null}
        preview={{
          previewVersion: "scope-sync-batch-preview-v1",
          selection: { mode: "matching-scope", query: { productDomain: "pokemon" } },
          budget: {
            maxScopesPerTurn: 1,
            defaultProviderConcurrency: 1,
            providerConcurrency: {},
            providerRequestLimits: {},
            creditedProviderRequestLimits: {},
            providerFailureThreshold: 3,
          },
          planFingerprint: "fingerprint",
          status: "blocked",
          confirmAllowed: false,
          counts: { scopes: 1, readyScopes: 0, blockedScopes: 1, providerUnits: 1 },
          providerUnitTotals: { tcgdex: 1 },
          providerRequestEstimates: { tcgdex: 1 },
          samples: [
            {
              scopeRecordId: "scope-1",
              providerUnitCount: 1,
              blockerCount: 1,
              estimatedRequestCount: 1,
              providerKeys: ["tcgdex"],
              mappingVersions: [],
              profileVersions: [],
            },
          ],
          blockers: [
            { code: "mapping-missing", scopeRecordId: "scope-1", providerKey: null, message: "Mapping is missing." },
          ],
          resolvedAt: "2026-07-14T00:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Scope Sync Batches" })).toBeTruthy();
    expect(screen.getByText("Batch needs attention")).toBeTruthy();
    expect(screen.getByText("Mapping is missing.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and enqueue" })).toBeNull();
  });

  it("shows partial progress and failed-unit recovery without exposing provider payloads", () => {
    renderPage(
      <ScopeSyncBatchPage
        preview={null}
        error={null}
        heldSetResolution={null}
        batch={{
          batchId: "batch-1",
          selection: { mode: "ids", scopeRecordIds: ["scope-1", "scope-2"] },
          budget: {
            maxScopesPerTurn: 1,
            defaultProviderConcurrency: 1,
            providerConcurrency: {},
            providerRequestLimits: {},
            creditedProviderRequestLimits: {},
            providerFailureThreshold: 3,
          },
          planFingerprint: "fingerprint",
          preview: {} as never,
          status: "partial",
          fastNoOp: false,
          circuitOpenProviders: [],
          counts: { queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0 },
          units: [
            {
              scopeRecordId: "scope-1",
              state: "completed",
              syncRunId: "run-1",
              providerKeys: ["tcgdex"],
              attemptCount: 1,
              errorMessage: null,
              updatedAt: "2026-07-14T00:00:00.000Z",
            },
            {
              scopeRecordId: "scope-2",
              state: "failed",
              syncRunId: "run-2",
              providerKeys: ["scrydex"],
              attemptCount: 1,
              errorMessage: "Provider unavailable.",
              updatedAt: "2026-07-14T00:00:00.000Z",
            },
          ],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:01:00.000Z",
        }}
      />,
    );
    expect(screen.getByText(/1 completed · 1 failed/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry unit" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/https?:\/\//)).toBeNull();
  });

  it("renders held-set resolution and previews exactly its resolved ids", () => {
    const rendered = renderPage(
      <ScopeSyncBatchPage
        preview={null}
        batch={null}
        error={null}
        heldSetResolution={{
          resolved: [
            {
              scopeRecordId: "scope-magic",
              productDomain: "magic",
              scopeKind: "set",
              productLine: "Magic",
              setName: "Time Spiral",
              rowCount: 2,
            },
            {
              scopeRecordId: "scope-pokemon",
              productDomain: "pokemon",
              scopeKind: "expansion",
              productLine: "Pokemon",
              setName: "Shared Name",
              rowCount: 1,
            },
          ],
          unresolved: [
            {
              productLine: "Pokemon",
              setName: "Missing Set",
              rowCount: 1,
              reason: "mapping-missing",
              productDomain: "pokemon",
            },
          ],
          totals: {
            rows: 4,
            distinctPairs: 3,
            resolvedPairs: 2,
            unresolvedPairs: 1,
            resolvedRows: 3,
            unresolvedRows: 1,
          },
        }}
      />,
    );

    const page = within(rendered.container);
    expect(page.getByRole("heading", { name: "From held-set export" })).toBeTruthy();
    expect(page.getAllByText("Magic / Time Spiral").length).toBeGreaterThan(0);
    expect(page.getAllByText("mapping-missing").length).toBeGreaterThan(0);
    expect(page.getAllByRole("link", { name: "Open unmapped-scope inbox" })[0]?.getAttribute("href")).toBe(
      "/catalog/scope-coverage?productDomain=pokemon",
    );
    expect(page.getByRole("button", { name: "Preview resolved sets" })).toBeTruthy();
    expect(rendered.container.querySelector('input[name="scopeRecordIds"]')?.getAttribute("value")).toBe(
      "scope-magic,scope-pokemon",
    );
  });

  it("shows only the held-set form as submitting until its deferred action settles", async () => {
    let settleAction!: (value: unknown) => void;
    let actionCalls = 0;
    const pendingAction = new Promise((resolve) => {
      settleAction = resolve;
    });
    const router = createMemoryRouter(
      [
        {
          path: "/catalog/scopes/sync-batches",
          element: <ScopeSyncBatchesRoute />,
          loader: async () => ({ batch: null }),
          action: async () => {
            actionCalls += 1;
            return pendingAction;
          },
        },
      ],
      { initialEntries: ["/catalog/scopes/sync-batches"] },
    );
    const rendered = render(<RouterProvider router={router} />);
    const route = within(rendered.container);
    const resolveButton = await route.findByRole("button", { name: "Resolve held sets" });
    fireEvent.change(route.getByLabelText("Held-set export CSV"), {
      target: {
        files: [new File(["Product Line,Set Name\nMagic,Time Spiral"], "held.csv", { type: "text/csv" })],
      },
    });
    fireEvent.submit(resolveButton.closest("form")!);

    await waitFor(() => {
      expect(actionCalls).toBe(1);
      expect(router.state.navigation.formData?.get("intent")).toBe("resolve-held-sets");
      expect(router.state.navigation.formData?.get("file")).toBeInstanceOf(File);
      const pendingButton = route.getByRole("button", { name: "Resolve held sets" });
      expect(pendingButton.getAttribute("aria-busy")).toBe("true");
      expect(pendingButton.hasAttribute("disabled")).toBe(true);
      expect(pendingButton.closest("form")?.getAttribute("aria-busy")).toBe("true");
      expect(route.getByRole("button", { name: "Preview batch" }).hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      settleAction({
        preview: null,
        error: null,
        heldSetResolution: {
          resolved: [],
          unresolved: [],
          totals: {
            rows: 0,
            distinctPairs: 0,
            resolvedPairs: 0,
            unresolvedPairs: 0,
            resolvedRows: 0,
            unresolvedRows: 0,
          },
        },
      });
      await pendingAction;
    });

    await waitFor(() => {
      expect(
        route.getByText("No held sets resolved. Review provider scope mappings in the unmapped-scope inbox."),
      ).toBeTruthy();
      const settledButton = route.getByRole("button", { name: "Resolve held sets" });
      expect(settledButton.getAttribute("aria-busy")).toBeNull();
      expect(settledButton.hasAttribute("disabled")).toBe(false);
    });
  });
});

function renderPage(element: ReactNode) {
  const router = createMemoryRouter([{ path: "*", element, action: async () => null }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}
