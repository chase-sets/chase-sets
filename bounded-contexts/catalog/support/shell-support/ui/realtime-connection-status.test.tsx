// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CatalogRealtimeConnectionStatus } from "./realtime-connection-status";

describe("CatalogRealtimeConnectionStatus", () => {
  it("renders the live badge when the connection is healthy", () => {
    render(<CatalogRealtimeConnectionStatus status="live" staleSince={null} reload={vi.fn()} />);

    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("escalates to a stale banner with a reload action once the connection drops", () => {
    const reload = vi.fn();
    const staleSince = new Date("2026-07-09T10:32:00.000Z");

    render(<CatalogRealtimeConnectionStatus status="stale" staleSince={staleSince} reload={reload} />);

    expect(screen.getByText("Stale since Jul 9, 2026, 10:32 AM UTC")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
