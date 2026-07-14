// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogScopeBulkReviewActions, partitionCandidates } from "./scope-bulk-review-actions";
import type {
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";

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
): CatalogPrimaryWorkbenchReadModel {
  return {
    routeContext: parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex",
    ),
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
  it("submits only the ready candidate IDs on the bulk promote form and reports the skipped remainder", () => {
    const rows = [
      candidate("ready_1", "ready", "ready"),
      candidate("ready_2", "ready", "ready"),
      candidate("conflicts_1", "has-conflicts", "blocked"),
      candidate("stale_1", "stale", "stale"),
    ];
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel(rows)} />);

    const promoteForm = container.querySelector('[data-catalog-merge-candidate-bulk-promote="true"]');
    expect(promoteForm?.querySelector('input[name="_intent"]')).toHaveProperty(
      "value",
      "bulk-promote-merge-candidates",
    );
    expect(promoteForm?.querySelector('input[name="bulkCandidateIds"]')).toHaveProperty("value", "ready_1,ready_2");

    const deferForm = container.querySelector('[data-catalog-merge-candidate-bulk-defer="true"]');
    expect(deferForm?.querySelector('input[name="bulkCandidateIds"]')).toHaveProperty("value", "conflicts_1,stale_1");

    // Reports how many the promote-all skips.
    expect(screen.getByText("Skips 2 not ready (conflicts, stale, or deferred).")).toBeTruthy();
    // Jump-to-conflicts is available when conflicts exist.
    expect(screen.getByText("Jump to conflicts").closest("a")).toBeTruthy();
  });

  it("disables bulk actions for a view-only operator", () => {
    const rows = [candidate("ready_1", "ready", "ready")];
    const { container } = render(<CatalogScopeBulkReviewActions readModel={readModel(rows, false)} />);

    const promoteButton = container
      .querySelector('[data-catalog-merge-candidate-bulk-promote="true"]')
      ?.querySelector("button");
    expect(promoteButton).toHaveProperty("disabled", true);
  });

  it("renders an empty state when the scope has no candidates", () => {
    render(<CatalogScopeBulkReviewActions readModel={readModel([])} />);
    expect(screen.getByText("No candidates in this scope yet.")).toBeTruthy();
  });
});
