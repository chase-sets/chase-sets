import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IconButton, Pagination, Toolbar, ToolbarButton } from "../components/actions";
import { DataTable, TaskLineItem, type DataColumn } from "../components/data-display";
import { Calendar, Checkbox, PasswordInput, RadioGroup, Switch, TagInput } from "../components/forms";
import { ChaseRoot } from "../theme/provider";

function repositoryRoot(): string {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

const styles = readFileSync(join(repositoryRoot(), "packages", "design-system", "src", "styles", "styles.css"), "utf8");

const rows = [{ id: "alpha", name: "Alpha" }];
const columns: DataColumn<(typeof rows)[number]>[] = [
  { key: "name", header: "Name", cell: (row) => row.name, sortable: true },
];

function expectHeightTarget(element: HTMLElement, size: "sm" | "md" = "md") {
  expect(element.className).toContain(`min-h-[var(--control-${size}-height)]`);
}

function expectSquareTarget(element: HTMLElement, size: "sm" | "md" = "md") {
  expectHeightTarget(element, size);
  expect(element.className).toContain(`min-w-[var(--control-${size}-height)]`);
}

describe("design-system touch targets", () => {
  it("keeps every default control size at or above the 44px floor with an explicit compact exception", () => {
    expect(styles).toMatch(/--control-sm-height:\s*2\.75rem;/);
    expect(styles).toMatch(/--control-md-height:\s*2\.75rem;/);
    expect(styles).toMatch(/\[data-density="compact"\][\s\S]*--control-sm-height:\s*1\.75rem;/);
  });

  it("renders the interactive catalog with effective target sizing on controls instead of glyphs", () => {
    render(
      <ChaseRoot>
        <IconButton label="Small icon action" icon="check" size="sm" />
        <Pagination page={2} totalPages={3} />
        <Checkbox label="Accept terms" />
        <RadioGroup label="Shipping speed" items={[{ value: "standard", label: "Standard" }]} />
        <PasswordInput label="Password" />
        <Calendar value="2026-07-14" />
        <TagInput label="Tags" values={["rare"]} />
        <Switch label="Notifications" />
        <Toolbar label="Editing tools">
          <ToolbarButton>Crop</ToolbarButton>
        </Toolbar>
        <DataTable
          rows={rows}
          columns={columns}
          mobileMode="scroll"
          getRowId={(row) => row.id}
          selectedKeys={new Set<string>()}
          onSelectionChange={() => undefined}
        />
        <TaskLineItem
          title="Alpha"
          quantity={1}
          checked={false}
          checkboxLabel="Pack Alpha"
          onCheckedChange={() => undefined}
        />
      </ChaseRoot>,
    );

    expectSquareTarget(screen.getByRole("button", { name: "Small icon action" }), "sm");

    const pageButton = screen.getByRole("button", { name: "1" });
    expect(pageButton.className).toContain("min-h-11");
    expect(pageButton.className).toContain("min-w-11");

    expectHeightTarget(screen.getByLabelText("Accept terms").closest("label") as HTMLElement);
    expectHeightTarget(screen.getByRole("radio", { name: "Standard" }));
    expectSquareTarget(screen.getByRole("button", { name: "Show password" }));
    expectSquareTarget(screen.getByRole("button", { name: "Previous month" }));
    expectSquareTarget(screen.getByRole("button", { name: "Remove rare" }), "sm");
    expectHeightTarget(screen.getByRole("switch", { name: "Notifications" }).closest("label") as HTMLElement);
    expectHeightTarget(screen.getByRole("button", { name: "Crop" }));
    expectHeightTarget(screen.getByRole("button", { name: "Name" }));
    expectSquareTarget(screen.getByLabelText("Select row alpha"));
    expectSquareTarget(screen.getByRole("button", { name: "Pack Alpha" }));
  });
});
