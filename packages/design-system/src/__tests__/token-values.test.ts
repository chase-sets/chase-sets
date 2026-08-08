import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chaseTheme } from "../theme/tokens";

// Ink & Foil re-foundation guard (#6015).
//
// This suite owns three separable claims about packages/design-system/src/styles/styles.css:
//
//   AC-01  every *ratified anchor* equals its value character-for-character;
//   AC-02  every re-valued property that carries no anchor is pinned by snapshot,
//          so no derived value can drift without review;
//   AC-03  the values-only fence — no custom property is renamed, added, or removed
//          in any of the five declaration blocks, and the three alias blocks stay in
//          lockstep with the --dark-* literals.
//
// The stylesheet carries custom-property declarations in five blocks, not two. The
// three alias blocks only restate `--x: var(--dark-x)` or `--color-x: var(--x)`, so
// re-valuing dark means editing the --dark-* literals; asserting only the light and
// alias blocks would let a dark literal drift silently.
const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles/styles.css");
const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const rawStyles = readFileSync(stylesPath, "utf8");
// Comments are stripped before parsing so a token name mentioned in prose can never
// be counted as a declaration.
const styles = rawStyles.replace(/\/\*[\s\S]*?\*\//g, "");

const BLOCK_MARKERS = {
  light: '[data-chase-theme-scope][data-color-mode="light"] {',
  darkLiteral: "\n  :root {",
  darkAlias: '[data-chase-theme-scope][data-color-mode="dark"] {',
  prefersDarkAlias: ':root:not([data-theme="light"]) {',
  colorLayer: "body:has([data-theme-choice]:checked) {",
} as const;

type BlockName = keyof typeof BLOCK_MARKERS;

function blockBody(name: BlockName): string {
  const marker = BLOCK_MARKERS[name];
  const markerIndex = styles.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`styles.css no longer contains the '${name}' block marker ${JSON.stringify(marker)}.`);
  }
  if (styles.indexOf(marker, markerIndex + 1) >= 0) {
    throw new Error(`styles.css block marker ${JSON.stringify(marker)} is no longer unique to the '${name}' block.`);
  }

  const open = markerIndex + marker.length - 1;
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    else if (styles[index] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(open + 1, index);
    }
  }
  throw new Error(`styles.css '${name}' block is unbalanced.`);
}

function declarations(name: BlockName): readonly (readonly [string, string])[] {
  return [...blockBody(name).matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);\s*$/gm)].map(
    (match) => [match[1]!, match[2]!.trim()] as const,
  );
}

function declarationNames(name: BlockName): string[] {
  return declarations(name).map(([property]) => property);
}

function declarationMap(name: BlockName): Record<string, string> {
  return Object.fromEntries(declarations(name).map(([property, value]) => [property, value]));
}

const LIGHT_BLOCK_DECLARATIONS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--primary-hover",
  "--primary-active",
  "--primary-soft",
  "--overlay",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--border-strong",
  "--input",
  "--ring",
  "--success",
  "--success-soft",
  "--success-hover",
  "--success-active",
  "--success-contrast",
  "--warning",
  "--warning-soft",
  "--warning-hover",
  "--warning-active",
  "--warning-contrast",
  "--danger",
  "--danger-soft",
  "--danger-hover",
  "--danger-active",
  "--danger-contrast",
  "--destructive",
  "--destructive-foreground",
  "--info",
  "--info-soft",
  "--info-hover",
  "--info-active",
  "--info-contrast",
  "--trust",
  "--trust-soft",
  "--deal",
  "--deal-soft",
  "--rating",
  "--rating-soft",
  "--surface-2",
  "--surface-3",
  "--elevated",
  "--disabled-bg",
  "--disabled-text",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--text-disabled",
  "--chase-logo-start",
  "--chase-logo-mid",
  "--chase-logo-end",
  "--page-spotlight-a",
  "--page-spotlight-b",
  "--surface-line",
  "--surface-depth",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-overlay",
  "--display-font",
  "--body-font",
  "--mono-font",
  "--radius",
  "--radius-lg",
  "--radius-xl",
  "--radius-full",
  "--border-width-0",
  "--border-width-sm",
  "--border-width-md",
  "--border-width-lg",
  "--opacity-disabled",
  "--opacity-overlay",
  "--space-unit",
  "--space-0",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-7",
  "--space-8",
  "--space-9",
  "--space-10",
  "--space-11",
  "--space-12",
  "--motion-base",
  "--motion-fast",
  "--motion-slow",
  "--motion-ease",
  "--control-sm-height",
  "--control-md-height",
  "--control-lg-height",
  "--control-sm-px",
  "--control-md-px",
  "--control-lg-px",
  "--control-sm-py",
  "--control-md-py",
  "--control-lg-py",
  "--control-sm-icon-size",
  "--control-md-icon-size",
  "--control-lg-icon-size",
  "--control-compact-sm-height",
  "--control-compact-md-height",
  "--control-compact-lg-height",
  "--control-compact-sm-px",
  "--control-compact-md-px",
  "--control-compact-lg-px",
  "--control-compound-inset",
  "--control-py",
  "--control-px",
  "--z-sticky",
  "--z-dropdown",
  "--z-popover",
  "--z-drawer",
  "--z-modal",
  "--z-toast",
] as const;

const DARK_LITERAL_BLOCK_DECLARATIONS = [
  "--dark-background",
  "--dark-foreground",
  "--dark-card",
  "--dark-card-foreground",
  "--dark-popover",
  "--dark-popover-foreground",
  "--dark-primary",
  "--dark-primary-foreground",
  "--dark-primary-hover",
  "--dark-primary-active",
  "--dark-primary-soft",
  "--dark-overlay",
  "--dark-secondary",
  "--dark-secondary-foreground",
  "--dark-muted",
  "--dark-muted-foreground",
  "--dark-accent",
  "--dark-accent-foreground",
  "--dark-border",
  "--dark-border-strong",
  "--dark-input",
  "--dark-ring",
  "--dark-success",
  "--dark-success-soft",
  "--dark-success-hover",
  "--dark-success-active",
  "--dark-success-contrast",
  "--dark-warning",
  "--dark-warning-soft",
  "--dark-warning-hover",
  "--dark-warning-active",
  "--dark-warning-contrast",
  "--dark-danger",
  "--dark-danger-soft",
  "--dark-danger-hover",
  "--dark-danger-active",
  "--dark-danger-contrast",
  "--dark-destructive",
  "--dark-destructive-foreground",
  "--dark-info",
  "--dark-info-soft",
  "--dark-info-hover",
  "--dark-info-active",
  "--dark-info-contrast",
  "--dark-trust",
  "--dark-trust-soft",
  "--dark-deal",
  "--dark-deal-soft",
  "--dark-rating",
  "--dark-rating-soft",
  "--dark-surface-2",
  "--dark-surface-3",
  "--dark-elevated",
  "--dark-disabled-bg",
  "--dark-disabled-text",
  "--dark-text-primary",
  "--dark-text-secondary",
  "--dark-text-muted",
  "--dark-text-disabled",
  "--dark-chase-logo-start",
  "--dark-chase-logo-mid",
  "--dark-chase-logo-end",
  "--dark-page-spotlight-a",
  "--dark-page-spotlight-b",
  "--dark-surface-line",
  "--dark-surface-depth",
  "--dark-shadow-sm",
  "--dark-shadow-md",
  "--dark-shadow-lg",
  "--dark-shadow-overlay",
] as const;

const DARK_ALIAS_BLOCK_DECLARATIONS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--primary-hover",
  "--primary-active",
  "--primary-soft",
  "--overlay",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--border-strong",
  "--input",
  "--ring",
  "--success",
  "--success-soft",
  "--success-hover",
  "--success-active",
  "--success-contrast",
  "--warning",
  "--warning-soft",
  "--warning-hover",
  "--warning-active",
  "--warning-contrast",
  "--danger",
  "--danger-soft",
  "--danger-hover",
  "--danger-active",
  "--danger-contrast",
  "--destructive",
  "--destructive-foreground",
  "--info",
  "--info-soft",
  "--info-hover",
  "--info-active",
  "--info-contrast",
  "--trust",
  "--trust-soft",
  "--deal",
  "--deal-soft",
  "--rating",
  "--rating-soft",
  "--surface-2",
  "--surface-3",
  "--elevated",
  "--disabled-bg",
  "--disabled-text",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--text-disabled",
  "--chase-logo-start",
  "--chase-logo-mid",
  "--chase-logo-end",
  "--page-spotlight-a",
  "--page-spotlight-b",
  "--surface-line",
  "--surface-depth",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-overlay",
] as const;

const PREFERS_DARK_ALIAS_BLOCK_DECLARATIONS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--primary-hover",
  "--primary-active",
  "--primary-soft",
  "--overlay",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--border-strong",
  "--input",
  "--ring",
  "--success",
  "--success-soft",
  "--success-hover",
  "--success-active",
  "--success-contrast",
  "--warning",
  "--warning-soft",
  "--warning-hover",
  "--warning-active",
  "--warning-contrast",
  "--danger",
  "--danger-soft",
  "--danger-hover",
  "--danger-active",
  "--danger-contrast",
  "--destructive",
  "--destructive-foreground",
  "--info",
  "--info-soft",
  "--info-hover",
  "--info-active",
  "--info-contrast",
  "--trust",
  "--trust-soft",
  "--deal",
  "--deal-soft",
  "--rating",
  "--rating-soft",
  "--surface-2",
  "--surface-3",
  "--elevated",
  "--disabled-bg",
  "--disabled-text",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--text-disabled",
  "--chase-logo-start",
  "--chase-logo-mid",
  "--chase-logo-end",
  "--page-spotlight-a",
  "--page-spotlight-b",
  "--surface-line",
  "--surface-depth",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-overlay",
] as const;

const COLOR_LAYER_BLOCK_DECLARATIONS = [
  "--color-background",
  "--color-surface",
  "--color-surface-2",
  "--color-surface-3",
  "--color-elevated-surface",
  "--color-border",
  "--color-muted-border",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-disabled",
  "--color-text-inverse",
  "--color-brand-primary",
  "--color-brand-secondary",
  "--color-primary",
  "--color-primary-soft",
  "--color-overlay",
  "--color-accent",
  "--color-accent-2",
  "--color-accent-soft",
  "--color-accent-contrast",
  "--color-success",
  "--color-success-soft",
  "--color-success-hover",
  "--color-success-active",
  "--color-success-contrast",
  "--color-warning",
  "--color-warning-soft",
  "--color-warning-hover",
  "--color-warning-active",
  "--color-warning-contrast",
  "--color-danger",
  "--color-danger-soft",
  "--color-danger-hover",
  "--color-danger-active",
  "--color-danger-contrast",
  "--color-info",
  "--color-info-soft",
  "--color-info-hover",
  "--color-info-active",
  "--color-info-contrast",
  "--color-trust",
  "--color-trust-soft",
  "--color-deal",
  "--color-deal-soft",
  "--color-rating",
  "--color-rating-soft",
  "--color-focus-ring",
  "--color-accent-hover",
  "--color-accent-active",
  "--font-display",
  "--font-heading",
  "--font-body",
  "--font-mono",
  "--font-size-3xs",
  "--font-size-2xs",
  "--font-size-xs",
  "--font-size-sm",
  "--font-size-base",
  "--font-size-lg",
  "--font-size-xl",
  "--font-size-2xl",
  "--font-size-3xl",
  "--font-size-4xl",
  "--font-size-5xl",
  "--line-height-3xs",
  "--line-height-2xs",
  "--line-height-xs",
  "--line-height-sm",
  "--line-height-base",
  "--line-height-lg",
  "--line-height-xl",
  "--line-height-2xl",
  "--line-height-3xl",
  "--line-height-4xl",
  "--line-height-5xl",
  "--line-height-none",
  "--line-height-tight",
  "--line-height-snug",
  "--line-height-normal",
  "--line-height-relaxed",
  "--line-height-display",
  "--line-height-hero",
  "--line-height-badge",
  "--letter-spacing-none",
  "--letter-spacing-normal",
  "--letter-spacing-wide",
  "--letter-spacing-label",
  "--radius-sm",
  "--radius-md",
] as const;

// The ratified Ink & Foil anchors, transcribed from the #6015 acceptance contract.
// A mistyped hex is a named test failure here, never a diff-review miss.
const LIGHT_ANCHORS: Readonly<Record<string, string>> = {
  "--background": "#f7f5f1",
  "--card": "#ffffff",
  "--surface-3": "#efece5",
  "--foreground": "#211d33",
  "--text-secondary": "#4d4763",
  "--text-muted": "#7d7791",
  "--border": "#e6e2d9",
  "--border-strong": "#d4cfc2",
  "--primary": "#4845c6",
  "--primary-hover": "#3b38ad",
  "--primary-active": "#312e94",
  "--primary-soft": "#e6e5fb",
  "--chase-logo-start": "#8a682a",
  "--chase-logo-mid": "#c9a44e",
  "--chase-logo-end": "#a87e2f",
};

// Dark anchors live in the --dark-* literal block. Asserting them through the alias
// blocks would only prove that `var(--dark-x)` was spelled correctly.
const DARK_ANCHORS: Readonly<Record<string, string>> = {
  "--dark-background": "#0e0c15",
  "--dark-surface-2": "#14111c",
  "--dark-card": "#1a1626",
  "--dark-elevated": "#211c30",
  "--dark-popover": "#211c30",
  "--dark-border": "rgba(242, 239, 250, 0.08)",
  "--dark-border-strong": "#4a4363",
  "--dark-foreground": "#f2effa",
  "--dark-text-secondary": "#b6b0c9",
  "--dark-text-muted": "#857e9c",
  "--dark-text-disabled": "#5c5675",
  "--dark-primary": "#8a97ff",
  "--dark-primary-foreground": "#14102a",
  "--dark-primary-hover": "#a1acff",
  "--dark-primary-active": "#b8c1ff",
  "--dark-primary-soft": "#232048",
  "--dark-ring": "#b8c1ff",
  "--dark-chase-logo-start": "#b9863b",
  "--dark-chase-logo-mid": "#edd28d",
  "--dark-chase-logo-end": "#d4a94e",
  // The ratified opaque equivalent of the alpha border, required wherever a field
  // edge must not composite differently against card, elevated and popover.
  "--dark-input": "#3a3450",
};

const BLOCK_DECLARATION_LISTS: ReadonlyArray<readonly [BlockName, readonly string[]]> = [
  ["light", LIGHT_BLOCK_DECLARATIONS],
  ["darkLiteral", DARK_LITERAL_BLOCK_DECLARATIONS],
  ["darkAlias", DARK_ALIAS_BLOCK_DECLARATIONS],
  ["prefersDarkAlias", PREFERS_DARK_ALIAS_BLOCK_DECLARATIONS],
  ["colorLayer", COLOR_LAYER_BLOCK_DECLARATIONS],
];

describe("token values", () => {
  describe("AC-01 ratified anchors are exact", () => {
    const light = declarationMap("light");
    const darkLiteral = declarationMap("darkLiteral");

    it.each(Object.entries(LIGHT_ANCHORS))("light %s", (property, expected) => {
      expect(light[property], `${property} (light block)`).toBe(expected);
    });

    it.each(Object.entries(DARK_ANCHORS))("dark %s", (property, expected) => {
      expect(darkLiteral[property], `${property} (--dark-* literal block)`).toBe(expected);
    });
  });

  describe("AC-03 values-only fence", () => {
    it.each(BLOCK_DECLARATION_LISTS)("%s block declares the same properties in the same order", (block, expected) => {
      expect(declarationNames(block), `declaration set changed in the '${block}' block`).toEqual([...expected]);
    });

    it("declares every custom property exactly once per block", () => {
      for (const [block] of BLOCK_DECLARATION_LISTS) {
        const names = declarationNames(block);
        expect(new Set(names).size, `duplicate declaration in the '${block}' block`).toBe(names.length);
      }
    });

    // A dark literal with no alias never reaches a rendered surface; an alias with no
    // literal resolves to nothing. Both are invisible in a values-only diff.
    it.each([["darkAlias"], ["prefersDarkAlias"]] as const)("%s maps one alias per --dark-* literal", (block) => {
      const literals = declarationNames("darkLiteral");
      const aliases = declarations(block);

      expect(aliases).toHaveLength(literals.length);
      for (const [property, value] of aliases) {
        const literal = `--dark${property.slice(1)}`;
        expect(value, `${property} must alias its --dark-* literal`).toBe(`var(${literal})`);
        expect(literals, `${property} has no --dark-* literal`).toContain(literal);
      }
    });

    it("keeps the retained trust hue and sweeps the superseded logo hue", () => {
      // --trust is deliberately retained. A sweep that took its count to zero would
      // mean a retained hue was removed by mistake, which reads identically to success.
      expect(rawStyles.match(/0f766e/g) ?? []).toHaveLength(1);
      expect(declarationMap("light")["--trust"]).toBe("#0f766e");
      expect(declarationMap("darkLiteral")["--dark-trust"]).toBe("#2dd4bf");
    });
  });

  describe("AC-05 type roles resolve to the ratified faces", () => {
    const light = declarationMap("light");
    const colorLayer = declarationMap("colorLayer");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };

    it("points the display and heading roles at Space Grotesk", () => {
      expect(light["--display-font"]).toBe('"Space Grotesk", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
      expect(colorLayer["--font-display"]).toBe('"Space Grotesk"');
      expect(colorLayer["--font-heading"]).toBe('"Space Grotesk"');
    });

    it("keeps IBM Plex Sans on body and IBM Plex Mono on the mono role", () => {
      expect(light["--body-font"]).toBe('"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
      expect(light["--mono-font"]).toBe('"IBM Plex Mono", ui-monospace, monospace');
      expect(colorLayer["--font-body"]).toBe('"IBM Plex Sans"');
      expect(colorLayer["--font-mono"]).toBe('"IBM Plex Mono"');
    });

    // A stale tokens.ts default degrades silently to a system fallback wherever the
    // custom property does not resolve, which no visual diff would surface.
    it("keeps the tokens.ts typography defaults in lockstep with the stylesheet", () => {
      expect(chaseTheme.typography.display).toBe(`var(--display-font, ${light["--display-font"]})`);
      expect(chaseTheme.typography.heading).toBe(`var(--font-heading, ${colorLayer["--font-heading"]})`);
      expect(chaseTheme.typography.body).toBe(`var(--body-font, ${light["--body-font"]})`);
      expect(chaseTheme.typography.mono).toBe(`var(--mono-font, ${light["--mono-font"]})`);
    });

    it("declares and imports both newly required font families", () => {
      expect(packageJson.dependencies?.["@fontsource/space-grotesk"]).toBeTruthy();
      expect(packageJson.dependencies?.["@fontsource/ibm-plex-mono"]).toBeTruthy();
      expect(rawStyles).toContain('@import "@fontsource/space-grotesk/latin.css";');
      expect(rawStyles).toContain('@import "@fontsource/ibm-plex-mono/latin.css";');
    });
  });

  describe("AC-02 derived values are pinned", () => {
    // Every re-valued property that carries no ratified anchor — the light and dark
    // surface ramps, muted/secondary/input/ring, the disabled pair, the overlay, the
    // surface line and depth, the shadow scale and both spotlights — is captured here
    // alongside the anchored ones. Snapshotting the whole resolved map rather than a
    // hand-maintained subset is what keeps a re-valued property from escaping review
    // by being absent from the anchor table.
    it("pins the resolved light-mode property map", () => {
      expect(declarationMap("light")).toMatchInlineSnapshot(`
        {
          "--accent": "var(--primary)",
          "--accent-foreground": "var(--primary-foreground)",
          "--background": "#f7f5f1",
          "--body-font": ""IBM Plex Sans", ui-sans-serif, system-ui, sans-serif",
          "--border": "#e6e2d9",
          "--border-strong": "#d4cfc2",
          "--border-width-0": "0",
          "--border-width-lg": "4px",
          "--border-width-md": "2px",
          "--border-width-sm": "1px",
          "--card": "#ffffff",
          "--card-foreground": "#211d33",
          "--chase-logo-end": "#a87e2f",
          "--chase-logo-mid": "#c9a44e",
          "--chase-logo-start": "#8a682a",
          "--control-compact-lg-height": "2.5rem",
          "--control-compact-lg-px": "1rem",
          "--control-compact-md-height": "2rem",
          "--control-compact-md-px": "0.75rem",
          "--control-compact-sm-height": "1.75rem",
          "--control-compact-sm-px": "0.625rem",
          "--control-compound-inset": "0.25rem",
          "--control-lg-height": "3rem",
          "--control-lg-icon-size": "2.25rem",
          "--control-lg-px": "1.25rem",
          "--control-lg-py": "0.75rem",
          "--control-md-height": "2.75rem",
          "--control-md-icon-size": "2rem",
          "--control-md-px": "1rem",
          "--control-md-py": "0.625rem",
          "--control-px": "var(--control-md-px)",
          "--control-py": "var(--control-md-py)",
          "--control-sm-height": "2.75rem",
          "--control-sm-icon-size": "1.75rem",
          "--control-sm-px": "0.75rem",
          "--control-sm-py": "0.375rem",
          "--danger": "#b91c1c",
          "--danger-active": "#7f1d1d",
          "--danger-contrast": "#ffffff",
          "--danger-hover": "#991b1b",
          "--danger-soft": "#fee2e2",
          "--deal": "#9c4611",
          "--deal-soft": "#ffedd5",
          "--destructive": "var(--danger)",
          "--destructive-foreground": "var(--danger-contrast)",
          "--disabled-bg": "#e6e2d9",
          "--disabled-text": "#9a94ab",
          "--display-font": ""Space Grotesk", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif",
          "--elevated": "#ffffff",
          "--foreground": "#211d33",
          "--info": "#0369a1",
          "--info-active": "#0c4a6e",
          "--info-contrast": "#ffffff",
          "--info-hover": "#075985",
          "--info-soft": "#e0f2fe",
          "--input": "#d4cfc2",
          "--mono-font": ""IBM Plex Mono", ui-monospace, monospace",
          "--motion-base": "150ms",
          "--motion-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
          "--motion-fast": "120ms",
          "--motion-slow": "240ms",
          "--muted": "#e6e2d9",
          "--muted-foreground": "#7d7791",
          "--opacity-disabled": "0.5",
          "--opacity-overlay": "0.88",
          "--overlay": "rgba(33, 29, 51, 0.35)",
          "--page-spotlight-a": "rgba(72, 69, 198, 0.05)",
          "--page-spotlight-b": "rgba(201, 164, 78, 0.04)",
          "--popover": "#ffffff",
          "--popover-foreground": "#211d33",
          "--primary": "#4845c6",
          "--primary-active": "#312e94",
          "--primary-foreground": "#ffffff",
          "--primary-hover": "#3b38ad",
          "--primary-soft": "#e6e5fb",
          "--radius": "0.5rem",
          "--radius-full": "9999px",
          "--radius-lg": "0.75rem",
          "--radius-xl": "1rem",
          "--rating": "#8a5a06",
          "--rating-soft": "#fef3c7",
          "--ring": "#5b58d6",
          "--secondary": "#efece5",
          "--secondary-foreground": "#4d4763",
          "--shadow-lg": "0 18px 38px -28px rgba(33, 29, 51, 0.36)",
          "--shadow-md": "0 8px 20px -16px rgba(33, 29, 51, 0.3)",
          "--shadow-overlay": "0 24px 64px -32px rgba(33, 29, 51, 0.44)",
          "--shadow-sm": "0 1px 2px rgba(33, 29, 51, 0.07)",
          "--space-0": "0",
          "--space-1": "0.25rem",
          "--space-10": "2.5rem",
          "--space-11": "2.75rem",
          "--space-12": "3rem",
          "--space-2": "0.5rem",
          "--space-3": "0.75rem",
          "--space-4": "1rem",
          "--space-5": "1.25rem",
          "--space-6": "1.5rem",
          "--space-7": "1.75rem",
          "--space-8": "2rem",
          "--space-9": "2.25rem",
          "--space-unit": "0.25rem",
          "--success": "#15803d",
          "--success-active": "#14532d",
          "--success-contrast": "#ffffff",
          "--success-hover": "#166534",
          "--success-soft": "#dcfce7",
          "--surface-2": "#f7f5f1",
          "--surface-3": "#efece5",
          "--surface-depth": "rgba(33, 29, 51, 0.05)",
          "--surface-line": "rgba(255, 255, 255, 0.86)",
          "--text-disabled": "#9a94ab",
          "--text-muted": "#7d7791",
          "--text-primary": "#211d33",
          "--text-secondary": "#4d4763",
          "--trust": "#0f766e",
          "--trust-soft": "#ccfbf1",
          "--warning": "#b45309",
          "--warning-active": "#78350f",
          "--warning-contrast": "#ffffff",
          "--warning-hover": "#92400e",
          "--warning-soft": "#fef3c7",
          "--z-drawer": "50",
          "--z-dropdown": "65",
          "--z-modal": "60",
          "--z-popover": "70",
          "--z-sticky": "20",
          "--z-toast": "80",
        }
      `);
    });

    it("pins the resolved dark-mode property map", () => {
      expect(declarationMap("darkLiteral")).toMatchInlineSnapshot(`
        {
          "--dark-accent": "var(--dark-primary)",
          "--dark-accent-foreground": "var(--dark-primary-foreground)",
          "--dark-background": "#0e0c15",
          "--dark-border": "rgba(242, 239, 250, 0.08)",
          "--dark-border-strong": "#4a4363",
          "--dark-card": "#1a1626",
          "--dark-card-foreground": "#f2effa",
          "--dark-chase-logo-end": "#d4a94e",
          "--dark-chase-logo-mid": "#edd28d",
          "--dark-chase-logo-start": "#b9863b",
          "--dark-danger": "#f87171",
          "--dark-danger-active": "#fecaca",
          "--dark-danger-contrast": "#1f0808",
          "--dark-danger-hover": "#fca5a5",
          "--dark-danger-soft": "#450a0a",
          "--dark-deal": "#fbbf24",
          "--dark-deal-soft": "#451a03",
          "--dark-destructive": "var(--dark-danger)",
          "--dark-destructive-foreground": "var(--dark-danger-contrast)",
          "--dark-disabled-bg": "#211c30",
          "--dark-disabled-text": "#5c5675",
          "--dark-elevated": "#211c30",
          "--dark-foreground": "#f2effa",
          "--dark-info": "#38bdf8",
          "--dark-info-active": "#bae6fd",
          "--dark-info-contrast": "#082f49",
          "--dark-info-hover": "#7dd3fc",
          "--dark-info-soft": "#082f49",
          "--dark-input": "#3a3450",
          "--dark-muted": "#322c4a",
          "--dark-muted-foreground": "#857e9c",
          "--dark-overlay": "rgba(10, 8, 17, 0.55)",
          "--dark-page-spotlight-a": "rgba(138, 151, 255, 0.06)",
          "--dark-page-spotlight-b": "rgba(212, 169, 78, 0.045)",
          "--dark-popover": "#211c30",
          "--dark-popover-foreground": "#f2effa",
          "--dark-primary": "#8a97ff",
          "--dark-primary-active": "#b8c1ff",
          "--dark-primary-foreground": "#14102a",
          "--dark-primary-hover": "#a1acff",
          "--dark-primary-soft": "#232048",
          "--dark-rating": "#fbbf24",
          "--dark-rating-soft": "#422006",
          "--dark-ring": "#b8c1ff",
          "--dark-secondary": "#211c30",
          "--dark-secondary-foreground": "#b6b0c9",
          "--dark-shadow-lg": "0 22px 60px -34px rgba(6, 5, 11, 0.9)",
          "--dark-shadow-md": "0 12px 30px -22px rgba(6, 5, 11, 0.82)",
          "--dark-shadow-overlay": "0 32px 80px -34px rgba(6, 5, 11, 0.92)",
          "--dark-shadow-sm": "0 1px 2px rgba(6, 5, 11, 0.32)",
          "--dark-success": "#4ade80",
          "--dark-success-active": "#bbf7d0",
          "--dark-success-contrast": "#052e16",
          "--dark-success-hover": "#86efac",
          "--dark-success-soft": "#052e16",
          "--dark-surface-2": "#14111c",
          "--dark-surface-3": "#2a2540",
          "--dark-surface-depth": "rgba(6, 5, 11, 0.28)",
          "--dark-surface-line": "rgba(242, 239, 250, 0.06)",
          "--dark-text-disabled": "#5c5675",
          "--dark-text-muted": "#857e9c",
          "--dark-text-primary": "#f2effa",
          "--dark-text-secondary": "#b6b0c9",
          "--dark-trust": "#2dd4bf",
          "--dark-trust-soft": "#042f2e",
          "--dark-warning": "#facc15",
          "--dark-warning-active": "#fef08a",
          "--dark-warning-contrast": "#422006",
          "--dark-warning-hover": "#fde047",
          "--dark-warning-soft": "#422006",
        }
      `);
    });

    it("pins the resolved --color-* semantic layer", () => {
      expect(declarationMap("colorLayer")).toMatchInlineSnapshot(`
        {
          "--color-accent": "var(--accent)",
          "--color-accent-2": "var(--trust)",
          "--color-accent-active": "var(--primary-active)",
          "--color-accent-contrast": "var(--primary-foreground)",
          "--color-accent-hover": "var(--primary-hover)",
          "--color-accent-soft": "var(--primary-soft)",
          "--color-background": "var(--background)",
          "--color-border": "var(--border)",
          "--color-brand-primary": "var(--primary)",
          "--color-brand-secondary": "var(--trust)",
          "--color-danger": "var(--danger)",
          "--color-danger-active": "var(--danger-active)",
          "--color-danger-contrast": "var(--danger-contrast)",
          "--color-danger-hover": "var(--danger-hover)",
          "--color-danger-soft": "var(--danger-soft)",
          "--color-deal": "var(--deal)",
          "--color-deal-soft": "var(--deal-soft)",
          "--color-elevated-surface": "var(--elevated)",
          "--color-focus-ring": "var(--ring)",
          "--color-info": "var(--info)",
          "--color-info-active": "var(--info-active)",
          "--color-info-contrast": "var(--info-contrast)",
          "--color-info-hover": "var(--info-hover)",
          "--color-info-soft": "var(--info-soft)",
          "--color-muted-border": "var(--muted)",
          "--color-overlay": "var(--overlay)",
          "--color-primary": "var(--primary)",
          "--color-primary-soft": "var(--primary-soft)",
          "--color-rating": "var(--rating)",
          "--color-rating-soft": "var(--rating-soft)",
          "--color-success": "var(--success)",
          "--color-success-active": "var(--success-active)",
          "--color-success-contrast": "var(--success-contrast)",
          "--color-success-hover": "var(--success-hover)",
          "--color-success-soft": "var(--success-soft)",
          "--color-surface": "var(--card)",
          "--color-surface-2": "var(--surface-2)",
          "--color-surface-3": "var(--surface-3)",
          "--color-text-disabled": "var(--text-disabled)",
          "--color-text-inverse": "var(--primary-foreground)",
          "--color-text-primary": "var(--foreground)",
          "--color-text-secondary": "var(--text-secondary)",
          "--color-text-tertiary": "var(--text-muted)",
          "--color-trust": "var(--trust)",
          "--color-trust-soft": "var(--trust-soft)",
          "--color-warning": "var(--warning)",
          "--color-warning-active": "var(--warning-active)",
          "--color-warning-contrast": "var(--warning-contrast)",
          "--color-warning-hover": "var(--warning-hover)",
          "--color-warning-soft": "var(--warning-soft)",
          "--font-body": ""IBM Plex Sans"",
          "--font-display": ""Space Grotesk"",
          "--font-heading": ""Space Grotesk"",
          "--font-mono": ""IBM Plex Mono"",
          "--font-size-2xl": "1.5rem",
          "--font-size-2xs": "0.6875rem",
          "--font-size-3xl": "1.875rem",
          "--font-size-3xs": "0.625rem",
          "--font-size-4xl": "2.25rem",
          "--font-size-5xl": "3rem",
          "--font-size-base": "1rem",
          "--font-size-lg": "1.125rem",
          "--font-size-sm": "0.875rem",
          "--font-size-xl": "1.25rem",
          "--font-size-xs": "0.75rem",
          "--letter-spacing-label": "0",
          "--letter-spacing-none": "0",
          "--letter-spacing-normal": "0",
          "--letter-spacing-wide": "0.025em",
          "--line-height-2xl": "2rem",
          "--line-height-2xs": "1rem",
          "--line-height-3xl": "2.25rem",
          "--line-height-3xs": "1",
          "--line-height-4xl": "2.5rem",
          "--line-height-5xl": "1",
          "--line-height-badge": "1rem",
          "--line-height-base": "1.5rem",
          "--line-height-display": "1.15",
          "--line-height-hero": "1.08",
          "--line-height-lg": "1.75rem",
          "--line-height-none": "1",
          "--line-height-normal": "1.5",
          "--line-height-relaxed": "1.625",
          "--line-height-sm": "1.25rem",
          "--line-height-snug": "1.375",
          "--line-height-tight": "1.25",
          "--line-height-xl": "1.75rem",
          "--line-height-xs": "1rem",
          "--radius-md": "var(--radius)",
          "--radius-sm": "0.375rem",
        }
      `);
    });
  });
});
