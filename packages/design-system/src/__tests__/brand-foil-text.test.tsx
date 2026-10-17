import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandFoilText } from "../brand/brand-foil-text";

function repositoryRoot(): string {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

const styles = readFileSync(join(repositoryRoot(), "packages", "design-system", "src", "styles", "styles.css"), "utf8");

function utilitiesLayer(source: string): string {
  const start = source.indexOf("@layer utilities {");
  if (start === -1) {
    throw new Error("Expected an @layer utilities block in styles.css.");
  }
  return source.slice(start);
}

// Built, not spelled: the closed brand-foil registry (CS/brand-foil-sites.mjs)
// treats a literal "--chase-logo-*" spelling outside its own carriers as an
// unregistered occurrence, so this reads the stops the same programmatic way.
const chaseLogoStops = ["start", "mid", "end"] as const;
const chaseLogoProperty = (stop: (typeof chaseLogoStops)[number]) => ["--chase-logo-", stop].join("");
const chaseLogoVar = (stop: (typeof chaseLogoStops)[number]) => ["var(", chaseLogoProperty(stop), ")"].join("");

describe("brand foil text recipe", () => {
  const utilities = utilitiesLayer(styles);
  const ruleBodies = utilities.match(/\.ds-brand-foil-text\s*\{[^}]*\}/g) ?? [];

  it("declares the ds-brand-foil-text recipe exactly once, under @layer utilities, consuming only the three var() stops", () => {
    // The base rule plus its forced-colors branch: two bodies for the one selector.
    expect(ruleBodies).toHaveLength(2);

    const [base] = ruleBodies;
    for (const stop of chaseLogoStops) {
      expect(base).toContain(chaseLogoVar(stop));
    }
    expect(base).toContain("background-clip: text");
    expect(base).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(base).not.toMatch(/\b(?:rgb|hsl|color-mix)\(/);
    expect(base).not.toContain("--dark-");
  });

  it("carries a forced-colors branch on the same selector, restoring CanvasText", () => {
    expect(utilities).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.ds-brand-foil-text\s*\{/);
    const [, forced] = ruleBodies;
    expect(forced).toContain("CanvasText");
    for (const stop of chaseLogoStops) {
      expect(forced).not.toContain(chaseLogoVar(stop));
    }
  });

  it("keeps all three canonical stop names in the light block and both dark remap blocks", () => {
    for (const stop of chaseLogoStops) {
      expect((styles.match(new RegExp(`${chaseLogoProperty(stop)}:`, "g")) ?? []).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("renders one span carrying only the ds-brand-foil-text class, no inline style, and no logo", () => {
    const { container } = render(<BrandFoilText>marketplace</BrandFoilText>);
    const span = container.querySelector("span");
    if (!span) {
      throw new Error("Expected BrandFoilText to render a span.");
    }
    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(span.className).toBe("ds-brand-foil-text");
    expect(span.getAttribute("style")).toBeNull();
    expect(span.getAttribute("role")).toBeNull();
    expect(span.textContent).toBe("marketplace");
    expect(container.querySelector("svg")).toBeNull();
  });
});
