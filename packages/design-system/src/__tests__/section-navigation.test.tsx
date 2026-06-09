import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SectionNavigation, type SectionNavigationGroup } from "../index";

const catalogGroups: SectionNavigationGroup[] = [
  {
    key: "primary",
    label: "Primary workflow",
    items: [
      {
        key: "import-promotion",
        label: "Import to promotion",
        href: "/admin/catalog/primary-workbench?section=import-promotion",
        icon: "refreshCcw",
        description: "Pull, review, and promote provider data",
        count: 24,
      },
      {
        key: "observation-review",
        label: "Observation review",
        href: "/admin/catalog/primary-workbench?section=observation-review",
        state: "pending",
        statusLabel: "Ready",
      },
    ],
  },
  {
    key: "unblock",
    label: "Unblock provider data",
    items: [
      {
        key: "health",
        label: "Health triage",
        href: "/admin/catalog/provider-health",
        state: "warning",
        statusLabel: "Needs evidence",
      },
      {
        key: "adapter",
        label: "Adapter readiness",
        state: "blocked",
        disabled: true,
        statusLabel: "Blocked",
      },
    ],
  },
  {
    key: "govern",
    label: "Govern and recover",
    items: [
      {
        key: "lifecycle",
        label: "Lifecycle recovery",
        href: "/admin/catalog/jobs-recovery",
        state: "blocked",
        statusLabel: "Blocked",
      },
    ],
  },
];

describe("SectionNavigation", () => {
  it("renders desktop groups with active, status, and count affordances", () => {
    render(
      <SectionNavigation
        variant="desktop"
        label="Catalog control plane sections"
        groups={catalogGroups}
        activeKey="import-promotion"
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Catalog control plane sections" });
    expect(within(nav).getByRole("group", { name: "Primary workflow" })).toBeTruthy();
    expect(within(nav).getByRole("group", { name: "Unblock provider data" })).toBeTruthy();
    expect(within(nav).getByRole("group", { name: "Govern and recover" })).toBeTruthy();

    const activeLink = within(nav).getByRole("link", { name: /Import to promotion/ });
    expect(activeLink.getAttribute("aria-current")).toBe("page");
    expect(activeLink.getAttribute("href")).toBe("/admin/catalog/primary-workbench?section=import-promotion");
    expect(within(activeLink).getByText("24")).toBeTruthy();

    expect(within(nav).getByText("Needs evidence")).toBeTruthy();
    expect(within(nav).getAllByText("Blocked")).toHaveLength(2);
  });

  it("keeps desktop traversal in grouped workflow order", async () => {
    const user = userEvent.setup();

    render(<SectionNavigation variant="desktop" groups={catalogGroups} activeKey="import-promotion" />);

    const first = screen.getByRole("link", { name: /Import to promotion/ });
    const second = screen.getByRole("link", { name: /Observation review/ });
    const third = screen.getByRole("link", { name: /Health triage/ });

    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab();
    expect(document.activeElement).toBe(second);

    await user.tab();
    expect(document.activeElement).toBe(third);
  });

  it("does not fire selection for disabled desktop items", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<SectionNavigation variant="desktop" groups={catalogGroups} activeKey="health" onSelect={onSelect} />);

    const blocked = screen.getByRole("button", { name: /Adapter readiness/ });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);

    await user.click(blocked);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("translates groups to a mobile selector with disabled blocked options", () => {
    const onSelect = vi.fn();

    render(
      <SectionNavigation
        variant="mobile"
        mobileLabel="Catalog section"
        groups={catalogGroups}
        activeKey="import-promotion"
        onSelect={onSelect}
      />,
    );

    const select = screen.getByRole("combobox", { name: "Catalog section" }) as HTMLSelectElement;
    const groupLabels = Array.from(select.querySelectorAll("optgroup")).map((group) => group.label);
    const adapterOption = within(select).getByRole("option", { name: "Adapter readiness (Blocked)" });

    expect(select.value).toBe("import-promotion");
    expect(groupLabels).toEqual(["Primary workflow", "Unblock provider data", "Govern and recover"]);
    expect((adapterOption as HTMLOptionElement).disabled).toBe(true);
    expect(within(select).getByRole("option", { name: "Import to promotion (24)" })).toBeTruthy();

    fireEvent.change(select, { target: { value: "health" } });

    expect(onSelect).toHaveBeenCalledWith("health");
  });
});
