// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  loadProjectionOperationsSnapshot,
  loadWakeStatusSnapshot,
} from "../../features/projection-operations/api/client";
import ProjectionOperationsRoute, { loader } from "./projection-operations";

vi.mock("../../features/projection-operations/api/client", () => ({
  cancelProjectionOperation: vi.fn(),
  loadProjectionOperationsSnapshot: vi.fn(),
  loadWakeStatusSnapshot: vi.fn(),
  readProjectionOperationsFilters: (request: Request) => ({
    state: new URL(request.url).searchParams.get("state") ?? "",
    contextName: "",
    projectionName: "",
    search: "",
    selected: new URL(request.url).searchParams.get("selected") ?? "",
  }),
  rebuildProjectionContext: vi.fn(),
  rebuildProjectionGroup: vi.fn(),
  refreshProjectionStatus: vi.fn(),
  retryBlockedStream: vi.fn(),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {}

  emit(type: string, data: unknown, lastEventId = "") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }
}

const operation = {
  operationId: "op_running",
  operationKind: "rebuild-projection-group",
  state: "running" as const,
  contextName: "catalog",
  projectionName: "catalog-item-projection",
  projectionKey: null,
  streamId: null,
  requestedByUserId: null,
  claimOwnerId: null,
  requestedAt: "2026-05-26T00:00:00.000Z",
  startedAt: null,
  updatedAt: "2026-05-26T00:01:00.000Z",
  completedAt: null,
  error: null,
};

function buildSnapshot(
  loadNumber: number,
  initialState = "running",
  nextState = "cancel_requested",
): Awaited<ReturnType<typeof loadProjectionOperationsSnapshot>> {
  return {
    summary: {
      status: "ok",
      totalGroups: 0,
      caughtUpGroups: 0,
      behindGroups: 0,
      staleGroups: 0,
      runningGroups: 0,
      errorGroups: 0,
      outstandingEventCount: String(loadNumber),
    },
    projectionGroups: [],
    blockedProjections: [],
    workers: [],
    workerHeartbeatHistory: {
      activeOrStaleCount: 0,
      expiredTotalCount: 0,
      expiredWithinDiagnosticWindowCount: 0,
      expiredReturnedCount: 0,
      expiredTruncated: false,
      expiredDiagnosticLimit: 0,
      diagnosticWindowMs: 0,
    },
    runners: [],
    projectionStatusSource: "runtime-memory",
    operationSummary: {
      queuedCount: "0",
      runningCount: "1",
      failedCount: "0",
      cancelRequestedCount: "0",
      oldestQueuedAt: null,
      oldestRunningAt: null,
      averageDurationMs: null,
    },
    operations: [
      {
        ...operation,
        state: loadNumber > 1 ? nextState : initialState,
        updatedAt: loadNumber > 1 ? "2026-05-26T00:02:00.000Z" : operation.updatedAt,
      },
    ],
  };
}

async function renderRoute() {
  const router = createMemoryRouter([{ path: "/platform/projections", loader, Component: ProjectionOperationsRoute }], {
    initialEntries: ["/platform/projections?selected=op_running"],
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

describe("ProjectionOperationsRoute live revalidation", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    let loadNumber = 0;
    vi.mocked(loadProjectionOperationsSnapshot).mockImplementation(async () => buildSnapshot(++loadNumber));
    vi.mocked(loadWakeStatusSnapshot).mockResolvedValue(null);
    Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true });
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "EventSource", { value: originalEventSource, configurable: true });
  });

  it.each([
    ["queued", "running"],
    ["running", "cancel_requested"],
  ])("revalidates once when a streamed non-terminal state changes from %s to %s", async (initialState, nextState) => {
    let loadNumber = 0;
    vi.mocked(loadProjectionOperationsSnapshot).mockImplementation(async () =>
      buildSnapshot(++loadNumber, initialState, nextState),
    );
    await renderRoute();
    await screen.findByText(`rebuild-projection-group / ${initialState}`);
    expect(screen.getByText("Source lag").parentElement?.nextElementSibling?.textContent).toBe("1");

    await act(async () => {
      FakeEventSource.instances[0]?.emit(
        "status",
        { ...operation, state: nextState, updatedAt: "2026-05-26T00:02:00.000Z" },
        "1",
      );
    });

    await waitFor(() =>
      expect(screen.getByText("Source lag").parentElement?.nextElementSibling?.textContent).toBe("2"),
    );
    expect(screen.getByText(`rebuild-projection-group / ${nextState}`)).toBeTruthy();
    expect(loadProjectionOperationsSnapshot).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      FakeEventSource.instances[0]?.emit(
        "status",
        { ...operation, state: nextState, updatedAt: "2026-05-26T00:03:00.000Z" },
        "2",
      );
    });
    expect(loadProjectionOperationsSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not revalidate for a streamed progress event with the same state", async () => {
    await renderRoute();
    await screen.findByText("rebuild-projection-group / running");

    await act(async () => {
      FakeEventSource.instances[0]?.emit("status", operation, "1");
      FakeEventSource.instances[0]?.emit(
        "status",
        { ...operation, claimOwnerId: "worker-progress", updatedAt: "2026-05-26T00:02:00.000Z" },
        "2",
      );
    });

    expect(await screen.findByText("worker-progress")).toBeTruthy();
    expect(screen.getByText("rebuild-projection-group / running")).toBeTruthy();
    expect(loadProjectionOperationsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("revalidates exactly once for a streamed terminal transition", async () => {
    await renderRoute();
    await screen.findByText("rebuild-projection-group / running");

    await act(async () => {
      FakeEventSource.instances[0]?.emit(
        "status",
        {
          ...operation,
          state: "succeeded",
          completedAt: "2026-05-26T00:02:00.000Z",
          updatedAt: "2026-05-26T00:02:00.000Z",
        },
        "1",
      );
    });

    await waitFor(() => expect(loadProjectionOperationsSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByText("rebuild-projection-group / succeeded")).toBeTruthy();
    expect(screen.getByText("Source lag").parentElement?.nextElementSibling?.textContent).toBe("2");
    expect(loadProjectionOperationsSnapshot).toHaveBeenCalledTimes(2);
  });
});
