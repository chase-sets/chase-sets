import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChaseSetsLogo, chaseSetsLogoSvg } from "../brand/chase-sets-logo";
import { BrandLink } from "../components/actions/navigation";
import { SellerBadge } from "../patterns/app-shells/commerce-atoms";
import { deriveReceiptSourceDigestPaths } from "./ink-foil-candidate-fixture.test";

// Vector-side Ink & Foil guard: the display-type and brand-foil value fence,
// the mark's three-representation parity, its accessibility semantics, and
// the vector half of the closed changed-path set. The changed-path arrays are
// read out of scripts/check-structure/brand-mark-representations.test.mjs by
// slicing its sentinel comments, so this side and the raster side always
// parse the same bytes and can never hold two hand-kept lists.

function repositoryRoot() {
  let candidate = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("Could not locate the repository root");
    candidate = parent;
  }
  return candidate;
}

const root = repositoryRoot();
const designSystemSrc = join(root, "packages", "design-system", "src");
const stylesPath = join(designSystemSrc, "styles", "styles.css");
const stylesSource = readFileSync(stylesPath, "utf8");
const fixture = JSON.parse(
  readFileSync(join(designSystemSrc, "theme", "__fixtures__", "ink-foil-candidate-tokens.json"), "utf8"),
) as Record<"light" | "dark", Record<string, { shipped: string; candidate: string }>>;

// The raster-side guard module, resolved from this file's own location.
const representationGuardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "check-structure",
  "brand-mark-representations.test.mjs",
);
const representationGuardSource = readFileSync(representationGuardPath, "utf8");

function sliceSentinelJson(source: string, name: string): string[] {
  const begin = source.indexOf(`// ${name}:begin`);
  const end = source.indexOf(`// ${name}:end`);
  if (begin === -1 || end === -1 || end <= begin) throw new Error(`sentinel block ${name} not found`);
  const block = source.slice(begin, end);
  const first = block.indexOf("[");
  const last = block.lastIndexOf("]");
  if (first === -1 || last === -1) throw new Error(`sentinel block ${name} carries no JSON array`);
  // The repository formatter writes a trailing comma before the closing
  // bracket; both sides normalise it away identically before parsing.
  return JSON.parse(block.slice(first, last + 1).replace(/,\s*\]$/, "]")) as string[];
}

const combinedCandidatePaths = sliceSentinelJson(representationGuardSource, "combined-candidate-paths");

// ---------------------------------------------------------------------------
// Stylesheet block model: ordered declaration names per declaration-carrying
// block. The fence binds names and per-block counts, never absolute line
// ranges, because the Fontsource imports shift every range by construction.
// ---------------------------------------------------------------------------

type DeclarationBlock = { names: string[]; values: Map<string, string> };

function parseDeclarationBlocks(css: string): DeclarationBlock[] {
  const stack: { names: string[]; values: Map<string, string> }[] = [];
  const blocks: DeclarationBlock[] = [];
  for (const line of css.split("\n")) {
    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    if (opens) stack.push({ names: [], values: new Map() });
    const top = stack[stack.length - 1];
    const declaration = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/);
    if (top && declaration) {
      top.names.push(declaration[1]!);
      if (!top.values.has(declaration[1]!)) top.values.set(declaration[1]!, declaration[2]!);
    }
    for (let k = 0; k < closes; k++) {
      const done = stack.pop();
      if (done && done.names.length) blocks.push(done);
    }
  }
  return blocks;
}

const declarationBlocks = parseDeclarationBlocks(stylesSource);

// Ordered declaration-name lists of the six declaration-carrying blocks,
// generated with the frozen count-derivation model and committed here.
const committedBlockDeclarationNames: string[][] = [
  [
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
  ],
  [
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
  ],
  [
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
  ],
  [
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
  ],
  [
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
  ],
  [
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
    "--control-py",
    "--control-px",
  ],
];

const advancedNames = [
  "--display-font",
  "--font-display",
  "--font-heading",
  "--chase-logo-start",
  "--chase-logo-mid",
  "--chase-logo-end",
] as const;

describe("Ink & Foil display type and brand foil values", () => {
  it("resolves each of the six advanced names to the fixture candidate in its owning block", () => {
    const lightBlock = declarationBlocks[0]!;
    const darkLiteralBlock = declarationBlocks[1]!;
    const aliasBlock = declarationBlocks[4]!;

    expect(lightBlock.values.get("--chase-logo-start")).toBe(fixture.light["--chase-logo-start"]!.candidate);
    expect(lightBlock.values.get("--chase-logo-mid")).toBe(fixture.light["--chase-logo-mid"]!.candidate);
    expect(lightBlock.values.get("--chase-logo-end")).toBe(fixture.light["--chase-logo-end"]!.candidate);
    expect(lightBlock.values.get("--display-font")).toBe(fixture.light["--display-font"]!.candidate);

    expect(darkLiteralBlock.values.get("--dark-chase-logo-start")).toBe(fixture.dark["--chase-logo-start"]!.candidate);
    expect(darkLiteralBlock.values.get("--dark-chase-logo-mid")).toBe(fixture.dark["--chase-logo-mid"]!.candidate);
    expect(darkLiteralBlock.values.get("--dark-chase-logo-end")).toBe(fixture.dark["--chase-logo-end"]!.candidate);

    expect(aliasBlock.values.get("--font-display")).toBe(fixture.light["--font-display"]!.candidate);
    expect(aliasBlock.values.get("--font-heading")).toBe(fixture.light["--font-heading"]!.candidate);

    // No dark alias exists for the three font names, so their dark resolution
    // is the light literal and the fixture keys light and dark identically.
    expect(fixture.dark["--display-font"]!.candidate).toBe(fixture.light["--display-font"]!.candidate);
    expect(fixture.dark["--font-display"]!.candidate).toBe(fixture.light["--font-display"]!.candidate);
    expect(fixture.dark["--font-heading"]!.candidate).toBe(fixture.light["--font-heading"]!.candidate);
  });

  it("keeps the stylesheet values-only: six blocks, ordered declaration names, per-block counts", () => {
    expect(declarationBlocks.length).toBe(6);
    const counts = declarationBlocks.map((block) => block.names.length);
    expect(counts).toEqual([128, 70, 70, 70, 90, 14]);
    for (let i = 0; i < 6; i++) {
      expect(declarationBlocks[i]!.names, `declaration set changed in block ${i + 1}`).toEqual(
        committedBlockDeclarationNames[i]!,
      );
    }
  });

  it("imports all three Fontsource families at identical per-weight latin entrypoints backed by declared dependencies", () => {
    const imports = [...stylesSource.matchAll(/^@import "(@fontsource\/[\w-]+)\/([\w.-]+)";$/gm)].map((match) => ({
      pkg: match[1]!,
      entry: match[2]!,
    }));
    const byPackage = new Map<string, string[]>();
    for (const entry of imports) {
      byPackage.set(entry.pkg, [...(byPackage.get(entry.pkg) ?? []), entry.entry]);
    }
    expect([...byPackage.keys()].sort()).toEqual([
      "@fontsource/ibm-plex-mono",
      "@fontsource/ibm-plex-sans",
      "@fontsource/space-grotesk",
    ]);
    for (const [pkg, entries] of byPackage) {
      expect(entries, `${pkg} weight entrypoints`).toEqual([
        "latin-400.css",
        "latin-500.css",
        "latin-600.css",
        "latin-700.css",
      ]);
    }
    const packageJson = JSON.parse(readFileSync(join(root, "packages", "design-system", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const pkg of byPackage.keys()) {
      expect(packageJson.dependencies[pkg], `${pkg} must be a declared dependency`).toBeDefined();
    }
  });

  it("keeps tokens.ts in agreement with the stylesheet for all four font roles", () => {
    const tokensSource = readFileSync(join(designSystemSrc, "theme", "tokens.ts"), "utf8");
    const role = (name: string) => {
      const match = tokensSource.match(new RegExp(`${name}: '(var\\([^']+\\))',`));
      if (!match) throw new Error(`typography.${name} not found in tokens.ts`);
      return match[1]!;
    };
    expect(role("display")).toBe(
      'var(--display-font, "Space Grotesk", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)',
    );
    expect(role("heading")).toBe('var(--font-heading, "Space Grotesk")');
    // body and mono do not move; --body-font is the only font name a Stripe
    // factory consumes and it must stay at its pre-change bytes.
    expect(role("body")).toBe('var(--body-font, "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)');
    expect(role("mono")).toBe('var(--mono-font, "IBM Plex Mono", ui-monospace, monospace)');
    const lightBlock = declarationBlocks[0]!;
    expect(lightBlock.values.get("--body-font")).toBe('"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
    expect(lightBlock.values.get("--mono-font")).toBe('"IBM Plex Mono", ui-monospace, monospace');
    // The tokens.ts fallbacks restate the stylesheet values character for
    // character.
    expect(role("display")).toContain(lightBlock.values.get("--display-font")!);
  });

  it("derives each display/heading name's consumer set and keeps all three outside the Stripe factory", () => {
    const gitGrepFiles = (pattern: string): string[] => {
      try {
        return execFileSync(
          "git",
          ["-C", root, "grep", "-lE", pattern, "--", "packages", "bounded-contexts", "deployables", "contracts"],
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean)
          .map((file) => file.replaceAll("\\", "/"))
          .sort();
      } catch {
        return [];
      }
    };

    const displayFontRules = [...stylesSource.matchAll(/^\s*font-family:\s*var\(--display-font\);\s*$/gm)];
    expect(displayFontRules.length).toBe(1);
    expect(stylesSource).toMatch(/\.ds-display,\s*\n\s*\.ds-label \{\s*\n\s*font-family: var\(--display-font\);/);

    const consumers = {
      "--display-font": gitGrepFiles("\\b(ds-display|ds-label)\\b"),
      "--font-display": gitGrepFiles("\\bfont-display\\b"),
      "--font-heading": gitGrepFiles("\\bfont-heading\\b"),
    };
    console.log(`derived consumer sets:\n${JSON.stringify(consumers, null, 2)}`);

    const committedConsumers: Record<string, string[]> = {
      "--display-font": [
        "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
        "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
        "packages/design-system/src/components/actions/navigation-header.tsx",
        "packages/design-system/src/styles/styles.css",
      ],
      "--font-display": [
        "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
        "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts",
        "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
        "packages/design-system/src/patterns/app-shells/marketing.tsx",
        "packages/design-system/src/patterns/app-shells/page-layouts.tsx",
        "packages/design-system/src/primitives/typography.tsx",
        "packages/design-system/src/styles/styles.css",
        "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
        "packages/design-system/src/theme/tokens.ts",
      ],
      "--font-heading": [
        "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
        "packages/design-system/src/__tests__/design-system-components.test.tsx",
        "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts",
        "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
        "packages/design-system/src/components/actions/account-menu-surfaces.tsx",
        "packages/design-system/src/components/data-display/actor-identity-cue.tsx",
        "packages/design-system/src/components/data-display/card.tsx",
        "packages/design-system/src/components/data-display/comparison-list.tsx",
        "packages/design-system/src/components/data-display/stat.tsx",
        "packages/design-system/src/components/feedback/alert-dialog.tsx",
        "packages/design-system/src/components/feedback/dialog.tsx",
        "packages/design-system/src/components/forms/fieldset.tsx",
        "packages/design-system/src/patterns/app-shells/facets.tsx",
        "packages/design-system/src/patterns/app-shells/marketing.tsx",
        "packages/design-system/src/patterns/app-shells/page-layouts.tsx",
        "packages/design-system/src/patterns/app-shells/product-cards.tsx",
        "packages/design-system/src/patterns/app-shells/product-detail.tsx",
        "packages/design-system/src/patterns/dense-admin-workbench.tsx",
        "packages/design-system/src/primitives/typography.tsx",
        "packages/design-system/src/styles/styles.css",
        "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
        "packages/design-system/src/theme/tokens.ts",
      ],
    };

    for (const name of ["--display-font", "--font-display", "--font-heading"] as const) {
      expect(consumers[name].length, `${name} must have at least one consumer`).toBeGreaterThan(0);
      expect(consumers[name], `derived consumer set for ${name}`).toEqual(committedConsumers[name]);
    }

    const appearanceSource = readFileSync(join(designSystemSrc, "theme", "stripe-appearance.ts"), "utf8");
    for (const name of advancedNames) {
      expect(appearanceSource.includes(name), `${name} must not appear in stripe-appearance.ts`).toBe(false);
    }
  });
});

describe("brand mark sources and parity", () => {
  const rawAssetPath = join(designSystemSrc, "brand", "chase-sets-logo.svg");
  const rawAsset = readFileSync(rawAssetPath, "utf8");

  function parseStyleDeclarations(svg: string, blockPattern: RegExp): Map<string, string> {
    const block = svg.match(blockPattern);
    if (!block) throw new Error(`style block ${blockPattern} not found`);
    const values = new Map<string, string>();
    for (const declaration of block[1]!.matchAll(/(--chase-logo-[\w-]+):\s*([^;]+);/g)) {
      values.set(declaration[1]!, declaration[2]!.trim());
    }
    return values;
  }

  it("declares the fixture foil candidates positively, by name, in the raw asset", () => {
    const lightValues = parseStyleDeclarations(rawAsset, /:root \{([^}]+)\}/);
    const darkValues = parseStyleDeclarations(rawAsset, /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]+)\}/);
    for (const stop of ["start", "mid", "end"] as const) {
      expect(lightValues.get(`--chase-logo-${stop}`), `light --chase-logo-${stop}`).toBe(
        fixture.light[`--chase-logo-${stop}`]!.candidate,
      );
      expect(darkValues.get(`--chase-logo-${stop}`), `dark --chase-logo-${stop}`).toBe(
        fixture.dark[`--chase-logo-${stop}`]!.candidate,
      );
    }
    console.log(
      `raw asset foil declarations: light ${JSON.stringify([...lightValues])} dark ${JSON.stringify([...darkValues])}`,
    );

    const stops = [...rawAsset.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map((match) => ({
      offset: match[1]!,
      color: match[2]!,
    }));
    expect(stops).toEqual([
      { offset: "0", color: "var(--chase-logo-start)" },
      { offset: "0.52", color: "var(--chase-logo-mid)" },
      { offset: "1", color: "var(--chase-logo-end)" },
    ]);
  });

  it("keeps the exported string, the raw asset, and the rendered markup in geometric and gradient parity", () => {
    // The exported string is the raw asset byte-for-byte (the file adds one
    // trailing newline), so the representation no test renders cannot drift.
    expect(`${chaseSetsLogoSvg}\n`).toBe(rawAsset);

    const markup = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "auto" }));
    const attr = (source: string, name: string): string[] =>
      [...source.matchAll(new RegExp(`(?<![-\\w])${name}="([^"]+)"`, "g"))].map((match) => match[1]!);

    expect(attr(markup, "viewBox")).toEqual(attr(rawAsset, "viewBox"));
    const markupPaths = attr(markup, "d");
    const assetPaths = attr(rawAsset, "d");
    expect(markupPaths.length).toBe(2);
    expect(markupPaths).toEqual(assetPaths);
    for (const name of ["gradientUnits", "x1", "y1", "x2", "y2"]) {
      expect(attr(markup, name), `gradient ${name}`).toEqual(attr(rawAsset, name));
    }
    expect(attr(markup, "offset")).toEqual(attr(rawAsset, "offset"));
    console.log(
      `parity tuple: viewBox ${attr(rawAsset, "viewBox")[0]}, paths ${assetPaths.length}, gradient ${attr(rawAsset, "x1")[0]},${attr(rawAsset, "y1")[0]} -> ${attr(rawAsset, "x2")[0]},${attr(rawAsset, "y2")[0]}, offsets ${attr(rawAsset, "offset")!.join("/")}`,
    );
  });

  it("renders every colorMode's stops from the fixture, never from a transcription", () => {
    const stopColors = (markup: string): string[] =>
      [...markup.matchAll(/stop-color="([^"]+)"/g)].map((match) => match[1]!);

    const light = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "light" }));
    expect(stopColors(light)).toEqual(
      ["start", "mid", "end"].map((s) => fixture.light[`--chase-logo-${s}`]!.candidate),
    );

    const dark = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "dark" }));
    expect(stopColors(dark)).toEqual(["start", "mid", "end"].map((s) => fixture.dark[`--chase-logo-${s}`]!.candidate));

    const auto = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "auto" }));
    expect(stopColors(auto)).toEqual(
      ["start", "mid", "end"].map((s) => `var(--chase-logo-${s}, ${fixture.light[`--chase-logo-${s}`]!.candidate})`),
    );
  });

  it("carries the forced-colors fallback in all three representations with the rendered gradient id bound", () => {
    const forcedRule = /@media \(forced-colors: active\)/;
    expect(rawAsset).toMatch(forcedRule);
    expect(rawAsset).toMatch(/@media \(forced-colors: active\) \{\s*#logoGradient stop \{\s*stop-color: CanvasText;/);
    expect(chaseSetsLogoSvg).toMatch(
      /@media \(forced-colors: active\) \{\s*#logoGradient stop \{\s*stop-color: CanvasText;/,
    );

    const markup = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "auto" }));
    const styleRule = markup.match(
      /@media \(forced-colors: active\) \{ #([\w:-]+) stop \{ stop-color: CanvasText; \} \}/,
    );
    expect(styleRule, "React component must carry an id-scoped forced-colors style child").not.toBeNull();
    const gradientId = markup.match(/<linearGradient id="([^"]+)"/);
    expect(gradientId).not.toBeNull();
    expect(styleRule![1], "forced-colors rule must bind the rendered useId-derived gradient id").toBe(gradientId![1]);
  });
});

describe("logo semantics and caller accessibility", () => {
  it("keeps the decorative mode hidden and the non-decorative mode named, with focus suppressed in both", () => {
    const decorative = renderToString(createElement(ChaseSetsLogo, { decorative: true }));
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    expect(decorative).not.toContain("aria-label=");
    expect(decorative).toContain('focusable="false"');

    const named = renderToString(createElement(ChaseSetsLogo, {}));
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Chase Sets"');
    expect(named).toContain('focusable="false"');

    const titled = renderToString(createElement(ChaseSetsLogo, { title: "Chase Sets logo" }));
    expect(titled).toContain('aria-label="Chase Sets logo"');
  });

  it("gives BrandLink exactly its label as accessible name, contributed by the link and never by the mark", () => {
    const markup = renderToString(createElement(BrandLink, { label: "Chase Sets" }));
    expect(markup).toContain('aria-label="Chase Sets"');
    // The mark inside is decorative: hidden from the tree and nameless.
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
  });

  it("keeps SellerBadge's generic container nameless while its verified state reads name-then-Verified", () => {
    const markup = renderToString(createElement(SellerBadge, { name: "Alpha Seller", verified: true }));
    const container = markup.match(/^<div ([^>]*)>/);
    expect(container).not.toBeNull();
    expect(container![1]).not.toContain("role=");
    expect(container![1]).not.toContain("aria-label");
    expect(markup.split("Alpha Seller").length - 1).toBe(1);
    expect(markup).toContain("Verified");
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("closed-set closure from the vector side", () => {
  it("parses the same thirty-two paths out of the raster-side sentinel block", () => {
    console.log(
      `combinedCandidatePaths as parsed on the vector side:\n${JSON.stringify(combinedCandidatePaths, null, 2)}`,
    );
    expect(combinedCandidatePaths.length).toBe(32);
    expect(new Set(combinedCandidatePaths).size).toBe(32);
    expect(combinedCandidatePaths).toContain("packages/design-system/src/styles/styles.css");
    expect(combinedCandidatePaths).toContain("infrastructure/playwright-evidence/responsive-evidence-manifest.json");
  });

  it("takes a changed-path set as an explicit argument and reports missing and extra paths by name", () => {
    const evaluate = (changedPaths: string[]) => {
      const changed = new Set(changedPaths);
      const published = new Set(combinedCandidatePaths);
      return {
        missing: combinedCandidatePaths.filter((p) => !changed.has(p)),
        extra: [...changed].filter((p) => !published.has(p)),
      };
    };

    // Synthetic controls, passed directly -- never read from an ambient
    // changed-files variable.
    const omitted = evaluate(combinedCandidatePaths.filter((p) => p !== "pnpm-lock.yaml"));
    expect(omitted.missing).toEqual(["pnpm-lock.yaml"]);
    const added = evaluate([...combinedCandidatePaths, "packages/design-system/src/scratch.ts"]);
    expect(added.extra).toEqual(["packages/design-system/src/scratch.ts"]);

    // The real candidate set, when one is in flight.
    const mergeBase = execFileSync("git", ["-C", root, "merge-base", "HEAD", "refs/remotes/origin/main"], {
      encoding: "utf8",
    }).trim();
    const tracked = execFileSync("git", ["-C", root, "diff", "--name-only", mergeBase], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const untracked = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(3).trim());
    const changed = [...new Set([...tracked, ...untracked])];
    console.log(`real changed-path set on the vector side (${changed.length}):\n${JSON.stringify(changed, null, 2)}`);
    if (changed.some((p) => combinedCandidatePaths.includes(p))) {
      const report = evaluate(changed);
      expect(report.missing, "paths the candidate is missing").toEqual([]);
      expect(report.extra, "paths outside the published thirty-two").toEqual([]);
    } else {
      const identity = evaluate(combinedCandidatePaths);
      expect(identity.missing).toEqual([]);
      expect(identity.extra).toEqual([]);
    }
  });

  it("derives the receipt-source digest paths from both probe specs and proves the candidate touches none", () => {
    const probeSpecs = [
      "deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts",
      "deployables/marketplace/e2e/payout-connect-appearance.uat.spec.ts",
    ];
    const derived = new Set<string>();
    for (const spec of probeSpecs) {
      for (const path of deriveReceiptSourceDigestPaths(readFileSync(join(root, spec), "utf8"))) {
        derived.add(path);
      }
    }
    console.log(`derived receiptSourceDigestPaths union:\n${JSON.stringify([...derived].sort(), null, 2)}`);
    expect(derived.size).toBe(5);
    const intersection = [...derived].filter((path) => combinedCandidatePaths.includes(path));
    expect(intersection, "digest-bound paths inside the candidate").toEqual([]);
  });

  it("keeps the fixtures directory at exactly its four committed files", () => {
    const entries = readdirSync(join(designSystemSrc, "theme", "__fixtures__")).sort();
    expect(entries).toEqual([
      "ink-foil-candidate-tokens.json",
      "ink-foil-candidate-tokens.schema.json",
      "stripe-appearance-acceptance-receipt.schema.json",
      "stripe-connect-discovery.schema.json",
    ]);
  });
});
