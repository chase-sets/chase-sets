// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RealtimeProjectionPatch,
  RealtimeSyncRequired,
} from "@chase-sets/platform-runtime/realtime";
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
});
