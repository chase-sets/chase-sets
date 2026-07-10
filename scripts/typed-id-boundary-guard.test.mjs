import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { repoRoot } from "./lib/repo.mjs";

const boundaryRoots = ["bounded-contexts", "deployables", "infrastructure"].map((directory) =>
  path.join(repoRoot, directory),
);

function isBoundaryFile(filePath) {
  const normalized = path.relative(repoRoot, filePath).replaceAll("\\", "/");
  return (
    normalized.includes("/api/") &&
    /\/(?:route|http|mcp|[^/]+-routes)\.ts$/.test(normalized) &&
    !normalized.endsWith(".test.ts")
  );
}

function isIdType(typeNode) {
  if (ts.isArrayTypeNode(typeNode)) {
    return isIdType(typeNode.elementType);
  }
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some(isIdType);
  }
  if (!ts.isTypeReferenceNode(typeNode)) {
    return false;
  }

  return /Id$/.test(typeNode.typeName.getText());
}

function findBoundaryIdAssertions(sourceText, fileName = "boundary.ts") {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const untrustedVariables = new Set(["args", "body", "requestBody", "input"]);
  const violations = [];

  function containsUntrustedSource(node) {
    const text = node.getText(sourceFile);
    if (
      /\b(?:parseTypedIdBoundary|readMcpTypedIdArgument|readOptionalMcpTypedIdArgument|ensureMcpActorAccount)\s*\(/.test(
        text,
      ) ||
      /^(?:scopedActor|actor)\./.test(text)
    ) {
      return false;
    }
    if (/\bc\.req\.(?:json|param|query)\b/.test(text) || /\bread\w*\(\s*args\b/.test(text)) {
      return true;
    }

    let found = false;
    function visit(child) {
      if (ts.isIdentifier(child) && untrustedVariables.has(child.text)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }

  function collectUntrustedVariables(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      containsUntrustedSource(node.initializer)
    ) {
      untrustedVariables.add(node.name.text);
    }
    ts.forEachChild(node, collectUntrustedVariables);
  }

  collectUntrustedVariables(sourceFile);

  function visit(node) {
    if (ts.isAsExpression(node) && isIdType(node.type) && containsUntrustedSource(node.expression)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({ line: position.line + 1, column: position.character + 1, text: node.getText(sourceFile) });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe("typed ID trust-boundary guard", () => {
  it("detects request body, route param, and MCP argument assertions", () => {
    const violations = findBoundaryIdAssertions(`
      const body = await c.req.json();
      const accountId = body.accountId as AccountId;
      const orderId = c.req.param("id") as OrderId;
      const offerId = readRequiredString(args, "offerId") as OfferId;
    `);

    expect(violations).toHaveLength(3);
  });

  it("keeps boundary modules free from raw branded-ID assertions", async () => {
    const violations = [];
    for (const root of boundaryRoots) {
      for (const filePath of await collectFiles(root, {
        extensions: new Set([".ts"]),
        skippedDirectories: defaultSkippedDirectories,
      })) {
        if (!isBoundaryFile(filePath)) {
          continue;
        }

        for (const violation of findBoundaryIdAssertions(readFileSync(filePath, "utf8"), filePath)) {
          violations.push(
            `${path.relative(repoRoot, filePath)}:${violation.line}:${violation.column} ${violation.text}`,
          );
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
