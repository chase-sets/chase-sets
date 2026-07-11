// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeProjectionPatch, RealtimeSyncRequired } from "@chase-sets/platform-runtime/realtime";
import { catalogRealtimeRouteTopics } from "../../realtime-support/topics";
import { useCatalogRealtimeRevalidation } from "./realtime-revalidation";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  revalidate: vi.fn(),
  activeRevalidate: vi.fn(),
  subscribeRealtimePatches: vi.fn(),
}));

vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate: mocks.activeRevalidate }),
}));

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: (id: string, topics: readonly string[]) => ({
    id,
    topics,
  }),
  subscribeRealtimePatches: mocks.subscribeRealtimePatches,
}));

function Probe() {
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.catalogItems(), 25);
  return <div />;
}

function ManualProbe() {
  const realtime = useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.catalogItems(), {
    debounceMs: 25,
    mode: "manual",
  });

  return (
    <button type="button" onClick={realtime.reload}>
      {realtime.pendingChangeCount}:{realtime.syncRequired ? "sync" : "fresh"}
    </button>
  );
}

function ConnectionProbe({ connectionStaleAfterMs }: { connectionStaleAfterMs?: number }) {
  const realtime = useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.catalogItems(), {
    debounceMs: 25,
    connectionStaleAfterMs,
  });

  return (
    <span>
      {realtime.connectionStatus}:{realtime.connectionStaleSince ? "since" : "never"}
    </span>
  );
}

describe("useCatalogRealtimeRevalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.close.mockReset();
    mocks.revalidate.mockReset();
    mocks.activeRevalidate = mocks.revalidate;
    mocks.subscribeRealtimePatches.mockReset();
    mocks.subscribeRealtimePatches.mockReturnValue({ close: mocks.close });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to a catalog route topic and debounces revalidation on patches", () => {
    render(<Probe />);

    expect(mocks.subscribeRealtimePatches).toHaveBeenCalledWith(
      expect.objectContaining({
        topics: ["catalog:admin:catalog-items"],
        debounceMs: 25,
      }),
    );

    const options = mocks.subscribeRealtimePatches.mock.calls[0]?.[0];
    act(() => {
      options.onPatch({
        kind: "projection.patch",
        context: "catalog",
        projection: "catalog-admin-catalog-item-projection",
        topics: ["catalog:admin:catalog-items"],
        changes: [
          {
            op: "summary",
            entity: "catalog.adminProjection",
            id: "catalog-items:catalog.item-cat_1",
            value: {},
          },
        ],
      } satisfies RealtimeProjectionPatch);
      options.onPatch({
        kind: "projection.patch",
        context: "catalog",
        projection: "catalog-admin-catalog-item-projection",
        topics: ["catalog:admin:catalog-items"],
        changes: [
          {
            op: "summary",
            entity: "catalog.adminProjection",
            id: "catalog-items:catalog.item-cat_2",
            value: {},
          },
        ],
      } satisfies RealtimeProjectionPatch);
      vi.advanceTimersByTime(24);
    });

    expect(mocks.revalidate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it("revalidates when realtime requires a full sync", () => {
    render(<Probe />);
    const options = mocks.subscribeRealtimePatches.mock.calls[0]?.[0];

    act(() => {
      options.onSyncRequired({
        kind: "sync.required",
        reason: "cursor-expired",
        contexts: ["catalog"],
      } satisfies RealtimeSyncRequired);
      vi.advanceTimersByTime(25);
    });

    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it("keeps the subscription open when the route rerenders with a new revalidator object", () => {
    const nextRevalidate = vi.fn();
    const { rerender } = render(<Probe />);

    mocks.activeRevalidate = nextRevalidate;
    rerender(<Probe />);

    expect(mocks.subscribeRealtimePatches).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();

    const options = mocks.subscribeRealtimePatches.mock.calls[0]?.[0];
    act(() => {
      options.onPatch({
        kind: "projection.patch",
        context: "catalog",
        projection: "catalog-admin-catalog-item-projection",
        topics: ["catalog:admin:catalog-items"],
        changes: [
          {
            op: "summary",
            entity: "catalog.adminProjection",
            id: "catalog-items:catalog.item-cat_1",
            value: {},
          },
        ],
      } satisfies RealtimeProjectionPatch);
      vi.advanceTimersByTime(25);
    });

    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(nextRevalidate).toHaveBeenCalledOnce();
  });

  it("can collect route changes for an explicit reload instead of auto revalidating", () => {
    render(<ManualProbe />);
    const options = mocks.subscribeRealtimePatches.mock.calls[0]?.[0];

    act(() => {
      options.onPatch({
        kind: "projection.patch",
        context: "catalog",
        projection: "catalog-admin-catalog-item-projection",
        topics: ["catalog:admin:catalog-items"],
        changes: [
          {
            op: "summary",
            entity: "catalog.adminProjection",
            id: "catalog-items:catalog.item-cat_1",
            value: {},
          },
          {
            op: "summary",
            entity: "catalog.adminProjection",
            id: "catalog-items:catalog.item-cat_1",
            value: {},
          },
          {
            op: "summary",
            entity: "catalog.adminProjection",
            id: "catalog-items:catalog.item-cat_2",
            value: {},
          },
        ],
      } satisfies RealtimeProjectionPatch);
      vi.advanceTimersByTime(25);
    });

    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "2:fresh" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "2:fresh" }));

    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "0:fresh" })).toBeTruthy();
  });

  it("prompts for an explicit reload when realtime requires a full sync in manual mode", () => {
    render(<ManualProbe />);
    const options = mocks.subscribeRealtimePatches.mock.calls[0]?.[0];

    act(() => {
      options.onSyncRequired({
        kind: "sync.required",
        reason: "cursor-expired",
        contexts: ["catalog"],
      } satisfies RealtimeSyncRequired);
    });

    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "0:sync" })).toBeTruthy();
  });

  it("tracks connection health independently of patch activity", () => {
    render(<ConnectionProbe connectionStaleAfterMs={1_000} />);
    const options = mocks.subscribeRealtimePatches.mock.calls[0]?.[0];

    expect(screen.getByText("connecting:never")).toBeTruthy();

    act(() => {
      options.onConnectionStateChange(true);
    });
    expect(screen.getByText("live:never")).toBeTruthy();

    act(() => {
      options.onConnectionStateChange(false);
    });
    expect(screen.getByText("connecting:never")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText("connecting:never")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("stale:since")).toBeTruthy();
  });
});
