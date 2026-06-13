import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Calendar, DatePicker } from "../components/forms";
import { ChaseRoot } from "../theme/provider";

function renderInRoot(ui: ReactNode) {
  return render(<ChaseRoot>{ui}</ChaseRoot>);
}

async function expectFocusedDay(name: string) {
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name })));
}

describe("Calendar", () => {
  it("renders a labelled month grid with weekday column headers", () => {
    renderInRoot(<Calendar value="2026-06-15" aria-label="Choose date" />);

    const grid = screen.getByRole("grid", { name: "Choose date" });
    expect(grid).toBeTruthy();

    const headers = within(grid).getAllByRole("columnheader");
    expect(headers).toHaveLength(7);
    expect(headers[0]?.getAttribute("aria-label")).toBe("Sunday");
    expect(headers[6]?.getAttribute("aria-label")).toBe("Saturday");
  });

  it("gives each day an accessible name and marks the selected day", () => {
    renderInRoot(<Calendar value="2026-06-15" aria-label="Choose date" />);

    const selectedDay = screen.getByRole("button", { name: "Monday, June 15, 2026" });
    expect(selectedDay.getAttribute("aria-pressed")).toBe("true");
    expect(selectedDay.getAttribute("tabindex")).toBe("0");
  });

  it("moves focus with arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderInRoot(<Calendar value="2026-06-15" aria-label="Choose date" onValueChange={onValueChange} />);

    const selectedDay = screen.getByRole("button", { name: "Monday, June 15, 2026" });
    selectedDay.focus();
    expect(document.activeElement).toBe(selectedDay);

    await user.keyboard("{ArrowRight}");
    await expectFocusedDay("Tuesday, June 16, 2026");

    await user.keyboard("{ArrowDown}");
    await expectFocusedDay("Tuesday, June 23, 2026");

    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("2026-06-23");
  });

  it("navigates months with PageDown and Home jumps to the start of the week", async () => {
    const user = userEvent.setup();
    renderInRoot(<Calendar value="2026-06-15" aria-label="Choose date" />);

    screen.getByRole("button", { name: "Monday, June 15, 2026" }).focus();
    await user.keyboard("{PageDown}");
    await expectFocusedDay("Wednesday, July 15, 2026");

    await user.keyboard("{Home}");
    await expectFocusedDay("Sunday, July 12, 2026");
  });
});

describe("DatePicker", () => {
  it("opens a calendar popover from the trigger and selects a date", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    renderInRoot(<DatePicker label="Ship by" value="2026-06-15" onValueChange={onValueChange} />);

    const trigger = screen.getByRole("button", { name: /ship by/i });
    await user.click(trigger);

    const day = await screen.findByRole("button", { name: "Wednesday, June 10, 2026" });
    await user.click(day);

    expect(onValueChange).toHaveBeenCalledWith("2026-06-10");
    await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  });

  it("tracks selection internally when uncontrolled and submits an ISO value", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [submitted, setSubmitted] = useState<string | null>(null);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(String(new FormData(event.currentTarget).get("ship_by")));
          }}
        >
          <DatePicker label="Ship by" name="ship_by" defaultValue="2026-06-01" />
          <button type="submit">Save</button>
          <output>{submitted ?? "none"}</output>
        </form>
      );
    }

    renderInRoot(<Harness />);

    await user.click(screen.getByRole("button", { name: /ship by/i }));
    await user.click(await screen.findByRole("button", { name: "Friday, June 5, 2026" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("2026-06-05")).toBeTruthy();
  });

  it("wires FieldChrome error state into the trigger and exposes the alert", () => {
    renderInRoot(<DatePicker label="Ship by" error="Pick a valid date." />);

    const trigger = screen.getByRole("button", { name: /ship by/i });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Pick a valid date.");
    expect(trigger.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("renders the placeholder when no value is selected", () => {
    renderInRoot(<DatePicker label="Ship by" placeholder="Choose a ship date" />);

    expect(screen.getByText("Choose a ship date")).toBeTruthy();
  });
});
