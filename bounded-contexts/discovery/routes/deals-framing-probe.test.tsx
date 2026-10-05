// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import fixture from "./deals-framing-fixture.json" with { type: "json" };
import DealsFramingProbeRoute from "./deals-framing-probe";

const PRODUCT =
  "cat_seed_pikachu_jungle::dim_seed_form:chc_seed_form_raw|dim_seed_condition:chc_seed_condition_excellent|dim_seed_grading_company:-|dim_seed_grade:-";

// Approved literals from the brief, plus fixture-derived values and the
// design-system internals the shipped primitives render on their own.
const APPROVED_STRINGS = new Set([
  "Deals",
  "Under market",
  "Over market",
  "Buy",
  "Sell",
  "Deal",
  "Product",
  "Price",
  "Benchmark",
  "Quantity",
  "Action",
  "Add to cart",
  "Add to Sell List",
  "+$0.30 · +1.67% above the median of $17.95",
  "+$0.05 · +0.28% above the median of $17.95",
  "$18.25 · median $17.95 · +1.67%",
  "$18.00 · median $17.95 · +0.28%",
  "No items found",
  "0 rows in the frozen #7898 Capture 3 fixture.",
  "Filters",
  "Sort",
  "Newest",
  "0 items selected",
]);
const FIXTURE_VALUES = new Set([PRODUCT, "$18.25", "$18.00", "4", "8"]);
const DESIGN_SYSTEM_INTERNALS = new Set(["Table data loaded"]);

function renderProbe(search: string) {
  const router = createMemoryRouter([{ path: "/deals-framing-probe", element: <DealsFramingProbeRoute /> }], {
    initialEntries: [`/deals-framing-probe${search}`],
  });
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}

function probeRoot(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>("[data-deals-probe-variant]");
  if (!root) throw new Error("probe root not rendered");
  return root;
}

function renderedStrings(container: HTMLElement) {
  const strings = new Set<string>();
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // <wbr> break opportunities split one string into several text nodes.
    const parent = node.parentElement;
    const source = parent && [...parent.children].every((child) => child.tagName === "WBR") ? parent : node;
    const text = source.textContent?.replace(/\s+/g, " ").trim();
    if (text) strings.add(text);
  }
  for (const element of container.querySelectorAll("[aria-label], [title], [placeholder], [alt]")) {
    for (const attribute of ["aria-label", "title", "placeholder", "alt"]) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) strings.add(value);
    }
  }
  return strings;
}

function headers(container: HTMLElement) {
  return [...container.querySelectorAll("th")].map((cell) => cell.textContent?.trim());
}

function mobileLabels(container: HTMLElement) {
  return [...container.querySelectorAll('[role="listitem"]')].map((card) =>
    [...card.querySelectorAll("dt")].map((label) => label.textContent?.trim()),
  );
}

function gapTexts(container: HTMLElement) {
  return [...container.querySelectorAll("table [data-deals-probe-gap]")].map((cell) => cell.textContent);
}

afterEach(() => {
  cleanup();
});

describe("deals framing fixture", () => {
  it("transcribes #7898 Capture 3 dollar-ungated boards without padding", () => {
    expect(fixture.source).toEqual({
      url: "https://github.com/chase-sets/chase-sets/issues/7898#issuecomment-5853527125",
      section: "Capture 3: Buy and Sell boards",
      environment: "staging (read-only transaction via platform-worker pod, host session)",
      capturedAt: "2026-09-27T06:49:32Z",
    });
    expect(fixture.medianWindow).toBeNull();
    expect(fixture.gatedBoards.map((board) => [board.name, board.totalRows])).toEqual([
      ["Buy dollar gated", 0],
      ["Sell dollar gated", 0],
    ]);
    expect(fixture.boards.buy).toMatchObject({ name: "Buy dollar ungated", totalRows: 0, completeness: "complete" });
    expect(fixture.boards.buy.rows).toEqual([]);
    expect(fixture.boards.sell).toMatchObject({ name: "Sell dollar ungated", totalRows: 2, completeness: "complete" });
    expect(
      fixture.boards.sell.rows.map((row) => [
        row.rank,
        row.product,
        row.price,
        row.benchmark,
        row.gapAmount,
        row.gapPercent,
        row.quantity,
        row.trades,
      ]),
    ).toEqual([
      [1, PRODUCT, "18.25", "17.95", "0.30", "1.6713091922005571", 4, 3],
      [2, PRODUCT, "18.00", "17.95", "0.05", "0.27855153203342618384", 8, 3],
    ]);
    expect(JSON.stringify(fixture)).not.toContain("30-day");
  });
});

describe("DealsFramingProbeRoute", () => {
  it("renders variant A Sell with the Deal badge, gap-led copy under Benchmark and Add to Sell List", () => {
    const { container } = renderProbe("?variant=a&side=sell");
    const root = probeRoot(container);

    expect(root.dataset).toMatchObject({ dealsProbeVariant: "a", dealsProbeSide: "sell", dealsProbeRowCount: "2" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Deals");
    expect(screen.getAllByRole("radio").map((segment) => segment.textContent)).toEqual(["Buy", "Sell"]);
    expect(screen.getByRole("radio", { name: "Sell" }).getAttribute("aria-checked")).toBe("true");
    expect(headers(container)).toEqual(["Product", "Price", "Benchmark", "Quantity", "Action"]);
    expect(mobileLabels(container)).toEqual([
      ["Product", "Price", "Benchmark", "Quantity", "Action"],
      ["Product", "Price", "Benchmark", "Quantity", "Action"],
    ]);
    expect(gapTexts(container)).toEqual([
      "+$0.30 · +1.67% above the median of $17.95",
      "+$0.05 · +0.28% above the median of $17.95",
    ]);
    const table = container.querySelector("table") as HTMLElement;
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))).toEqual([
      [PRODUCT, "$18.25", "Deal+$0.30 · +1.67% above the median of $17.95", "4", "Add to Sell List"],
      [PRODUCT, "$18.00", "Deal+$0.05 · +0.28% above the median of $17.95", "8", "Add to Sell List"],
    ]);
    for (const badge of table.querySelectorAll("[data-deals-probe-badge]")) {
      expect(badge.textContent).toBe("Deal");
      expect(badge.className).toContain("text-deal");
    }
  });

  it("renders variant B Sell with the neutral side badge and price-led copy under Price", () => {
    const { container } = renderProbe("?variant=b&side=sell");
    const root = probeRoot(container);

    expect(root.dataset).toMatchObject({ dealsProbeVariant: "b", dealsProbeSide: "sell", dealsProbeRowCount: "2" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Over market");
    expect(screen.getAllByRole("radio").map((segment) => segment.textContent)).toEqual(["Under market", "Over market"]);
    expect(headers(container)).toEqual(["Product", "Price", "Quantity", "Action"]);
    expect(mobileLabels(container)).toEqual([
      ["Product", "Price", "Quantity", "Action"],
      ["Product", "Price", "Quantity", "Action"],
    ]);
    expect(gapTexts(container)).toEqual(["$18.25 · median $17.95 · +1.67%", "$18.00 · median $17.95 · +0.28%"]);
    const table = container.querySelector("table") as HTMLElement;
    for (const badge of table.querySelectorAll("[data-deals-probe-badge]")) {
      expect(badge.textContent).toBe("Over market");
      expect(badge.className).not.toContain("deal");
      expect(badge.className).toContain("text-secondary");
    }
    expect(
      within(table)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Add to Sell List", "Add to Sell List"]);
  });

  it.each([
    ["a", "Deals", ["Buy", "Sell"]],
    ["b", "Under market", ["Under market", "Over market"]],
  ])("renders the actual empty Buy board under variant %s", (variant, title, segments) => {
    const { container } = renderProbe(`?variant=${variant}&side=buy`);
    const root = probeRoot(container);

    expect(root.dataset).toMatchObject({ dealsProbeVariant: variant, dealsProbeSide: "buy", dealsProbeRowCount: "0" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    expect(screen.getAllByRole("radio").map((segment) => segment.textContent)).toEqual(segments);
    expect(screen.getByText("No items found")).toBeTruthy();
    expect(screen.getByText("0 rows in the frozen #7898 Capture 3 fixture.")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-deals-probe-gap]")).toHaveLength(0);
  });

  it.each(["?variant=a&side=buy", "?variant=a&side=sell", "?variant=b&side=buy", "?variant=b&side=sell"])(
    "renders only approved, fixture or design-system strings and inert chrome for %s",
    (search) => {
      const { container } = renderProbe(search);
      const strings = renderedStrings(container);
      const unlisted = [...strings].filter(
        (value) => !APPROVED_STRINGS.has(value) && !FIXTURE_VALUES.has(value) && !DESIGN_SYSTEM_INTERNALS.has(value),
      );

      expect(unlisted).toEqual([]);
      expect([...strings].some((value) => value.includes("30-day"))).toBe(false);
      expect(screen.getByRole("heading", { level: 2, name: "Filters" })).toBeTruthy();
      expect(screen.getByText("0 items selected")).toBeTruthy();
      expect(container.textContent).toContain("Sort");
      expect(container.textContent).toContain("Newest");
    },
  );

  it("switches side through the query parameter without leaving the variant", () => {
    const { router } = renderProbe("?variant=b&side=buy");

    fireEvent.click(screen.getByRole("radio", { name: "Over market" }));

    expect(new URLSearchParams(router.state.location.search).get("side")).toBe("sell");
    expect(new URLSearchParams(router.state.location.search).get("variant")).toBe("b");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Over market");
  });
});
