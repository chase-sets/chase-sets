import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, Table, type DataColumn } from "../components/data-display";
import { ChaseRoot } from "../theme/provider";

interface Row {
  name: string;
  price: number;
}

const baseColumns: DataColumn<Row>[] = [
  { key: "name", header: "Name", cell: (row) => row.name, sortable: true },
  { key: "price", header: "Price", align: "right", cell: (row) => row.price, sortable: true },
  { key: "stock", header: "Stock", cell: () => "Available" },
];

const baseRows: Row[] = [
  { name: "Alpha", price: 10 },
  { name: "Beta", price: 20 },
];

describe("TableShell scaffolding", () => {
  it("renders the shared wrapper + table chrome once for the simple Table", () => {
    const { container } = render(<Table caption="People" columns={["Name", "Role"]} rows={[["Ada", "Engineer"]]} />);

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("modern-surface");
    expect(wrapper.className).toContain("overflow-x-auto");

    const table = wrapper.querySelector("table");
    expect(table?.className).toBe("min-w-full border-collapse text-left text-sm");

    const caption = table?.querySelector("caption");
    expect(caption?.textContent).toBe("People");
    expect(caption?.className).toBe("sr-only");

    // Header cells use semantic <th>; body uses <td>.
    expect(within(table as HTMLElement).getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getByText("Ada").tagName).toBe("TD");
  });

  it("uses the inset surface for DataTable", () => {
    const { container } = render(<DataTable rows={baseRows} columns={baseColumns} mobileMode="scroll" />);
    const wrapper = container.querySelector(".inset-surface.overflow-x-auto");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector("table")?.className).toBe("min-w-full border-collapse text-left text-sm");
  });

  it("forwards DataTable captions to the table shell as a hidden accessible name", () => {
    const { container } = render(
      <DataTable rows={baseRows} columns={baseColumns} caption="Catalog profile versions" mobileMode="scroll" />,
    );

    expect(screen.getByRole("table", { name: "Catalog profile versions" })).toBeTruthy();
    const caption = container.querySelector("caption");
    expect(caption?.textContent).toBe("Catalog profile versions");
    expect(caption?.className).toBe("sr-only");
  });

  it("applies data row props to desktop rows and compact cards", () => {
    const { container } = render(
      <DataTable
        rows={baseRows}
        columns={baseColumns}
        getRowId={(row) => row.name}
        getRowProps={(row) => ({
          "data-testid": `catalog-row-${row.name}`,
          "data-catalog-row-name": row.name,
        })}
      />,
    );

    expect(container.querySelector('tr[data-catalog-row-name="Alpha"]')).toBeTruthy();
    expect(container.querySelector('[role="listitem"][data-catalog-row-name="Alpha"]')).toBeTruthy();
  });
});

describe("Table density", () => {
  it("defaults to comfortable padding and tightens under compact", () => {
    const { rerender } = render(<Table columns={["Name", "Role"]} rows={[["Ada", "Engineer"]]} />);
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("px-4 py-3");

    rerender(<Table columns={["Name", "Role"]} rows={[["Ada", "Engineer"]]} density="compact" />);
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("px-3 py-2");
    expect(screen.getByText("Ada").className).toContain("px-3 py-2");
  });

  it("inherits density from the surrounding ChaseRoot when no prop is set", () => {
    render(
      <ChaseRoot density="compact">
        <Table columns={["Name", "Role"]} rows={[["Ada", "Engineer"]]} />
      </ChaseRoot>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("px-3 py-2");
  });
});

describe("Table wrapFirstColumn", () => {
  it("leaves cells untouched by default", () => {
    render(<Table columns={["Name", "Role"]} rows={[["Ada", "Engineer"]]} />);
    expect(screen.getByRole("columnheader", { name: "Name" }).className).not.toContain("max-w-11");
    expect(screen.getByText("Ada").className).not.toContain("max-w-11");
  });

  it("constrains only the first column's header and body cells to the narrow wrap width", () => {
    render(<Table columns={["Name", "Role"]} rows={[["Ada", "Engineer"]]} wrapFirstColumn />);

    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    expect(nameHeader.className).toContain("max-w-11");
    expect(nameHeader.className).toContain("hyphens-auto");
    expect(nameHeader.getAttribute("lang")).toBe("en");

    const roleHeader = screen.getByRole("columnheader", { name: "Role" });
    expect(roleHeader.className).not.toContain("max-w-11");
    expect(roleHeader.hasAttribute("lang")).toBe(false);

    const nameCell = screen.getByText("Ada");
    expect(nameCell.className).toContain("max-w-11");
    expect(nameCell.getAttribute("lang")).toBe("en");

    const roleCell = screen.getByText("Engineer");
    expect(roleCell.className).not.toContain("max-w-11");
    expect(roleCell.hasAttribute("lang")).toBe(false);
  });
});

describe("DataTable density", () => {
  it("defaults to comfortable padding and tightens under compact", () => {
    const { rerender } = render(<DataTable rows={baseRows} columns={baseColumns} density="comfortable" />);
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("px-4 py-3");

    rerender(<DataTable rows={baseRows} columns={baseColumns} density="compact" />);
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("px-3 py-2");
  });

  it("inherits density from the surrounding ChaseRoot when no prop is set", () => {
    render(
      <ChaseRoot density="compact">
        <DataTable rows={baseRows} columns={baseColumns} />
      </ChaseRoot>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("px-3 py-2");
  });
});

describe("DataTable mobileMode", () => {
  it("renders a stacked card list alongside the desktop table by default", () => {
    const { container } = render(<DataTable rows={baseRows} columns={baseColumns} />);

    expect(within(container).getByRole("list")).toBeTruthy();
    expect(container.querySelector(".hidden.md\\:block")).not.toBeNull();
  });

  it("associates stacked-card labels and values with description list semantics", () => {
    const { container } = render(<DataTable rows={baseRows} columns={baseColumns} />);

    const firstCard = within(container).getAllByRole("listitem")[0];
    const descriptionList = firstCard.querySelector("dl");
    expect(descriptionList).toBeTruthy();

    const terms = Array.from(descriptionList?.querySelectorAll("dt") ?? []).map((term) => term.textContent);
    const definitions = Array.from(descriptionList?.querySelectorAll("dd") ?? []).map(
      (definition) => definition.textContent,
    );

    expect(terms).toEqual(["Name", "Price", "Stock"]);
    expect(definitions).toEqual(["Alpha", "10", "Available"]);
  });

  it("drops the card list and always shows the table in scroll mode", () => {
    const { container } = render(<DataTable rows={baseRows} columns={baseColumns} mobileMode="scroll" />);

    expect(within(container).queryByRole("list")).toBeNull();
    expect(container.querySelector(".block")?.querySelector("table")).not.toBeNull();
  });
});

describe("DataTable loading", () => {
  it("renders the requested number of skeleton rows without hover affordance", () => {
    const { container } = render(<DataTable rows={[]} columns={baseColumns} loading loadingRows={3} />);

    const table = container.querySelector(".hidden.md\\:block table");
    const skeletonRows = table?.querySelectorAll("tbody tr");
    expect(skeletonRows).toHaveLength(3);
    skeletonRows?.forEach((row) => {
      expect(row.className).toBe("border-b border-muted last:border-b-0");
      expect(row.className).not.toContain("hover:");
    });
  });

  it("announces loading state via a polite status region", () => {
    const { rerender } = render(<DataTable rows={[]} columns={baseColumns} loading />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading table data");
    expect(status.getAttribute("aria-live")).toBe("polite");

    rerender(<DataTable rows={baseRows} columns={baseColumns} loading={false} />);
    expect(screen.getByRole("status").textContent).toBe("Table data loaded");
  });
});

describe("DataTable sort affordances", () => {
  it("exposes aria-sort and emits direction toggles", () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        rows={baseRows}
        columns={baseColumns}
        sortKey="name"
        sortDirection="asc"
        onSortChange={onSortChange}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: "Price" }).getAttribute("aria-sort")).toBe("none");
    expect(screen.getByRole("columnheader", { name: "Stock" }).hasAttribute("aria-sort")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenCalledWith("name", "desc");

    fireEvent.click(screen.getByRole("button", { name: "Price" }));
    expect(onSortChange).toHaveBeenCalledWith("price", "asc");
  });
});

describe("DataTable selection", () => {
  it("toggles individual rows and supports select-all with indeterminate state", () => {
    const onSelectionChange = vi.fn();
    const { container, rerender } = render(
      <DataTable
        rows={baseRows}
        columns={baseColumns}
        mobileMode="scroll"
        getRowId={(row) => row.name}
        selectedKeys={new Set<string>()}
        onSelectionChange={onSelectionChange}
      />,
    );

    const rowCheckbox = screen.getByLabelText("Select row Alpha") as HTMLInputElement;
    fireEvent.click(rowCheckbox);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["Alpha"]));

    const selectAll = screen.getByLabelText("Select all rows") as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["Alpha", "Beta"]));

    rerender(
      <DataTable
        rows={baseRows}
        columns={baseColumns}
        mobileMode="scroll"
        getRowId={(row) => row.name}
        selectedKeys={new Set(["Alpha"])}
        onSelectionChange={onSelectionChange}
      />,
    );
    const partial = within(container).getByLabelText("Select all rows");
    expect(partial.getAttribute("aria-checked")).toBe("mixed");
  });

  it("toggles row selection when the wrapper is clicked outside the glyph", () => {
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        rows={baseRows}
        columns={baseColumns}
        mobileMode="scroll"
        getRowId={(row) => row.name}
        selectedKeys={new Set<string>()}
        onSelectionChange={onSelectionChange}
      />,
    );

    const rowCheckbox = screen.getByLabelText("Select row Alpha") as HTMLInputElement;
    const rowWrapper = rowCheckbox.closest("label") as HTMLElement;
    fireEvent.click(rowWrapper);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["Alpha"]));

    const selectAllCheckbox = screen.getByLabelText("Select all rows") as HTMLInputElement;
    const selectAllWrapper = selectAllCheckbox.closest("label") as HTMLElement;
    fireEvent.click(selectAllWrapper);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["Alpha", "Beta"]));
  });

  it("uses a meaningful row name for row selection when getRowId is omitted", () => {
    render(
      <DataTable
        rows={baseRows}
        columns={baseColumns}
        mobileMode="scroll"
        selectedKeys={new Set<string>()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Select row Alpha")).toBeTruthy();
    expect(screen.queryByLabelText("Select row 0")).toBeNull();
  });
});

describe("DataTable a11y semantics", () => {
  it("keeps empty state out of a table and surfaces it as a message", () => {
    render(<DataTable rows={[]} columns={baseColumns} emptyTitle="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(document.querySelector("table")).toBeNull();
  });

  it("renders header cells as scoped column headers", () => {
    render(<DataTable rows={baseRows} columns={baseColumns} mobileMode="scroll" />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.tagName)).toEqual(["TH", "TH", "TH"]);
    expect(headers.map((header) => header.getAttribute("scope"))).toEqual(["col", "col", "col"]);
  });
});
