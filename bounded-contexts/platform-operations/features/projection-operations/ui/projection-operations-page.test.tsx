import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectionOperationsPage } from "./projection-operations-page";
import { ProjectionOperationsReferencePage } from "./projection-operations-reference-page";
import { normalizeProjectionOperationsSnapshot } from "../read-model/contracts";
import { normalizeWakeStatusSnapshot } from "../read-model/wake-status-contracts";

const emptyFilters = {
  state: "",
  contextName: "",
  projectionName: "",
  search: "",
  selected: "",
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown, lastEventId = "") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }
}

describe("ProjectionOperationsPage", () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    vi.useRealTimers();
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", {
      value: originalEventSource,
      configurable: true,
    });
  });

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
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("link", { name: "Settings and reference" }).getAttribute("href")).toBe(
      "/platform/projections/reference",
    );
  });

  it("opens poison-event evidence in a drawer with the stream retry action", () => {
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "degraded" },
      projectionStatusSource: "worker-snapshot",
      blockedProjections: [
        {
          projectionKey: "catalog.catalog-item-projection",
          blockedStreams: [{ streamId: "catalog.item-1", state: "blocked" }],
          poisonEvents: [
            {
              eventId: "evt_poison",
              eventType: "catalog.item.updated",
              streamId: "catalog.item-1",
              state: "blocked",
              errorMessage: "handler failed",
            },
          ],
        },
      ],
    });

    render(
      <ProjectionOperationsPage
        data={data}
        filters={{ ...emptyFilters, selected: "poison-event:evt_poison" }}
        actorPermissions={["projection-operations.view", "projection-operations.operate"]}
      />,
    );

    expect(screen.getByRole("dialog", { name: "catalog.item.updated" })).toBeTruthy();
    expect(screen.getAllByText("handler failed").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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

    render(
      <ProjectionOperationsPage
        data={data}
        filters={{ ...emptyFilters, selected: "op_running" }}
        actorPermissions={["projection-operations.view", "projection-operations.operate"]}
      />,
    );

    expect(screen.getByText("rebuild-projection-group / running")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "rebuild-projection-group / running" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hides operate and rebuild actions for projection operations view actors", () => {
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
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          state: "caught-up",
          outstandingEventCount: "0",
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
        },
      ],
    });

    render(
      <ProjectionOperationsPage
        data={data}
        filters={{ ...emptyFilters, selected: "op_running" }}
        actorPermissions={["projection-operations.view"]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rebuild context" })).toBeNull();
  });

  it("updates selected operation detail from live status events", async () => {
    Object.defineProperty(globalThis, "EventSource", {
      value: FakeEventSource,
      configurable: true,
    });
    const onOperationTerminal = vi.fn();
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

    render(
      <ProjectionOperationsPage
        data={data}
        filters={{ ...emptyFilters, selected: "op_running" }}
        onOperationTerminal={onOperationTerminal}
      />,
    );

    expect(FakeEventSource.instances[0]?.url).toBe("/api/platform/projections/operations/op_running/events");
    FakeEventSource.instances[0]?.emit(
      "status",
      {
        ...data.operations[0],
        state: "succeeded",
        completedAt: "2026-05-26T00:02:00.000Z",
        updatedAt: "2026-05-26T00:02:00.000Z",
      },
      "2",
    );

    expect(await screen.findByText("rebuild-projection-group / succeeded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(onOperationTerminal).toHaveBeenCalledOnce();
  });

  it("flips a watched operation's connection indicator to stale once its SSE stream drops", () => {
    Object.defineProperty(globalThis, "EventSource", {
      value: FakeEventSource,
      configurable: true,
    });
    vi.useFakeTimers();

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

    render(<ProjectionOperationsPage data={data} filters={emptyFilters} connectionStaleAfterMs={1_000} />);

    act(() => {
      FakeEventSource.instances[0]?.emit("open", {});
    });
    expect(screen.getByText("Live")).toBeTruthy();

    act(() => {
      FakeEventSource.instances[0]?.emit("error", {});
    });
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText(/^Stale since/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.queryByText(/^Stale since/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(/^Stale since/)).toBeTruthy();
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

    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getAllByText("Cancel requested").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale workers").length).toBeGreaterThan(0);
  });

  it("server-renders a 20,000-row heartbeat history as only the capped diagnostic repair queue", () => {
    const expiredWorkers = Array.from({ length: 100 }, (_, index) => ({
      worker_id: `expired-${String(index).padStart(3, "0")}`,
      worker_kind: "platform-worker",
      worker_state: "expired",
    }));
    const data = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok", outstandingEventCount: "0" },
      projectionStatusSource: "worker-snapshot",
      workers: [{ worker_id: "active", worker_kind: "platform-worker", worker_state: "active" }, ...expiredWorkers],
      workerHeartbeatHistory: {
        activeOrStaleCount: 1,
        expiredTotalCount: 20_000,
        expiredWithinDiagnosticWindowCount: 20_000,
        expiredReturnedCount: expiredWorkers.length,
        expiredTruncated: true,
        expiredDiagnosticLimit: expiredWorkers.length,
        diagnosticWindowMs: 7 * 24 * 60 * 60_000,
      },
    });

    const { container } = render(<ProjectionOperationsPage data={data} filters={emptyFilters} />);

    expect(screen.getByText("1 / 20000 stale")).toBeTruthy();
    const detailTargets = new Set(
      screen.getAllByRole("link", { name: "Details" }).map((link) => link.getAttribute("href")),
    );
    expect(detailTargets.size).toBe(100);
    expect(Buffer.byteLength(container.innerHTML, "utf8")).toBeLessThan(2 * 1024 * 1024);
  });

  it("renders the push-wake handoff without duplicating Grafana telemetry sections", () => {
    const data = normalizeProjectionOperationsSnapshot({ summary: { status: "ok" } });
    const wakeStatus = normalizeWakeStatusSnapshot({
      generatedAt: "2026-06-11T12:00:00.000Z",
      wakeStore: {
        available: true,
        intentSummary: {
          queuedCount: 2,
          claimedCount: 1,
          failedCount: 0,
          expiredCount: 0,
          staleClaimCount: 0,
          oldestQueuedAgeMs: 42000,
        },
        intentBreakdown: [
          {
            priorityLane: "hot",
            origin: "api-wait",
            state: "queued",
            intentCount: 2,
            oldestAgeMs: 42000,
            maxAttemptCount: 0,
          },
        ],
        checkpointSignals: {
          readinessCount: 4,
          expiredReadinessCount: 0,
          latestReadyAgeMs: 9000,
          pendingWaiterCount: 1,
          expiredPendingWaiterCount: 0,
          satisfiedWaiterCount: 8,
          pendingWaiterOrigins: [{ origin: "api-wait", waiterCount: 1 }],
        },
      },
      relay: {
        available: true,
        activeLeaseName: "projection-wake-relay:active",
        lease: {
          ownerId: "platform-worker-1",
          fencingToken: "12",
          acquiredAt: "2026-06-11T11:50:00.000Z",
          renewedAt: "2026-06-11T11:59:00.000Z",
          expiresAt: "2026-06-11T12:01:00.000Z",
          state: "active",
        },
        cursors: [
          {
            sourceContextName: "checkout",
            lastFanOutPosition: "102",
            ownerId: "platform-worker-1",
            fencingToken: "12",
            updatedAt: "2026-06-11T11:59:30.000Z",
            updatedAgeMs: 30000,
            interestIndexVersion: "v3",
            lastAdvanceReason: "notify",
          },
        ],
      },
      schedulers: {
        available: true,
        wakeCapableWorkerCount: 1,
        activeWakeCapableWorkerCount: 1,
        workers: [
          {
            workerId: "platform-worker-1",
            workerKind: "platform-worker",
            workerState: "active",
            heartbeatAgeMs: 5000,
            wakeRunnerCount: 3,
            wakeMaxConcurrentRunners: 3,
          },
        ],
      },
      rollout: {
        eventStoreWakeEmissionEnabledOnHost: true,
        summary: {
          entryCount: 18,
          activeEntryCount: 4,
          enabledEventStoreWakeContextCount: 4,
          enabledRelayFanOutContextCount: 4,
        },
        sources: [
          {
            sourceContextName: "checkout",
            rolloutState: "staging-enabled",
            phase: "phase-1-hot-path",
            rolloutWave: "wave-1-hot-path",
            priorityLane: "hot",
            eventStoreWakeNotificationsEnabled: true,
            relayFanOutEnabled: true,
            affectedProjectionNames: ["checkout:checkout.checkout-session-projection"],
          },
        ],
      },
      migration: {
        summary: {
          projectionCount: 58,
          statusCounts: [
            { status: "push-enabled", count: 20 },
            { status: "push-eligible", count: 38 },
            { status: "disabled", count: 0 },
            { status: "opted-out", count: 0 },
          ],
          optOutCount: 0,
          routeDependencyCount: 18,
          pushEnabledRouteDependencyCount: 12,
        },
        projections: [
          {
            projectionKey: "checkout:checkout.session-projection",
            targetContextName: "checkout",
            projectionName: "checkout.session-projection",
            owner: "Checkout",
            status: "push-enabled",
            sourceContextCount: 1,
            enabledSourceContextCount: 1,
            sourceContextNames: ["checkout"],
            consumesDurableWakeIntents: true,
            optOutReason: null,
            optOutReviewBy: null,
          },
          {
            projectionKey: "discovery:discovery-market-projection",
            targetContextName: "discovery",
            projectionName: "discovery-market-projection",
            owner: "Discovery",
            status: "push-eligible",
            sourceContextCount: 3,
            enabledSourceContextCount: 1,
            sourceContextNames: ["identity", "marketplace", "reputation"],
            consumesDurableWakeIntents: true,
            optOutReason: null,
            optOutReviewBy: null,
          },
        ],
      },
    });

    render(<ProjectionOperationsReferencePage data={data} filters={emptyFilters} wakeStatus={wakeStatus} />);

    expect(screen.getByRole("heading", { name: "Projection settings and reference" })).toBeTruthy();
    expect(screen.getByText("Wake telemetry lives in Grafana")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Grafana wake dashboard" }).getAttribute("href")).toBe(
      "https://grafana.chasesets.com/d/chase-sets-projection-wake-pipeline/projection-wake-pipeline",
    );
    expect(screen.getByRole("link", { name: "Open push-wake runbook" }).getAttribute("href")).toBe(
      "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/push-wake-operations.md",
    );
    expect(screen.queryByText("Wake intent queue")).toBeNull();
    expect(screen.queryByText("Active relay lease")).toBeNull();
    expect(screen.queryByText("Push-first migration by projection group")).toBeNull();
  });

  it("merges wake attention items into the attention-first console", () => {
    const data = normalizeProjectionOperationsSnapshot({ summary: { status: "ok" } });
    const wakeStatus = normalizeWakeStatusSnapshot({
      wakeStore: {
        available: true,
        intentSummary: { failedCount: 2, staleClaimCount: 1 },
        checkpointSignals: {},
      },
      relay: { available: true, lease: null, cursors: [] },
      rollout: { summary: { enabledRelayFanOutContextCount: 0 } },
    });

    render(<ProjectionOperationsPage data={data} filters={emptyFilters} wakeStatus={wakeStatus} />);

    expect(screen.getAllByText("Failed wake intents").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale wake claims").length).toBeGreaterThan(0);
  });

  it("renders an explicit unavailable state when wake status is missing", () => {
    const data = normalizeProjectionOperationsSnapshot({ summary: { status: "ok" } });

    render(<ProjectionOperationsReferencePage data={data} filters={emptyFilters} wakeStatus={null} />);

    expect(screen.getByText("Push-wake status unavailable")).toBeTruthy();
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
      <ProjectionOperationsReferencePage
        data={data}
        filters={{
          ...emptyFilters,
          contextName: "catalog",
          projectionName: "catalog-item-projection",
          state: "caught-up",
          search: "catalog",
          selected: "catalog:catalog-item-projection",
        }}
        actorPermissions={["projection-operations.view", "projection-operations.rebuild"]}
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
