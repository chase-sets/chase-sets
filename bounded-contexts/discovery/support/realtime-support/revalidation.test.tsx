// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiscoveryRealtimeRevalidation } from "./revalidation";

const mocks = vi.hoisted(() => ({
  activeRevalidate: vi.fn(),
  firstRevalidate: vi.fn(),
}));

vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate: mocks.activeRevalidate }),
}));

const callbacks: Array<ReturnType<typeof useDiscoveryRealtimeRevalidation>> = [];

function Probe({ renderKey }: { renderKey: string }) {
  const revalidate = useDiscoveryRealtimeRevalidation();
  callbacks.push(revalidate);

  return (
    <button type="button" data-render-key={renderKey} onClick={revalidate}>
      Revalidate
    </button>
  );
}

describe("useDiscoveryRealtimeRevalidation", () => {
  beforeEach(() => {
    callbacks.length = 0;
    mocks.firstRevalidate.mockReset();
    mocks.activeRevalidate = mocks.firstRevalidate;
  });

  afterEach(() => {
    cleanup();
  });

  it("revalidates through the router and keeps a stable realtime callback across rerenders", () => {
    const { rerender } = render(<Probe renderKey="first" />);
    const firstCallback = callbacks.at(-1);

    fireEvent.click(screen.getByRole("button", { name: "Revalidate" }));
    expect(mocks.firstRevalidate).toHaveBeenCalledOnce();

    const nextRevalidate = vi.fn();
    mocks.activeRevalidate = nextRevalidate;
    rerender(<Probe renderKey="second" />);

    expect(callbacks.at(-1)).toBe(firstCallback);
    fireEvent.click(screen.getByRole("button", { name: "Revalidate" }));
    expect(nextRevalidate).toHaveBeenCalledOnce();
  });
});
