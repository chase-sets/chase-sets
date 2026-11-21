import { act, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LocalDateTime } from "../components/data-display";

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  process.env.TZ = zone;
});

describe("LocalDateTime", () => {
  it("is written in UTC on the server, which does not know the reader's zone", () => {
    expect(renderToString(<LocalDateTime value="2026-11-10T15:00:00.000Z" />)).toBe(
      '<time dateTime="2026-11-10T15:00:00.000Z">Nov 10, 2026, 3:00 PM UTC</time>',
    );
  });

  it("is written in the reader's zone once it hydrates, in a sentence when given one", async () => {
    const { container } = render(
      <LocalDateTime value="2026-11-10T15:00:00.000Z">{(text) => `Scheduled for ${text}`}</LocalDateTime>,
    );
    await act(async () => {});

    expect(container.textContent).toBe("Scheduled for Nov 10, 2026, 9:00 AM CST");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-10T15:00:00.000Z");
  });

  it("writes a value that is not an instant as its fallback", () => {
    const { container } = render(<LocalDateTime value="soon" fallback="Not set" />);

    expect(container.textContent).toBe("Not set");
  });
});
