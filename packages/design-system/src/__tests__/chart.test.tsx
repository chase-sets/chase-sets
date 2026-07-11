import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sparkline, TimeSeriesChart, type TimeSeriesSeries } from "../components/data-display/chart";
import { ChaseRoot } from "../theme/provider";

const motionElementCalls = vi.hoisted(
  () => [] as Array<{ tag: string; initial: unknown; animate: unknown; transition: unknown }>,
);

vi.mock("motion/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const motion = new Proxy(
    {},
    {
      get(_target, tag: string) {
        return React.forwardRef<Element, Record<string, unknown>>(function MotionElement(props, ref) {
          const { initial, animate, transition, whileHover, whileTap, layoutId, ...domProps } = props;
          motionElementCalls.push({ tag, initial, animate, transition });
          return React.createElement(tag, { ...domProps, ref });
        });
      },
    },
  );

  return {
    AnimatePresence({ children }: { children: ReactNode }) {
      return <>{children}</>;
    },
    MotionConfig({ children }: { children: ReactNode }) {
      return <>{children}</>;
    },
    motion,
  };
});

function renderWithRoot(node: ReactNode, reducedMotion: "always" | "never" = "never") {
  return render(<ChaseRoot reducedMotion={reducedMotion}>{node}</ChaseRoot>);
}

describe("Sparkline", () => {
  beforeEach(() => {
    motionElementCalls.length = 0;
  });

  it("renders a line and area path colored from design-system tone tokens, never raw colors", () => {
    const { container } = renderWithRoot(
      <Sparkline label="7-day price trend" data={[10, 12, 9, 15, 14]} tone="success" />,
    );

    const paths = [...container.querySelectorAll("path")];
    expect(paths.some((path) => path.getAttribute("class")?.includes("stroke-success"))).toBe(true);
    expect(paths.some((path) => path.getAttribute("class")?.includes("fill-success-soft"))).toBe(true);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(container.innerHTML).not.toMatch(/rgb\(/);
  });

  it("exposes an accessible name and a screen-reader summary sentence", () => {
    renderWithRoot(<Sparkline label="7-day price trend" data={[10, 12, 9, 15, 14]} />);

    const svg = screen.getByRole("img", { name: "7-day price trend" });
    const describedBy = svg.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const summary = document.getElementById(describedBy!);
    expect(summary?.textContent).toContain("5 data points");
    expect(summary?.textContent).toContain("trending up");
  });

  it("renders an insufficient-data state below the minimum sample count instead of a misleading line", () => {
    renderWithRoot(<Sparkline label="7-day price trend" data={[10]} />);

    const svg = screen.getByRole("img", { name: "7-day price trend" });
    expect(svg.querySelector("path")).toBeNull();
    expect(svg.querySelector("line")).not.toBeNull();
    const describedBy = svg.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toBe("Not enough data yet.");
  });

  it("renders an empty state distinct from the insufficient-data state", () => {
    renderWithRoot(<Sparkline label="7-day price trend" data={[]} />);

    const svg = screen.getByRole("img", { name: "7-day price trend" });
    const describedBy = svg.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toBe("No data yet.");
  });

  it("accepts copy-injected empty/insufficient labels instead of hardcoded English", () => {
    renderWithRoot(<Sparkline label="Tendance des prix" data={[]} emptyLabel="Pas encore de données." />);

    const svg = screen.getByRole("img", { name: "Tendance des prix" });
    const describedBy = svg.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toBe("Pas encore de données.");
  });

  it("honors reduced motion by rendering without an entrance animation", () => {
    renderWithRoot(<Sparkline label="7-day price trend" data={[10, 12, 9, 15, 14]} />, "always");

    const svgCall = motionElementCalls.find((call) => call.tag === "svg");
    expect(svgCall).toMatchObject({ initial: undefined, animate: undefined, transition: undefined });
  });

  it("animates the entrance when motion is allowed", () => {
    renderWithRoot(<Sparkline label="7-day price trend" data={[10, 12, 9, 15, 14]} />, "never");

    const svgCall = motionElementCalls.find((call) => call.tag === "svg");
    expect(svgCall?.initial).toMatchObject({ opacity: 0 });
    expect(svgCall?.animate).toMatchObject({ opacity: 1 });
  });
});

describe("TimeSeriesChart", () => {
  beforeEach(() => {
    motionElementCalls.length = 0;
  });

  const platformTrades: TimeSeriesSeries = {
    id: "platform-trades",
    name: "Platform trades",
    tone: "accent",
    points: [
      { timestamp: 1, value: 40, label: "Jul 1: $40.00" },
      { timestamp: 2, value: 42, label: "Jul 2: $42.00" },
      { timestamp: 3, value: 38, label: "Jul 3: $38.00" },
      { timestamp: 4, value: 45, label: "Jul 4: $45.00" },
    ],
    band: [
      { timestamp: 1, min: 36, max: 44 },
      { timestamp: 4, min: 40, max: 50 },
    ],
    markers: [{ timestamp: 2, value: 42, label: "Verified sale, $42.00, Jul 2" }],
  };

  const externalComps: TimeSeriesSeries = {
    id: "external-comps",
    name: "External comps",
    tone: "trust",
    curve: "step",
    points: [
      { timestamp: 1, value: 41 },
      { timestamp: 4, value: 44 },
    ],
  };

  it("renders one line per series, a band, and verified-sale markers using token classes", () => {
    const { container } = renderWithRoot(
      <TimeSeriesChart label="Price history" series={[platformTrades, externalComps]} />,
    );

    const lines = container.querySelectorAll("svg > path");
    // one band path + two series line paths
    expect(lines.length).toBe(3);
    expect(container.querySelector("circle")).not.toBeNull();
    expect(container.querySelector("circle title")?.textContent).toBe("Verified sale, $42.00, Jul 2");
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(container.innerHTML).not.toMatch(/rgb\(/);
  });

  it("renders a legend with series names when multiple series are present", () => {
    renderWithRoot(<TimeSeriesChart label="Price history" series={[platformTrades, externalComps]} />);

    expect(screen.getByText("Platform trades")).toBeTruthy();
    expect(screen.getByText("External comps")).toBeTruthy();
  });

  it("exposes an accessible chart name and a per-series screen-reader summary", () => {
    renderWithRoot(<TimeSeriesChart label="Price history" series={[platformTrades]} />);

    const svg = screen.getByRole("img", { name: "Price history" });
    const describedBy = svg.getAttribute("aria-describedby");
    const summary = document.getElementById(describedBy!)?.textContent ?? "";
    expect(summary).toContain("Platform trades: 4 points");
    expect(summary).toContain("Verified sale, $42.00, Jul 2");
  });

  it("renders the minimum-sample insufficient-data state instead of a misleading trend", () => {
    renderWithRoot(
      <TimeSeriesChart
        label="Price history"
        series={[{ id: "platform-trades", name: "Platform trades", points: [{ timestamp: 1, value: 40 }] }]}
      />,
    );

    expect(screen.getByText("Not enough data yet")).toBeTruthy();
    expect(screen.getByText("At least 2 data points are required to show a reliable trend.")).toBeTruthy();
  });

  it("renders a distinct empty state when a series has zero samples", () => {
    renderWithRoot(
      <TimeSeriesChart
        label="Price history"
        series={[{ id: "platform-trades", name: "Platform trades", points: [] }]}
      />,
    );

    expect(screen.getByText("No data yet")).toBeTruthy();
  });

  it("provides an integration point slot for a caller-supplied time-range selector", () => {
    renderWithRoot(
      <TimeSeriesChart
        label="Price history"
        series={[platformTrades]}
        title="Price history"
        rangeSelector={<button type="button">30D</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "30D" })).toBeTruthy();
  });

  it("scrolls instead of overflowing the page when a minimum chart width is set", () => {
    const { container } = renderWithRoot(
      <TimeSeriesChart label="Price history" series={[platformTrades]} minChartWidth={1200} />,
    );

    const scrollContainer = container.querySelector(".overflow-x-auto");
    expect(scrollContainer).not.toBeNull();
    const inner = scrollContainer!.firstElementChild as HTMLElement;
    expect(inner.style.minWidth).toBe("1200px");
  });

  it("honors reduced motion by rendering without an entrance animation", () => {
    renderWithRoot(<TimeSeriesChart label="Price history" series={[platformTrades]} />, "always");

    const svgCall = motionElementCalls.find((call) => call.tag === "svg");
    expect(svgCall).toMatchObject({ initial: undefined, animate: undefined, transition: undefined });
  });
});
