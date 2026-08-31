import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Eyebrow, MarketingImageHero, PageHeader } from "../index";

const accentClasses = "text-xs font-semibold uppercase text-accent";
const primaryClasses = "text-xs font-semibold uppercase tracking-wide text-primary";

/**
 * Type-only tripwire for the closed Eyebrow prop surface. The function is
 * never called — its value is the five `@ts-expect-error` refusals below,
 * verified by `pnpm run verify:typecheck`.
 */
function eyebrowRefusesEscapeHatches() {
  return [
    // @ts-expect-error — the class surface is closed; no `className` passthrough.
    <Eyebrow key="refuse-class" className="text-sm" />,
    // @ts-expect-error — the class surface is closed; no `style` passthrough.
    <Eyebrow key="refuse-style" style={{ margin: 0 }} />,
    // @ts-expect-error — Eyebrow is not polymorphic; no `as` prop.
    <Eyebrow key="refuse-as" as="span" />,
    // @ts-expect-error — Eyebrow is not polymorphic; no `render` prop.
    <Eyebrow key="refuse-render" render={<span />} />,
    // @ts-expect-error — Eyebrow is not polymorphic; no `element` prop.
    <Eyebrow key="refuse-element" element="span" />,
  ];
}

describe("Eyebrow contract", () => {
  it("keeps the negative type fixture referenced so it is not tree-shaken or deleted as dead code", () => {
    expect(typeof eyebrowRefusesEscapeHatches).toBe("function");
  });

  it("renders the accent variant with the frozen PageHeader treatment", () => {
    render(<Eyebrow variant="accent">Marketplace</Eyebrow>);

    expect(screen.getByText("Marketplace").className).toBe(accentClasses);
  });

  it("renders the primary variant with the frozen MarketingImageHero treatment", () => {
    render(<Eyebrow variant="primary">Featured drop</Eyebrow>);

    expect(screen.getByText("Featured drop").className).toBe(primaryClasses);
  });

  it("defaults the omitted variant to accent on a rendered div", () => {
    render(<Eyebrow>Sealed product</Eyebrow>);

    const eyebrow = screen.getByText("Sealed product");

    expect(eyebrow.className).toBe(accentClasses);
    expect(eyebrow.tagName).toBe("DIV");
  });

  it("forwards native div props per the typography family convention", () => {
    render(
      <Eyebrow id="listing-eyebrow" aria-label="Listing kicker" data-qa="eyebrow">
        Graded slabs
      </Eyebrow>,
    );

    const eyebrow = screen.getByText("Graded slabs");

    expect(eyebrow.id).toBe("listing-eyebrow");
    expect(eyebrow.getAttribute("aria-label")).toBe("Listing kicker");
    expect(eyebrow.getAttribute("data-qa")).toBe("eyebrow");
  });
});

describe("Eyebrow adoption sites render the frozen class output byte-for-byte", () => {
  it("keeps the PageHeader eyebrow at the accent treatment", () => {
    render(<PageHeader eyebrow="Orders" title="Open orders" />);

    const eyebrow = screen.getByText("Orders");

    expect(eyebrow.tagName).toBe("DIV");
    expect(eyebrow.className).toBe(accentClasses);
  });

  it("keeps the MarketingImageHero eyebrow at the primary treatment", () => {
    render(<MarketingImageHero imageSrc="/hero.png" imageAlt="" title="Chase the set" eyebrow="New season" />);

    const eyebrow = screen.getByText("New season");

    expect(eyebrow.tagName).toBe("DIV");
    expect(eyebrow.className).toBe(primaryClasses);
  });
});

describe("residual inline eyebrow inventory", () => {
  const patternsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "patterns");
  const inlinePattern = "text-xs font-semibold uppercase";

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  function collectPatternFiles(directory: string, prefix = ""): Map<string, string> {
    const sources = new Map<string, string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        for (const [childPath, content] of collectPatternFiles(join(directory, entry.name), relativePath)) {
          sources.set(childPath, content);
        }
        continue;
      }
      sources.set(relativePath, readFileSync(join(directory, entry.name), "utf8"));
    }
    return sources;
  }

  it("keeps exactly the eight enumerated survivors and no inline treatment at either adoption site", () => {
    const sources = collectPatternFiles(patternsRoot);
    const counts = new Map<string, number>();
    for (const [relativePath, content] of sources) {
      const occurrences = countOccurrences(content, inlinePattern);
      if (occurrences > 0) {
        counts.set(relativePath, occurrences);
      }
    }

    expect(Object.fromEntries([...counts.entries()].sort())).toEqual({
      "app-shells/marketing.tsx": 3,
      "app-shells/product-detail.tsx": 2,
      "dense-admin-workbench.tsx": 3,
    });
    expect([...counts.values()].reduce((total, value) => total + value, 0)).toBe(8);
    expect(countOccurrences(sources.get("app-shells/page-layouts.tsx") ?? "", accentClasses)).toBe(0);
    expect(countOccurrences(sources.get("app-shells/marketing.tsx") ?? "", primaryClasses)).toBe(0);
  });
});

describe("README Prop Vocabulary entry", () => {
  it("commits the exact Eyebrow line", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    const vocabularySection = readme.slice(readme.indexOf("## Prop Vocabulary"));
    const committedLine =
      "- `Eyebrow` is the uppercase kicker above a heading: `variant` is the closed vocabulary `accent | primary` (default `accent`) naming the frozen per-site treatment, it always renders a `div`, and it accepts no `className`, `style`, or polymorphic `as`/`render`/`element` props.";

    expect(vocabularySection.split("\n")).toContain(committedLine);
  });
});
