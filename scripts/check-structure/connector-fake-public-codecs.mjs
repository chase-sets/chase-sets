import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles } from "../lib/files.mjs";

const harness = "deployables/tcgplayer-connector-extension/__tests__/harness";
const producer = "bounded-contexts/channels/features/connector-feed/domain/transport.ts";
const codecs = ["assertConnectorClaim", "assertConnectorReport"];
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

export async function validateConnectorFakeGraph({ repoRoot, overrides = new Map() }) {
  const read = async (file) => overrides.get(file) ?? readFile(path.join(repoRoot, file), "utf8");
  const fields = new Set();
  const grammar = parse(producer, await read(producer));
  for (const node of grammar.statements) {
    if (!ts.isFunctionDeclaration(node) || !codecs.includes(node.name?.text)) continue;
    walk(node, (child) => {
      if (ts.isCallExpression(child) && child.expression.getText(grammar) === "assertClosedRecord") {
        const keys = child.arguments[1];
        if (keys && ts.isArrayLiteralExpression(keys))
          for (const key of keys.elements) if (ts.isStringLiteral(key)) fields.add(key.text);
      }
    });
  }
  if (!fields.size) throw new Error("connector-codec-producer-shape-moved");
  const files = (await collectFiles(path.join(repoRoot, harness), { extensions: new Set([".ts"]) })).map((file) =>
    path.relative(repoRoot, file).replaceAll("\\", "/"),
  );
  for (const file of overrides.keys()) if (file.startsWith(`${harness}/`) && !files.includes(file)) files.push(file);
  const pending = [...files];
  const scanned = new Set();
  const called = new Set();
  const violations = [];
  while (pending.length) {
    const file = pending.pop();
    if (scanned.has(file)) continue;
    scanned.add(file);
    const source = parse(file, await read(file));
    const names = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.includes("bounded-contexts/") || specifier.startsWith("@chase-sets/channels/features/"))
        violations.push(`${file}: connector fake imports context internals`);
      if (
        specifier === "@chase-sets/channels/server" &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const name of statement.importClause.namedBindings.elements) {
          const exported = name.propertyName?.text ?? name.name.text;
          if (codecs.includes(exported)) names.set(name.name.text, exported);
        }
      if (specifier.startsWith(".")) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (!dependency.startsWith("deployables/tcgplayer-connector-extension/")) {
          violations.push(`${file}: connector fake relative import escapes the deployable`);
        } else pending.push(/\.[cm]?[jt]sx?$/.test(dependency) ? dependency : `${dependency}.ts`);
      }
    }
    walk(source, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text))
        called.add(names.get(node.expression.text));
      const field = (value) => value && ts.isPropertyAccessExpression(value) && fields.has(value.name.text);
      if (
        (ts.isTypeOfExpression(node) && field(node.expression)) ||
        (ts.isCallExpression(node) &&
          node.expression.getText(source) === "Array.isArray" &&
          field(node.arguments[0])) ||
        (ts.isArrayLiteralExpression(node) &&
          node.elements.some((item) => ts.isStringLiteral(item) && fields.has(item.text)))
      )
        violations.push(`${file}: connector fake copies producer-owned transport grammar`);
    });
  }
  if (files.length)
    for (const codec of codecs)
      if (!called.has(codec)) violations.push(`${harness}: must call public ${codec}, not merely import it`);
  return { violations: [...new Set(violations)].sort(), scannedFiles: scanned.size, totalFiles: scanned.size };
}
