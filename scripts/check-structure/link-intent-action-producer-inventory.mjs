import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { deriveOwnerLinkTypes } from "./generate-link-intents.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const inventoryPath = path.join(import.meta.dirname, "link-intent-action-producers.json");
const linkField = /(?:href|url|link|path)$/i;

function ownerBuilderViolations(source, file, producerLines) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const builders = new Set();
  const variables = [];
  const helpers = new Map();
  const calls = [];
  const sinks = [];
  const scope = (node) => {
    for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return current;
    return ast;
  };
  const walk = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      /(?:integration\/link-intents|routes\/link-intents)$/.test(node.moduleSpecifier.text)
    )
      for (const binding of node.importClause?.namedBindings?.elements ?? []) builders.add(binding.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      variables.push(node);
      if (node.initializer && ts.isArrowFunction(node.initializer)) helpers.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) helpers.set(node.name.text, node);
    if (ts.isCallExpression(node)) calls.push(node);
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name?.text &&
      !(node.name.text === "path" && ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) &&
      linkField.test(node.name.text) &&
      ts.isObjectLiteralExpression(node.parent)
    )
      sinks.push(node);
    ts.forEachChild(node, walk);
  };
  walk(ast);
  const resolves = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return false;
    const next = new Set(seen).add(node);
    if (node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
      return resolves(node.expression, next);
    if (ts.isConditionalExpression(node)) return resolves(node.whenTrue, next) && resolves(node.whenFalse, next);
    if (ts.isIdentifier(node)) {
      let current = scope(node);
      while (current) {
        const binding = variables.find((v) => v.name.text === node.text && scope(v) === current);
        if (binding) return resolves(binding.initializer, next);
        current = current === ast ? null : scope(current);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "href" && ts.isCallExpression(node.expression)) {
        const callee = node.expression.expression;
        if (ts.isIdentifier(callee) && builders.has(callee.text)) return true;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "fromHref" &&
          ts.isIdentifier(callee.expression) &&
          builders.has(callee.expression.text)
        )
          return true;
      }
      // Channel helpers may forward only a builder-produced field from every real caller.
      const fn = scope(node);
      const name = ts.isFunctionDeclaration(fn) ? fn.name?.text : null;
      if (name && ts.isIdentifier(node.expression)) {
        const parameter = fn.parameters.findIndex(
          (p) => ts.isIdentifier(p.name) && p.name.text === node.expression.text,
        );
        if (parameter >= 0) {
          const uses = calls.filter((call) => ts.isIdentifier(call.expression) && call.expression.text === name);
          return (
            uses.length > 0 &&
            uses.every((call) => {
              const argument = call.arguments[parameter];
              if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
              const property = argument.properties.find((p) => p.name?.text === node.name.text);
              return (
                property &&
                resolves(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, next)
              );
            })
          );
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = helpers.get(node.expression.text);
      if (!helper?.body) return false;
      if (!ts.isBlock(helper.body)) return resolves(helper.body, next);
      const returns = helper.body.statements.filter(ts.isReturnStatement);
      return returns.length > 0 && returns.every((statement) => resolves(statement.expression, next));
    }
    return false;
  };
  return sinks
    .filter(
      (sink) =>
        producerLines.has(ast.getLineAndCharacterOfPosition(sink.getStart(ast)).line + 1) &&
        !resolves(ts.isShorthandPropertyAssignment(sink) ? sink.name : sink.initializer),
    )
    .map((sink) => ast.getLineAndCharacterOfPosition(sink.getStart(ast)).line + 1);
}

function isProduction(file) {
  return (
    /\.[cm]?[jt]sx?$/.test(file) &&
    !/(?:^|\/)(?:tests?|fixtures?|node_modules)\//.test(file) &&
    !/\.(?:test|spec)\./.test(file) &&
    !file.endsWith(".d.ts")
  );
}

export function deriveActionProducers({ repoRoot = root, extraSources = [] } = {}) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(isProduction);
  const sources = tracked.map((file) => ({ path: file, source: readFileSync(path.join(repoRoot, file), "utf8") }));
  const rows = [];
  for (const sourceFile of [...sources, ...extraSources]) {
    const file = { ...sourceFile, source: sourceFile.source.replaceAll("\r\n", "\n") };
    if (!/\b(?:messageType|NotificationMessage)\b|@chase-sets\/outbound-messaging/.test(file.source)) continue;
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const aliases = new Set(["NotificationMessage"]);
    const messageConstructors = new Set();
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "@chase-sets/outbound-messaging") {
        for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
          if ((binding.propertyName?.text ?? binding.name.text) === "NotificationMessage")
            aliases.add(binding.name.text);
          if ((binding.propertyName?.text ?? binding.name.text) === "createTransactionalEmailNotificationMessage")
            messageConstructors.add(binding.name.text);
        }
      }
    }
    const visit = (node, functionName = "module", typed = false) => {
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const ownName =
          node.name?.text ??
          (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(ast) : `anonymous-${node.pos}`);
        const name = functionName === "module" ? ownName : `${functionName}/${ownName}`;
        const type = node.type?.getText(ast) ?? "";
        const isTyped = [...aliases].some((alias) =>
          new RegExp(`^(?:readonly\\s+)?${alias}(?:\\[\\]|\\[["']channels["']\\])?(?:\\s*\\|\\s*null)?$`).test(type),
        );
        const sinks = [];
        const messageTypes = [];
        let constructsThroughPublicContract = false;
        let hasTypedMessageValue = false;
        const scan = (child) => {
          if (
            child !== node &&
            (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child))
          )
            return;
          if (
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            messageConstructors.has(child.expression.text)
          )
            constructsThroughPublicContract = true;
          if (
            (ts.isVariableDeclaration(child) || ts.isAsExpression(child) || ts.isSatisfiesExpression(child)) &&
            child.type &&
            aliases.has(child.type.getText(ast))
          )
            hasTypedMessageValue = true;
          if (
            (ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) &&
            ts.isObjectLiteralExpression(child.parent)
          ) {
            const key = ts.isComputedPropertyName(child.name)
              ? ts.isStringLiteralLike(child.name.expression)
                ? child.name.expression.text
                : null
              : child.name.text;
            if (key === "messageType") messageTypes.push(child.initializer?.getText(ast) ?? key);
            if (
              key &&
              linkField.test(key) &&
              !(key === "path" && ts.isPropertyAssignment(child) && ts.isObjectLiteralExpression(child.initializer))
            )
              sinks.push({
                field: key,
                expression: child.initializer?.getText(ast) ?? key,
                line: ast.getLineAndCharacterOfPosition(child.getStart(ast)).line + 1,
              });
          }
          ts.forEachChild(child, scan);
        };
        scan(node);
        const constructsMessageType = messageTypes.some((expression) => /^['"`]/.test(expression));
        if (
          constructsMessageType ||
          constructsThroughPublicContract ||
          ((isTyped || hasTypedMessageValue) && sinks.length)
        )
          rows.push({
            id: `${file.path}::${name}`,
            path: file.path,
            function: name,
            messageTypes: [...new Set(messageTypes)],
            fields: sinks,
            source: node.getText(ast),
          });
        ts.forEachChild(node, (child) => visit(child, name, isTyped));
        return;
      }
      // A top-level message value is also a producer, even without an annotation or import.
      if (
        functionName === "module" &&
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer) &&
        node.initializer.properties.some((p) => p.name?.text === "messageType")
      ) {
        const fields = node.initializer.properties
          .filter((p) => p.name && linkField.test(p.name.text))
          .map((p) => ({
            field: p.name.text,
            expression: p.initializer?.getText(ast) ?? p.name.text,
            line: ast.getLineAndCharacterOfPosition(p.getStart(ast)).line + 1,
          }));
        rows.push({
          id: `${file.path}::${node.name.getText(ast)}`,
          path: file.path,
          function: node.name.getText(ast),
          messageTypes: [],
          fields,
          source: node.getText(ast),
        });
      }
      ts.forEachChild(node, (child) => visit(child, functionName, typed));
    };
    visit(ast);
  }
  return rows
    .map((row) => ({ ...row, sourceDigest: createHash("sha256").update(row.source).digest("hex") }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function verifyActionProducers(
  rows = deriveActionProducers(),
  { registrations = JSON.parse(readFileSync(inventoryPath, "utf8")), repoRoot = root } = {},
) {
  const violations = [];
  const actual = new Map(rows.map((row) => [row.id, row]));
  const registered = new Map(registrations.map((row) => [row.id, row]));
  const inspectedBusinessFiles = new Set();
  if (actual.size !== rows.length || registered.size !== registrations.length)
    violations.push("Duplicate action producer");
  for (const row of rows) {
    const registration = registered.get(row.id);
    if (!registration) {
      violations.push(`Unclassified action producer ${row.id}`);
      continue;
    }
    const fields = row.fields.map(({ field, expression }) => ({ field, expression }));
    if (row.sourceDigest !== registration.sourceDigest) violations.push(`Stale producer implementation ${row.id}`);
    if (
      JSON.stringify(fields) !== JSON.stringify(registration.fields) ||
      JSON.stringify(row.messageTypes) !== JSON.stringify(registration.messageTypes)
    )
      violations.push(`Stale action producer ${row.id}`);
    if (
      !["business-navigation", "web-only-campaign", "auth-single-use", "external", "non-actionable"].includes(
        registration.classification,
      ) ||
      !registration.reason
    )
      violations.push(`Invalid classification ${row.id}`);
    if (registration.classification === "non-actionable" && row.fields.length)
      violations.push(`Actionable producer classified as non-actionable ${row.id}`);
    if (registration.classification === "business-navigation") {
      if (!registration.intentIds?.length) violations.push(`Missing intent coverage ${row.id}`);
      for (const intentId of registration.intentIds ?? []) {
        const separator = intentId.indexOf(".");
        const owner = intentId.slice(0, separator);
        const routeId = intentId.slice(separator + 1);
        const manifest = JSON.parse(
          readFileSync(path.join(repoRoot, `bounded-contexts/${owner}/context.json`), "utf8"),
        );
        const routes = manifest.deployableContributions
          .flatMap((c) => c.routes)
          .filter((r) => r.routeId === routeId && r.canonicalLink?.kind === "route-derived");
        if (routes.length !== 1) violations.push(`Inactive contributed intent ${row.id}/${intentId}`);
      }
      const source = readFileSync(path.join(repoRoot, row.path), "utf8");
      if (!/from ["'][^"']*(?:integration\/link-intents|routes\/link-intents)["']/.test(source))
        violations.push(`Missing owner builder ${row.id}`);
      if (row.fields.some((field) => /^['"`]\//.test(field.expression))) violations.push(`Raw business link ${row.id}`);
      if (!inspectedBusinessFiles.has(row.path)) {
        inspectedBusinessFiles.add(row.path);
        const producerLines = new Set(
          rows.filter((entry) => entry.path === row.path).flatMap((entry) => entry.fields.map((field) => field.line)),
        );
        for (const line of ownerBuilderViolations(source, row.path, producerLines))
          violations.push(`Unproved owner builder ${row.path}:${line}`);
      }
    }
  }
  for (const row of registrations) if (!actual.has(row.id)) violations.push(`Missing action producer ${row.id}`);
  for (const generated of deriveOwnerLinkTypes(repoRoot)) {
    if (readFileSync(path.join(repoRoot, generated.path), "utf8").replaceAll("\r\n", "\n") !== generated.source)
      violations.push(`Stale owner link types ${generated.path}`);
  }
  return violations;
}

export function validateLinkIntentActionProducers({ addPathViolation }) {
  for (const violation of verifyActionProducers())
    addPathViolation("scripts/check-structure/link-intent-action-producers.json", violation);
}

if (process.argv[1] === import.meta.filename) {
  const rows = deriveActionProducers();
  if (process.argv.includes("--derive")) {
    writeFileSync(
      path.join(root, "artifacts/7274/derived-action-producers.json"),
      `${JSON.stringify(rows, null, 2)}\n`,
    );
    console.log(`Derived ${rows.length} producers; classifications require owner inspection.`);
  } else {
    const errors = verifyActionProducers(rows);
    for (const error of errors) console.error(error);
    console.log(`link-intent-action-producer-inventory: ${rows.length} producers; ${errors.length} violations`);
    if (errors.length) process.exitCode = 1;
  }
}
