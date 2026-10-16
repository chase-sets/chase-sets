import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { createClassificationProgram, enumerateTrackedRoots } from "./authoritative-stream-read-classification.mjs";

const checkedMembers = Object.freeze({
  mutations: "FAMILY",
  checkoutReservationAuthority: "FAMILY",
  catalogItems: "FAMILY",
  storageLocations: "FAMILY",
  items: "FAMILY",
  importBatches: "FAMILY",
  holds: "FAMILY",
  holdCleanupAuthority: "FAMILY",
  holdCollisions: "FAMILY",
  channelSales: "FAMILY",
  channelStockAllocations: "FAMILY",
  reservations: "FAMILY",
  restockDecisions: "FAMILY",
  recoveredItems: "FAMILY",
  appendToStreams: "FAMILY",
  projectors: "NON_FAMILY",
  pool: "NON_FAMILY",
  db: "NON_FAMILY",
});

const normalize = (file) => file.replaceAll("\\", "/");
const declarations = (symbol) => symbol?.getDeclarations() ?? [];
const inventoryDeclaration = (declaration) =>
  normalize(declaration.getSourceFile().fileName).includes("/bounded-contexts/inventory/");

function exportedSymbol(program, checker, repoRoot, file, name) {
  const source = program.getSourceFile(path.join(repoRoot, file));
  const module = source && checker.getSymbolAtLocation(source);
  let symbol = module && checker.getExportsOfModule(module).find((entry) => entry.name === name);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol) throw new Error(`Unresolved Inventory family anchor: ${file} ${name}`);
  return symbol;
}

function parts(checker, type, seen = new Set()) {
  if (seen.has(type)) return [];
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.flatMap((part) => parts(checker, part, seen));
  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint && constraint !== type) return parts(checker, constraint, seen);
  const apparent = checker.getApparentType(type);
  // A mapped wrapper can erase a callable's signatures while retaining its checked source type.
  const mappedArguments = apparent.objectFlags & ts.ObjectFlags.Mapped ? (apparent.aliasTypeArguments ?? []) : [];
  return [apparent, ...mappedArguments.flatMap((argument) => parts(checker, argument, seen))];
}

function isInventoryType(checker, type) {
  return parts(checker, type).some((part) =>
    [
      ...declarations(part.getSymbol()),
      ...declarations(part.aliasSymbol),
      ...part.getProperties().flatMap(declarations),
      ...part
        .getCallSignatures()
        .map(({ declaration }) => declaration)
        .filter(Boolean),
    ].some(inventoryDeclaration),
  );
}

export function resolveInventoryFamilies(program, repoRoot, options = {}) {
  const checker = program.getTypeChecker();
  const services = exportedSymbol(
    program,
    checker,
    repoRoot,
    "bounded-contexts/inventory/support/runtime-support/services.ts",
    "InventoryServices",
  );
  const aggregate = checker.getDeclaredTypeOfSymbol(services);
  const api = exportedSymbol(
    program,
    checker,
    repoRoot,
    options.apiFile ?? "bounded-contexts/inventory/client.ts",
    "createInventoryApiClient",
  );
  const apiType = checker.getTypeOfSymbolAtLocation(api, api.valueDeclaration ?? declarations(api)[0]);
  const apiSignature = apiType.getCallSignatures()[0];
  if (!apiSignature) throw new Error("Unresolved Inventory API client return type");
  const client = checker.getReturnTypeOfSignature(apiSignature);
  if (opaqueType(client) || client.getProperties().length === 0)
    throw new Error("Opaque Inventory API client return type");
  const families = [
    { name: "InventoryServices", type: aggregate },
    { name: "InventoryApiClient", type: client },
  ];
  const table = [];
  const checked = { ...checkedMembers, ...options.additionalMembers };
  for (const member of aggregate.getProperties()) {
    const name = member.name;
    if (!Object.hasOwn(checked, name)) throw new Error(`Unlisted InventoryServices member: ${name}`);
    const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, declarations(member)[0]));
    const classification = isInventoryType(checker, type) ? "FAMILY" : "NON_FAMILY";
    table.push({ name, classification });
    if (checked[name] !== classification)
      throw new Error(`Inventory family derivation differs: ${name} ${classification}`);
    if (classification === "FAMILY") families.push({ name, type });
  }
  for (const name of Object.keys(checked)) {
    if (!table.some((row) => row.name === name)) throw new Error(`Missing InventoryServices member: ${name}`);
  }
  const propertyDeclarations = new Set();
  const memberSignatures = new Set();
  const memberFunctionTypes = new Set();
  const familySignatures = new Set();
  for (const { type } of families) {
    for (const part of parts(checker, type)) {
      for (const signature of part.getCallSignatures()) {
        if (signature.declaration) familySignatures.add(signature.declaration);
      }
      for (const property of part.getProperties()) {
        for (const declaration of declarations(property)) propertyDeclarations.add(declaration);
        const propertyType = checker.getTypeOfSymbolAtLocation(property, declarations(property)[0]);
        for (const value of parts(checker, propertyType)) {
          if (value.getCallSignatures().length) memberFunctionTypes.add(value);
          for (const signature of value.getCallSignatures()) {
            // Shared generic declarations alone cannot identify an Inventory instantiation.
            if (signature.declaration && inventoryDeclaration(signature.declaration))
              memberSignatures.add(signature.declaration);
          }
        }
      }
    }
  }
  return { table, families, propertyDeclarations, memberSignatures, memberFunctionTypes, familySignatures };
}

function finiteStringKeys(type) {
  if (type.flags & ts.TypeFlags.StringLiteral) return true;
  return type.isUnion() && type.types.length > 0 && type.types.every(finiteStringKeys);
}

function opaqueType(type) {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

export function analyzeInventoryDynamicDispatch({ repoRoot, roots, program, families, sources = [], mutant }) {
  roots ??= enumerateTrackedRoots(repoRoot);
  program ??= createClassificationProgram(repoRoot, roots);
  const checker = program.getTypeChecker();
  families ??= resolveInventoryFamilies(program, repoRoot);
  const diagnostics = [];
  const isMemberFunction = (type) =>
    parts(checker, type).some(
      (part) =>
        families.memberFunctionTypes.has(part) ||
        part.getCallSignatures().some((signature) => families.memberSignatures.has(signature.declaration)),
    );
  const familyCache = new Map();
  const isFamily = (type) => {
    if (mutant === "receiver-type-ignored") return false;
    if (familyCache.has(type)) return familyCache.get(type);
    const result = parts(checker, type).some(
      (part) =>
        part
          .getProperties()
          .some((property) =>
            declarations(property).some((declaration) => families.propertyDeclarations.has(declaration)),
          ) || part.getCallSignatures().some((signature) => families.familySignatures.has(signature.declaration)),
    );
    familyCache.set(type, result);
    return result;
  };
  const typeOf = (node) => checker.getTypeAtLocation(node);
  const accessOf = (call) => ts.skipParentheses(call.expression);
  const libraryMethod = (call, names, owner) => {
    const access = accessOf(call);
    let symbol;
    if (ts.isPropertyAccessExpression(access)) symbol = checker.getSymbolAtLocation(access.name);
    if (ts.isElementAccessExpression(access)) {
      const key = typeOf(access.argumentExpression);
      if (key.flags & ts.TypeFlags.StringLiteral)
        symbol = checker.getPropertyOfType(typeOf(access.expression), key.value);
    }
    const signature = checker.getResolvedSignature(call);
    return [...declarations(symbol), signature?.declaration]
      .filter(Boolean)
      .some(
        (declaration) =>
          ts.isMethodSignature(declaration) &&
          ts.isIdentifier(declaration.name) &&
          names.includes(declaration.name.text) &&
          (!owner || (ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === owner)) &&
          program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
      );
  };
  const namedAdapter = (call) => {
    const access = accessOf(call);
    return Boolean(
      ts.isCallExpression(call) &&
      (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
      libraryMethod(call, ["bind", "call", "apply"]) &&
      isMemberFunction(typeOf(access.expression)),
    );
  };
  for (const file of roots) {
    const source = program.getSourceFile(path.join(repoRoot, file));
    if (!source) throw new Error(`Unloaded Inventory census root: ${file}`);
    const reject = (node, reason) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      diagnostics.push({ file, line, reason });
    };
    const laundering = (value, target, node) => {
      if (mutant !== "laundering-unchecked" && opaqueType(target) && isFamily(typeOf(value)))
        reject(node, "FAMILY_TYPE_ERASURE");
    };
    const visit = (node) => {
      if (ts.isElementAccessExpression(node)) {
        if (isFamily(typeOf(node.expression))) {
          if (!finiteStringKeys(typeOf(node.argumentExpression))) reject(node, "FAMILY_DYNAMIC_KEY");
        } else if (isMemberFunction(typeOf(node))) reject(node, "UNNAMED_FAMILY_MEMBER");
      }
      if (ts.isForInStatement(node) && isFamily(typeOf(node.expression))) reject(node, "FAMILY_ENUMERATION");
      if (ts.isForOfStatement(node)) {
        const inspectBinding = (binding) => {
          if (ts.isIdentifier(binding) && isMemberFunction(typeOf(binding))) reject(binding, "UNNAMED_FAMILY_MEMBER");
          else ts.forEachChild(binding, inspectBinding);
        };
        inspectBinding(node.initializer);
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
        laundering(node.expression, checker.getTypeFromTypeNode(node.type), node);
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.type && node.initializer) {
        laundering(node.initializer, checker.getTypeFromTypeNode(node.type), node);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (
          ts.isCallExpression(node.expression) &&
          isMemberFunction(typeOf(node.expression)) &&
          !namedAdapter(node.expression)
        )
          reject(node, "UNNAMED_FAMILY_MEMBER");
        const signature = checker.getResolvedSignature(node);
        if (signature) {
          if (
            libraryMethod(node, ["values", "entries"], "ObjectConstructor") &&
            node.arguments?.some((argument) => isFamily(typeOf(argument)))
          )
            reject(node, "FAMILY_ENUMERATION");
          node.arguments?.forEach((argument, index) => {
            if (index === 0 && namedAdapter(node)) return;
            const parameter = signature.parameters[index];
            if (parameter) laundering(argument, checker.getTypeOfSymbolAtLocation(parameter, argument), argument);
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const scanned = [...roots].sort();
  const scannedSet = new Set(scanned);
  const ignored = [
    ...new Set(sources.map(({ path: file }) => normalize(file)).filter((file) => !scannedSet.has(file))),
  ].sort();
  return { diagnostics, scanned, ignored, total: scanned.length + ignored.length };
}
