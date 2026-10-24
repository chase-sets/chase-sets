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
  const staticKey = (expression, depth = 0) => {
    if (depth > 32) return false;
    const node = ts.skipParentheses(expression);
    if (ts.isStringLiteralLike(node)) return true;
    if (ts.isNonNullExpression(node)) return staticKey(node.expression, depth + 1);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))
      return staticKey(node.expression, depth + 1);
    if (ts.isConditionalExpression(node))
      return staticKey(node.whenTrue, depth + 1) && staticKey(node.whenFalse, depth + 1);
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
        return (
          staticKey(declaration.initializer, depth + 1) &&
          (Boolean(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) || finiteStringKeys(typeOf(node)))
        );
    }
    return finiteStringKeys(typeOf(node));
  };
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
          declaration.name &&
          ts.isIdentifier(declaration.name) &&
          names.includes(declaration.name.text) &&
          (!owner ||
            (ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === owner) ||
            (ts.isModuleBlock(declaration.parent) && declaration.parent.parent.name?.text === owner)) &&
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
    const rejected = new Set();
    const reject = (node, reason) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const key = `${line}:${reason}`;
      if (rejected.has(key)) return;
      rejected.add(key);
      diagnostics.push({ file, line, reason });
    };
    const laundering = (value, target, node) => {
      if (mutant !== "laundering-unchecked" && opaqueType(target) && isFamily(typeOf(value)))
        reject(node, "FAMILY_TYPE_ERASURE");
    };
    const adapterThis = (node) => {
      const call = node.parent;
      if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return false;
      const callee = ts.skipParentheses(call.expression);
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : "";
      return ["bind", "call", "apply"].includes(name);
    };
    const NOT_ASSIGNMENT_PATTERN = Symbol("not-assignment-pattern");
    const UNRESOLVED_ASSIGNMENT_PATTERN = Symbol("unresolved-assignment-pattern");
    const assignmentSourceType = (pattern) => {
      let current = pattern;
      let spread = false;
      for (let depth = 0; depth <= 32; depth++) {
        const parent = current.parent;
        if (!parent) return NOT_ASSIGNMENT_PATTERN;
        if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
          current = parent;
          continue;
        }
        if (
          ts.isBinaryExpression(parent) &&
          parent.left === current &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const owner = parent.parent;
          if (spread)
            return mutant === "assignment-unresolved-open" ? NOT_ASSIGNMENT_PATTERN : UNRESOLVED_ASSIGNMENT_PATTERN;
          if (
            (ts.isBindingElement(owner) && owner.initializer === parent) ||
            (ts.isPropertyAssignment(owner) && owner.initializer === parent) ||
            (ts.isArrayLiteralExpression(owner) && owner.elements.some((element) => element === parent))
          )
            return mutant === "assignment-unresolved-open" || mutant === "assignment-default-trusted"
              ? NOT_ASSIGNMENT_PATTERN
              : UNRESOLVED_ASSIGNMENT_PATTERN;
          try {
            return mutant === "assignment-source-syntactic"
              ? typeOf(pattern)
              : (checker.getTypeOfAssignmentPattern(pattern) ?? UNRESOLVED_ASSIGNMENT_PATTERN);
          } catch {
            return UNRESOLVED_ASSIGNMENT_PATTERN;
          }
        }
        if (ts.isForOfStatement(parent) && parent.initializer === current) {
          if (spread)
            return mutant === "assignment-unresolved-open" ? NOT_ASSIGNMENT_PATTERN : UNRESOLVED_ASSIGNMENT_PATTERN;
          try {
            return mutant === "assignment-source-syntactic"
              ? typeOf(pattern)
              : (checker.getTypeOfAssignmentPattern(pattern) ?? UNRESOLVED_ASSIGNMENT_PATTERN);
          } catch {
            return UNRESOLVED_ASSIGNMENT_PATTERN;
          }
        }
        if (ts.isForInStatement(parent) && parent.initializer === current) return UNRESOLVED_ASSIGNMENT_PATTERN;
        if (ts.isSpreadElement(parent) && parent.expression === current && ts.isArrayLiteralExpression(parent.parent)) {
          spread = true;
          current = parent.parent;
          continue;
        }
        if (ts.isBindingElement(parent) && parent.name === current) {
          if (parent.initializer || parent.dotDotDotToken)
            return mutant === "assignment-unresolved-open" ||
              (mutant === "assignment-default-trusted" && parent.initializer)
              ? NOT_ASSIGNMENT_PATTERN
              : UNRESOLVED_ASSIGNMENT_PATTERN;
          current = parent.parent;
          continue;
        }
        if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
          current = parent.parent;
          continue;
        }
        if (ts.isArrayLiteralExpression(parent) && parent.elements.some((element) => element === current)) {
          current = parent;
          continue;
        }
        return NOT_ASSIGNMENT_PATTERN;
      }
      return UNRESOLVED_ASSIGNMENT_PATTERN;
    };
    const memberType = (sourceType, element) => {
      if (sourceType === UNRESOLVED_ASSIGNMENT_PATTERN) return UNRESOLVED_ASSIGNMENT_PATTERN;
      const parent = element.parent;
      let key;
      if (ts.isBindingElement(element)) {
        if (element.dotDotDotToken || ts.isArrayBindingPattern(parent))
          return checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number) ?? UNRESOLVED_ASSIGNMENT_PATTERN;
        const name = element.propertyName ?? element.name;
        if (ts.isComputedPropertyName(name)) {
          const keyType = typeOf(name.expression);
          key = keyType.isStringLiteral() || keyType.isNumberLiteral() ? String(keyType.value) : undefined;
        } else if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) key = name.text;
      } else if (ts.isPropertyAssignment(element)) {
        const name = element.name;
        if (ts.isComputedPropertyName(name)) {
          const keyType = typeOf(name.expression);
          key = keyType.isStringLiteral() || keyType.isNumberLiteral() ? String(keyType.value) : undefined;
        } else if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) key = name.text;
      } else if (ts.isShorthandPropertyAssignment(element)) {
        key = element.name.text;
      } else if (ts.isSpreadAssignment(element)) {
        return checker.getIndexTypeOfType(sourceType, ts.IndexKind.String) ?? UNRESOLVED_ASSIGNMENT_PATTERN;
      }
      if (key === undefined) {
        const computed = element.propertyName ?? element.name;
        const keyType = computed && ts.isComputedPropertyName(computed) ? typeOf(computed.expression) : undefined;
        const numeric = keyType && Boolean(keyType.flags & ts.TypeFlags.NumberLike);
        return (
          (numeric ? checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number) : undefined) ??
          checker.getIndexTypeOfType(sourceType, ts.IndexKind.String) ??
          UNRESOLVED_ASSIGNMENT_PATTERN
        );
      }
      return (
        checker.getTypeOfPropertyOfType(sourceType, key) ??
        checker.getIndexTypeOfType(sourceType, /^\d+$/.test(key) ? ts.IndexKind.Number : ts.IndexKind.String) ??
        UNRESOLVED_ASSIGNMENT_PATTERN
      );
    };
    const targetType = (element) => {
      let symbol;
      if (ts.isShorthandPropertyAssignment(element)) {
        try {
          symbol = checker.getShorthandAssignmentValueSymbol(element);
        } catch {
          symbol = undefined;
        }
      } else {
        const target =
          ts.isPropertyAssignment(element) &&
          ts.isBinaryExpression(element.initializer) &&
          element.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? element.initializer.left
            : ts.isPropertyAssignment(element)
              ? element.initializer
              : (element.name ?? element.expression);
        symbol = target && checker.getSymbolAtLocation(target);
      }
      const fallback =
        ts.isPropertyAssignment(element) &&
        ts.isBinaryExpression(element.initializer) &&
        element.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? element.initializer.left
          : ts.isPropertyAssignment(element)
            ? element.initializer
            : (element.name ?? element.expression);
      return symbol ? checker.getTypeOfSymbolAtLocation(symbol, element) : typeOf(fallback);
    };
    const inspectPattern = (pattern) => {
      const assignment = assignmentSourceType(pattern);
      const sourceType = assignment === NOT_ASSIGNMENT_PATTERN ? typeOf(pattern) : assignment;
      if (assignment === NOT_ASSIGNMENT_PATTERN && !ts.isObjectBindingPattern(pattern)) return;
      const sourceFamily = sourceType === UNRESOLVED_ASSIGNMENT_PATTERN || (sourceType && isFamily(sourceType));
      if (!sourceFamily && assignment === NOT_ASSIGNMENT_PATTERN) return;
      const elements = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
      for (const element of elements) {
        const name = element.propertyName ?? element.name;
        if (sourceFamily && name && ts.isComputedPropertyName(name) && !staticKey(name.expression))
          reject(name, "FAMILY_DYNAMIC_KEY");
        const fallbackValue = ts.isBindingElement(element)
          ? element.initializer
          : ts.isShorthandPropertyAssignment(element)
            ? element.objectAssignmentInitializer
            : ts.isPropertyAssignment(element) &&
                ts.isBinaryExpression(element.initializer) &&
                element.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ? element.initializer.right
              : undefined;
        if (
          mutant !== "assignment-target-erasure-off" &&
          fallbackValue &&
          opaqueType(targetType(element)) &&
          isFamily(typeOf(fallbackValue))
        )
          reject(fallbackValue, "FAMILY_TYPE_ERASURE");
        const target = targetType(element);
        const member = memberType(sourceType, element);
        if (
          mutant !== "assignment-target-erasure-off" &&
          opaqueType(target) &&
          (member === UNRESOLVED_ASSIGNMENT_PATTERN || (member && isFamily(member)))
        )
          reject(element.name ?? element, "FAMILY_TYPE_ERASURE");
      }
    };
    const inspectArrayPattern = (pattern) => {
      const sourceType = assignmentSourceType(pattern);
      if (sourceType === NOT_ASSIGNMENT_PATTERN || mutant === "assignment-target-erasure-off") return;
      pattern.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return;
        const isDefault = ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const target = isDefault ? element.left : element;
        if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) return;
        const symbol = checker.getSymbolAtLocation(target);
        const targetTypeAtLocation = symbol ? checker.getTypeOfSymbolAtLocation(symbol, target) : typeOf(target);
        if (!opaqueType(targetTypeAtLocation)) return;
        const member =
          sourceType === UNRESOLVED_ASSIGNMENT_PATTERN
            ? sourceType
            : (checker.getTypeOfPropertyOfType(sourceType, String(index)) ??
              checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number) ??
              UNRESOLVED_ASSIGNMENT_PATTERN);
        if (
          member === UNRESOLVED_ASSIGNMENT_PATTERN ||
          isFamily(member) ||
          (isDefault && isFamily(typeOf(element.right)))
        )
          reject(target, "FAMILY_TYPE_ERASURE");
      });
    };
    const isContextualSink = (node) => {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.initializer === node;
      if (ts.isPropertyDeclaration(parent)) return parent.initializer === node;
      if (ts.isPropertyAssignment(parent)) return parent.initializer === node;
      if (ts.isBindingElement(parent)) return parent.initializer === node;
      if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) return true;
      if (ts.isReturnStatement(parent)) return parent.expression === node;
      if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.arguments.includes(node);
      if (ts.isConditionalExpression(parent)) return parent.whenTrue === node || parent.whenFalse === node;
      if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) return true;
      if (ts.isArrowFunction(parent)) return parent.body === node;
      if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
      if (ts.isYieldExpression(parent) || ts.isAwaitExpression(parent)) return parent.expression === node;
      if (ts.isTemplateSpan(parent)) return ts.isTaggedTemplateExpression(parent.parent.parent);
      if (ts.isJsxExpression(parent)) return parent.expression === node;
      if (ts.isBinaryExpression(parent) && parent.right === node)
        return (
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        );
      return false;
    };
    const visit = (node) => {
      if (
        ts.isExpression(node) &&
        isContextualSink(node) &&
        !ts.isSatisfiesExpression(node.parent) &&
        !adapterThis(node)
      ) {
        const contextual = checker.getContextualType(node);
        if (contextual && opaqueType(contextual) && isFamily(typeOf(node))) {
          if (mutant !== "laundering-unchecked") reject(node, "FAMILY_TYPE_ERASURE");
        }
      }
      // A throw operand has no contextual type, yet every catch binding that receives it is any or unknown.
      if (mutant !== "throw-erasure-off" && ts.isThrowStatement(node) && isFamily(typeOf(node.expression)))
        reject(node.expression, "FAMILY_TYPE_ERASURE");
      if (ts.isElementAccessExpression(node)) {
        if (isFamily(typeOf(node.expression))) {
          if (!staticKey(node.argumentExpression)) reject(node, "FAMILY_DYNAMIC_KEY");
        } else if (isMemberFunction(typeOf(node))) reject(node, "UNNAMED_FAMILY_MEMBER");
      }
      if (ts.isObjectBindingPattern(node) || ts.isObjectLiteralExpression(node)) inspectPattern(node);
      if (ts.isArrayLiteralExpression(node)) inspectArrayPattern(node);
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
            libraryMethod(node, ["values", "entries", "keys", "getOwnPropertyNames"], "ObjectConstructor") &&
            node.arguments?.[0] &&
            isFamily(typeOf(node.arguments[0]))
          )
            reject(node, "FAMILY_ENUMERATION");
          if (
            libraryMethod(node, ["ownKeys", "get", "getOwnPropertyDescriptor"], "Reflect") &&
            node.arguments?.[0] &&
            isFamily(typeOf(node.arguments[0]))
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
