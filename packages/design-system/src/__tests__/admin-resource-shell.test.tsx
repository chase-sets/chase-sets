// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminResourceDetailPage, AdminResourceListPage } from "../patterns/admin-resource-shell";
import type { DataColumn } from "../components/data-display/data-table";

type Row = Readonly<{ id: string; name: string }>;

const rows: readonly Row[] = [{ id: "row_1", name: "Row One" }];
const columns: DataColumn<Row>[] = [{ key: "name", header: "Name", cell: (row) => row.name }];

describe("AdminResourceListPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the title, item count, and rows", () => {
    render(<AdminResourceListPage title="Widgets" items={rows} columns={columns} emptyMessage="No widgets yet." />);

    expect(screen.getByRole("heading", { name: "Widgets" })).toBeTruthy();
    expect(screen.getByText("1 items")).toBeTruthy();
    // DataTable renders both a mobile card list and a desktop table for the same rows.
    expect(screen.getAllByText("Row One").length).toBeGreaterThan(0);
  });

  it("renders the empty message instead of a table when there are no items", () => {
    render(<AdminResourceListPage title="Widgets" items={[]} columns={columns} emptyMessage="No widgets yet." />);

    expect(screen.getByText("No widgets yet.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("appends a view column that links to getHref(row)", () => {
    render(
      <AdminResourceListPage
        title="Widgets"
        items={rows}
        columns={columns}
        emptyMessage="No widgets yet."
        getHref={(row) => `/widgets/${row.id}`}
      />,
    );

    const viewLinks = screen.getAllByRole("link", { name: "View" });
    expect(viewLinks.length).toBeGreaterThan(0);
    for (const link of viewLinks) {
      expect(link.getAttribute("href")).toBe("/widgets/row_1");
    }
  });

  it("supports a custom view label", () => {
    render(
      <AdminResourceListPage
        title="Widgets"
        items={rows}
        columns={columns}
        emptyMessage="No widgets yet."
        getHref={(row) => `/widgets/${row.id}`}
        viewLabel="Open"
      />,
    );

    expect(screen.getAllByRole("link", { name: "Open" }).length).toBeGreaterThan(0);
  });

  it("renders a filters slot above the table when provided", () => {
    render(
      <AdminResourceListPage
        title="Widgets"
        items={rows}
        columns={columns}
        emptyMessage="No widgets yet."
        filters={<div data-testid="filters-slot">Filters go here</div>}
      />,
    );

    expect(screen.getByTestId("filters-slot")).toBeTruthy();
  });

  it("renders a pager once total exceeds the page size and forwards page changes via onPageChange", async () => {
    const onPageChange = vi.fn();
    render(
      <AdminResourceListPage
        title="Widgets"
        items={rows}
        columns={columns}
        emptyMessage="No widgets yet."
        pagination={{ limit: 1, offset: 0, total: 3 }}
        onPageChange={onPageChange}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("hides the pager when the full list fits on one page", () => {
    render(
      <AdminResourceListPage
        title="Widgets"
        items={rows}
        columns={columns}
        emptyMessage="No widgets yet."
        pagination={{ limit: 10, offset: 0, total: 1 }}
      />,
    );

    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });
});

describe("AdminResourceDetailPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders breadcrumbs, actions, status, and sections", () => {
    render(
      <AdminResourceDetailPage
        breadcrumbs={[{ label: "Widgets", href: "/widgets" }, { label: "Widget One" }]}
        title="Widget One"
        status="active"
        actions={<button type="button">Retire</button>}
        sections={[
          { label: "Widget ID", value: "widget_1" },
          { label: "Owner", value: "Alex" },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Widgets" }).getAttribute("href")).toBe("/widgets");
    expect(screen.getByRole("heading", { name: "Widget One" })).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retire" })).toBeTruthy();
    expect(screen.getByText("widget_1")).toBeTruthy();
  });

  it("standardizes loading, error, and not-found states with generic defaults", () => {
    const { unmount: unmountLoading } = render(
      <AdminResourceDetailPage title="Loading widget" loading sections={[]} />,
    );
    expect(screen.getByText("Loading record")).toBeTruthy();
    unmountLoading();

    const { unmount: unmountError } = render(
      <AdminResourceDetailPage title="Broken widget" error="Database timeout" sections={[]} />,
    );
    expect(screen.getByText("Unable to load record")).toBeTruthy();
    expect(screen.getByText("Database timeout")).toBeTruthy();
    unmountError();

    render(<AdminResourceDetailPage title="Missing widget" notFound sections={[]} />);
    expect(screen.getByText("Record not found")).toBeTruthy();
    expect(screen.getByText("The requested record does not exist or is no longer available.")).toBeTruthy();
  });

  it("supports overriding the loading, error, and not-found copy", () => {
    render(
      <AdminResourceDetailPage
        title="Missing session"
        notFound
        notFoundTitle="Session not found"
        notFoundDescription="This session has expired or was revoked."
        sections={[]}
      />,
    );

    expect(screen.getByText("Session not found")).toBeTruthy();
    expect(screen.getByText("This session has expired or was revoked.")).toBeTruthy();
  });
});
