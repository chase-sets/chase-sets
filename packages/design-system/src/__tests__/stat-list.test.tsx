import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatList, StatListItem, Text } from "../index";

afterEach(() => {
  cleanup();
});

describe("StatList", () => {
  it("lists each stat as a term with its value and detail, not as a heading", () => {
    const { container } = render(
      <StatList columns={{ base: 1, lg: 4 }} aria-label="Market stats">
        <StatListItem label="Last sold" value="$44.50" detail={<Text size="sm">Aug 14, 2026</Text>} />
        <StatListItem label="Active listings" value={3} />
      </StatList>,
    );

    const list = screen.getByLabelText("Market stats");
    expect(list.tagName).toBe("DL");
    expect(list.className).toContain("lg:grid-cols-4");
    expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);

    const items = [...list.children].map((item) =>
      [...item.children].map((child) => [child.tagName, child.textContent]),
    );
    expect(items).toEqual([
      [
        ["DT", "Last sold"],
        ["DD", "$44.50"],
        ["DD", "Aug 14, 2026"],
      ],
      [
        ["DT", "Active listings"],
        ["DD", "3"],
      ],
    ]);
  });
});
