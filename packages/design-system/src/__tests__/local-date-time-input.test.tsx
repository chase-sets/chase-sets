import { act, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDateTimeInput, instantToLocalDateTime, localDateTimeToInstant } from "../components/forms";
import { ChaseRoot } from "../theme/provider";

function renderInRoot(ui: ReactNode) {
  return render(<ChaseRoot>{ui}</ChaseRoot>);
}

// The operator's zone is the runtime's; these run as a browser in Chicago.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  process.env.TZ = zone;
});

describe("localDateTimeToInstant", () => {
  it("reads the wall-clock time in the runtime's zone", () => {
    expect(localDateTimeToInstant("2026-11-10T09:00")).toBe("2026-11-10T15:00:00.000Z");
    expect(localDateTimeToInstant("2026-07-10T09:00:30")).toBe("2026-07-10T14:00:30.000Z");
  });

  it("is empty for a value that is not a time the operator could have meant", () => {
    expect(localDateTimeToInstant("")).toBe("");
    expect(localDateTimeToInstant("tomorrow")).toBe("");
    expect(localDateTimeToInstant("2026-02-30T09:00")).toBe("");
    // Clocks in Chicago skip from 2:00 to 3:00 that morning.
    expect(localDateTimeToInstant("2026-03-08T02:30")).toBe("");
  });
});

describe("instantToLocalDateTime", () => {
  it("shows the instant in the runtime's zone", () => {
    expect(instantToLocalDateTime("2026-11-10T15:00:00.000Z")).toBe("2026-11-10T09:00");
    expect(instantToLocalDateTime("not a time")).toBe("");
  });
});

describe("LocalDateTimeInput", () => {
  function fields(container: HTMLElement) {
    return {
      shown: container.querySelector<HTMLInputElement>('input[name="startsAtLocal"]')!,
      sent: container.querySelector<HTMLInputElement>('input[name="startsAt"]')!,
    };
  }

  it("shows the saved instant in the operator's zone and sends it unchanged", async () => {
    const { container } = renderInRoot(
      <LocalDateTimeInput name="startsAt" label="Starts at" defaultInstant="2026-11-10T15:00:00.000Z" />,
    );
    await act(async () => {});
    const { shown, sent } = fields(container);

    expect(shown.type).toBe("datetime-local");
    expect(shown.value).toBe("2026-11-10T09:00");
    expect(sent.type).toBe("hidden");
    expect(sent.value).toBe("2026-11-10T15:00:00.000Z");
  });

  it("sends the instant the operator typed, or nothing for a time it cannot read", async () => {
    const { container } = renderInRoot(<LocalDateTimeInput name="startsAt" label="Starts at" required />);
    await act(async () => {});
    const { shown, sent } = fields(container);
    expect(sent.value).toBe("");

    fireEvent.change(shown, { target: { value: "2026-11-10T09:00" } });
    expect(sent.value).toBe("2026-11-10T15:00:00.000Z");

    fireEvent.change(shown, { target: { value: "" } });
    expect(sent.value).toBe("");
  });
});
