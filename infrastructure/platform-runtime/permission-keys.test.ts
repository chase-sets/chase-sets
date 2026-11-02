import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { AGENT_OAUTH_KNOWN_SCOPE_FAMILIES, PERMISSION_KEYS, ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import { describe, expect, it } from "vitest";
import { flattenMcpTools } from "./mcp-contracts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_TIMEOUT_MS = 120_000;

type PermissionString = Readonly<{ source: string; permission: string }>;
type SourceText = Readonly<{ path: string; text: string }>;

// A permission key is a dotted, lowercase kebab name such as `orders.view`.
// Literals in a permission position without that shape are not permission
// keys: localized copy, browser-extension manifest permissions, SQL casts.
const PERMISSION_KEY_SHAPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const PERMISSION_NAME = /permission/i;
const testPathSegment = /(^|\/)(?:__tests__|tests|fixtures|test-fixtures|test-support|e2e)(\/|$)/;

function trackedFiles(pathspecs: readonly string[]): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function productionSources(): readonly SourceText[] {
  return trackedFiles(["bounded-contexts", "contracts", "infrastructure", "deployables", "packages"])
    .filter((file) => /\.tsx?$/.test(file) && !/\.d\.ts$/.test(file) && !/\.(?:test|spec)\.tsx?$/.test(file))
    .filter((file) => !testPathSegment.test(file) && !/test-support\.tsx?$/.test(file))
    .map((file) => ({ path: file, text: readFileSync(path.join(repoRoot, file), "utf8") }));
}

function nameOf(node: ts.Node | undefined): string {
  if (node === undefined) return "";
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return "";
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
}

function stringLiterals(node: ts.Expression): readonly ts.StringLiteralLike[] {
  const expression = unwrap(node);
  if (ts.isStringLiteralLike(expression)) return [expression];
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => (ts.isSpreadElement(element) ? [] : stringLiterals(element)));
  }
  if (ts.isConditionalExpression(expression)) {
    return [...stringLiterals(expression.whenTrue), ...stringLiterals(expression.whenFalse)];
  }
  return [];
}

function functionName(node: ts.SignatureDeclaration): string {
  if (node.name !== undefined) return nameOf(node.name);
  return ts.isVariableDeclaration(node.parent) ? nameOf(node.parent.name) : "";
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) return functionName(current);
  }
  return "";
}

/**
 * Every string literal in a permission position: a property, variable or
 * parameter default named for a permission; an argument to a call named for a
 * permission; an argument to `.includes`/`.has`/`.indexOf` on a `permissions`
 * value; a value returned by a function named for a permission; and an
 * argument passed where any scanned function declares a parameter named for a
 * permission (such as an MCP boundary builder's `permission`).
 */
function scanPermissionLiterals(sources: readonly SourceText[]): readonly PermissionString[] {
  const files = sources.map((source) =>
    ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.Latest,
      true,
      source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  );

  const permissionParameters = new Map<string, Set<number>>();
  const indexParameters = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      node.parameters.forEach((parameter, position) => {
        if (!PERMISSION_NAME.test(nameOf(parameter.name))) return;
        const name = functionName(node);
        if (name === "") return;
        permissionParameters.set(name, (permissionParameters.get(name) ?? new Set()).add(position));
      });
    }
    ts.forEachChild(node, indexParameters);
  };
  files.forEach(indexParameters);

  const found: PermissionString[] = [];
  for (const file of files) {
    const record = (expression: ts.Expression | undefined) => {
      if (expression === undefined) return;
      for (const literal of stringLiterals(expression)) {
        if (!PERMISSION_KEY_SHAPE.test(literal.text)) continue;
        const line = file.getLineAndCharacterOfPosition(literal.getStart(file)).line + 1;
        found.push({ source: `${file.fileName}:${line}`, permission: literal.text });
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && PERMISSION_NAME.test(nameOf(node.name))) record(node.initializer);
      if (ts.isVariableDeclaration(node) && PERMISSION_NAME.test(nameOf(node.name))) record(node.initializer);
      if (ts.isParameter(node) && PERMISSION_NAME.test(nameOf(node.name))) record(node.initializer);
      if (ts.isReturnStatement(node) && PERMISSION_NAME.test(enclosingFunctionName(node))) record(node.expression);
      if (ts.isCallExpression(node)) {
        const callee = nameOf(node.expression);
        const receiver = ts.isPropertyAccessExpression(node.expression) ? nameOf(node.expression.expression) : "";
        if (PERMISSION_NAME.test(callee)) {
          node.arguments.forEach(record);
        } else if (/permissions$/i.test(receiver) && ["includes", "has", "indexOf"].includes(callee)) {
          node.arguments.forEach(record);
        } else {
          for (const position of permissionParameters.get(callee) ?? []) record(node.arguments[position]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

function roleGrants(): readonly PermissionString[] {
  return Object.entries(ROLE_PERMISSIONS).flatMap(([role, permissions]) =>
    permissions.map((permission) => ({ source: `ROLE_PERMISSIONS.${role}`, permission })),
  );
}

function oauthScopePermissions(): readonly PermissionString[] {
  return AGENT_OAUTH_KNOWN_SCOPE_FAMILIES.flatMap((family) =>
    family.scopes.flatMap((scope) =>
      (scope.permissions as readonly string[]).map((permission) => ({ source: `oauth:${scope.scope}`, permission })),
    ),
  );
}

function contextManifestPermissions(): readonly PermissionString[] {
  const found: PermissionString[] = [];
  const walk = (value: unknown, source: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, position) => walk(entry, `${source}[${position}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "requiredPermissions") {
        expect(Array.isArray(entry), `${source}.${key} is an array`).toBe(true);
        for (const permission of entry as readonly unknown[]) {
          found.push({ source: `${source}.${key}`, permission: String(permission) });
        }
      } else {
        walk(entry, `${source}.${key}`);
      }
    }
  };
  for (const manifest of trackedFiles(["bounded-contexts/*/context.json"])) {
    walk(JSON.parse(readFileSync(path.join(repoRoot, manifest), "utf8")), manifest);
  }
  return found;
}

function mcpToolPermissions(): readonly PermissionString[] {
  return flattenMcpTools().flatMap((tool) =>
    tool.permissionBoundary.requiredPermissions.map((permission) => ({ source: `mcp:${tool.name}`, permission })),
  );
}

describe("permission vocabulary", () => {
  it(
    "permission strings are declared keys",
    () => {
      const declared = new Set<string>(PERMISSION_KEYS);
      const sources = {
        roleGrants: roleGrants(),
        oauthScopes: oauthScopePermissions(),
        contextManifests: contextManifestPermissions(),
        mcpTools: mcpToolPermissions(),
        productionLiterals: scanPermissionLiterals(productionSources()),
      };
      for (const [name, strings] of Object.entries(sources)) {
        expect(strings.length, `${name} yields permission strings`).toBeGreaterThan(0);
      }
      expect(
        Object.values(sources)
          .flat()
          .filter(({ permission }) => !declared.has(permission)),
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it("finds a literal in every permission position it scans and nothing else", () => {
    const synthetic = [
      'const ACCESS_PERMISSION = "fixture.variable";',
      'const policy = { requiredPermissions: ["fixture.property"], label: "fixture.label" };',
      'function boundary(permission: string, scope = "fixture.scope") { return [permission, scope]; }',
      'boundary("fixture.parameter", "fixture.other-argument");',
      'hasPermission(actor, "fixture.callee");',
      'actor.permissions.includes("fixture.receiver");',
      'function routePermission(write: boolean) { return write ? "fixture.return-a" : "fixture.return-b"; }',
      'function guard(permission = "fixture.default") { return permission; }',
      'requirePermission("not a key", "Permission denied", "storage");',
    ].join("\n");

    expect(scanPermissionLiterals([{ path: "synthetic.ts", text: synthetic }])).toEqual([
      { source: "synthetic.ts:1", permission: "fixture.variable" },
      { source: "synthetic.ts:2", permission: "fixture.property" },
      { source: "synthetic.ts:4", permission: "fixture.parameter" },
      { source: "synthetic.ts:5", permission: "fixture.callee" },
      { source: "synthetic.ts:6", permission: "fixture.receiver" },
      { source: "synthetic.ts:7", permission: "fixture.return-a" },
      { source: "synthetic.ts:7", permission: "fixture.return-b" },
      { source: "synthetic.ts:8", permission: "fixture.default" },
    ]);
  });
});
