// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogScopeBulkReviewActions, partitionCandidates } from "./scope-bulk-review-actions";
import type {
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";
import { CatalogIntegrationCommandActionProvider } from "./command-action-context";
import { CATALOG_CONTROL_PLANE_ACTIONS } from "../information-architecture-v2";

afterEach(cleanup);

function candidate(
  candidateId: string,
  status: CatalogPrimaryWorkbenchMergeCandidateReviewRow["status"],
  promoteState: CatalogPrimaryWorkbenchMergeCandidateReviewRow["promoteReadiness"]["state"],
): CatalogPrimaryWorkbenchMergeCandidateReviewRow {
  return {
    candidateId,
    status,
    promoteReadiness: { state: promoteState, blockers: [] },
  } as unknown as CatalogPrimaryWorkbenchMergeCandidateReviewRow;
}

function readModel(
  rows: readonly CatalogPrimaryWorkbenchMergeCandidateReviewRow[],
  rbacAllowed = true,
  scopeRecordId: string | null = "scope_base_set",
): CatalogPrimaryWorkbenchReadModel {
  const query = new URLSearchParams({ providerKey: "tcgdex" });
  if (scopeRecordId) {
    query.set("scopeRecordId", scopeRecordId);
  }
  return {
    routeContext: parseCatalogPrimaryWorkbenchRouteContext(`https://admin.example/catalog/integrations?${query}`),
    readiness: { rbacAllowed, blockers: [] },
    mergeCandidateReview: { rows },
  } as unknown as CatalogPrimaryWorkbenchReadModel;
}

describe("partitionCandidates", () => {
  it("only classifies ready + promote-ready candidates as promotable and excludes terminal ones", () => {
    const partition = partitionCandidates([
      candidate("ready_1", "ready", "ready"),
      candidate("ready_blocked", "ready", "blocked"),
      candidate("conflicts_1", "has-conflicts", "blocked"),
      candidate("stale_1", "stale", "stale"),
      candidate("deferred_1", "deferred", "deferred"),
      candidate("promoted_1", "promoted", "terminal"),
    ]);

    expect(partition.promotableIds).toEqual(["ready_1"]);
    expect(partition.conflictIds).toEqual(["conflicts_1"]);
    // Remainder = actionable but not promotable: ready-but-blocked, has-conflicts, stale.
    expect(partition.remainderIds).toEqual(["ready_blocked", "conflicts_1", "stale_1"]);
  });
});

describe("CatalogScopeBulkReviewActions", () => {
  it("submits the registered candidate actions with only the scope record ID, never page candidate IDs", () => {
    const rows = [
      candidate("ready_1", "ready", "ready"),
      candidate("ready_2", "ready", "ready"),
      candidate("conflicts_1", "has-conflicts", "blocked"),
      candidate("stale_1", "stale", "stale"),
    ];
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel(rows)} />);
    const registeredActionIds = new Set<string>(CATALOG_CONTROL_PLANE_ACTIONS.map((action) => action.id));

    const promoteForm = container.querySelector('[data-catalog-merge-candidate-bulk-promote="true"]');
    const promoteIntent = promoteForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value;
    expect(promoteIntent).toBe("candidate.promote");
    expect(registeredActionIds.has(promoteIntent ?? "")).toBe(true);
    expect(promoteForm?.querySelector('input[name="candidateSelection"]')).toHaveProperty("value", "scope");
    expect(promoteForm?.querySelector('input[name="scopeRecordId"]')).toHaveProperty("value", "scope_base_set");
    expect(promoteForm?.querySelector('input[name="candidateId"]')).toBeNull();
    expect(promoteForm?.querySelector('input[name="bulkCandidateIds"]')).toBeNull();

    const deferForm = container.querySelector('[data-catalog-merge-candidate-bulk-defer="true"]');
    const deferIntent = deferForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value;
    expect(deferIntent).toBe("candidate.defer");
    expect(registeredActionIds.has(deferIntent ?? "")).toBe(true);
    expect(deferForm?.querySelector('input[name="candidateSelection"]')).toHaveProperty("value", "scope");
    expect(deferForm?.querySelector('input[name="scopeRecordId"]')).toHaveProperty("value", "scope_base_set");
    expect(deferForm?.querySelector('input[name="bulkCandidateIds"]')).toBeNull();

    // The page partition only reports what this page shows; the job decides.
    expect(screen.getByText("2 on this page need review. Promotion skips candidates that are not ready.")).toBeTruthy();
    // Jump-to-conflicts is available when conflicts exist.
    expect(screen.getByText("Jump to conflicts").closest("a")).toBeTruthy();
  });

  it("keeps the scope actions available when this page shows no ready candidate", () => {
    // The 25-row page cannot prove the scope has nothing ready; a submit on a
    // scope with nothing ready is a server-side no-op job.
    const rows = [
      candidate("promoted_1", "promoted", "terminal"),
      candidate("conflicts_1", "has-conflicts", "blocked"),
    ];
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel(rows)} />);

    for (const marker of ["data-catalog-merge-candidate-bulk-promote", "data-catalog-merge-candidate-bulk-defer"]) {
      expect(container.querySelector(`[${marker}="true"]`)?.querySelector("button")).toHaveProperty("disabled", false);
    }
  });

  it("keeps both registered scope forms enabled on an empty filtered page", () => {
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel([])} />);
    for (const intent of ["candidate.promote", "candidate.defer"]) {
      const form = container.querySelector(`input[name="_intent"][value="${intent}"]`)?.closest("form");
      expect(form).toBeTruthy();
      expect(form?.querySelector("button")).toHaveProperty("disabled", false);
      expect(form?.querySelector('input[name="scopeRecordId"]')).toHaveProperty("value", "scope_base_set");
      expect(form?.querySelector('input[name="candidateId"]')).toBeNull();
    }
  });

  it("disables the scope actions without a scope record to submit", () => {
    const rows = [candidate("ready_1", "ready", "ready")];
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel(rows, true, null)} />);

    for (const marker of ["data-catalog-merge-candidate-bulk-promote", "data-catalog-merge-candidate-bulk-defer"]) {
      expect(container.querySelector(`[${marker}="true"]`)?.querySelector("button")).toHaveProperty("disabled", true);
    }
  });

  it("disables bulk actions for a view-only operator", () => {
    const rows = [candidate("ready_1", "ready", "ready")];
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel(rows, false)} />);

    const promoteButton = container
      .querySelector('[data-catalog-merge-candidate-bulk-promote="true"]')
      ?.querySelector("button");
    expect(promoteButton).toHaveProperty("disabled", true);
  });

  it("describes an empty page without claiming the scope is empty", () => {
    render(<CatalogScopeBulkReviewActions readModel={readModel([])} />);
    expect(
      screen.getByText("No candidates match the current page filters. Scope actions still apply across the scope."),
    ).toBeTruthy();
  });

  it("submits scope-level bulk review on Scope Detail when composed there", () => {
    const { container } = render(
      <CatalogIntegrationCommandActionProvider actionPath="/catalog/scopes/scope_base_set">
        <CatalogScopeBulkReviewActions readModel={readModel([candidate("ready_1", "ready", "ready")])} />
      </CatalogIntegrationCommandActionProvider>,
    );
    const form = container.querySelector('[data-catalog-merge-candidate-bulk-promote="true"]') as HTMLFormElement;
    const action = new URL(form.action);

    expect(action.pathname).toBe("/catalog/scopes/scope_base_set");
  });
});
