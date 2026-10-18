import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const roots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
export const cancellationMapperPath =
  "bounded-contexts/notifications/features/notification-center/integrations/source-events/notification-intents.ts";
export const cancellationMapperAuthor = `${cancellationMapperPath}#mapOrderCancelledToNotification`;
// Paths are resolved against a fixed virtual root so the scan reads only the supplied sources.
const virtualRoot = path.resolve("/cancellation-producer-scan");
const normalize = (value) => value.replaceAll("\\", "/");

// The alias/closure producer pair and its `created` control, planted in the real program on every run.
const plantedCompositionSource = (event) =>
  `export function compose() { return { messageType: "ordering." + "order." + "${event}", channels: [{ channel: "email", to: [{ email: "synthetic@example.test" }] }], templateId: "order_" + "${event}" }; }`;
const plantedEmissionSource = `import { compose as differentName } from "./synthetic-composition";
      export function install(outbox) { const transmit = outbox.enqueueNotification.bind(outbox);
        return { ["ordering." + "order." + "cancelled"]: async () => { await transmit({ message: differentName() }); } }; }`;
const plantedCancelledRoot = "bounded-contexts/pricing/features/synthetic-cancellation-producer";
const plantedCreatedRoot = "bounded-contexts/pricing/features/synthetic-cancellation-control";
export const plantedCancelledAuthor = `${plantedCancelledRoot}/synthetic-composition.ts#compose`;
export const plantedCancellationSources = new Map([
  [`${plantedCancelledRoot}/synthetic-emission.ts`, plantedEmissionSource],
  [`${plantedCancelledRoot}/synthetic-composition.ts`, plantedCompositionSource("cancelled")],
  [`${plantedCreatedRoot}/synthetic-emission.ts`, plantedEmissionSource],
  [`${plantedCreatedRoot}/synthetic-composition.ts`, plantedCompositionSource("created")],
]);

export function trackedFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "--cached", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function partition(files) {
  const production = [];
  const excluded = [];
  for (const file of files) {
    if (!roots.some((root) => file.startsWith(`${root}/`))) throw new Error(`Source outside workspace roots: ${file}`);
    if (
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.(?:test|spec|tmp|d)\.[cm]?[jt]sx?$/.test(file) &&
      !/(?:^|\/)(?:tests|__tests__|fixtures|e2e|build|dist|coverage)(?:\/|$)/.test(file)
    )
      production.push(file);
    else excluded.push(file);
  }
  if (new Set(files).size !== files.length || production.length + excluded.length !== files.length)
    throw new Error("Incomplete source partition");
  return { production, excluded };
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function owner(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

export function scan(files, sources, expectedFiles) {
  if (!Array.isArray(expectedFiles)) throw new Error("Expected tracked source list is required");
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...expectedFiles].sort()))
    throw new Error("Omitted tracked source discovery");
  const { production, excluded } = partition(files);
  if (sources.size !== production.length || production.some((file) => !sources.has(file)))
    throw new Error("Unreadable or omitted production source partition");
  const absolute = (file) => normalize(path.resolve(virtualRoot, file));
  const sourceByAbsolute = new Map([...sources].map(([file, source]) => [absolute(file), source]));
  const directories = new Set();
  for (const file of sourceByAbsolute.keys())
    for (
      let directory = path.posix.dirname(file);
      !directories.has(directory);
      directory = path.posix.dirname(directory)
    )
      directories.add(directory);
  const options = {
    noLib: true,
    noResolve: true,
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  host.readFile = (file) => sourceByAbsolute.get(normalize(file));
  host.fileExists = (file) => sourceByAbsolute.has(normalize(file));
  host.directoryExists = (directory) => directories.has(normalize(directory).replace(/\/$/, ""));
  host.getDirectories = () => [];
  host.realpath = (file) => file;
  host.getSourceFile = (file, languageVersion) => {
    const source = host.readFile(file);
    return source === undefined ? undefined : ts.createSourceFile(file, source, languageVersion, true);
  };
  const program = ts.createProgram(production.map(absolute), options, host);
  const checker = program.getTypeChecker();
  const loaded = program.getSourceFiles();
  if (loaded.length !== production.length) throw new Error("Incomplete compiler source partition");
  const edges = new Map();
  const sinks = new Set();
  const cancellationOwners = new Set();
  const objects = [];

  function declarations(node) {
    let symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  }
  function values(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    node = unwrap(node);
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node))
      return declarations(node).flatMap((declaration) => {
        if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isBindingElement(declaration))
          return values(declaration.initializer, next);
        if (ts.isFunctionDeclaration(declaration)) return [declaration];
        if (ts.isShorthandPropertyAssignment(declaration)) return values(declaration.name, next);
        return [];
      });
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, next), ...values(node.whenFalse, next)];
    if (ts.isPropertyAccessExpression(node))
      return values(node.expression, next).flatMap((value) =>
        ts.isObjectLiteralExpression(value) ? values(property(value, node.name.text), next) : [],
      );
    return [node];
  }
  function strings(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    return values(node).flatMap((value) => {
      if (ts.isStringLiteralLike(value)) return [value.text];
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return strings(value.left, next).flatMap((left) => strings(value.right, next).map((right) => left + right));
      if (ts.isTemplateExpression(value)) {
        let result = [value.head.text];
        for (const span of value.templateSpans)
          result = result.flatMap((left) =>
            strings(span.expression, next).map((right) => left + right + span.literal.text),
          );
        return result;
      }
      return [];
    });
  }
  function property(object, name) {
    for (const member of object.properties) {
      if (
        (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
        (ts.isComputedPropertyName(member.name)
          ? strings(member.name.expression).includes(name)
          : member.name.getText().replace(/^["']|["']$/g, "") === name)
      )
        return ts.isPropertyAssignment(member) ? member.initializer : member.name;
    }
    return undefined;
  }
  function connect(from, to) {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  }
  function functionTargets(node, seen = new Set()) {
    if (seen.has(node)) return [];
    const next = new Set(seen).add(node);
    return declarations(node).flatMap((declaration) => {
      if (ts.isFunctionDeclaration(declaration)) return [declaration];
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const value = unwrap(declaration.initializer);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return [value];
        if (ts.isIdentifier(value)) return functionTargets(value, next);
      }
      return [];
    });
  }
  function isSink(node, seen = new Set()) {
    node = unwrap(node);
    if (seen.has(node)) return false;
    const next = new Set(seen).add(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "enqueueNotification") return true;
    if (ts.isElementAccessExpression(node) && strings(node.argumentExpression).includes("enqueueNotification"))
      return true;
    if (ts.isIdentifier(node))
      return declarations(node).some((declaration) => {
        if (ts.isBindingElement(declaration))
          return (declaration.propertyName ?? declaration.name).getText() === "enqueueNotification";
        return (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          isSink(declaration.initializer, next)
        );
      });
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "bind"
    )
      return isSink(node.expression.expression, next);
    return false;
  }
  function hasEmail(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    const next = new Set(seen).add(node);
    return values(node).some((value) => {
      if (ts.isArrayLiteralExpression(value)) return value.elements.some((element) => hasEmail(element, next));
      if (ts.isSpreadElement(value)) return hasEmail(value.expression, next);
      if (ts.isObjectLiteralExpression(value))
        return strings(property(value, "channel")).includes("email") || property(value, "to") !== undefined;
      return false;
    });
  }
  for (const source of loaded) {
    visit(source, (node) => {
      const current = owner(node);
      if (ts.isFunctionLike(node) && !ts.isSourceFile(current)) connect(current, node);
      if (ts.isObjectLiteralExpression(node)) objects.push(node);
      if (ts.isCallExpression(node) && isSink(node.expression)) sinks.add(current);
      if (ts.isIdentifier(node) && !ts.isSourceFile(current)) {
        for (const target of functionTargets(node)) connect(current, target);
      }
      if (
        ts.isPropertyAssignment(node) &&
        strings(ts.isComputedPropertyName(node.name) ? node.name.expression : node.name).includes(
          "ordering.order.cancelled",
        )
      ) {
        cancellationOwners.add(current);
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          cancellationOwners.add(node.initializer);
      }
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteralLike(node.initializer) || ts.isBinaryExpression(node.initializer)) &&
        strings(node.initializer).some((value) => value === "ordering.order.cancelled")
      )
        cancellationOwners.add(current);
      if (
        ts.isBinaryExpression(node) &&
        (ts.isStringLiteralLike(node.right) || ts.isBinaryExpression(node.right)) &&
        strings(node.right).includes("ordering.order.cancelled")
      )
        cancellationOwners.add(current);
    });
  }
  const incoming = new Map();
  for (const [caller, callees] of edges)
    for (const callee of callees) {
      if (!incoming.has(callee)) incoming.set(callee, new Set());
      incoming.get(callee).add(caller);
    }
  function ancestors(starts) {
    const found = new Set(starts);
    const pending = [...found];
    while (pending.length) {
      for (const caller of incoming.get(pending.pop()) ?? []) {
        if (!found.has(caller)) {
          found.add(caller);
          pending.push(caller);
        }
      }
    }
    return found;
  }
  const sinkCallers = ancestors(sinks);
  const cancellationReach = new Set(cancellationOwners);
  const pendingCancellation = [...cancellationOwners];
  while (pendingCancellation.length) {
    for (const callee of edges.get(pendingCancellation.pop()) ?? []) {
      if (!cancellationReach.has(callee)) {
        cancellationReach.add(callee);
        pendingCancellation.push(callee);
      }
    }
  }
  const authors = [];
  let safeMessages = 0;
  let forwardingMessages = 0;
  for (const object of objects) {
    const messageType = property(object, "messageType");
    if (!messageType) continue;
    const types = strings(messageType);
    const current = owner(object);
    const cancellation =
      types.some((value) => value === "ordering.order.cancelled" || value.startsWith("ordering.order.cancelled.")) ||
      strings(property(object, "templateId")).includes("order_cancelled");
    if (types.length === 0 && !cancellation) {
      // Generic adapters forward the caller's message; a cancellation owner cannot hide an unresolved author.
      if (cancellationReach.has(current) && (hasEmail(property(object, "channels")) || property(object, "to")))
        throw new Error(`Unresolved cancellation message in ${object.getSourceFile().fileName}`);
      forwardingMessages++;
      continue;
    }
    if (!cancellation) {
      safeMessages++;
      continue;
    }
    if (!hasEmail(property(object, "channels")) && !property(object, "to")) continue;
    const callersWithSink = [...ancestors([current])].filter((caller) => sinkCallers.has(caller));
    if (callersWithSink.length === 0)
      throw new Error(`Unresolved cancellation outbox composition: ${object.getSourceFile().fileName}`);
    const name = ts.isFunctionDeclaration(current)
      ? current.name?.text
      : ts.isVariableDeclaration(current.parent)
        ? current.parent.name.getText()
        : "closure";
    authors.push(`${normalize(path.relative(virtualRoot, object.getSourceFile().fileName))}#${name}`);
  }
  const retired = [
    "mapOrderPaymentDeadlineCancelledToTransactionalEmail",
    "OrderPaymentDeadlineCancelledEmailIntentInput",
    "OrderingOrderCancelledEmailData",
    "order_payment_deadline_cancelled",
    "reorderHref",
    "reorderFrom",
    "reorderCTA",
  ];
  for (const [file, source] of sources)
    for (const token of retired)
      if (source.includes(token)) throw new Error(`Retired cancellation token ${token} in ${file}`);
  return {
    authors: authors.sort(),
    total: files.length,
    scanned: production.length,
    excluded: excluded.length,
    safeMessages,
    forwardingMessages,
    sinks: sinks.size,
  };
}

const label = "cancellation producer uniqueness";

// One program over the tracked sources plus the planted pairs: the mapper and the planted `cancelled`
// helper must be the only authors, so a lost alias or closure owner fails every run.
export function evaluateCancellationProducerUniqueness(tracked, sources) {
  const collisions = tracked.filter((file) => plantedCancellationSources.has(file));
  if (collisions.length)
    return {
      violations: collisions.map((file) => `${file}: ${label}: planted control path is tracked`),
      inventory: null,
    };
  let inventory;
  try {
    const files = [...tracked, ...plantedCancellationSources.keys()].sort();
    inventory = scan(files, new Map([...sources, ...plantedCancellationSources]), files);
  } catch (error) {
    return { violations: [`${label}: ${error instanceof Error ? error.message : String(error)}`], inventory: null };
  }
  const expected = [cancellationMapperAuthor, plantedCancelledAuthor].sort();
  const violations = [];
  if (JSON.stringify(inventory.authors) !== JSON.stringify(expected))
    violations.push(
      `${label}: structural cancellation-email authors ${JSON.stringify(inventory.authors)}; expected ${JSON.stringify(expected)}`,
    );
  if (inventory.total !== inventory.scanned + inventory.excluded)
    violations.push(`${label}: scanned and excluded sources do not cover the ${inventory.total} tracked sources`);
  if (inventory.safeMessages === 0) violations.push(`${label}: no safe message was found`);
  if (inventory.sinks === 0) violations.push(`${label}: no enqueueNotification sink was found`);
  return { violations, inventory };
}

export function validateCancellationProducerUniqueness({ repoRoot }) {
  let tracked;
  let production;
  try {
    tracked = trackedFiles(repoRoot);
    production = partition(tracked).production;
  } catch (error) {
    return { violations: [`${label}: ${error instanceof Error ? error.message : String(error)}`], inventory: null };
  }
  const sources = new Map();
  for (const file of production) {
    try {
      sources.set(file, readFileSync(path.join(repoRoot, file), "utf8"));
    } catch {
      // An unreadable tracked source stays absent, so the scan fails its production partition.
    }
  }
  const result = evaluateCancellationProducerUniqueness(tracked, sources);
  if (result.inventory)
    console.log(
      `${label}: ${result.inventory.scanned}/${result.inventory.total} sources scanned (${plantedCancellationSources.size} planted), authors ${result.inventory.authors.join(", ")}`,
    );
  return result;
}
