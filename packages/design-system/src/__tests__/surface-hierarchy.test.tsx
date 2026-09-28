import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRef, forwardRef, type AnchorHTMLAttributes, type ReactElement, type Ref } from "react";
import ts from "@chase-sets/typescript-compiler-api";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Card,
  DetailPanel,
  DetailConfidenceModule,
  FormPanel,
  Inset,
  KeyValueList,
  MarketplaceDashboardPanel,
  OfferCard,
  OrderProtectionModule,
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

function discoverCardEmitters(root: string) {
  const directory = path.join(root, "packages/design-system/src");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages/design-system/src"], { cwd: root })
    .toString()
    .split("\0")
    .filter(
      (file) => /\.tsx?$/.test(file) && !/(?:^|\/)(?:__tests__|dist|build|node_modules)\/|\.test\.|\.d\.ts$/.test(file),
    )
    .map((file) => path.resolve(root, file));
  const sources = new Map(
    tracked.map((file) => [
      file,
      ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
    ]),
  );
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent({ ...config.config, files: [], include: [] }, ts.sys, root).options;
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file, options);
  const declarations = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>();
  const exported = new Set<string>();
  const identity = (file: string, name: string) => `${path.resolve(file)}#${name}`;
  const hasExport = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const [file, source] of sources) {
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const id = identity(file, statement.name.text);
        declarations.set(id, statement);
        if (hasExport(statement)) exported.add(id);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const id = identity(file, declaration.name.text);
          declarations.set(id, declaration);
          if (hasExport(statement)) exported.add(id);
        }
      }
    }
  }
  function resolveModule(file: string, specifier: string) {
    const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, resolutionCache).resolvedModule;
    const target = resolved && path.resolve(resolved.resolvedFileName);
    return target && sources.has(target) ? target : undefined;
  }
  const exportResolutions = new Map<string, string>();
  const localResolutions = new Map<string, string | undefined>();
  function resolveExport(file: string, name: string, seen = new Set<string>()): string | undefined {
    const id = identity(file, name);
    const cached = exportResolutions.get(id);
    if (cached) return cached;
    if (seen.has(id)) return undefined;
    seen.add(id);
    if (exported.has(id)) return id;
    for (const statement of sources.get(file)?.statements ?? []) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const target =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveModule(file, statement.moduleSpecifier.text)
          : file;
      if (!target) continue;
      if (!statement.exportClause) {
        const match = resolveExport(target, name, seen);
        if (match) {
          exportResolutions.set(id, match);
          return match;
        }
      } else if (ts.isNamedExports(statement.exportClause)) {
        const entry = statement.exportClause.elements.find((entry) => !entry.isTypeOnly && entry.name.text === name);
        if (entry) {
          const match =
            target === file
              ? resolveLocal(sources.get(file)!, (entry.propertyName ?? entry.name).text, seen)
              : resolveExport(target, (entry.propertyName ?? entry.name).text, seen);
          if (match) exportResolutions.set(id, match);
          return match;
        }
      }
    }
    return undefined;
  }
  function resolveLocal(source: ts.SourceFile, name: string, seen = new Set<string>()): string | undefined {
    const id = identity(source.fileName, name);
    if (declarations.has(id)) return id;
    if (localResolutions.has(id)) return localResolutions.get(id);
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const entry = bindings.elements.find((entry) => !entry.isTypeOnly && entry.name.text === name);
      const target = entry && resolveModule(source.fileName, statement.moduleSpecifier.text);
      if (entry && target) {
        const match = resolveExport(target, (entry.propertyName ?? entry.name).text, seen);
        localResolutions.set(id, match);
        return match;
      }
    }
    localResolutions.set(id, undefined);
    return undefined;
  }
  const seed = identity(path.join(directory, "components/data-display/card.tsx"), "Card");
  const surface = identity(path.join(directory, "primitives/layout.tsx"), "Surface");
  const inset = identity(path.join(directory, "primitives/layout.tsx"), "Inset");
  const rowList = identity(path.join(directory, "components/data-display/key-value-list.tsx"), "KeyValueList");
  const edges = new Map<string, Set<string>>();
  const roots: Array<{ owner: string; node: ts.JsxOpeningElement | ts.JsxSelfClosingElement }> = [];
  for (const [id, declaration] of declarations) {
    const dependencies = new Set<string>();
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        const target = resolveLocal(declaration.getSourceFile(), node.tagName.text);
        if (target) dependencies.add(target);
        if (target === seed) roots.push({ owner: id, node });
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration);
    edges.set(id, dependencies);
  }
  const card = new Set([seed]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, dependencies] of edges) {
      if (!card.has(id) && [...dependencies].some((dependency) => card.has(dependency))) {
        card.add(id);
        changed = true;
      }
    }
  }
  const direct = [...exported].filter((id) => edges.get(id)?.has(seed)).sort();
  const transitive = [...exported].filter((id) => id !== seed && card.has(id) && !direct.includes(id)).sort();
  const nonCard = [...exported].filter((id) => !card.has(id)).sort();
  return { sources, exported, seed, card, surface, inset, rowList, direct, transitive, nonCard, roots, resolveLocal };
}

type CardDiscovery = ReturnType<typeof discoverCardEmitters>;
let productionDiscovery: CardDiscovery | undefined;
function productionCardEmitters() {
  return (productionDiscovery ??= discoverCardEmitters(repositoryRoot()));
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

function collectSurfaceNames(sourceFile: ts.SourceFile, discovery: CardDiscovery) {
  const designSystemSource = discovery.sources.has(path.resolve(sourceFile.fileName));
  const cardLikeNames = new Set<string>();
  const insetNames = new Set<string>();
  const rowListNames = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && !node.importClause.isTypeOnly) {
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        for (const specifier of node.importClause.namedBindings.elements) {
          if (specifier.isTypeOnly) continue;
          const id = discovery.resolveLocal(sourceFile, specifier.name.text);

          if (id && (discovery.card.has(id) || id === discovery.surface)) {
            cardLikeNames.add(specifier.name.text);
          }

          if (id === discovery.inset) {
            insetNames.add(specifier.name.text);
          }

          if (id === discovery.rowList) {
            rowListNames.add(specifier.name.text);
          }
        }
      }
    }

    if (designSystemSource) {
      if (
        (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        const id = discovery.resolveLocal(sourceFile, node.name.text);
        if (id && (discovery.card.has(id) || id === discovery.surface)) {
          cardLikeNames.add(node.name.text);
        }

        if (id === discovery.inset) {
          insetNames.add(node.name.text);
        }

        if (id === discovery.rowList) {
          rowListNames.add(node.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (designSystemSource) visit(sourceFile);
  else sourceFile.statements.filter(ts.isImportDeclaration).forEach(visit);

  return { cardLikeNames, insetNames, rowListNames };
}

function surfaceHierarchyViolations(root: string, discovery = discoverCardEmitters(root)): SurfaceViolation[] {
  return scanRoots.flatMap((scanRoot) => {
    const absoluteRoot = path.join(root, scanRoot);

    if (!fs.existsSync(absoluteRoot)) {
      return [];
    }

    return scanFiles(absoluteRoot).flatMap((filePath) => {
      const sourceFile =
        discovery.sources.get(filePath) ??
        ts.createSourceFile(
          filePath,
          fs.readFileSync(filePath, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
      const { cardLikeNames, insetNames, rowListNames } = collectSurfaceNames(sourceFile, discovery);
      if (cardLikeNames.size === 0 && insetNames.size === 0 && rowListNames.size === 0) return [];
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
    const violations = surfaceHierarchyViolations(repositoryRoot(), productionCardEmitters());

    expect(violations).toEqual([]);
  }, 15_000);

  it("partitions tracked production exports into Card, direct, transitive and non-Card identities", () => {
    const discovery = productionCardEmitters();
    const partition = [discovery.seed, ...discovery.direct, ...discovery.transitive, ...discovery.nonCard];
    expect(new Set(partition).size).toBe(partition.length);
    expect(partition.sort()).toEqual([...discovery.exported].sort());
    expect(discovery.direct).toEqual([...new Set(discovery.roots.map(({ owner }) => owner))].sort());
    expect(discovery.transitive.map((id) => id.split("#")[1])).toEqual([
      "CheckoutTrustPanel",
      "MarketplaceProductCard",
    ]);
    expect(discovery.nonCard).toContain(discovery.surface);
    expect(discovery.card.has(discovery.surface)).toBe(false);
  });

  it("discovers fixture-root Card closure through unconventional resolved aliases without Surface leakage or build output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-closure-"));
    const write = (file: string, source: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    };
    try {
      write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            moduleResolution: "Bundler",
            paths: { "@unusual/*": ["./packages/design-system/src/unconventional/*"] },
          },
        }),
      );
      write(
        "packages/design-system/src/components/data-display/card.tsx",
        "export function Card() { return <div />; }",
      );
      write(
        "packages/design-system/src/primitives/layout.tsx",
        "export function Surface() { return <div />; } export function Inset() { return <div />; }",
      );
      write(
        "packages/design-system/src/unconventional/direct.tsx",
        'import { Card as Entity } from "../components/data-display/card"; export function FixtureEntity() { return <Entity />; }',
      );
      write(
        "packages/design-system/src/unconventional/second.tsx",
        'import { FixtureEntity as Child } from "./direct"; export function FixtureSecondOrder() { return <Child />; }',
      );
      write(
        "packages/design-system/src/unconventional/furniture.tsx",
        'import { Surface as Frame } from "../primitives/layout"; export function FixtureSurfaceOnly() { return <Frame />; }',
      );
      write(
        "packages/design-system/src/unconventional/bridge.ts",
        'export { FixtureEntity as RenamedEntity } from "./direct"; export * from "./second"; export * from "./furniture";',
      );
      write(
        "bounded-contexts/example/ui.tsx",
        'import { Surface, Inset } from "../../packages/design-system/src/primitives/layout"; import { RenamedEntity as Direct, FixtureSecondOrder as Second, FixtureSurfaceOnly as Furniture } from "@unusual/bridge"; export function Example() { return <><Surface><Direct /><Second /><Furniture /><Inset><Second /></Inset></Surface></>; }',
      );
      write("bounded-contexts/example/not-design-system.tsx", "export function RenamedEntity() { return <div />; }");
      write(
        "bounded-contexts/example/unrelated.tsx",
        'import { RenamedEntity as Direct } from "./not-design-system"; import { Surface } from "../../packages/design-system/src/primitives/layout"; export function Unrelated() { return <Surface><Direct /></Surface>; }',
      );
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      const clean = discoverCardEmitters(root);
      expect(clean.direct.map((id) => id.split("#")[1])).toEqual(["FixtureEntity"]);
      expect(clean.transitive.map((id) => id.split("#")[1])).toEqual(["FixtureSecondOrder"]);
      expect(clean.nonCard.map((id) => id.split("#")[1])).toContain("FixtureSurfaceOnly");
      const violations = surfaceHierarchyViolations(root, clean);
      expect(violations.map(({ tag, parent }) => ({ tag, parent }))).toEqual([
        { tag: "Direct", parent: "Surface" },
        { tag: "Second", parent: "Surface" },
        { tag: "Second", parent: "Inset" },
      ]);
      write("packages/design-system/src/unconventional/direct.js", "export function GeneratedEntity() {}");
      write(
        "packages/design-system/src/unconventional/direct.d.ts",
        "export declare function GeneratedEntity(): void;",
      );
      write(
        "packages/design-system/src/dist/generated.tsx",
        'import { Card } from "../components/data-display/card"; export function GeneratedEntity() { return <Card />; }',
      );
      const built = discoverCardEmitters(root);
      expect([...built.exported]).toEqual([...clean.exported]);
      expect(built.direct).toEqual(clean.direct);
      expect(built.transitive).toEqual(clean.transitive);
      expect(built.nonCard).toEqual(clean.nonCard);
      expect(surfaceHierarchyViolations(root, built)).toEqual(violations);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
 * text, `outlined` a plain border in the tone's border tint family plus
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

describe("composed Card intent", () => {
  it("classifies every Card root exactly once with ruled intent after every spread", () => {
    const intent: Record<string, "tinted" | "elevated"> = {
      PriceBreakdown: "tinted",
      ListingPurchasePanel: "elevated",
      OrderIntentSummary: "tinted",
      OrderProtectionModule: "tinted",
      PaymentRecoveryPanel: "tinted",
      MessageThreadPreview: "tinted",
      DetailConfidenceModule: "tinted",
      SpecificationList: "tinted",
      ComparisonModule: "tinted",
      OfferCard: "elevated",
      MarketplaceDashboardPanel: "tinted",
      SearchFilterPanel: "tinted",
      AccountTrustCard: "elevated",
      RatingDistribution: "tinted",
      ActorIdentityCue: "tinted",
      DetailPanel: "tinted",
      AdminResourceDetailPage: "tinted",
      ProductCard: "elevated",
      CategoryTile: "elevated",
      FeatureCard: "elevated",
      TokenSwatch: "tinted",
      FormPanel: "tinted",
    };
    const roots = productionCardEmitters().roots;
    expect(roots.map(({ owner }) => owner.split("#")[1]).sort()).toEqual(Object.keys(intent).sort());
    for (const { owner, node } of roots) {
      const name = owner.split("#")[1]!;
      const attributes = [...node.attributes.properties];
      const elevations = attributes.filter(
        (attribute): attribute is ts.JsxAttribute =>
          ts.isJsxAttribute(attribute) && attribute.name.getText() === "elevation",
      );
      expect(elevations, owner).toHaveLength(1);
      const elevation = elevations[0]!;
      expect(attributes.slice(attributes.indexOf(elevation) + 1).some(ts.isJsxSpreadAttribute), owner).toBe(false);
      if (name === "DetailPanel") {
        expect(elevation.initializer?.getText()).toBe("{elevation}");
        let declaration: ts.Node = node;
        while (declaration.parent && !ts.isFunctionDeclaration(declaration)) declaration = declaration.parent;
        expect(ts.isFunctionDeclaration(declaration)).toBe(true);
        if (!ts.isFunctionDeclaration(declaration)) throw new Error("DetailPanel must own its default");
        const parameter = declaration.parameters[0]?.name;
        expect(parameter && ts.isObjectBindingPattern(parameter)).toBe(true);
        if (!parameter || !ts.isObjectBindingPattern(parameter)) throw new Error("DetailPanel must bind elevation");
        expect(
          parameter.elements.find((element) => element.name.getText() === "elevation")?.initializer?.getText(),
        ).toBe('"tinted"');
      } else {
        expect(
          elevation.initializer && ts.isStringLiteral(elevation.initializer) ? elevation.initializer.text : null,
          owner,
        ).toBe(intent[name]);
      }
    }
  });

  it("renders DetailConfidenceModule in its own tinted furniture cell", () => {
    expect(
      rootElement(<DetailConfidenceModule title="Confidence" items={[{ label: "Status", value: "Ready" }]} />)
        .className,
    ).toBe(cardElevationMatrix.tinted.default);
  });

  it("renders OrderProtectionModule in its own tinted furniture cell", () => {
    expect(
      rootElement(
        <OrderProtectionModule title="Protection" items={[{ title: "Protected", description: "Tracked shipment" }]} />,
      ).className,
    ).toBe(cardElevationMatrix.tinted.default);
  });

  it("renders MarketplaceDashboardPanel in its own tinted furniture cell", () => {
    expect(
      rootElement(<MarketplaceDashboardPanel title="Operations" metrics={[{ label: "Ready", value: "1" }]} />)
        .className,
    ).toBe(cardElevationMatrix.tinted.default);
  });

  it("renders FormPanel in its own tinted furniture cell without glow", () => {
    expect(rootElement(<FormPanel glow>Form content</FormPanel>).className).toBe(cardElevationMatrix.tinted.default);
  });

  it("renders OfferCard in its own elevated entity cell", () => {
    expect(rootElement(<OfferCard title="Offer" amount="$25" details="One card" />).className).toBe(
      cardElevationMatrix.elevated.default,
    );
  });

  it("defaults DetailPanel to tinted while preserving the explicit elevated override", () => {
    expect(rootElement(<DetailPanel title="Feedback">Populated feedback</DetailPanel>).className).toBe(
      cardElevationMatrix.tinted.default,
    );
    expect(
      rootElement(
        <DetailPanel title="Feedback" elevation="elevated">
          Populated feedback
        </DetailPanel>,
      ).className,
    ).toBe(cardElevationMatrix.elevated.default);
  });
});

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
  it("classifies every design-system Surface emission with an explicit elevation", () => {
    const root = repositoryRoot();
    const bareRoots: string[] = [];
    let emissions = 0;

    for (const file of scanFiles(path.join(root, "packages/design-system/src"))) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          ts.isIdentifier(node.tagName) &&
          node.tagName.text === "Surface"
        ) {
          emissions += 1;
          if (
            !node.attributes.properties.some(
              (attribute) =>
                ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "elevation" && attribute.initializer,
            )
          ) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            bareRoots.push(`${path.relative(root, file)}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }

    expect(emissions).toBeGreaterThanOrEqual(14);
    expect(bareRoots).toEqual([]);
  });

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
