import fs from "node:fs";
import path from "node:path";
import { createRef, forwardRef, type AnchorHTMLAttributes, type ReactElement, type Ref } from "react";
import ts from "@chase-sets/typescript-compiler-api";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Card,
  DetailPanel,
  Inset,
  KeyValueList,
  MarketplaceDashboardPanel,
  SpecificationList,
  Stat,
  Surface,
} from "../index";

type SurfaceKind = "surface" | "inset";

interface SurfaceFrame {
  kind: SurfaceKind;
  tag: string;
}

interface SurfaceViolation {
  file: string;
  line: number;
  tag: string;
  parent: string;
  reason: string;
}

const cardLikeExports = new Set(["Card", "Surface", "DetailPanel"]);
const insetExports = new Set(["Inset"]);
const rowListExports = new Set(["KeyValueList"]);
const scanRoots = ["bounded-contexts", "packages/design-system/src"];

function repositoryRoot() {
  let candidate = process.cwd();
  while (!fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

function scanFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") {
      return [];
    }

    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return scanFiles(fullPath);
    }

    return entry.name.endsWith(".tsx") ? [fullPath] : [];
  });
}

function isDesignSystemSurfaceSource(source: string) {
  return (
    source === "@chase-sets/design-system" ||
    source.endsWith("/card") ||
    source.endsWith("/layout") ||
    source.endsWith("/data-display") ||
    source.endsWith("/commerce")
  );
}

function nearestSurface(stack: readonly SurfaceFrame[]) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];

    if (frame.kind === "surface" || frame.kind === "inset") {
      return frame;
    }
  }

  return null;
}

function jsxTagName(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) {
    return tag.text;
  }

  if (ts.isPropertyAccessExpression(tag)) {
    return tag.name.text;
  }

  return "";
}

function hasSurfaceVariant(node: ts.JsxElement | ts.JsxSelfClosingElement) {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes.properties : node.attributes.properties;

  return attributes.some((attribute) => {
    if (
      !ts.isJsxAttribute(attribute) ||
      !ts.isIdentifier(attribute.name) ||
      attribute.name.text !== "variant" ||
      !attribute.initializer
    ) {
      return false;
    }

    return ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "surface";
  });
}

function collectSurfaceNames(sourceFile: ts.SourceFile, filePath: string) {
  const cardLikeNames = new Set<string>();
  const insetNames = new Set<string>();
  const rowListNames = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const source = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";

      if (ts.isNamedImports(node.importClause.namedBindings) && isDesignSystemSurfaceSource(source)) {
        for (const specifier of node.importClause.namedBindings.elements) {
          const exportedName = (specifier.propertyName ?? specifier.name).text;

          if (cardLikeExports.has(exportedName)) {
            cardLikeNames.add(specifier.name.text);
          }

          if (insetExports.has(exportedName)) {
            insetNames.add(specifier.name.text);
          }

          if (rowListExports.has(exportedName)) {
            rowListNames.add(specifier.name.text);
          }
        }
      }
    }

    if (filePath.includes(path.join("packages", "design-system", "src"))) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        if (cardLikeExports.has(node.name.text)) {
          cardLikeNames.add(node.name.text);
        }

        if (insetExports.has(node.name.text)) {
          insetNames.add(node.name.text);
        }

        if (rowListExports.has(node.name.text)) {
          rowListNames.add(node.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { cardLikeNames, insetNames, rowListNames };
}

function surfaceHierarchyViolations(root: string): SurfaceViolation[] {
  return scanRoots.flatMap((scanRoot) => {
    const absoluteRoot = path.join(root, scanRoot);

    if (!fs.existsSync(absoluteRoot)) {
      return [];
    }

    return scanFiles(absoluteRoot).flatMap((filePath) => {
      const sourceText = fs.readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const { cardLikeNames, insetNames, rowListNames } = collectSurfaceNames(sourceFile, filePath);
      const violations: SurfaceViolation[] = [];

      function visit(node: ts.Node, stack: SurfaceFrame[]) {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = ts.isJsxElement(node) ? jsxTagName(node.openingElement.tagName) : jsxTagName(node.tagName);
          const kind: SurfaceKind | null = cardLikeNames.has(tag) ? "surface" : insetNames.has(tag) ? "inset" : null;

          if (kind) {
            const parent = nearestSurface(stack);

            if (parent && (kind === "surface" || parent.kind === "inset")) {
              const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
              violations.push({
                file: path.relative(root, filePath),
                line: position.line + 1,
                tag,
                parent: parent.tag,
                reason:
                  kind === "surface"
                    ? "card-like surfaces must not be nested; use Inset for one recessed child level"
                    : "Inset must not be nested inside another Inset",
              });
            }

            visitChildren(node, [...stack, { kind, tag }]);
            return;
          }

          if (rowListNames.has(tag) && hasSurfaceVariant(node)) {
            const parent = nearestSurface(stack);

            if (parent) {
              const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
              violations.push({
                file: path.relative(root, filePath),
                line: position.line + 1,
                tag,
                parent: parent.tag,
                reason: "framed key/value row lists must not sit inside card-like surfaces; use the default plain rows",
              });
            }
          }
        }

        visitChildren(node, stack);
      }

      function visitChildren(node: ts.Node, stack: SurfaceFrame[]) {
        ts.forEachChild(node, (child) => visit(child, stack));
      }

      visit(sourceFile, []);

      return violations;
    });
  });
}

describe("surface hierarchy", () => {
  it("uses Inset as the only nested surface level", () => {
    const violations = surfaceHierarchyViolations(repositoryRoot());

    expect(violations).toEqual([]);
  }, 15_000);

  it("renders insets and metric wells with the recessed cutout treatment", () => {
    expect(renderToString(<Inset>One nested child level</Inset>)).toContain("inset-surface");
    expect(renderToString(<Stat label="Results" value="72" />)).toContain("inset-surface");
    expect(
      renderToString(<MarketplaceDashboardPanel title="Operations" metrics={[{ label: "Attention", value: "1" }]} />),
    ).toContain("inset-surface");
  });

  it("keeps read-only detail rows visually flat inside panels", () => {
    const keyValueMarkup = renderToString(
      <DetailPanel title="projection-generation-retention">
        <KeyValueList items={[{ key: "RUNNER_NAME", value: "projection-generation-retention" }]} />
      </DetailPanel>,
    );
    const specsMarkup = renderToString(
      <SpecificationList
        title="Selected detail"
        specs={[{ label: "RUNNER_NAME", value: "projection-generation-retention" }]}
      />,
    );

    expect(keyValueMarkup).not.toContain("modern-surface");
    expect(keyValueMarkup).not.toContain("inset-surface");
    expect(specsMarkup).not.toContain("overflow-hidden rounded-[var(--radius)] border");
  });
});

const cardVariants = ["default", "product", "feature", "stat"] as const;
type CardVariantName = (typeof cardVariants)[number];

const elevations = ["flush", "tinted", "outlined", "elevated"] as const;
type ElevationName = (typeof elevations)[number];

const surfaceTones = [
  "default",
  "muted",
  "accent",
  "subtle",
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "trust",
  "primary",
] as const;
type SurfaceToneName = (typeof surfaceTones)[number];

function rootElement(ui: ReactElement): HTMLElement {
  const { container } = render(ui);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("expected the rendered tree to have a root element");
  }
  return root;
}

/**
 * Frozen Card `variant` × `elevation` oracle: fill family driven by `variant`
 * wherever a fill exists, fill presence and glass/border/shadow driven only by
 * `elevation`. Every cell is a committed literal.
 */
const cardElevationMatrix: Record<ElevationName, Record<CardVariantName, string>> = {
  flush: {
    default: "rounded-tokenLg overflow-hidden p-4",
    product: "rounded-tokenLg overflow-hidden p-4",
    feature: "rounded-tokenLg overflow-hidden p-4",
    stat: "rounded-tokenLg overflow-hidden p-4",
  },
  tinted: {
    default: "rounded-tokenLg overflow-hidden bg-surface-2 p-4",
    product: "rounded-tokenLg overflow-hidden bg-surface-2 p-4",
    feature: "rounded-tokenLg overflow-hidden bg-surface-2 p-4",
    stat: "rounded-tokenLg overflow-hidden bg-surface-2 p-4",
  },
  outlined: {
    default: "rounded-tokenLg border border-muted overflow-hidden bg-surface p-4",
    product: "rounded-tokenLg border border-muted overflow-hidden bg-surface p-4",
    feature: "rounded-tokenLg border border-muted overflow-hidden bg-surface-2 p-4",
    stat: "rounded-tokenLg border border-muted overflow-hidden bg-surface-2 p-4",
  },
  elevated: {
    default: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden p-4",
    product: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface p-4",
    feature: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 p-4",
    stat: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 p-4",
  },
};

/**
 * State chrome follows the elevation's chrome budget: full hover affordance
 * under legacy/`elevated`/`outlined`, bare `cursor-pointer transition` under
 * `flush`/`tinted`, and `ds-glow` only where the elevation carries a shadow.
 */
const cardInteractiveChrome: Record<"legacy" | ElevationName, string> = {
  legacy:
    "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  flush: "rounded-tokenLg overflow-hidden cursor-pointer transition p-4",
  tinted: "rounded-tokenLg overflow-hidden bg-surface-2 cursor-pointer transition p-4",
  outlined:
    "rounded-tokenLg border border-muted overflow-hidden bg-surface cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  elevated:
    "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
};

const cardGlowChrome: Record<"legacy" | ElevationName, string> = {
  legacy: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden ds-glow p-4",
  flush: "rounded-tokenLg overflow-hidden p-4",
  tinted: "rounded-tokenLg overflow-hidden bg-surface-2 p-4",
  outlined: "rounded-tokenLg border border-muted overflow-hidden bg-surface p-4",
  elevated: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden ds-glow p-4",
};

/**
 * Frozen Surface `tone` × `elevation` oracle. Each cell is the complete
 * rendered class string at the default system padding (`p-4`), committed as a
 * literal: `flush` keeps only the tone's text part, `tinted` the soft fill plus
 * text, `outlined` a plain border in the tone's border-color family plus
 * today's fill and text, and `elevated` the exact legacy `elevated=true`
 * output.
 */
const surfaceElevationMatrix: Record<ElevationName, Record<SurfaceToneName, string>> = {
  flush: {
    default: "min-w-0 max-w-full rounded-tokenLg p-4",
    muted: "min-w-0 max-w-full rounded-tokenLg p-4",
    accent: "min-w-0 max-w-full rounded-tokenLg p-4",
    subtle: "min-w-0 max-w-full rounded-tokenLg p-4",
    neutral: "min-w-0 max-w-full rounded-tokenLg text-secondary p-4",
    info: "min-w-0 max-w-full rounded-tokenLg text-info p-4",
    success: "min-w-0 max-w-full rounded-tokenLg text-success p-4",
    warning: "min-w-0 max-w-full rounded-tokenLg text-warning p-4",
    danger: "min-w-0 max-w-full rounded-tokenLg text-danger p-4",
    trust: "min-w-0 max-w-full rounded-tokenLg text-trust p-4",
    primary: "min-w-0 max-w-full rounded-tokenLg text-primary p-4",
  },
  tinted: {
    default: "min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4",
    muted: "min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4",
    accent: "min-w-0 max-w-full rounded-tokenLg ds-brand-gradient text-accent-contrast p-4",
    subtle: "min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4",
    neutral: "min-w-0 max-w-full rounded-tokenLg bg-surface-2 text-secondary p-4",
    info: "min-w-0 max-w-full rounded-tokenLg bg-info-soft text-info p-4",
    success: "min-w-0 max-w-full rounded-tokenLg bg-success-soft text-success p-4",
    warning: "min-w-0 max-w-full rounded-tokenLg bg-warning-soft text-warning p-4",
    danger: "min-w-0 max-w-full rounded-tokenLg bg-danger-soft text-danger p-4",
    trust: "min-w-0 max-w-full rounded-tokenLg bg-trust-soft text-trust p-4",
    primary: "min-w-0 max-w-full rounded-tokenLg bg-primary-soft text-primary p-4",
  },
  outlined: {
    default: "min-w-0 max-w-full rounded-tokenLg border border-muted bg-elevated p-4",
    muted: "min-w-0 max-w-full rounded-tokenLg border border-muted bg-surface-2 p-4",
    accent: "min-w-0 max-w-full rounded-tokenLg border border-muted ds-brand-gradient text-accent-contrast p-4",
    subtle: "min-w-0 max-w-full rounded-tokenLg border border-muted bg-surface p-4",
    neutral: "min-w-0 max-w-full rounded-tokenLg border border-muted bg-surface-2 text-secondary p-4",
    info: "min-w-0 max-w-full rounded-tokenLg border border-info-soft bg-info-soft text-info p-4",
    success: "min-w-0 max-w-full rounded-tokenLg border border-success-soft bg-success-soft text-success p-4",
    warning: "min-w-0 max-w-full rounded-tokenLg border border-warning-soft bg-warning-soft text-warning p-4",
    danger: "min-w-0 max-w-full rounded-tokenLg border border-danger-soft bg-danger-soft text-danger p-4",
    trust: "min-w-0 max-w-full rounded-tokenLg border border-trust-soft bg-trust-soft text-trust p-4",
    primary: "min-w-0 max-w-full rounded-tokenLg border border-primary-soft bg-primary-soft text-primary p-4",
  },
  elevated: {
    default: "surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated p-4 shadow-tokenLg",
    muted: "surface-border min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4 shadow-tokenLg",
    accent:
      "surface-border min-w-0 max-w-full rounded-tokenLg ds-brand-gradient text-accent-contrast p-4 shadow-tokenLg",
    subtle: "surface-border min-w-0 max-w-full rounded-tokenLg bg-surface border-muted p-4 shadow-tokenLg",
    neutral:
      "surface-border min-w-0 max-w-full rounded-tokenLg border-muted bg-surface-2 text-secondary p-4 shadow-tokenLg",
    info: "surface-border min-w-0 max-w-full rounded-tokenLg border-info-soft bg-info-soft text-info p-4 shadow-tokenLg",
    success:
      "surface-border min-w-0 max-w-full rounded-tokenLg border-success-soft bg-success-soft text-success p-4 shadow-tokenLg",
    warning:
      "surface-border min-w-0 max-w-full rounded-tokenLg border-warning-soft bg-warning-soft text-warning p-4 shadow-tokenLg",
    danger:
      "surface-border min-w-0 max-w-full rounded-tokenLg border-danger-soft bg-danger-soft text-danger p-4 shadow-tokenLg",
    trust:
      "surface-border min-w-0 max-w-full rounded-tokenLg border-trust-soft bg-trust-soft text-trust p-4 shadow-tokenLg",
    primary:
      "surface-border min-w-0 max-w-full rounded-tokenLg border-primary-soft bg-primary-soft text-primary p-4 shadow-tokenLg",
  },
};

const surfaceGlowChrome: Record<"legacy" | ElevationName, string> = {
  legacy: "surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated p-4 shadow-tokenSm ds-glow",
  flush: "min-w-0 max-w-full rounded-tokenLg p-4",
  tinted: "min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4",
  outlined: "min-w-0 max-w-full rounded-tokenLg border border-muted bg-elevated p-4",
  elevated: "surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated p-4 shadow-tokenLg ds-glow",
};

describe("Card elevation oracle", () => {
  const cells = elevations.flatMap((elevation) => cardVariants.map((variant) => ({ elevation, variant })));

  it.each(cells)("pins the Card $variant × $elevation cell", ({ elevation, variant }) => {
    expect(
      rootElement(
        <Card variant={variant} elevation={elevation}>
          cell content
        </Card>,
      ).className,
    ).toBe(cardElevationMatrix[elevation][variant]);
  });

  it.each(["legacy", ...elevations] as const)("pins the Card interactive state chrome for %s", (cell) => {
    expect(
      rootElement(
        <Card interactive elevation={cell === "legacy" ? undefined : cell}>
          cell content
        </Card>,
      ).className,
    ).toBe(cardInteractiveChrome[cell]);
  });

  it.each(["legacy", ...elevations] as const)("pins the Card glow state chrome for %s", (cell) => {
    expect(
      rootElement(
        <Card glow elevation={cell === "legacy" ? undefined : cell}>
          cell content
        </Card>,
      ).className,
    ).toBe(cardGlowChrome[cell]);
  });
});

describe("Surface elevation oracle", () => {
  const cells = elevations.flatMap((elevation) => surfaceTones.map((tone) => ({ elevation, tone })));

  it.each(cells)("pins the Surface $tone × $elevation cell", ({ elevation, tone }) => {
    expect(
      rootElement(
        <Surface tone={tone} elevation={elevation}>
          cell content
        </Surface>,
      ).className,
    ).toBe(surfaceElevationMatrix[elevation][tone]);
  });

  it.each(["legacy", ...elevations] as const)("pins the Surface glow state chrome for %s", (cell) => {
    expect(
      rootElement(
        <Surface glow elevation={cell === "legacy" ? undefined : cell}>
          cell content
        </Surface>,
      ).className,
    ).toBe(surfaceGlowChrome[cell]);
  });
});

/**
 * Legacy default byte-identity: every `variant` × `media` × `interactive` ×
 * `glow` permutation with NO `elevation` prop renders today's exact class
 * string, committed as literals.
 */
const legacyCardDefaults: ReadonlyArray<{
  variant: CardVariantName;
  media: boolean;
  interactive: boolean;
  glow: boolean;
  expected: string;
}> = [
  {
    variant: "default",
    media: false,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden p-4",
  },
  {
    variant: "default",
    media: false,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden ds-glow p-4",
  },
  {
    variant: "default",
    media: false,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  },
  {
    variant: "default",
    media: false,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow p-4",
  },
  {
    variant: "default",
    media: true,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden",
  },
  {
    variant: "default",
    media: true,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden ds-glow",
  },
  {
    variant: "default",
    media: true,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
  },
  {
    variant: "default",
    media: true,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow",
  },
  {
    variant: "product",
    media: false,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface p-4",
  },
  {
    variant: "product",
    media: false,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface ds-glow p-4",
  },
  {
    variant: "product",
    media: false,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  },
  {
    variant: "product",
    media: false,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow p-4",
  },
  {
    variant: "product",
    media: true,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface",
  },
  {
    variant: "product",
    media: true,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface ds-glow",
  },
  {
    variant: "product",
    media: true,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
  },
  {
    variant: "product",
    media: true,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow",
  },
  {
    variant: "feature",
    media: false,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 p-4",
  },
  {
    variant: "feature",
    media: false,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 ds-glow p-4",
  },
  {
    variant: "feature",
    media: false,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  },
  {
    variant: "feature",
    media: false,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow p-4",
  },
  {
    variant: "feature",
    media: true,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2",
  },
  {
    variant: "feature",
    media: true,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 ds-glow",
  },
  {
    variant: "feature",
    media: true,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
  },
  {
    variant: "feature",
    media: true,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow",
  },
  {
    variant: "stat",
    media: false,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 p-4",
  },
  {
    variant: "stat",
    media: false,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 ds-glow p-4",
  },
  {
    variant: "stat",
    media: false,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  },
  {
    variant: "stat",
    media: false,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow p-4",
  },
  {
    variant: "stat",
    media: true,
    interactive: false,
    glow: false,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2",
  },
  {
    variant: "stat",
    media: true,
    interactive: false,
    glow: true,
    expected: "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 ds-glow",
  },
  {
    variant: "stat",
    media: true,
    interactive: true,
    glow: false,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
  },
  {
    variant: "stat",
    media: true,
    interactive: true,
    glow: true,
    expected:
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden bg-surface-2 cursor-pointer transition hover:border-accent hover:shadow-tokenMd ds-glow",
  },
];

describe("Card legacy defaults stay byte-identical without an elevation prop", () => {
  it.each(legacyCardDefaults)(
    "keeps the $variant variant default (media=$media interactive=$interactive glow=$glow)",
    ({ variant, media, interactive, glow, expected }) => {
      expect(
        rootElement(
          <Card
            variant={variant}
            interactive={interactive}
            glow={glow}
            media={media ? <img alt="" src="about:blank" /> : undefined}
          >
            cell content
          </Card>,
        ).className,
      ).toBe(expected);
    },
  );
});

describe("Card explicit-elevated preservation", () => {
  const preservationCells = cardVariants.flatMap((variant) =>
    [false, true].flatMap((media) =>
      [false, true].flatMap((interactive) =>
        [false, true].flatMap((glow) =>
          (["hidden", "visible"] as const).map((overflow) => ({ variant, media, interactive, glow, overflow })),
        ),
      ),
    ),
  );

  it.each(preservationCells)(
    "renders explicit elevated byte-identical to omitted for $variant media=$media interactive=$interactive glow=$glow overflow=$overflow",
    ({ variant, media, interactive, glow, overflow }) => {
      const shared = {
        variant,
        interactive,
        glow,
        overflow,
        media: media ? <img alt="" src="about:blank" /> : undefined,
      };
      expect(
        renderToString(
          <Card {...shared} elevation="elevated">
            cell content
          </Card>,
        ),
      ).toBe(renderToString(<Card {...shared}>cell content</Card>));
    },
  );
});

describe("Card structural composites preserve overflow and media anatomy", () => {
  const composites = [
    { title: "default/flush", variant: "default", elevation: "flush", expected: "rounded-tokenLg overflow-visible" },
    {
      title: "product/tinted",
      variant: "product",
      elevation: "tinted",
      expected: "rounded-tokenLg overflow-visible bg-surface-2",
    },
    {
      title: "feature/outlined",
      variant: "feature",
      elevation: "outlined",
      expected: "rounded-tokenLg border border-muted overflow-visible bg-surface-2",
    },
  ] as const;

  it.each(composites)("keeps the $title composite anatomy", ({ variant, elevation, expected }) => {
    const { container, getByTestId } = render(
      <Card
        variant={variant}
        elevation={elevation}
        overflow="visible"
        media={<img data-testid="composite-media" alt="" src="about:blank" />}
      >
        composite content
      </Card>,
    );
    const root = container.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("expected the composite Card to render a root element");
    }

    expect(root.className).toBe(expected);
    expect(root.children).toHaveLength(2);
    const [mediaWrapper, contentWrapper] = Array.from(root.children);
    expect(mediaWrapper.contains(getByTestId("composite-media"))).toBe(true);
    expect(mediaWrapper.className).toBe("");
    expect(contentWrapper.className).toBe("p-4");
    expect(contentWrapper.textContent).toBe("composite content");
  });
});

interface TestLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

const TestLink = forwardRef<HTMLAnchorElement, TestLinkProps>(function TestLink({ to, children, ...rest }, ref) {
  return (
    <a ref={ref} href={to} {...rest}>
      {children}
    </a>
  );
});

const surfaceSystemProps = {
  padding: { base: 4, md: 8 },
  paddingX: { base: 2, lg: 4 },
  paddingY: { base: 1, sm: 3 },
  gap: { base: 2, lg: 6 },
  textAlign: "center",
} as const;

const surfaceSystemFragment = "p-4 md:p-8 px-2 lg:px-4 py-1 sm:py-3 gap-2 lg:gap-6 text-center";

describe("Surface explicit-elevation preservation across system props and polymorphism", () => {
  it("preserves the flush row: as wins target precedence", () => {
    const ref = createRef<HTMLElement>();
    const { getByTestId } = render(
      <Surface
        tone="neutral"
        elevation="flush"
        as="section"
        render="article"
        element="aside"
        ref={ref}
        data-testid="flush-surface-row"
        aria-label="flush surface row"
        {...surfaceSystemProps}
      >
        flush row content
      </Surface>,
    );

    const row = getByTestId("flush-surface-row");
    expect(row.tagName).toBe("SECTION");
    expect(row.className).toBe(`min-w-0 max-w-full rounded-tokenLg text-secondary ${surfaceSystemFragment}`);
    expect(row.getAttribute("aria-label")).toBe("flush surface row");
    expect(row.textContent).toBe("flush row content");
    expect(ref.current).toBe(row);
  });

  it("preserves the tinted row: render wins target precedence", () => {
    const ref = createRef<HTMLElement>();
    const { getByTestId } = render(
      <Surface
        tone="success"
        elevation="tinted"
        render="article"
        element="aside"
        ref={ref}
        data-testid="tinted-surface-row"
        aria-label="tinted surface row"
        {...surfaceSystemProps}
      >
        tinted row content
      </Surface>,
    );

    const row = getByTestId("tinted-surface-row");
    expect(row.tagName).toBe("ARTICLE");
    expect(row.className).toBe(
      `min-w-0 max-w-full rounded-tokenLg bg-success-soft text-success ${surfaceSystemFragment}`,
    );
    expect(row.getAttribute("aria-label")).toBe("tinted surface row");
    expect(row.textContent).toBe("tinted row content");
    expect(ref.current).toBe(row);
  });

  it("preserves the outlined row: element target", () => {
    const ref = createRef<HTMLDivElement>();
    const { getByTestId } = render(
      <Surface
        tone="warning"
        elevation="outlined"
        element="aside"
        ref={ref}
        data-testid="outlined-surface-row"
        aria-label="outlined surface row"
        {...surfaceSystemProps}
      >
        outlined row content
      </Surface>,
    );

    const row = getByTestId("outlined-surface-row");
    expect(row.tagName).toBe("ASIDE");
    expect(row.className).toBe(
      `min-w-0 max-w-full rounded-tokenLg border border-warning-soft bg-warning-soft text-warning ${surfaceSystemFragment}`,
    );
    expect(row.getAttribute("aria-label")).toBe("outlined surface row");
    expect(row.textContent).toBe("outlined row content");
    expect(ref.current).toBe(row);
  });

  it("preserves the elevated row: component target forwards `to` and the ref", () => {
    const ref = createRef<HTMLAnchorElement>();
    const { getByTestId } = render(
      <Surface
        tone="default"
        elevation="elevated"
        as={TestLink}
        to="/sets/holo-frontier"
        ref={ref}
        data-testid="elevated-surface-row"
        {...surfaceSystemProps}
      >
        elevated row content
      </Surface>,
    );

    const row = getByTestId("elevated-surface-row");
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/sets/holo-frontier");
    expect(row.className).toBe(
      `surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated ${surfaceSystemFragment} shadow-tokenLg`,
    );
    expect(row.textContent).toBe("elevated row content");
    expect(ref.current).toBe(row);
  });
});
