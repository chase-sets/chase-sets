// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchResultsTransition } from "../components/feedback/search-results-transition";

afterEach(cleanup);

describe("SearchResultsTransition", () => {
  it("keeps stale results visible with visual and assistive pending feedback", () => {
    const { rerender } = render(
      <SearchResultsTransition busy busyLabel="Updating results...">
        <h2>Existing result</h2>
      </SearchResultsTransition>,
    );

    const result = screen.getByRole("heading", { name: "Existing result" });
    const busyRegion = result.closest('[aria-busy="true"]');
    const status = screen.getByRole("status");
    expect(busyRegion).toBeTruthy();
    expect(busyRegion?.className).toContain("opacity-60");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(screen.getByText("Updating results...")).toBeTruthy();

    rerender(
      <SearchResultsTransition busy={false} busyLabel="Updating results...">
        <h2>Updated result</h2>
      </SearchResultsTransition>,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("heading", { name: "Updated result" }).closest("[aria-busy]")).toBeNull();
  });
});
