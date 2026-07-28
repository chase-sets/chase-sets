import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";
import { acquireHeavySlot } from "../lib/heavy-slot.mjs";

// Guards the scope-first daily boundary: rendered structured-scope pickers must
// come from the provider registry's declared shape, never from a literal
// provider-key selection. Discovery is code-shape based across every .tsx file.
// A candidate surface is the nearest execution container that owns JSX: a
// function-like node, or a module-level statement when the JSX is initialized
// outside a function.

const pickerTagPattern = /^(?:Select|NativeSelect|RadioGroup|Combobox|Autocomplete)$/;
const structuredScopeFields = new Set([
  "languageCode",
  "productLineId",
  "productLineName",
  "seriesId",
  "seriesName",
  "expansionId",
  "expansionName",
  "importScope",
]);
const providerKeyIdentifierPattern = /(?:^provider$|provider(?:Key|Id|Slug|Code)$)/i;
const providerObjectIdentifierPattern = /^provider$/i;
const providerKeyPropertyPattern = /^(?:key|id|slug|code)$/i;
const equalityOperators = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

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
    const sourceFacts = collectSourceFacts(sourceFile);
    candidateSurfaces += sourceFacts.candidateSurfaces;
    hits.push(...findProviderKeyedPickerSelections(sourceFile, relativeFile, sourceFacts.declarationsByName));
  }

  const violations = hits.map(
    (hit) =>
      `${hit.file}:${hit.line}: '${hit.discriminant}' selects provider-key literal(s) (${hit.literals.join(
        ", ",
      )}) to choose <${hit.tag}> for structured scope field '${hit.field}'; keep the rendered scope-picker driven by the provider registry's declared shape (see provider-import-scope-shape.ts), not literal provider selection in render code.`,
  );

  return {
    violations,
    hits,
    discovery: { scannedFiles: files.length, candidateSurfaces },
  };
}

function collectSourceFacts(sourceFile) {
  const surfaces = new Set();
  const declarationsByName = new Map();
  visit(sourceFile, (node) => {
    if (isJsxNode(node)) {
      const surface = nearestCandidateSurface(node, sourceFile);
      if (surface) surfaces.add(surface);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const candidates = declarationsByName.get(node.name.text) ?? [];
      candidates.push(node);
      declarationsByName.set(node.name.text, candidates);
    }
  });
  return { candidateSurfaces: surfaces.size, declarationsByName };
}

function nearestCandidateSurface(node, sourceFile) {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isFunctionLike(current)) return current;
    if (current.parent === sourceFile && ts.isStatement(current)) return current;
    current = current.parent;
  }
  return null;
}

function findProviderKeyedPickerSelections(sourceFile, relativeFile, declarationsByName) {
  const hits = [];
  const visitedBranches = new Set();

  const record = (selectedNode, selection) => {
    if (!selectedNode || selection.literals.length === 0) return;
    for (const picker of findStructuredScopePickers(selectedNode)) {
      const position = sourceFile.getLineAndCharacterOfPosition(picker.node.getStart(sourceFile));
      hits.push({
        file: relativeFile,
        line: position.line + 1,
        discriminant: selection.discriminant,
        literals: [...new Set(selection.literals)],
        tag: jsxTagName(picker.node),
        field: picker.field,
      });
    }
  };

  visit(sourceFile, (node) => {
    if (visitedBranches.has(node)) return;

    if (ts.isSwitchStatement(node)) {
      const discriminant = node.expression.getText(sourceFile);
      if (!isProviderKeyExpression(node.expression)) return;
      const literals = node.caseBlock.clauses
        .filter((clause) => ts.isCaseClause(clause))
        .map((clause) => stringLiteralValue(clause.expression))
        .filter((value) => value !== null);
      const selection = { discriminant, literals };
      for (const clause of node.caseBlock.clauses) {
        for (const statement of clause.statements) record(statement, selection);
      }
      return;
    }

    if (ts.isIfStatement(node)) {
      let current = node;
      const fallthroughSelections = [];
      while (current) {
        visitedBranches.add(current);
        const selections = extractProviderLiteralSelections(current.expression, sourceFile, declarationsByName);
        fallthroughSelections.push(...selections);
        for (const selection of selections) record(current.thenStatement, selection);
        if (current.elseStatement && ts.isIfStatement(current.elseStatement)) {
          current = current.elseStatement;
        } else {
          if (current.elseStatement) record(current.elseStatement, combineSelections(fallthroughSelections));
          current = null;
        }
      }
      return;
    }

    if (ts.isConditionalExpression(node)) {
      let current = node;
      const fallthroughSelections = [];
      while (current && ts.isConditionalExpression(current)) {
        visitedBranches.add(current);
        const selections = extractProviderLiteralSelections(current.condition, sourceFile, declarationsByName);
        fallthroughSelections.push(...selections);
        for (const selection of selections) record(current.whenTrue, selection);
        if (ts.isConditionalExpression(current.whenFalse)) {
          current = current.whenFalse;
        } else {
          record(current.whenFalse, combineSelections(fallthroughSelections));
          current = null;
        }
      }
      return;
    }

    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      if (!isProviderKeyExpression(node.argumentExpression)) return;
      const objectExpression = resolveObjectLiteral(node.expression, declarationsByName);
      if (!objectExpression) return;
      const entries = objectLiteralEntries(objectExpression);
      const selection = {
        discriminant: node.argumentExpression.getText(sourceFile),
        literals: entries.map((entry) => entry.key),
      };
      for (const entry of entries) record(entry.value, selection);
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      node.arguments.length > 0 &&
      isProviderKeyExpression(node.arguments[0])
    ) {
      const entries = resolveMapEntries(node.expression.expression, declarationsByName);
      if (!entries) return;
      const selection = {
        discriminant: node.arguments[0].getText(sourceFile),
        literals: entries.map((entry) => entry.key),
      };
      for (const entry of entries) record(entry.value, selection);
    }
  });

  return hits;
}

function extractProviderLiteralSelections(expression, sourceFile, declarationsByName) {
  const selections = [];
  visit(expression, (node) => {
    if (ts.isBinaryExpression(node) && equalityOperators.has(node.operatorToken.kind)) {
      const leftLiteral = stringLiteralValue(node.left);
      const rightLiteral = stringLiteralValue(node.right);
      if (leftLiteral !== null && isProviderKeyExpression(node.right)) {
        selections.push({ discriminant: node.right.getText(sourceFile), literals: [leftLiteral] });
      } else if (rightLiteral !== null && isProviderKeyExpression(node.left)) {
        selections.push({ discriminant: node.left.getText(sourceFile), literals: [rightLiteral] });
      }
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments.length > 0 &&
      isProviderKeyExpression(node.arguments[0])
    ) {
      const literals = resolveStringArray(node.expression.expression, declarationsByName);
      if (literals.length > 0) {
        selections.push({ discriminant: node.arguments[0].getText(sourceFile), literals });
      }
    }
  });
  return selections;
}

function combineSelections(selections) {
  return {
    discriminant: [...new Set(selections.map((selection) => selection.discriminant))].join(" / "),
    literals: [...new Set(selections.flatMap((selection) => selection.literals))],
  };
}

function resolveStringArray(expression, declarationsByName, seenNames = new Set()) {
  const resolved = resolveExpression(expression, declarationsByName, seenNames);
  if (!resolved || !ts.isArrayLiteralExpression(resolved)) return [];
  return resolved.elements.map((element) => stringLiteralValue(element)).filter((value) => value !== null);
}

function resolveObjectLiteral(expression, declarationsByName, seenNames = new Set()) {
  const resolved = resolveExpression(expression, declarationsByName, seenNames);
  return resolved && ts.isObjectLiteralExpression(resolved) ? resolved : null;
}

function resolveMapEntries(expression, declarationsByName, seenNames = new Set()) {
  const resolved = resolveExpression(expression, declarationsByName, seenNames);
  if (
    !resolved ||
    !ts.isNewExpression(resolved) ||
    !ts.isIdentifier(resolved.expression) ||
    resolved.expression.text !== "Map" ||
    !resolved.arguments?.[0]
  ) {
    return null;
  }
  const entryArray = resolveExpression(resolved.arguments[0], declarationsByName, seenNames);
  if (!entryArray || !ts.isArrayLiteralExpression(entryArray)) return null;
  return entryArray.elements
    .map((element) => {
      const tuple = unwrapExpression(element);
      if (!tuple || !ts.isArrayLiteralExpression(tuple) || tuple.elements.length < 2) return null;
      const key = stringLiteralValue(tuple.elements[0]);
      return key === null ? null : { key, value: tuple.elements[1] };
    })
    .filter((entry) => entry !== null);
}

function resolveExpression(expression, declarationsByName, seenNames = new Set()) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped || !ts.isIdentifier(unwrapped)) return unwrapped;
  if (seenNames.has(unwrapped.text)) return null;
  const declarations = declarationsByName.get(unwrapped.text);
  if (!declarations || declarations.length === 0) return null;
  const visibleDeclarations = declarations.filter((candidate) => nodeContains(lexicalScope(candidate), unwrapped));
  if (visibleDeclarations.length === 0) return null;
  seenNames.add(unwrapped.text);
  const declaration =
    [...visibleDeclarations].reverse().find((candidate) => candidate.getStart() < unwrapped.getStart()) ??
    visibleDeclarations[0];
  return resolveExpression(declaration.initializer, declarationsByName, seenNames);
}

function lexicalScope(node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isBlock(current) && !ts.isModuleBlock(current)) {
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

function nodeContains(ancestor, node) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function objectLiteralEntries(objectExpression) {
  return objectExpression.properties
    .map((property) => {
      if (!ts.isPropertyAssignment(property)) return null;
      const key = propertyKeyText(property.name);
      return key === null ? null : { key, value: property.initializer };
    })
    .filter((entry) => entry !== null);
}

function isProviderKeyExpression(expression) {
  const node = unwrapExpression(expression);
  if (!node) return false;
  if (ts.isIdentifier(node)) return providerKeyIdentifierPattern.test(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    if (providerKeyIdentifierPattern.test(node.name.text)) return true;
    return providerKeyPropertyPattern.test(node.name.text) && isProviderObjectExpression(node.expression);
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const property = stringLiteralValue(node.argumentExpression);
    if (property && providerKeyIdentifierPattern.test(property)) return true;
  }
  let found = false;
  node.forEachChild((child) => {
    if (!found && isProviderKeyExpression(child)) found = true;
  });
  return found;
}

function isProviderObjectExpression(expression) {
  const node = unwrapExpression(expression);
  if (!node) return false;
  if (ts.isIdentifier(node)) return providerObjectIdentifierPattern.test(node.text);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return isProviderObjectExpression(node.expression);
  }
  return false;
}

function findStructuredScopePickers(node) {
  const pickers = [];
  visit(node, (candidate) => {
    if (!isJsxElement(candidate) || !pickerTagPattern.test(jsxTagName(candidate))) return;
    const field = findStructuredScopeField(candidate);
    if (field) pickers.push({ node: candidate, field });
  });
  return pickers;
}

function findStructuredScopeField(node) {
  let field = null;
  visit(node, (candidate) => {
    if (field) return;
    if (ts.isIdentifier(candidate) && structuredScopeFields.has(candidate.text)) {
      field = candidate.text;
      return;
    }
    if (ts.isStringLiteralLike(candidate) && structuredScopeFields.has(candidate.text)) {
      field = candidate.text;
    }
  });
  return field;
}

function isJsxNode(node) {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

function isJsxElement(node) {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function jsxTagName(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

function propertyKeyText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function stringLiteralValue(expression) {
  const unwrapped = unwrapExpression(expression);
  return unwrapped && ts.isStringLiteralLike(unwrapped) ? unwrapped.text : null;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
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
  acquireHeavySlot("script-battery");
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
      `provider scope-picker shape guard: scanned ${result.discovery.scannedFiles} .tsx files, ${result.discovery.candidateSurfaces} JSX execution containers; no literal provider-key scope-picker selection found.`,
    );
  }
}
