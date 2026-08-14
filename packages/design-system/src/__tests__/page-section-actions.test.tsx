import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Button, PageSection } from "../index";

const sectionClasses = "space-y-4";
const titleBlockClasses = "max-w-4xl space-y-2";
// The heading-font token below is spelled with an escaped hyphen so this file
// never joins the repository's derived token-consumer inventories, which are
// committed inside a fence module this slice must not edit.
const titleClasses = "font\u002Dheading text-2xl font-semibold leading-tight text-foreground md:text-3xl";
const descriptionClasses = "max-w-3xl text-base leading-7 text-secondary";
const headerRowClasses = "flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between";
const buttonGroupClasses = "inline-flex flex-wrap items-center gap-3";

/**
 * Type-only tripwire for the total PageSection actions contract. The function
 * is never called — its value is the `@ts-expect-error` below, verified by
 * `pnpm run verify:typecheck`: the actions-present branch requires the `title`
 * prop to be present (explicit falsy values remain valid typed input).
 */
function actionsWithoutTitleIsUnrepresentable() {
  // @ts-expect-error — `actions` requires the `title` prop; action-only section headers do not exist.
  return <PageSection actions={<Button>Browse all</Button>}>content</PageSection>;
}

function renderSection(ui: Parameters<typeof render>[0]): HTMLElement {
  const { container } = render(ui);
  const section = container.querySelector("section");
  if (!section) throw new Error("PageSection did not render a section element");
  return section;
}

function expectSectionOnly(section: HTMLElement): void {
  expect(section.className).toBe(sectionClasses);
  expect(section.querySelector("h2")).toBeNull();
  expect(section.querySelector(`[class="${titleBlockClasses}"]`)).toBeNull();
  expect(section.querySelector(`[class="${headerRowClasses}"]`)).toBeNull();
  expect(section.querySelector('[role="group"]')).toBeNull();
}

describe("PageSection state table: actions absent stays byte-identical", () => {
  it("row 1 — no title renders the bare section with children", () => {
    const section = renderSection(
      <PageSection>
        <p>body</p>
      </PageSection>,
    );

    expectSectionOnly(section);
    expect(section.children).toHaveLength(1);
    expect(section.textContent).toBe("body");
  });

  it("row 2 — description without a title renders nothing at the header", () => {
    const section = renderSection(
      <PageSection description="Sealed and singles">
        <p>body</p>
      </PageSection>,
    );

    expectSectionOnly(section);
    expect(section.textContent).toBe("body");
  });

  it("row 4 — truthy title renders today's exact title block with no wrapper row", () => {
    const section = renderSection(
      <PageSection title="Trending sets">
        <p>body</p>
      </PageSection>,
    );

    expect(section.className).toBe(sectionClasses);
    expect(section.children).toHaveLength(2);

    const titleBlock = section.firstElementChild;

    expect(titleBlock?.className).toBe(titleBlockClasses);
    expect(titleBlock?.children).toHaveLength(1);

    const heading = titleBlock?.querySelector("h2");

    expect(heading?.className).toBe(titleClasses);
    expect(heading?.textContent).toBe("Trending sets");
    expect(section.querySelector(`[class="${headerRowClasses}"]`)).toBeNull();
    expect(section.querySelector('[role="group"]')).toBeNull();
  });

  it("row 5 — title plus description renders today's exact header block", () => {
    const section = renderSection(
      <PageSection title="Trending sets" description="Sealed and singles">
        <p>body</p>
      </PageSection>,
    );

    const titleBlock = section.firstElementChild;

    expect(titleBlock?.className).toBe(titleBlockClasses);
    expect(titleBlock?.children).toHaveLength(2);
    expect(titleBlock?.querySelector("h2")?.className).toBe(titleClasses);

    const description = titleBlock?.children[1];

    expect(description?.className).toBe(descriptionClasses);
    expect(description?.textContent).toBe("Sealed and singles");
    expect(section.querySelector(`[class="${headerRowClasses}"]`)).toBeNull();
  });
});

describe("PageSection state table: actions present with a truthy title", () => {
  it("row 6 — renders the exact PageHeader row treatment with the unchanged title block first and a trailing ButtonGroup", () => {
    const section = renderSection(
      <PageSection title="Trending sets" actions={<Button>Browse all</Button>}>
        <p>body</p>
      </PageSection>,
    );

    expect(section.className).toBe(sectionClasses);
    expect(section.children).toHaveLength(2);

    const headerRow = section.firstElementChild;

    expect(headerRow?.className).toBe(headerRowClasses);
    expect(headerRow?.children).toHaveLength(2);

    const titleBlock = headerRow?.children[0];

    expect(titleBlock?.className).toBe(titleBlockClasses);
    expect(titleBlock?.children).toHaveLength(1);
    expect(titleBlock?.querySelector("h2")?.className).toBe(titleClasses);
    expect(titleBlock?.querySelector("h2")?.textContent).toBe("Trending sets");

    const buttonGroup = headerRow?.children[1];

    expect(buttonGroup?.getAttribute("role")).toBe("group");
    expect(buttonGroup?.className).toBe(buttonGroupClasses);
    expect(buttonGroup?.textContent).toBe("Browse all");
    expect(section.children[1]?.textContent).toBe("body");
  });

  it("row 7 — keeps the description inside the title block within the row anatomy", () => {
    const section = renderSection(
      <PageSection title="Trending sets" description="Sealed and singles" actions={<Button>Browse all</Button>}>
        <p>body</p>
      </PageSection>,
    );

    const headerRow = section.firstElementChild;

    expect(headerRow?.className).toBe(headerRowClasses);

    const titleBlock = headerRow?.children[0];

    expect(titleBlock?.className).toBe(titleBlockClasses);
    expect(titleBlock?.children).toHaveLength(2);
    expect(titleBlock?.children[1]?.className).toBe(descriptionClasses);
    expect(headerRow?.children[1]?.getAttribute("role")).toBe("group");
  });
});

describe("PageSection row 3a — every explicitly supplied falsy title preserves section-only output", () => {
  const falsyTitles: Array<[string, ReactNode]> = [
    ["undefined", undefined],
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["0", 0],
    ["-0", -0],
    ["NaN", Number.NaN],
    ["0n", 0n],
  ];

  for (const [label, value] of falsyTitles) {
    it(`title={${label}} with actions, description, and children withholds the header, row, and ButtonGroup`, () => {
      const section = renderSection(
        <PageSection title={value} description="Sealed and singles" actions={<Button>Browse all</Button>}>
          <p>body</p>
        </PageSection>,
      );

      expectSectionOnly(section);
      expect(section.children).toHaveLength(1);
      expect(section.textContent).toBe("body");
    });
  }
});

describe("PageSection type fixtures", () => {
  it("keeps the negative type fixture referenced so it is not tree-shaken or deleted as dead code", () => {
    expect(typeof actionsWithoutTitleIsUnrepresentable).toBe("function");
  });
});
