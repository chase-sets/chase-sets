import fs from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailPanel, Inset, KeyValueList, MarketplaceDashboardPanel, SpecificationList, Stat } from "../index";

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
