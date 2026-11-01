import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

const identityRoot = path.resolve(import.meta.dirname, "..");

function glossaryEntry(source: string, heading: string) {
  const start = source.indexOf(`\n### ${heading}\n`);
  if (start < 0) throw new Error(`Identity glossary has no ${heading} entry.`);
  const end = source.slice(start + 1).search(/\n#{2,3} /);
  return end < 0 ? source.slice(start) : source.slice(start, start + 1 + end);
}

function isGuardInput(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "consentActivationGuardAppendInput"
  );
}

function ownerName(node: ts.Node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
    if (ts.isArrowFunction(parent) && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText();
  }
  return "<module>";
}

/**
 * Owners of every multi-stream append that carries a Consent activation guard
 * input, inline or through a local bound to one in the same append.
 */
function guardedAppendOwners(relativePath: string) {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(path.join(identityRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const guardLocals = new Set<string>();
  const appends: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isGuardInput(node.initializer)) {
      guardLocals.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "appendToStreams"
    ) {
      appends.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const isGuardLocal = (node: ts.Node) =>
    ts.isIdentifier(node) &&
    guardLocals.has(node.text) &&
    !(
      (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) &&
      node.parent.name === node
    );
  const carriesGuard = (node: ts.Node): boolean =>
    isGuardInput(node) || isGuardLocal(node) || ts.forEachChild(node, carriesGuard) === true;
  return appends
    .filter((append) => {
      const streams = append.arguments[0];
      return streams !== undefined && ts.isArrayLiteralExpression(streams) && streams.elements.some(carriesGuard);
    })
    .map(ownerName);
}

describe("Consent glossary contract", () => {
  const source = readFileSync(path.join(identityRoot, "GLOSSARY.md"), "utf8");
  const authority = glossaryEntry(source, "Consent Activation Authority");
  const bundle = glossaryEntry(source, "Consent Bundle");

  it("states Terms of Service acceptance and atomic registration as the shipped guard-bound writes", () => {
    expect(authority).toContain(
      "Terms of Service acceptance and atomic registration are the write call sites that commit against a guard",
    );
    expect(bundle).toContain("Consent recording is bound to a resolved bundle");
    expect(authority).not.toMatch(/write call sites that commit against a guard are owned elsewhere/);
    expect(bundle).not.toMatch(/is owned by a separate slice and is not part of this capability/);
  });

  it("keeps the race-elimination sweep and the registration affirmation surface unshipped", () => {
    expect(authority).toContain(
      "The elimination sweep for consent-activation races is owned elsewhere and does not exist yet.",
    );
    expect(bundle).toContain(
      "The registration surface does not yet render an affirmation of a non-empty requirement set",
    );
  });

  it("names exactly the write call sites whose append carries an activation guard", () => {
    expect(guardedAppendOwners("features/consents/api/runtime.ts")).toEqual(["recordTermsConsent"]);
    expect(guardedAppendOwners("api.ts")).toEqual(["appendPersonalIdentityRegistration"]);
  });
});
