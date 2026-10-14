import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const ts = createRequire(path.join(root, "package.json"))("@chase-sets/typescript-compiler-api").default;
const methods = {
  createItem: "item-create",
  adjustItem: "item-adjust",
  reduceItem: "item-adjust",
  ensureListingStock: "listing-stock-ensure",
  recordOfflineSale: "item-adjust",
  createHold: "hold-create",
  planCreateHold: "hold-create",
  createCheckoutReservation: "hold-create",
  releaseHold: "hold-release",
  releaseCheckoutReservation: "hold-release",
  createStorageLocation: "location-create",
  updateStorageLocation: "location-update",
  getItem: "item-read",
  listItems: "item-read",
  getHold: "hold-read",
  getCheckoutHold: "hold-read",
  getStorageLocation: "location-read",
  listStorageLocations: "location-read",
  resolveAccountSkuMappingsToInventoryItems: "item-read",
  getMutationAttempt: "attempt-read",
  readMutationAttempt: "attempt-read",
  createImportBatch: "import-create",
  commitImportBatch: "import-commit",
  resolveImportBatchRow: "import-resolve",
  recordRestockDecision: "restock-record",
};
const commands = {
  CreateInventoryItem: "item-create",
  AdjustInventoryItemQuantity: "item-adjust",
  RecordOfflineSale: "item-adjust",
  PlaceInventoryHold: "hold-create",
  ReleaseInventoryHold: "hold-release",
  CreateStorageLocation: "location-create",
  UpdateStorageLocation: "location-update",
  ArchiveStorageLocation: "location-archive",
};
const methodFamily = (symbol) => (Object.hasOwn(methods, symbol) ? methods[symbol] : null);
const commandFamily = (symbol) => (Object.hasOwn(commands, symbol) ? commands[symbol] : null);

export function trackedInventorySources(repositoryRoot = root) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", "bounded-contexts", "deployables", "infrastructure", "contracts", "packages"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => ({ path: file, source: readFileSync(path.join(repositoryRoot, file), "utf8") }));
}

function ignored(file) {
  return (
    /(?:^|\/)(?:tests?|__tests__|e2e|fixtures|dist|build|generated|node_modules|docs)(?:\/|$)/.test(file) ||
    /\.(?:test|spec|generated|d)\.[cm]?[jt]sx?$/.test(file) ||
    /(?:test-harness|test-support)/.test(file)
  );
}

function name(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null;
}

export function discoverInventoryCallers(sources) {
  const callers = [];
  const ignoredPaths = [];
  let scanned = 0;
  for (const input of sources) {
    const file = input.path.replaceAll("\\", "/");
    if (ignored(file)) {
      ignoredPaths.push(file);
      continue;
    }
    scanned++;
    const source = ts.createSourceFile(file, input.source, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Unresolved Inventory call: invalid syntax in ${file}`);
    const aliases = new Map();
    const scope = (node) => {
      let parent = node.parent;
      while (parent && !ts.isBlock(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
      return parent ?? source;
    };
    const alias = (node, key) => {
      for (let owner = scope(node); owner; owner = owner === source ? null : scope(owner)) {
        const value = aliases.get(owner)?.get(key);
        if (value) return value;
      }
      return null;
    };
    const addAlias = (node, local, symbol) => {
      const owner = scope(node);
      const entries = aliases.get(owner) ?? new Map();
      if (entries.has(local)) return false;
      entries.set(local, symbol);
      aliases.set(owner, entries);
      return true;
    };
    const nodes = [];
    const collect = (node) => {
      nodes.push(node);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const resolve = (node) => {
      if (!node) return null;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
        return resolve(node.expression);
      if (ts.isIdentifier(node)) return alias(node, node.text);
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === "read" && /(?:^|\.)mutations$/.test(node.expression.getText(source)))
          return "readMutationAttempt";
        return methodFamily(node.name.text) ? node.name.text : null;
      }
      if (ts.isElementAccessExpression(node))
        return methodFamily(name(node.argumentExpression)) ? name(node.argumentExpression) : null;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "bind"
      )
        return resolve(node.expression.expression);
      return null;
    };
    // Fixed point includes aliases declared before or after their source alias.
    for (let changed = true; changed; ) {
      changed = false;
      for (const node of nodes) {
        if (ts.isImportSpecifier(node)) {
          const symbol = name(node.propertyName ?? node.name);
          if (methodFamily(symbol) && addAlias(node, node.name.text, symbol)) changed = true;
        }
        if (!ts.isVariableDeclaration(node) || !node.initializer) continue;
        if (ts.isIdentifier(node.name)) {
          const symbol = resolve(node.initializer);
          if (symbol && addAlias(node, node.name.text, symbol)) changed = true;
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const symbol = name(element.propertyName ?? element.name);
            const local = name(element.name);
            if (methodFamily(symbol) && local && addAlias(node, local, symbol)) changed = true;
          }
        }
      }
    }
    for (const node of nodes) {
      let symbol = null;
      let family = null;
      if (
        ts.isElementAccessExpression(node) &&
        !ts.isStringLiteralLike(node.argumentExpression) &&
        /\binventory\b|\.holds\b|\.storageLocations\b/.test(node.expression.getText(source))
      ) {
        throw new Error(
          `Unresolved Inventory call: ${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        );
      }
      if (ts.isCallExpression(node)) {
        symbol = resolve(node.expression);
        if (
          !symbol &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["call", "apply"].includes(node.expression.name.text)
        )
          symbol = resolve(node.expression.expression);
        family = methodFamily(symbol);
        if (
          ts.isElementAccessExpression(node.expression) &&
          !ts.isStringLiteralLike(node.expression.argumentExpression) &&
          /\binventory\b|\.holds\b|\.storageLocations\b/.test(node.expression.expression.getText(source))
        ) {
          throw new Error(
            `Unresolved Inventory call: ${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        }
      } else if (ts.isPropertyAssignment(node) && name(node.name) === "type" && commandFamily(name(node.initializer))) {
        symbol = name(node.initializer);
        family = commandFamily(symbol);
      } else if (ts.isMethodDeclaration(node) && file === "bounded-contexts/inventory/client.ts") {
        symbol = name(node.name);
        family = methodFamily(symbol);
      }
      if (family)
        callers.push({
          path: file,
          family,
          symbol,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
    }
  }
  callers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.symbol.localeCompare(b.symbol));
  return { callers, scanned, total: sources.length, ignored: ignoredPaths.sort() };
}

export function partitionInventoryCallers(discovery, registry) {
  const callers = discovery.callers
    .map((caller) => {
      const row = registry[caller.path];
      if (!row || !row.families.includes(caller.family)) {
        if (process.env.CHASE_SETS_C1_MUTANT === "unknown-caller-ignored") return null;
        throw new Error(`Unclassified Inventory caller: ${caller.path}:${caller.line} ${caller.family}`);
      }
      for (const field of ["authority", "attempt", "read", "consumer", "status"]) {
        if (typeof row[field] !== "string" || !row[field])
          throw new Error(`Incomplete Inventory caller partition: ${caller.path} ${field}`);
      }
      return { ...caller, ...row };
    })
    .filter(Boolean);
  return { ...discovery, callers };
}
