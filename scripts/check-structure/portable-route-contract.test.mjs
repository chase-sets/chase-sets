import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { validatePortableRouteContract } from "./portable-route-contract.mjs";

function portableRoute(overrides = {}) {
  return {
    routeId: "search",
    routePath: "search",
    fileExport: "./routes/search",
    routeType: "route",
    sourceContext: "discovery",
    delivery: "portable",
    authorization: { kind: "public" },
    canonicalLink: { kind: "route-derived" },
    availability: { web: true, mobile: true },
    pageComponentExport: "SearchPage",
    portableDataOperations: { load: true, mutation: false },
    ...overrides,
  };
}

function validate(route) {
  return validatePortableRouteContract({
    contextName: "discovery",
    deployable: "marketplace-web",
    route,
  });
}

function exportedNames(sourceFile) {
  const names = new Set();
  const hasModifier = (node, kind) => node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) names.add("default");
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text !== undefined
    ) {
      names.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }

  return names;
}

function jsxComponentReferences(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let tag = node.tagName;
      while (ts.isPropertyAccessExpression(tag)) tag = tag.expression;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) names.add(tag.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function validatePageComponentExport({ route, source, modulePath = "route.tsx" }) {
  if (route.pageComponentExport === undefined) return [];
  const sourceFile = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const exports = exportedNames(sourceFile);
  const componentReferences = jsxComponentReferences(sourceFile);
  const claimedExport = route.pageComponentExport;
  const resolves =
    claimedExport === "default"
      ? exports.has("default") || exports.has("Component")
      : (/^[A-Z]/.test(claimedExport) && exports.has(claimedExport)) || componentReferences.has(claimedExport);

  return resolves
    ? []
    : [`pageComponentExport '${claimedExport}' does not resolve to a page component in '${modulePath}'`];
}

async function readRouteModule(contextDirectory, fileExport) {
  for (const extension of [".tsx", ".ts"]) {
    const modulePath = path.resolve(contextDirectory, `${fileExport}${extension}`);
    if (!modulePath.startsWith(`${path.resolve(contextDirectory)}${path.sep}`)) {
      throw new Error(`Route module '${fileExport}' resolves outside '${contextDirectory}'.`);
    }
    try {
      return { modulePath, source: await readFile(modulePath, "utf8") };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Route module '${fileExport}' did not resolve beneath '${contextDirectory}'.`);
}

async function readMarketplaceRouteModules() {
  const contextRoot = path.resolve(import.meta.dirname, "../../bounded-contexts");
  const entries = await readdir(contextRoot, { withFileTypes: true });
  const routeModules = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(contextRoot, entry.name, "context.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const contribution of manifest.deployableContributions ?? []) {
      if (contribution.deployable !== "marketplace-web") continue;
      for (const route of contribution.routes ?? []) {
        routeModules.push({
          contextName: manifest.contextName,
          route,
          ...(await readRouteModule(path.dirname(manifestPath), route.fileExport)),
        });
      }
    }
  }

  return routeModules;
}

describe("portable route manifest contract", () => {
  it("accepts a complete portable route contribution", () => {
    expect(validate(portableRoute())).toEqual([]);
  });

  it("fails when a mobile route omits canonical-link metadata", () => {
    expect(validate(portableRoute({ canonicalLink: undefined }))).toContainEqual(
      expect.stringContaining("canonicalLink must declare"),
    );
  });

  it("fails when a mobile route omits portable data operations", () => {
    expect(validate(portableRoute({ portableDataOperations: undefined }))).toContainEqual(
      expect.stringContaining("must declare a load operation"),
    );
  });

  it("requires unsupported inventory to name its owner and follow-up", () => {
    expect(
      validate(
        portableRoute({
          delivery: "server-only",
          availability: { web: true, mobile: false },
          portableDataOperations: undefined,
          unsupportedMobile: { owner: "", followUp: "", reason: "Server loader only." },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("identify an owner"), expect.stringContaining("follow-up")]),
    );
  });

  it("requires pages to identify a component and web resources to omit one", () => {
    const serverOnly = portableRoute({
      delivery: "server-only",
      availability: { web: true, mobile: false },
      portableDataOperations: undefined,
      unsupportedMobile: { owner: "discovery", followUp: "#5238", reason: "Server loader only." },
    });
    expect(validate(serverOnly)).toEqual([]);
    expect(validate({ ...serverOnly, pageComponentExport: undefined })).toContain(
      "pageComponentExport must identify the page component",
    );

    const webResourceOnly = {
      ...serverOnly,
      delivery: "web-resource-only",
      pageComponentExport: undefined,
    };
    expect(validate(webResourceOnly)).toEqual([]);
    expect(validate({ ...webResourceOnly, pageComponentExport: "default" })).toContain(
      "web-resource-only routes cannot declare pageComponentExport",
    );
  });

  it("fails closed for unknown and malformed route shapes with stable messages", () => {
    expect(validate(null)).toEqual(["route must be an object"]);
    expect(validate(portableRoute({ delivery: "unknown", pageComponentExport: 42 }))).toEqual(
      expect.arrayContaining([
        "delivery must be portable, web-resource-only, or server-only",
        "pageComponentExport must identify the page component",
      ]),
    );
  });

  it("resolves default, Component-convention, and named page components", () => {
    expect(
      validatePageComponentExport({
        route: { pageComponentExport: "default" },
        source: "export default function RoutePage() { return <main />; }",
      }),
    ).toEqual([]);
    expect(
      validatePageComponentExport({
        route: { pageComponentExport: "default" },
        source: "export function Component() { return <main />; }",
      }),
    ).toEqual([]);
    expect(
      validatePageComponentExport({
        route: { pageComponentExport: "SearchPage" },
        source:
          'import { SearchPage } from "./search-page"; export default function Route() { return <SearchPage />; }',
      }),
    ).toEqual([]);
  });

  it("rejects false default and named page-component claims", () => {
    const resourceSource = "export const loader = () => Response.json({});";
    expect(
      validatePageComponentExport({ route: { pageComponentExport: "default" }, source: resourceSource }),
    ).toContainEqual(expect.stringContaining("'default' does not resolve"));
    expect(
      validatePageComponentExport({ route: { pageComponentExport: "MissingPage" }, source: resourceSource }),
    ).toContainEqual(expect.stringContaining("'MissingPage' does not resolve"));
  });

  it("ratchets every live marketplace contribution through the portable contract", async () => {
    const routeModules = await readMarketplaceRouteModules();
    const violations = [];
    let routeCount = 0;
    let portableCount = 0;
    let webResourceOnlyCount = 0;

    for (const { contextName, route, modulePath, source } of routeModules) {
      routeCount += 1;
      if (route.delivery === "portable") portableCount += 1;
      if (route.delivery === "web-resource-only") webResourceOnlyCount += 1;
      const routeViolations = validatePortableRouteContract({
        contextName,
        deployable: "marketplace-web",
        route,
      });
      violations.push(...routeViolations.map((message) => `${contextName}/${route.routeId}: ${message}`));
      violations.push(
        ...validatePageComponentExport({ route, source, modulePath }).map(
          (message) => `${contextName}/${route.routeId}: ${message}`,
        ),
      );
    }

    expect(violations).toEqual([]);
    expect({ routeCount, portableCount, webResourceOnlyCount }).toEqual({
      routeCount: 79,
      portableCount: 3,
      webResourceOnlyCount: 1,
    });
  });

  it("rejects false page claims against live web-resource module surfaces", async () => {
    const resourceModules = (await readMarketplaceRouteModules()).filter(
      ({ route }) => route.delivery === "web-resource-only",
    );

    expect(resourceModules).toHaveLength(1);
    for (const { route, source, modulePath } of resourceModules) {
      expect(route.pageComponentExport).toBeUndefined();
      expect(validatePageComponentExport({ route, source, modulePath })).toEqual([]);
      expect(
        validatePageComponentExport({ route: { ...route, pageComponentExport: "default" }, source, modulePath }),
      ).toContainEqual(expect.stringContaining("'default' does not resolve"));
    }
  });
});
