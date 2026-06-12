// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import {
  useCheckoutPreparingRevalidation,
  type CheckoutPreparingRevalidationOptions,
} from "./checkout-recovery-revalidation";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigationState: "idle" as "idle" | "loading",
}));

vi.mock("react-router", () => ({
  useNavigate: () => mocks.navigate,
  useNavigation: () => ({ state: mocks.navigationState }),
}));

function checkoutCommit() {
  return {
    commitPosition: "42",
    commitEventIds: ["evt_checkout"],
    commitPositions: [
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "42",
        eventIds: ["evt_checkout"],
      },
    ],
  };
}

function Probe(options: CheckoutPreparingRevalidationOptions) {
  const { isAutoRevalidating } = useCheckoutPreparingRevalidation(options);
  return <output>{isAutoRevalidating ? "auto" : "manual"}</output>;
}

describe("useCheckoutPreparingRevalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.navigate.mockReset();
    mocks.navigationState = "idle";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("revalidates the current fresh-write path on the bounded schedule while the receipt is valid", () => {
    const nowMs = Date.now();
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit(), nowMs);

    render(<Probe enabled currentPath={currentPath} intervalMs={25} nowMs={() => nowMs} />);

    expect(screen.getByText("auto")).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(25);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith(currentPath, { replace: true, preventScrollReset: true });

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(3);
    expect(screen.getByText("auto")).toBeTruthy();
  });

  it("issues exactly one final revalidation when the receipt expires, then stops", () => {
    const startMs = Date.now();
    let nowMs = startMs;
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit(), startMs);

    render(<Probe enabled currentPath={currentPath} intervalMs={25} nowMs={() => nowMs} />);

    act(() => {
      vi.advanceTimersByTime(25);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);

    nowMs = startMs + 31_000;
    act(() => {
      vi.advanceTimersByTime(25);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
    expect(screen.getByText("manual")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });

  it("runs only the final revalidation when the receipt is already expired on mount", () => {
    const startMs = Date.now();
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit(), startMs - 31_000);

    render(<Probe enabled currentPath={currentPath} intervalMs={25} nowMs={() => startMs} />);

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("manual")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it("stops after the attempt budget even while the receipt stays valid", () => {
    const nowMs = Date.now();
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit(), nowMs);

    render(<Probe enabled currentPath={currentPath} intervalMs={25} maxRevalidations={2} nowMs={() => nowMs} />);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
    expect(screen.getByText("manual")).toBeTruthy();
  });

  it("skips a tick without consuming the attempt budget while a revalidation is in flight", () => {
    const nowMs = Date.now();
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit(), nowMs);

    mocks.navigationState = "loading";
    const { rerender } = render(
      <Probe enabled currentPath={currentPath} intervalMs={25} maxRevalidations={2} nowMs={() => nowMs} />,
    );

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByText("auto")).toBeTruthy();

    mocks.navigationState = "idle";
    rerender(<Probe enabled currentPath={currentPath} intervalMs={25} maxRevalidations={2} nowMs={() => nowMs} />);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });

  it("does nothing for non-preparing recovery states or token-less paths", () => {
    const nowMs = Date.now();
    const freshPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit(), nowMs);

    const { unmount } = render(<Probe enabled={false} currentPath={freshPath} intervalMs={25} nowMs={() => nowMs} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByText("manual")).toBeTruthy();
    unmount();

    render(<Probe enabled currentPath="/checkout/buy/session/chk_1" intervalMs={25} nowMs={() => nowMs} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByText("manual")).toBeTruthy();
  });
});
