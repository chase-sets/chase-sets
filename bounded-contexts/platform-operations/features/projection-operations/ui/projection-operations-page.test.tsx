import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProjectionOperationsPage } from "./projection-operations-page";
import { normalizeProjectionOperationsSnapshot } from "../read-model/contracts";

const emptyFilters = {
  tab: "",
  state: "",
  contextName: "",
  projectionName: "",
  search: "",
  selected: "",
};

describe("ProjectionOperationsPage", () => {
  it("renders an attention-first console for failed operations and blocked streams", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: {
        status: "degraded",
        totalGroups: 1,
        outstandingEventCount: "24",
      },
      projectionStatusSource: "worker-snapshot",
      operationSummary: {
        queuedCount: "1",
        runningCount: "0",
        failedCount: "1",
        cancelRequestedCount: "0",
      },
      operations: [
        {
          operationId: "op_failed",
          operationKind: "rebuild-projection-group",
          state: "failed",
          contextName: "catalog",
          projectionName: "catalog-item-projection",
          requestedAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:01:00.000Z",
          error: { message: "handler failed" },
        },
      ],
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          state: "degraded",
          outstandingEventCount: "24",
          sourceLagEventCount: "24",
          blockedStreamCount: 1,
          poisonEventCount: 1,
          updatedAt: "2026-05-26T00:01:00.000Z",
        },
      ],
      blockedProjections: [
        {
          projectionKey: "catalog.catalog-item-projection",
          blockedStreams: [
            {
              streamId: "catalog.item-1",
              firstBlockedGlobalPosition: "10",
              lastSeenGlobalPosition: "20",
              firstBlockedStreamVersion: 2,
              deferredEventCount: 3,
              state: "blocked",
            },
          ],
          poisonEvents: [
            {
              eventId: "evt_1",
              eventType: "catalog.item.updated",
              streamId: "catalog.item-1",
              streamVersion: 2,
              globalPosition: "10",
              errorMessage: "handler failed",
              retryCount: 1,
              firstSeenAt: "2026-05-26T00:00:00.000Z",
              lastSeenAt: "2026-05-26T00:01:00.000Z",
              state: "poison",
            },
          ],
        },
      ],
    });

    render(<ProjectionOperationsPage data={data} filters={emptyFilters} />);

    expect(screen.getByRole("heading", { name: "Projection Operations" })).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getAllByText("Failed operations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Blocked streams").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Poison events").length).toBeGreaterThan(0);
  });

  it("renders selected operation detail with cancellable action", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok" },
      operations: [
        {
          operationId: "op_running",
          operationKind: "rebuild-projection-group",
          state: "running",
          contextName: "catalog",
          projectionName: "catalog-item-projection",
          requestedAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:01:00.000Z",
        },
      ],
    });

    render(<ProjectionOperationsPage data={data} filters={{ ...emptyFilters, selected: "op_running" }} />);

    expect(screen.getByText("rebuild-projection-group / running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders a quiet healthy overview when no attention signals exist", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: {
        status: "ok",
        totalGroups: 1,
        caughtUpGroups: 1,
        outstandingEventCount: "0",
      },
      projectionStatusSource: "worker-snapshot",
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          state: "caught-up",
          caughtUp: true,
          outstandingEventCount: "0",
        },
      ],
    });

    render(<ProjectionOperationsPage data={data} filters={emptyFilters} />);

    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("No attention signals")).toBeTruthy();
  });

  it("hides cross-section shortcuts when the platform actor lacks target permissions", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok" },
    });

    render(<ProjectionOperationsPage data={data} filters={emptyFilters} actorPermissions={["security.manage"]} />);

    expect(screen.queryByRole("link", { name: "Catalog" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Identity" })).toBeNull();
    expect(screen.getByRole("link", { name: "Release dashboard" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Release controls" })).toBeTruthy();
  });

  it("shows cross-section shortcuts when the platform actor has target permissions", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok" },
    });

    render(
      <ProjectionOperationsPage
        data={data}
        filters={emptyFilters}
        actorPermissions={["security.manage", "catalog.view", "accounts.view"]}
      />,
    );

    expect(screen.getByRole("link", { name: "Catalog" }).getAttribute("href")).toBe("/catalog/dimensions");
    expect(screen.getByRole("link", { name: "Identity" }).getAttribute("href")).toBe("/access/accounts");
  });

  it("surfaces cancel-requested and stale worker attention", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok", outstandingEventCount: "0" },
      operationSummary: {
        queuedCount: "0",
        runningCount: "0",
        failedCount: "0",
        cancelRequestedCount: "1",
      },
      workers: [{ worker_id: "worker_1", worker_state: "expired" }],
      operations: [
        {
          operationId: "op_cancel",
          operationKind: "rebuild-projection-group",
          state: "cancel_requested",
          contextName: "catalog",
          requestedAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:01:00.000Z",
        },
      ],
    });

    render(<ProjectionOperationsPage data={data} filters={emptyFilters} />);

    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getAllByText("Cancel requested").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale workers").length).toBeGreaterThan(0);
  });

  it("renders applied filter chips and rebuild confirmation dialogs", async () => {
    const user = userEvent.setup();
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok" },
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          state: "caught-up",
          outstandingEventCount: "0",
        },
      ],
    });

    render(
      <ProjectionOperationsPage
        data={data}
        filters={{
          ...emptyFilters,
          contextName: "catalog",
          projectionName: "catalog-item-projection",
          state: "caught-up",
          search: "catalog",
          selected: "catalog:catalog-item-projection",
        }}
      />,
    );

    expect(screen.getByText("Search: catalog")).toBeTruthy();
    expect(screen.getByText("State: caught-up")).toBeTruthy();
    expect(screen.getAllByText("Context: catalog").length).toBeGreaterThan(0);
    expect(screen.getByText("Projection: catalog-item-projection")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Rebuild" }));

    expect(await screen.findByRole("heading", { name: "Rebuild projection group?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue rebuild" })).toBeTruthy();
  });
});
