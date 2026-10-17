import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HTMLAttributes } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DataTable,
  Heading,
  KeyValueList,
  MarketplaceDashboardPanel,
  NumericValue,
  type NumericValueProps,
  PriceBreakdown,
  Text,
} from "../index";

/**
 * The entire emitted class string of the role carrier: the mono face plus
 * tabular figures, and nothing that competes with the owner's typography.
 */
const roleClasses = "font-mono tabular-nums";

/** Any size, weight, tone, line-height, alignment, truncation, or clamp utility. */
const competingTypographyPattern =
  /(^|\s)(text-(xs|sm|base|lg|xl|\dxl|left|right|center|foreground|secondary|tertiary|accent)|font-(normal|medium|semibold|bold)|leading-\S+|truncate|line-clamp-\d+)(\s|$)/;

/**
 * Type-only tripwire for the closed NumericValue prop surface. The function is
 * never called — its value is the five `@ts-expect-error` refusals below,
 * verified by `pnpm run verify:typecheck`.
 */
function numericValueRefusesEscapeHatches() {
  return [
    // @ts-expect-error — the class surface is closed; no `className` passthrough.
    <NumericValue key="refuse-class" className="text-sm">
      $1.00
    </NumericValue>,
    // @ts-expect-error — the class surface is closed; no `style` passthrough.
    <NumericValue key="refuse-style" style={{ margin: 0 }}>
      $1.00
    </NumericValue>,
    // @ts-expect-error — NumericValue is not polymorphic; no `as` prop.
    <NumericValue key="refuse-as" as="div">
      $1.00
    </NumericValue>,
    // @ts-expect-error — NumericValue is not polymorphic; no `render` prop.
    <NumericValue key="refuse-render" render={<div />}>
      $1.00
    </NumericValue>,
    // @ts-expect-error — NumericValue is not polymorphic; no `element` prop.
    <NumericValue key="refuse-element" element="div">
      $1.00
    </NumericValue>,
  ];
}

/**
 * Type-level proof that `NumericValueProps` adds no member of its own beyond
 * the span attribute type with `className` and `style` omitted.
 */
type SpanAttributesWithoutClassSurface = Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style">;
type ExtraNumericValueMembers = Exclude<keyof NumericValueProps, keyof SpanAttributesWithoutClassSurface>;
const numericValueDeclaresNoExtraMember: [ExtraNumericValueMembers] extends [never] ? true : false = true;

function classNameOf(element: Element | null | undefined): string {
  expect(element).not.toBeNull();
  return (element as Element).className;
}

describe("NumericValue contract", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the negative type fixture referenced so it is not tree-shaken or deleted as dead code", () => {
    expect(typeof numericValueRefusesEscapeHatches).toBe("function");
    expect(numericValueDeclaresNoExtraMember).toBe(true);
  });

  it("renders a span whose entire class string is the mono face plus tabular figures", () => {
    render(<NumericValue>$12.50</NumericValue>);

    const value = screen.getByText("$12.50");

    expect(value.tagName).toBe("SPAN");
    expect(value.className).toBe(roleClasses);
    expect(value.className).not.toMatch(competingTypographyPattern);
  });

  it("forwards native span props per the typography family convention", () => {
    render(
      <NumericValue id="net-payout" aria-label="Net payout" data-qa="numeric-value">
        $79.00
      </NumericValue>,
    );

    const value = screen.getByText("$79.00");

    expect(value.id).toBe("net-payout");
    expect(value.getAttribute("aria-label")).toBe("Net payout");
    expect(value.getAttribute("data-qa")).toBe("numeric-value");
    expect(value.className).toBe(roleClasses);
  });
});

describe("NumericValue is typography-neutral at every production parent shape", () => {
  afterEach(() => {
    cleanup();
  });

  it("MarketplaceDashboardPanel metric value keeps the owner scale and weight", () => {
    render(<MarketplaceDashboardPanel title="Wallet" metrics={[{ label: "Available", value: "$125.00" }]} />);
    const bareOwner = classNameOf(screen.getByText("$125.00"));
    cleanup();

    render(
      <MarketplaceDashboardPanel
        title="Wallet"
        metrics={[{ label: "Available", value: <NumericValue>$125.00</NumericValue> }]}
      />,
    );
    const carrier = screen.getByText("$125.00");

    expect(bareOwner).toBe("text-2xl font-bold tabular-nums text-foreground");
    expect(classNameOf(carrier.parentElement)).toBe(bareOwner);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.className).toBe(roleClasses);
  });

  it("KeyValueList value keeps the owner scale", () => {
    render(<KeyValueList items={[{ key: "Amount", value: "$40.00" }]} />);
    const bareOwner = classNameOf(screen.getByText("$40.00"));
    cleanup();

    render(<KeyValueList items={[{ key: "Amount", value: <NumericValue>$40.00</NumericValue> }]} />);
    const carrier = screen.getByText("$40.00");

    expect(bareOwner).toBe("min-w-0 text-sm text-foreground text-left break-words");
    expect(carrier.parentElement?.tagName).toBe("DD");
    expect(classNameOf(carrier.parentElement)).toBe(bareOwner);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.className).toBe(roleClasses);
  });

  it("DataTable desktop cell and mobile card value keep the owner typography", () => {
    type Row = { amount: string };
    const rows: Row[] = [{ amount: "$12.21" }];
    const bareColumns = [{ key: "amount", header: "Net payout", cell: (row: Row) => row.amount }];
    const roledColumns = [
      { key: "amount", header: "Net payout", cell: (row: Row) => <NumericValue>{row.amount}</NumericValue> },
    ];

    render(<DataTable rows={rows} columns={bareColumns} />);
    const bareCells = screen.getAllByText("$12.21");
    const bareDesktop = bareCells.find((cell) => cell.tagName === "TD");
    const bareMobile = bareCells.find((cell) => cell.tagName === "DD");
    const bareDesktopOwner = classNameOf(bareDesktop);
    const bareMobileOwner = classNameOf(bareMobile);
    cleanup();

    render(<DataTable rows={rows} columns={roledColumns} />);
    const carriers = screen.getAllByText("$12.21");
    const desktopCarrier = carriers.find((carrier) => carrier.closest("td") !== null);
    const mobileCarrier = carriers.find((carrier) => carrier.closest("dd") !== null);

    expect(bareDesktopOwner).toBe("px-4 py-3 text-foreground");
    expect(bareMobileOwner).toBe("max-w-[75%] text-right text-sm text-foreground");
    expect(carriers).toHaveLength(2);
    expect(classNameOf(desktopCarrier?.parentElement)).toBe(bareDesktopOwner);
    expect(classNameOf(mobileCarrier?.parentElement)).toBe(bareMobileOwner);
    for (const carrier of carriers) {
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.className).toBe(roleClasses);
    }
  });

  it("DataTable right-aligned desktop cell keeps its alignment on the owner", () => {
    type Row = { amount: string };
    const rows: Row[] = [{ amount: "$0.29" }];

    render(
      <DataTable
        rows={rows}
        columns={[{ key: "fee", header: "Fee", align: "right", cell: (row: Row) => row.amount }]}
      />,
    );
    const bareOwner = classNameOf(screen.getAllByText("$0.29").find((cell) => cell.tagName === "TD"));
    cleanup();

    render(
      <DataTable
        rows={rows}
        columns={[
          {
            key: "fee",
            header: "Fee",
            align: "right",
            cell: (row: Row) => <NumericValue>{row.amount}</NumericValue>,
          },
        ]}
      />,
    );
    const carrier = screen.getAllByText("$0.29").find((value) => value.closest("td") !== null);

    expect(bareOwner).toBe("px-4 py-3 text-foreground text-right");
    expect(classNameOf(carrier?.parentElement)).toBe(bareOwner);
    expect(carrier?.className).toBe(roleClasses);
  });

  it("PriceBreakdown line value keeps the owner weight", () => {
    render(<PriceBreakdown lines={[{ label: "Requested amount", value: "$80.00" }]} total="$79.00" />);
    const bareOwner = classNameOf(screen.getByText("$80.00"));
    cleanup();

    render(
      <PriceBreakdown
        lines={[{ label: "Requested amount", value: <NumericValue>$80.00</NumericValue> }]}
        total="$79.00"
      />,
    );
    const carrier = screen.getByText("$80.00");

    expect(bareOwner).toBe("font-semibold tabular-nums text-foreground");
    expect(classNameOf(carrier.parentElement)).toBe(bareOwner);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.className).toBe(roleClasses);
  });

  it.each([
    ["charge-grade", false],
    ["deferred", true],
  ])("PriceBreakdown %s total keeps the owner scale, weight, and tone", (_label, deferred) => {
    render(<PriceBreakdown lines={[]} total="$79.00" deferred={deferred} />);
    const bareOwner = classNameOf(screen.getByText("$79.00"));
    cleanup();

    render(<PriceBreakdown lines={[]} total={<NumericValue>$79.00</NumericValue>} deferred={deferred} />);
    const carrier = screen.getByText("$79.00");

    expect(bareOwner).toContain("tabular-nums");
    expect(bareOwner).toMatch(competingTypographyPattern);
    expect(classNameOf(carrier.parentElement)).toBe(bareOwner);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.className).toBe(roleClasses);
  });

  it("Heading level 2 at visual size 4 keeps its own heading classes on the h2, proven differentially", () => {
    render(
      <Heading level={2} visualSize={4}>
        $22.00
      </Heading>,
    );
    const bareHeading = screen.getByRole("heading", { level: 2 });
    const bareOwner = bareHeading.className;
    cleanup();

    render(
      <Heading level={2} visualSize={4}>
        <NumericValue>$22.00</NumericValue>
      </Heading>,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    const carrier = screen.getByText("$22.00");

    expect(bareOwner).not.toBe("");
    expect(bareOwner).toMatch(competingTypographyPattern);
    expect(heading.className).toBe(bareOwner);
    expect(heading.className).not.toContain("font-mono");
    expect(carrier.parentElement).toBe(heading);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.className).toBe(roleClasses);
  });

  it("secondary copy keeps its size and tone around an inline amount", () => {
    render(
      <Text size="sm" tone="secondary">
        Fee $1.00
      </Text>,
    );
    const bareOwner = classNameOf(screen.getByText("Fee $1.00"));
    cleanup();

    render(
      <Text size="sm" tone="secondary">
        Fee <NumericValue>$1.00</NumericValue>
      </Text>,
    );
    const carrier = screen.getByText("$1.00");

    expect(bareOwner).toBe("leading-relaxed text-sm text-secondary font-normal");
    expect(classNameOf(carrier.parentElement)).toBe(bareOwner);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.className).toBe(roleClasses);
  });
});

describe("README Prop Vocabulary entry", () => {
  it("commits the exact NumericValue line", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    const vocabularySection = readme.slice(readme.indexOf("## Prop Vocabulary"));
    const committedLine =
      "- `NumericValue` is the closed inline role carrier for prices and market data: it always renders a `span`, its entire class string is the mono face plus tabular figures, it inherits the owner's size, weight, tone, and line height, and it accepts no `className`, `style`, or polymorphic `as`/`render`/`element` props.";

    expect(vocabularySection.split("\n")).toContain(committedLine);
  });
});
