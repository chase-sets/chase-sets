import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";

// Guards the scope-first daily boundary (issue #3802): the canonical daily
// journey (Scope Landing / Scope Detail) renders its scope-picker controls
// from the provider registry's declared shape, never from a literal branch on
// a provider-key string. Discovery is by CODE SHAPE, not filename: every .tsx
// file in the repository is parsed, and any branch construct (if/else-if,
// switch, ternary, or an object literal indexed by a provider-key-like
// expression) that (a) compares/keys on an expression whose text mentions
// "provider" and (b) renders a picker-shaped control (<Select>,
// <NativeSelect>, <RadioGroup>, <Combobox>, <Autocomplete>) that also
// references one of the structured scope fields is rejected. Registry-backed
// compatibility parsers (provider-import-scope-shape.ts and friends) are
// plain .ts lookup tables with no JSX, so they never enter this scan; a
// provider-keyed branch that renders operational/mapping content (badges,
// tables, links) rather than a scope-field picker is likewise unaffected.

const pickerTagPattern = /^(?:Select|NativeSelect|RadioGroup|Combobox|Autocomplete)$/;
const scopeFieldPattern =
  /\b(languageCode|productLineId|productLineName|seriesId|seriesName|expansionId|expansionName|importScope)\b/;
const providerLikePattern = /provider/i;
const literalPattern = /["']([a-zA-Z][a-zA-Z0-9_-]{1,40})["']/g;

export async function validateProviderScopePickerShapeGuard({ repoRoot }) {
  const absoluteFiles = await collectFiles(repoRoot, {
    extensions: new Set([".tsx"]),
    skippedDirectories: defaultSkippedDirectories,
  });
  const files = absoluteFiles.map((file) => path.relative(repoRoot, file).replaceAll("\\", "/")).sort();

  const hits = [];
  let candidateSurfaces = 0;

  for (const relativeFile of files) {
    const source = await readFile(path.join(repoRoot, relativeFile), "utf8");
    const sourceFile = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    candidateSurfaces += countJsxComponents(sourceFile);
    hits.push(...findProviderKeyedPickerBranches(sourceFile, relativeFile));
  }

  const violations = hits.map(
    (hit) =>
      `${hit.file}:${hit.line}: '${hit.discriminant}' branches on provider-key literal(s) (${hit.literals.join(
        ", ",
      )}) to choose which <${hit.tag}> to render for '${hit.field}'; keep the rendered scope-picker driven by the provider registry's declared shape (see provider-import-scope-shape.ts), not literal provider branching in render code.`,
  );

  return {
    violations,
    hits,
    discovery: { scannedFiles: files.length, candidateSurfaces },
  };
}

function countJsxComponents(sourceFile) {
  let count = 0;
  visit(sourceFile, (node) => {
    if (!ts.isFunctionLike(node) || !node.body) return;
    if (containsJsx(node.body)) count += 1;
  });
  return count;
}

function containsJsx(node) {
  let found = false;
  visit(node, (candidate) => {
    if (found) return;
    if (ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate) || ts.isJsxFragment(candidate)) {
      found = true;
    }
  });
  return found;
}

function findProviderKeyedPickerBranches(sourceFile, relativeFile) {
  const hits = [];
  const visited = new Set();
  const objectLiteralsByName = new Map();
  visit(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      objectLiteralsByName.set(node.name.text, node.initializer);
    }
  });

  const record = (branchNode, discriminant, literals) => {
    if (!branchNode || literals.length === 0) return;
    const picker = findPickerElement(branchNode, sourceFile);
    if (!picker) return;
    const branchText = branchNode.getText(sourceFile);
    const fieldMatch = scopeFieldPattern.exec(branchText);
    if (!fieldMatch) return;
    const position = sourceFile.getLineAndCharacterOfPosition(picker.getStart(sourceFile));
    hits.push({
      file: relativeFile,
      line: position.line + 1,
      discriminant,
      literals: [...new Set(literals)],
      tag: jsxTagName(picker),
      field: fieldMatch[1],
    });
  };

  const extractLiterals = (node) => {
    const text = node.getText(sourceFile);
    if (!providerLikePattern.test(text)) return [];
    return [...text.matchAll(literalPattern)].map((match) => match[1]);
  };

  visit(sourceFile, (node) => {
    if (visited.has(node)) return;

    if (ts.isSwitchStatement(node)) {
      const discriminant = node.expression.getText(sourceFile);
      if (!providerLikePattern.test(discriminant)) return;
      const literals = node.caseBlock.clauses
        .filter((clause) => ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression))
        .map((clause) => clause.expression.text);
      for (const clause of node.caseBlock.clauses) {
        for (const statement of clause.statements) {
          record(statement, discriminant, literals);
        }
      }
      return;
    }

    if (ts.isIfStatement(node)) {
      const discriminant = node.expression.getText(sourceFile);
      const literals = [];
      const branchNodes = [];
      let current = node;
      while (current) {
        visited.add(current);
        literals.push(...extractLiterals(current.expression));
        branchNodes.push(current.thenStatement);
        if (current.elseStatement && ts.isIfStatement(current.elseStatement)) {
          current = current.elseStatement;
        } else {
          if (current.elseStatement) branchNodes.push(current.elseStatement);
          current = null;
        }
      }
      for (const branch of branchNodes) record(branch, discriminant, literals);
      return;
    }

    if (ts.isConditionalExpression(node)) {
      const discriminant = node.condition.getText(sourceFile);
      const literals = [];
      const branchNodes = [];
      let current = node;
      while (current && ts.isConditionalExpression(current)) {
        visited.add(current);
        literals.push(...extractLiterals(current.condition));
        branchNodes.push(current.whenTrue);
        if (ts.isConditionalExpression(current.whenFalse)) {
          current = current.whenFalse;
        } else {
          branchNodes.push(current.whenFalse);
          current = null;
        }
      }
      for (const branch of branchNodes) record(branch, discriminant, literals);
      return;
    }

    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const unwrapped = unwrapExpression(node.expression);
      const objectExpression = ts.isObjectLiteralExpression(unwrapped)
        ? unwrapped
        : ts.isIdentifier(unwrapped)
          ? (objectLiteralsByName.get(unwrapped.text) ?? null)
          : null;
      if (!objectExpression) return;
      const discriminant = node.argumentExpression.getText(sourceFile);
      if (!providerLikePattern.test(discriminant)) return;
      const literals = objectExpression.properties
        .filter((property) => ts.isPropertyAssignment(property))
        .map((property) => propertyKeyText(property.name))
        .filter((value) => value !== null);
      for (const property of objectExpression.properties) {
        if (ts.isPropertyAssignment(property)) {
          record(property.initializer, discriminant, literals);
        }
      }
    }
  });

  return hits;
}

function findPickerElement(node, sourceFile) {
  let found = null;
  visit(node, (candidate) => {
    if (found) return;
    if (!ts.isJsxElement(candidate) && !ts.isJsxSelfClosingElement(candidate)) return;
    if (pickerTagPattern.test(jsxTagName(candidate))) found = candidate;
  });
  return found;
}

function jsxTagName(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

function propertyKeyText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current ?? null;
}

function visit(node, callback) {
  const walkNode = (candidate) => {
    callback(candidate);
    candidate.forEachChild((child) => walkNode(child));
  };
  walkNode(node);
}

if (process.argv[1]?.endsWith("provider-scope-picker-shape-guard.mjs")) {
  const repoRoot = process.cwd();
  const result = await validateProviderScopePickerShapeGuard({ repoRoot });
  if (process.argv.includes("--inventory")) {
    console.log(JSON.stringify({ discovery: result.discovery, hits: result.hits }, null, 2));
  }
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else if (!process.argv.includes("--inventory")) {
    console.log(
      `provider scope-picker shape guard: scanned ${result.discovery.scannedFiles} .tsx files, ${result.discovery.candidateSurfaces} JSX-rendering surfaces; no provider-key-keyed scope-picker branching found.`,
    );
  }
}
