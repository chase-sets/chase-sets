// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { useAdminResourceListPageChange } from "../components/forms/router-form";

function PaginationHarness() {
  const location = useLocation();
  const onPageChange = useAdminResourceListPageChange({ limit: 10, offset: 0, total: 25 });

  return (
    <div>
      <div data-testid="current-search">{location.search}</div>
      <button type="button" onClick={() => onPageChange(3)}>
        Go to page 3
      </button>
    </div>
  );
}

function NoOpHarness() {
  const onPageChange = useAdminResourceListPageChange(undefined);

  return (
    <button type="button" onClick={() => onPageChange(3)}>
      Go to page 3
    </button>
  );
}

describe("useAdminResourceListPageChange", () => {
  afterEach(() => {
    cleanup();
  });

  it("navigates to limit/offset search params for the requested page via client-side routing", async () => {
    const router = createMemoryRouter([{ path: "/access/example", element: <PaginationHarness /> }], {
      initialEntries: ["/access/example"],
    });

    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Go to page 3" }));

    expect(router.state.location.pathname + router.state.location.search).toBe("/access/example?limit=10&offset=20");
  });

  it("is a no-op when there is no pagination to navigate", async () => {
    const router = createMemoryRouter([{ path: "/access/example", element: <NoOpHarness /> }], {
      initialEntries: ["/access/example"],
    });

    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Go to page 3" }));

    expect(router.state.location.pathname + router.state.location.search).toBe("/access/example");
  });
});
