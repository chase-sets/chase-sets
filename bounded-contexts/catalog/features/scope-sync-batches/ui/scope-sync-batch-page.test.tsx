// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ScopeSyncBatchPage } from "./scope-sync-batch-page";

describe("Scope Sync Batch admin page", () => {
  it("renders blocked preview evidence before confirmation", () => {
    renderPage(
      <ScopeSyncBatchPage
        batch={null}
        error={null}
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
});

function renderPage(element: ReactNode) {
  const router = createMemoryRouter([{ path: "*", element, action: async () => null }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}
