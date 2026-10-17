import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRef, forwardRef, type AnchorHTMLAttributes, type ReactElement, type Ref } from "react";
import ts from "@chase-sets/typescript-compiler-api";
import { fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SurfaceOwnProps } from "../primitives/layout";
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
  const raisedEdges = new Map<string, Set<string>>();
  const roots: Array<{ owner: string; node: ts.JsxOpeningElement | ts.JsxSelfClosingElement }> = [];
  for (const [id, declaration] of declarations) {
    const dependencies = new Set<string>();
    const raisedDependencies = new Set<string>();
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        const target = resolveLocal(declaration.getSourceFile(), node.tagName.text);
        if (target) dependencies.add(target);
        if (target && (target !== surface || !hasFlatElevation(node))) raisedDependencies.add(target);
        if (target === seed) roots.push({ owner: id, node });
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration);
    edges.set(id, dependencies);
    raisedEdges.set(id, raisedDependencies);
  }
  const card = new Set([seed]);
  const surfaceEmitters = new Set([surface]);
  const raisedSurfaceEmitters = new Set([surface]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, dependencies] of edges) {
      for (const [closure, targets] of [
        [card, dependencies],
        [surfaceEmitters, dependencies],
        [raisedSurfaceEmitters, raisedEdges.get(id)!],
      ] as const) {
        if (!closure.has(id) && [...targets].some((dependency) => closure.has(dependency))) {
          closure.add(id);
          changed = true;
        }
      }
    }
  }
  const direct = [...exported].filter((id) => edges.get(id)?.has(seed)).sort();
  const transitive = [...exported].filter((id) => id !== seed && card.has(id) && !direct.includes(id)).sort();
  const nonCard = [...exported].filter((id) => !card.has(id)).sort();
  return {
    sources,
    exported,
    seed,
    card,
    surface,
    surfaceEmitters,
    raisedSurfaceEmitters,
    surfaceDirect: [...exported].filter((id) => edges.get(id)?.has(surface)).sort(),
    surfaceTransitive: [...exported]
      .filter((id) => id !== surface && surfaceEmitters.has(id) && !edges.get(id)?.has(surface))
      .sort(),
    inset,
    rowList,
    direct,
    transitive,
    nonCard,
    roots,
    resolveLocal,
    resolveModule,
    resolveExport,
  };
}

type CardDiscovery = ReturnType<typeof discoverCardEmitters>;
let productionDiscovery: CardDiscovery | undefined;
function productionCardEmitters() {
  return (productionDiscovery ??= discoverCardEmitters(repositoryRoot()));
}

const directCardScanRoots = ["bounded-contexts", "deployables", "packages/design-system/src"];

function directCardCandidates(root: string) {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...directCardScanRoots], { cwd: root })
    .toString()
    .split("\0")
    .filter((file) => file.endsWith(".tsx"));
  // Test/fixture conventions are non-production; generated directories follow
  // .gitignore and tsconfig.json. No feature-name or Card-consumer exceptions.
  const excluded = tracked.filter((file) =>
    /(?:^|\/)(?:__tests__|__fixtures__|node_modules|dist|build|coverage|\.react-router)\/|\.(?:test|spec)\.tsx$/.test(
      file,
    ),
  );
  const candidates = tracked.filter((file) => !excluded.includes(file));
  const digest = createHash("sha256").update(JSON.stringify({ tracked, excluded, candidates })).digest("hex");
  return { tracked, excluded, candidates, digest };
}

function directCardRoots(source: ts.SourceFile, discovery: CardDiscovery, seed = discovery.seed) {
  const roots: Array<{ file: string; line: number; tag: string; explicit: boolean }> = [];
  function isCard(tag: ts.JsxTagNameExpression) {
    if (ts.isIdentifier(tag)) return discovery.resolveLocal(source, tag.text) === seed;
    if (!ts.isPropertyAccessExpression(tag) || !ts.isIdentifier(tag.expression)) return false;
    const namespace = tag.expression.text;
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamespaceImport(bindings) || bindings.name.text !== namespace) continue;
      const target = discovery.resolveModule(source.fileName, statement.moduleSpecifier.text);
      return !!target && discovery.resolveExport(target, tag.name.text) === seed;
    }
    return false;
  }
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isCard(node.tagName)) {
      roots.push({
        file: path.relative(repositoryRoot(), source.fileName).replaceAll("\\", "/"),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        tag: node.tagName.getText(source),
        explicit: node.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "elevation" && !!attribute.initializer,
        ),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return roots;
}

function scanDirectCards(root: string, discovery = productionCardEmitters(), seed = discovery.seed) {
  const partition = directCardCandidates(root);
  const roots = partition.candidates.flatMap((file) => {
    const absolute = path.resolve(root, file);
    return directCardRoots(
      ts.createSourceFile(absolute, fs.readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
      discovery,
      seed,
    );
  });
  return { ...partition, roots, violations: roots.filter((root) => !root.explicit) };
}

function hasFlatElevation(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
  const attributes = node.attributes.properties;
  const lastSpread = attributes.reduce(
    (last, attribute, index) => (ts.isJsxSpreadAttribute(attribute) ? index : last),
    -1,
  );
  return attributes.some(
    (attribute, index) =>
      index > lastSpread &&
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === "elevation" &&
      attribute.initializer &&
      ts.isStringLiteral(attribute.initializer) &&
      (attribute.initializer.text === "flush" || attribute.initializer.text === "tinted"),
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

          if (id && (discovery.card.has(id) || discovery.raisedSurfaceEmitters.has(id))) {
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
        if (id && (discovery.card.has(id) || discovery.raisedSurfaceEmitters.has(id))) {
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

describe("direct Card elevation guard", () => {
  it("scans every tracked production candidate with zero bare roots and no allowlist", () => {
    const result = scanDirectCards(repositoryRoot());
    console.info(
      "Direct Card census",
      JSON.stringify({
        scanned: result.candidates.length,
        total: result.tracked.length,
        excluded: result.excluded.length,
        digest: result.digest,
        roots: result.roots.length,
        groups: Object.fromEntries(
          directCardScanRoots.map((prefix) => [
            prefix,
            result.roots.filter(({ file }) => file.startsWith(prefix + "/")).length,
          ]),
        ),
        violations: result.violations,
      }),
    );
    expect(result.candidates.length + result.excluded.length).toBe(result.tracked.length);
    expect(result.roots.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  const controls = [
    {
      name: "restored checkout #6858",
      file: "bounded-contexts/checkout/features/cart/ui/add-to-cart-section.tsx",
      source:
        'import { Card, PageSection, Form, Stack } from "@chase-sets/design-system"; export function CheckoutAddToCartSection() { return <PageSection><Card><Form spacing="none" method="post"><Stack /></Form></Card></PageSection>; }',
      tag: "Card",
    },
    {
      name: "admin hub #7219",
      file: "deployables/admin-web/app/routes/index.tsx",
      source:
        'import { Card, Grid } from "@chase-sets/design-system"; export default function AdminIndexRoute() { return <Grid>{sections.map(section => <Card key={section.key} interactive>{section.label}</Card>)}</Grid>; }',
      tag: "Card",
    },
    {
      name: "arbitrary sibling subpath alias",
      file: "bounded-contexts/example/features/unconventional/ui/odd.tsx",
      source:
        'import { Card as Tile } from "@chase-sets/design-system/card"; export const Odd = () => ready ? <Tile {...props} /> : null;',
      tag: "Tile",
    },
    {
      name: "root import alias",
      file: "bounded-contexts/example/another.tsx",
      source: 'import { Card as Entity } from "@chase-sets/design-system"; export const Another = <Entity />;',
      tag: "Entity",
    },
    {
      name: "namespace root import",
      file: "bounded-contexts/example/namespace.tsx",
      source: 'import * as DS from "@chase-sets/design-system"; export const Example = <DS.Card />;',
      tag: "DS.Card",
    },
    {
      name: "design-system local Card #6877",
      file: "packages/design-system/src/components/data-display/card.tsx",
      source:
        "export const Card = Object.assign(CardSurface, {}); export function DetailPanel() { return <Card {...rest}><div>{children}</div></Card>; }",
      tag: "Card",
    },
    {
      name: "design-system relative alias",
      file: "packages/design-system/src/components/data-display/arbitrary.tsx",
      source: 'import { Card as Entity } from "./card"; export function Arbitrary() { return <Entity />; }',
      tag: "Entity",
    },
  ];

  it.each(controls)("rejects bare $name and accepts the identical explicit candidate", ({ file, source, tag }) => {
    const parse = (text: string) =>
      ts.createSourceFile(path.join(repositoryRoot(), file), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const discovery = productionCardEmitters();
    expect(directCardRoots(parse(source), discovery)).toEqual([{ file, line: 1, tag, explicit: false }]);
    expect(directCardRoots(parse(source.replace(`<${tag}`, `<${tag} elevation="outlined"`)), discovery)).toEqual([
      { file, line: 1, tag, explicit: true },
    ]);
  });

  it("does not mistake any compound slot, unrelated Card or composed emitter for a direct root", () => {
    const source = ts.createSourceFile(
      path.join(repositoryRoot(), "bounded-contexts/example/slots.tsx"),
      'import { Card as Tile, Surface, OfferCard } from "@chase-sets/design-system"; import * as DS from "@chase-sets/design-system"; function Card() { return null; } export const Slots = () => <><Tile.Header /><Tile.Title /><Tile.Description /><Tile.Body /><Tile.Footer /><DS.Card.Header /><Card /><Surface /><OfferCard /></>;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(directCardRoots(source, productionCardEmitters())).toEqual([]);
  });

  it("keeps the indexed partition identical with generated output and rejects a newly tracked arbitrary sibling", () => {
    const scratch = path.join(repositoryRoot(), "artifacts");
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratch, "card-partition-"));
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(
        path.join(root, file),
        'import { Card as Tile } from "@chase-sets/design-system/card"; export const Odd = () => <Tile />;',
      );
    };
    try {
      const candidate = "bounded-contexts/example/unconventional.tsx";
      const exclusions = [
        "bounded-contexts/example/ui.test.tsx",
        "deployables/example/ui.spec.tsx",
        "packages/design-system/src/__tests__/example.tsx",
        "bounded-contexts/example/__fixtures__/example.tsx",
        "deployables/example/build/example.tsx",
        "deployables/example/.react-router/types/example.tsx",
      ];
      write(candidate);
      exclusions.forEach(write);
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      const clean = directCardCandidates(root);
      expect(clean.candidates).toEqual([candidate]);
      expect(clean.excluded).toEqual([...exclusions].sort());
      const bare = scanDirectCards(root);
      expect(bare.roots).toHaveLength(1);
      expect(bare.violations).toEqual(bare.roots);
      expect(bare.violations[0]?.tag).toBe("Tile");
      const candidatePath = path.join(root, candidate);
      fs.writeFileSync(
        candidatePath,
        fs.readFileSync(candidatePath, "utf8").replace("<Tile", '<Tile elevation="outlined"'),
      );
      expect(scanDirectCards(root).violations).toEqual([]);
      write("deployables/example/.react-router/types/generated.tsx");
      write("packages/design-system/src/dist/generated.tsx");
      write("bounded-contexts/example/untracked.tsx");
      expect(directCardCandidates(root)).toEqual(clean);
      execFileSync("git", ["add", "bounded-contexts/example/untracked.tsx"], { cwd: root });
      const added = directCardCandidates(root);
      expect(added.candidates).toEqual([candidate, "bounded-contexts/example/untracked.tsx"]);
      expect(added.digest).not.toBe(clean.digest);
      expect(scanDirectCards(root).violations).toHaveLength(1);
    } finally {
      expect(path.resolve(root).startsWith(path.resolve(scratch) + path.sep)).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Surface elevation guard", () => {
  it("derives the Surface closure and scans the shared tracked production partition with zero allowlist entries", () => {
    const discovery = productionCardEmitters();
    const result = scanDirectCards(repositoryRoot(), discovery, discovery.surface);
    const relative = (id: string) => path.relative(repositoryRoot(), id).replaceAll("\\", "/");
    console.info(
      "Surface derivation and census",
      JSON.stringify({
        scanned: result.candidates.length,
        total: result.tracked.length,
        excluded: result.excluded.length,
        digest: result.digest,
        roots: result.roots.length,
        violations: result.violations,
        allowlist: [],
        direct: discovery.surfaceDirect.map(relative),
        transitive: discovery.surfaceTransitive.map(relative),
        raised: [...discovery.raisedSurfaceEmitters].sort().map(relative),
      }),
    );
    expect(result.candidates.length + result.excluded.length).toBe(result.tracked.length);
    expect(result.roots.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
    expect(new Set([discovery.surface, ...discovery.surfaceDirect, ...discovery.surfaceTransitive])).toEqual(
      new Set([...discovery.surfaceEmitters].filter((id) => discovery.exported.has(id))),
    );
  });

  const controls = [
    {
      name: "planted direct root",
      file: "bounded-contexts/example/arbitrary.tsx",
      source: 'import { Surface } from "@chase-sets/design-system"; export const Example = <Surface />;',
      tag: "Surface",
    },
    {
      name: "renamed root alias",
      file: "bounded-contexts/example/alias.tsx",
      source: 'import { Surface as Furniture } from "@chase-sets/design-system"; export const Example = <Furniture />;',
      tag: "Furniture",
    },
    {
      name: "subpath alias",
      file: "bounded-contexts/example/subpath.tsx",
      source: 'import { Surface as Frame } from "@chase-sets/design-system/layout"; export const Example = <Frame />;',
      tag: "Frame",
    },
    {
      name: "namespace root",
      file: "bounded-contexts/example/namespace.tsx",
      source: 'import * as DS from "@chase-sets/design-system"; export const Example = <DS.Surface />;',
      tag: "DS.Surface",
    },
    {
      name: "local Surface symbol",
      file: "packages/design-system/src/primitives/layout.tsx",
      source: "export function Surface() { return <div />; } export const Example = <Surface />;",
      tag: "Surface",
    },
  ];
  it.each(controls)("candidate/bypass: $name rejects only the bare-elevation clause", ({ name, file, source, tag }) => {
    const discovery = productionCardEmitters();
    const roots = (text: string) =>
      directCardRoots(
        ts.createSourceFile(path.join(repositoryRoot(), file), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
        discovery,
        discovery.surface,
      );
    expect(roots(source)).toEqual([{ file, line: 1, tag, explicit: false }]);
    expect(roots(source.replace(`<${tag}`, `<${tag} elevation="flush"`))).toEqual([
      { file, line: 1, tag, explicit: true },
    ]);
    console.info("Surface candidate/bypass", JSON.stringify({ name, clause: "bare elevation", bare: 1, explicit: 0 }));
  });

  it.each([
    ["public-presence shell #8270", "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx"],
    ["payments root #8272", "bounded-contexts/payments/features/payments/ui/account-payment/account-payment-page.tsx"],
    ["design-system emitter #8273", "packages/design-system/src/components/checkout/status.tsx"],
  ])("restores exactly the owned historical omission: %s", (name, file) => {
    const absolute = path.join(repositoryRoot(), file!);
    const source = ts.createSourceFile(
      absolute,
      fs.readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const discovery = productionCardEmitters();
    let removed: ts.JsxAttribute | undefined;
    function visit(node: ts.Node) {
      if (
        !removed &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        discovery.resolveLocal(source, node.tagName.text) === discovery.surface
      ) {
        removed = node.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "elevation",
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(removed).toBeDefined();
    const green = directCardRoots(source, discovery, discovery.surface);
    expect(green.filter((root) => !root.explicit)).toEqual([]);
    const attribute = removed!;
    const mutant =
      source.text.slice(0, attribute.getStart(source)) +
      source.text.slice(attribute.getStart(source), attribute.end).replace(/[^\r\n]/g, " ") +
      source.text.slice(attribute.end);
    const red = directCardRoots(
      ts.createSourceFile(absolute, mutant, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
      discovery,
      discovery.surface,
    );
    expect(red).toEqual(green.map((root, index) => (index === 0 ? { ...root, explicit: false } : root)));
    console.info(
      "Surface historical mutant",
      JSON.stringify({ name, violation: red.filter((root) => !root.explicit), restored: 0 }),
    );
  });
});

describe("surface hierarchy", () => {
  it("uses Inset as the only nested surface level", () => {
    const violations = surfaceHierarchyViolations(repositoryRoot(), productionCardEmitters());
    console.info("Card and Surface nesting", JSON.stringify({ violations: violations.length, sites: violations }));
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
        "packages/design-system/src/unconventional/second-furniture.tsx",
        'import { FixtureSurfaceOnly as Child } from "./furniture"; export function FixtureSecondFurniture() { return <Child />; }',
      );
      write(
        "packages/design-system/src/unconventional/bridge.ts",
        'export { FixtureEntity as RenamedEntity } from "./direct"; export * from "./second"; export * from "./furniture"; export { FixtureSecondFurniture as OddFurniture } from "./second-furniture";',
      );
      write(
        "bounded-contexts/example/ui.tsx",
        'import { Surface, Inset } from "../../packages/design-system/src/primitives/layout"; import { RenamedEntity as Direct, FixtureSecondOrder as Second, FixtureSurfaceOnly as Furniture, OddFurniture as SecondFurniture } from "@unusual/bridge"; export function Example() { return <><Surface elevation="elevated"><Direct /><Second /><Furniture /><SecondFurniture /><Inset><Second /></Inset></Surface></>; }',
      );
      write("bounded-contexts/example/not-design-system.tsx", "export function RenamedEntity() { return <div />; }");
      write(
        "bounded-contexts/example/unrelated.tsx",
        'import { RenamedEntity as Direct } from "./not-design-system"; import { Surface } from "../../packages/design-system/src/primitives/layout"; export function Unrelated() { return <Surface elevation="flush"><Direct /></Surface>; }',
      );
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      const clean = discoverCardEmitters(root);
      expect(clean.direct.map((id) => id.split("#")[1])).toEqual(["FixtureEntity"]);
      expect(clean.transitive.map((id) => id.split("#")[1])).toEqual(["FixtureSecondOrder"]);
      expect(clean.nonCard.map((id) => id.split("#")[1])).toContain("FixtureSurfaceOnly");
      expect(clean.surfaceDirect.map((id) => id.split("#")[1])).toEqual(["FixtureSurfaceOnly"]);
      expect(clean.surfaceTransitive.map((id) => id.split("#")[1])).toEqual(["FixtureSecondFurniture"]);
      const bare = scanDirectCards(root, clean, clean.surface);
      expect(bare.violations).toHaveLength(1);
      expect(bare.violations[0]).toMatchObject({ tag: "Frame", explicit: false });
      const violations = surfaceHierarchyViolations(root, clean);
      expect(violations.map(({ tag, parent }) => ({ tag, parent }))).toEqual([
        { tag: "Direct", parent: "Surface" },
        { tag: "Second", parent: "Surface" },
        { tag: "Furniture", parent: "Surface" },
        { tag: "SecondFurniture", parent: "Surface" },
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
      for (const elevation of ["flush", "tinted", "outlined", "elevated"] as const) {
        write(
          "packages/design-system/src/unconventional/furniture.tsx",
          `import { Surface as Frame } from "../primitives/layout"; export function FixtureSurfaceOnly() { return <Frame elevation="${elevation}" />; }`,
        );
        const explicit = discoverCardEmitters(root);
        expect(explicit.surfaceDirect).toEqual(clean.surfaceDirect);
        expect(explicit.surfaceTransitive).toEqual(clean.surfaceTransitive);
        expect(scanDirectCards(root, explicit, explicit.surface).violations).toEqual([]);
        const flat = elevation === "flush" || elevation === "tinted";
        expect(surfaceHierarchyViolations(root, explicit)).toEqual(
          flat ? violations.filter(({ tag }) => tag !== "Furniture" && tag !== "SecondFurniture") : violations,
        );
      }
      for (const attributes of ["elevation={intent}", 'elevation="flush" {...props}']) {
        write(
          "packages/design-system/src/unconventional/furniture.tsx",
          `import { Surface as Frame } from "../primitives/layout"; export function FixtureSurfaceOnly() { return <Frame ${attributes} />; }`,
        );
        const uncertain = discoverCardEmitters(root);
        expect(surfaceHierarchyViolations(root, uncertain)).toEqual(violations);
      }
      console.info(
        "Surface candidate/bypass",
        JSON.stringify({
          name: "second-order unconventional specifier",
          clause: "bare elevation at emission",
          bare: 1,
          explicit: 0,
        }),
      );
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
 * under `elevated`/`outlined`, bare `cursor-pointer transition` under
 * `flush`/`tinted`, and `ds-glow` only where the elevation carries a shadow.
 */
const cardInteractiveChrome: Record<ElevationName, string> = {
  flush: "rounded-tokenLg overflow-hidden cursor-pointer transition p-4",
  tinted: "rounded-tokenLg overflow-hidden bg-surface-2 cursor-pointer transition p-4",
  outlined:
    "rounded-tokenLg border border-muted overflow-hidden bg-surface cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
  elevated:
    "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden cursor-pointer transition hover:border-accent hover:shadow-tokenMd p-4",
};

const cardGlowChrome: Record<ElevationName, string> = {
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

const surfaceGlowChrome: Record<ElevationName, string> = {
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

  it.each(elevations)("pins the Card interactive state chrome for %s", (cell) => {
    expect(
      rootElement(
        <Card interactive elevation={cell}>
          cell content
        </Card>,
      ).className,
    ).toBe(cardInteractiveChrome[cell]);
  });

  it.each(elevations)("pins the Card glow state chrome for %s", (cell) => {
    expect(
      rootElement(
        <Card glow elevation={cell}>
          cell content
        </Card>,
      ).className,
    ).toBe(cardGlowChrome[cell]);
  });

  it.each(elevations)("preserves native and ARIA props and interaction for explicit %s", (elevation) => {
    let clicks = 0;
    const root = rootElement(
      <Card
        elevation={elevation}
        id="entity"
        role="group"
        aria-label="Entity"
        tabIndex={0}
        data-entity="123"
        onClick={() => {
          clicks += 1;
        }}
      >
        cell content
      </Card>,
    );
    expect(root.tagName).toBe("DIV");
    expect(root.id).toBe("entity");
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Entity");
    expect(root.getAttribute("tabindex")).toBe("0");
    expect(root.getAttribute("data-entity")).toBe("123");
    expect(root.textContent).toBe("cell content");
    fireEvent.click(root);
    expect(clicks).toBe(1);
  });
});

describe("Surface elevation oracle", () => {
  it("documents the omission rule and the retired boolean in the canonical catalog", () => {
    const directory = path.join(repositoryRoot(), "packages/design-system");
    const readme = fs.readFileSync(path.join(directory, "README.md"), "utf8");
    const index = fs.readFileSync(path.join(directory, "COMPONENT_INDEX.md"), "utf8");
    expect(readme).toContain("omitting it on `Surface` renders exactly the `flush` treatment for its tone");
    expect(readme).toContain("Surface has no `elevated` boolean");
    const surface = index.split("\n").find((line) => line.startsWith("| `Surface` |"));
    expect(surface).toContain("flush-by-default");
    expect(surface).not.toContain("legacy");
  });
  it("retires the elevated boolean from the public prop contract", () => {
    // @ts-expect-error Surface no longer accepts the legacy boolean.
    const legacy = <Surface elevated />;
    const hasLegacyProp: "elevated" extends keyof SurfaceOwnProps ? true : false = false;
    expect(legacy).toBeDefined();
    expect(hasLegacyProp).toBe(false);
  });
  it("renders the omitted-default row byte-identically to flush for every tone and glow state", () => {
    for (const tone of surfaceTones) {
      for (const glow of [false, true]) {
        const omitted = (
          <Surface tone={tone} glow={glow}>
            cell content
          </Surface>
        );
        expect(renderToString(omitted)).toBe(
          renderToString(
            <Surface tone={tone} glow={glow} elevation="flush">
              cell content
            </Surface>,
          ),
        );
        expect(rootElement(omitted).className).toBe(surfaceElevationMatrix.flush[tone]);
        expect(rootElement(omitted).className).not.toMatch(/surface-border|shadow-tokenSm|shadow-tokenLg|ds-glow/);
      }
    }
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

  it.each(elevations)("pins the Surface glow state chrome for %s", (cell) => {
    expect(
      rootElement(
        <Surface glow elevation={cell}>
          cell content
        </Surface>,
      ).className,
    ).toBe(surfaceGlowChrome[cell]);
  });
});

/**
 * Explicit elevated byte-identity: every `variant` × `media` × `interactive` ×
 * `glow` permutation retains the original class string, committed as literals.
 */
const elevatedCardRecipes: ReadonlyArray<{
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

describe("Card explicit-elevated preservation", () => {
  it.each(elevatedCardRecipes)(
    "keeps the $variant elevated recipe (media=$media interactive=$interactive glow=$glow)",
    ({ variant, media, interactive, glow, expected }) => {
      expect(
        rootElement(
          <Card
            elevation="elevated"
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

describe("Card omitted-default oracle", () => {
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
    "renders omitted byte-identical to outlined for $variant media=$media interactive=$interactive glow=$glow overflow=$overflow",
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
          <Card {...shared} elevation="outlined">
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
