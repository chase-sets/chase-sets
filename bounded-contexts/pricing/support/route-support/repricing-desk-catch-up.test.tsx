// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPRICING_DESK_CATCH_UP_DELAY_MS,
  REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS,
  useRepricingDeskCatchUp,
} from "./repricing-desk-catch-up";

const router = vi.hoisted(() => ({
  location: { pathname: "/account/desk/repricing/rpp_1", search: "?postWriteToken=pwt_1" },
  navigationState: "idle" as "idle" | "loading" | "submitting",
  revalidationState: "idle" as "idle" | "loading",
  revalidate: vi.fn(async () => undefined),
}));

vi.mock("react-router", () => ({
  useLocation: () => router.location,
  useNavigation: () => ({ state: router.navigationState }),
  useRevalidator: () => ({ revalidate: router.revalidate, state: router.revalidationState }),
}));

function Probe({ catchingUp }: Readonly<{ catchingUp: boolean }>) {
  useRepricingDeskCatchUp(catchingUp);
  return null;
}

// Advances one attempt delay at a time so React commits each reload's state
// before the next timer is scheduled.
function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += REPRICING_DESK_CATCH_UP_DELAY_MS) {
    act(() => {
      vi.advanceTimersByTime(Math.min(REPRICING_DESK_CATCH_UP_DELAY_MS, ms - elapsed));
    });
  }
}

describe("useRepricingDeskCatchUp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    router.location = { pathname: "/account/desk/repricing/rpp_1", search: "?postWriteToken=pwt_1" };
    router.navigationState = "idle";
    router.revalidationState = "idle";
    router.revalidate.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reloads a catching-up page shortly after it renders", () => {
    render(<Probe catchingUp />);

    advance(REPRICING_DESK_CATCH_UP_DELAY_MS - 1);
    expect(router.revalidate).not.toHaveBeenCalled();
    advance(1);
    expect(router.revalidate).toHaveBeenCalledTimes(1);
  });

  it("never reloads a page that has caught up", () => {
    render(<Probe catchingUp={false} />);

    advance(REPRICING_DESK_CATCH_UP_DELAY_MS * (REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS + 1));
    expect(router.revalidate).not.toHaveBeenCalled();
  });

  it("waits while a navigation or reload is in flight", () => {
    router.navigationState = "loading";
    const view = render(<Probe catchingUp />);
    advance(REPRICING_DESK_CATCH_UP_DELAY_MS * 4);
    expect(router.revalidate).not.toHaveBeenCalled();

    router.navigationState = "idle";
    router.revalidationState = "loading";
    view.rerender(<Probe catchingUp />);
    advance(REPRICING_DESK_CATCH_UP_DELAY_MS * 4);
    expect(router.revalidate).not.toHaveBeenCalled();

    router.revalidationState = "idle";
    view.rerender(<Probe catchingUp />);
    advance(REPRICING_DESK_CATCH_UP_DELAY_MS);
    expect(router.revalidate).toHaveBeenCalledTimes(1);
  });

  it("stops at the attempt cap and leaves the manual refresh to the seller", () => {
    render(<Probe catchingUp />);

    advance(REPRICING_DESK_CATCH_UP_DELAY_MS * (REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS + 5));
    expect(router.revalidate).toHaveBeenCalledTimes(REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS);
  });

  it("gives a new write its own attempt budget", () => {
    const view = render(<Probe catchingUp />);
    advance(REPRICING_DESK_CATCH_UP_DELAY_MS * (REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS + 5));
    expect(router.revalidate).toHaveBeenCalledTimes(REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS);

    router.location = { pathname: "/account/desk/repricing/rpp_1", search: "?postWriteToken=pwt_2" };
    view.rerender(<Probe catchingUp />);
    advance(REPRICING_DESK_CATCH_UP_DELAY_MS);
    expect(router.revalidate).toHaveBeenCalledTimes(REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS + 1);
  });
});
