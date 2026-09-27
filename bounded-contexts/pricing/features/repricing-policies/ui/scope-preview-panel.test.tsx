// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepricingScopePreview } from "../read-model/controls";
import { ScopePreviewPanel } from "./scope-preview-panel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const empty: RepricingScopePreview = { matching: 0, governed: 0, shadowedBy: [], takenFrom: [] };
const all = { scope: { kind: "all-listings" as const } };

describe("scope preview", () => {
  it("debounces scope changes and ignores an older response without hiding current precedence", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: RepricingScopePreview) => void;
    const previewRepricingScope = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValue({
        matching: 3,
        governed: 2,
        shadowedBy: [{ policyId: "p1", name: "Older policy", count: 1 }],
        takenFrom: [{ policyId: "p2", name: "Broad policy", count: 2 }],
      });
    const api = { previewRepricingScope };
    const view = render(<ScopePreviewPanel api={api} input={all} />);
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(previewRepricingScope).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    view.rerender(<ScopePreviewPanel api={api} input={{ scope: { kind: "listing-set", listingIds: ["lst_a"] } }} />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    const latest = { scope: { kind: "listing-set" as const, listingIds: ["lst_b"] } };
    view.rerender(<ScopePreviewPanel api={api} input={latest} />);
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(previewRepricingScope).toHaveBeenCalledTimes(2);
    expect(previewRepricingScope).toHaveBeenLastCalledWith(latest);
    expect(screen.getByText("Older policy")).toBeTruthy();
    expect(screen.getByText("Broad policy")).toBeTruthy();
    await act(async () => resolveOld(empty));
    expect(screen.getByText("Older policy")).toBeTruthy();
    expect(screen.getByTestId("repricing-scope-preview").getAttribute("aria-busy")).toBe("false");
  });
  it("distinguishes failure from empty success and retries the same scope", async () => {
    vi.useFakeTimers();
    const api = {
      previewRepricingScope: vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic-private-message"))
        .mockResolvedValue(empty),
    };
    render(<ScopePreviewPanel api={api} input={all} />);
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(screen.queryByText("synthetic-private-message")).toBeNull();
    expect(screen.queryByTestId("repricing-scope-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(api.previewRepricingScope).toHaveBeenLastCalledWith(all);
    expect(screen.getAllByText("0")).toHaveLength(2);
  });
});
