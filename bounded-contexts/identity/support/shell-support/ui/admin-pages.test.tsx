// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AdminListPage } from "./admin-pages";

type Row = Readonly<{ id: string; name: string }>;

const rows: readonly Row[] = [{ id: "row_1", name: "Row One" }];
const columns = [{ key: "name", header: "Name", cell: (row: Row) => row.name }];

function renderAtPath(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/access/example",
        element: (
          <AdminListPage
            title="Example"
            items={rows}
            columns={columns}
            emptyMessage="No rows yet."
            pagination={{ limit: 1, offset: 0, total: 3 }}
          />
        ),
      },
    ],
    { initialEntries: [path] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe("Identity AdminListPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("paginates via client-side router navigation instead of a full page reload", async () => {
    const router = renderAtPath("/access/example");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(router.state.location.pathname + router.state.location.search).toBe("/access/example?limit=1&offset=1");
  });

  it("renders a filters slot above the table when provided", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/access/example",
          element: (
            <AdminListPage
              title="Example"
              items={rows}
              columns={columns}
              emptyMessage="No rows yet."
              filters={<div data-testid="filters-slot">Filters go here</div>}
            />
          ),
        },
      ],
      { initialEntries: ["/access/example"] },
    );

    render(<RouterProvider router={router} />);

    expect(screen.getByTestId("filters-slot")).toBeTruthy();
  });
});
