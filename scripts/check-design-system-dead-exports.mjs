import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

// Audits the root @chase-sets/design-system public surface for exports that no
// production bounded-context or deployable file imports and uses.
//
// Known limits: this deliberately audits runtime/value exports only and ignores
// type-only exports, design-system self-usage, tests, documentation, package
// metadata, style-only imports, and subpath exports. It can miss consumers that
// access symbols through computed property names, strings, code generation, or a
// local re-export chain that does not keep the original import specifier in a
// production file. Namespace imports are counted only when used as
// DesignSystem.Symbol-style property access.

const designSystemPackageName = "@chase-sets/design-system";
const designSystemEntryRelativePath = "packages/design-system/src/index.ts";
const consumerRoots = ["bounded-contexts", "deployables"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const moduleFileExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const canonicalReserveZeroConsumerExports = [
  "AccountProfileHeader",
  "ActivityList",
  "ActivitySheet",
  "AspectRatio",
  "AssistantSheet",
  "Autocomplete",
  "Avatar",
  "Bleed",
  "BottomNav",
  "BottomSheet",
  "ButtonGroup",
  "Calendar",
  "Caption",
  "CategoryTile",
  "Center",
  "chaseDarkTheme",
  "ChaseSetsLogo",
  "chaseTheme",
  "CheckoutExpressActions",
  "CheckoutSummaryLineItem",
  "CheckoutTrustPanel",
  "clearFieldError",
  "ColorModeToggle",
  "CommentsSheet",
  "ComparisonModule",
  "ConditionBadge",
  "DatePicker",
  "cx",
  "defaultToastManager",
  "DenseAdminWorkbenchProof",
  "EmptyStateIllustration",
  "FeatureCard",
  "Field",
  "FilterBottomSheet",
  "firstFieldError",
  "FlexItem",
  "formatProductOptionsAriaLabel",
  "formatProductOptionsText",
  "FormRow",
  "FormSection",
  "FullPage",
  "hasFormErrors",
  "HelperText",
  "HelpSheet",
  "IconButton",
  "IconRow",
  "InlineMessage",
  "InspectorLayout",
  "Label",
  "layoutWidthClasses",
  "MarketplaceActionSheet",
  "MarketplaceFacetStrip",
  "MarketplaceProductCard",
  "MarketplaceProductCommerceRail",
  "MarketplaceProductMobileActionDock",
  "Menu",
  "MessageThreadPreview",
  "NavigationDrawer",
  "NavigationHeader",
  "NavigationMenu",
  "NavRail",
  "normalizeFormErrors",
  "NumberField",
  "packingSlipPrintStyles",
  "Popover",
  "PriceDisplay",
  "ProductCard",
  "ProductMediaImage",
  "ProductMediaModule",
  "Progress",
  "ProgressBar",
  "ProgressiveDisclosureGroup",
  "ProgressTrack",
  "Quote",
  "RadioGroup",
  "RecordPage",
  "renderOptionalNode",
  "resolveAlignClass",
  "resolveChaseMotion",
  "resolveColumnsClass",
  "resolveDirectionClass",
  "resolveJustifyClass",
  "resolveResponsiveClass",
  "resolveSpaceClass",
  "resolveSystemProps",
  "resolveTextAlignClass",
  "resolveTheme",
  "resolveThemeOverrideStyle",
  "resolveThemeStyle",
  "ResponsiveActionMenu",
  "ResponsiveSupportSheet",
  "Reveal",
  "ScrollArea",
  "SearchFilterPanel",
  "SectionNavigation",
  "selectCheckoutNotice",
  "SelectionToolbar",
  "showToast",
  "Sidebar",
  "sidebarWidthClasses",
  "SideNav",
  "Slider",
  "Spacer",
  "SplitPane",
  "Stagger",
  "StickyBar",
  "Subheading",
  "surfaceSemanticToneClasses",
  "Switch",
  "Table",
  "Tag",
  "TagInput",
  "ThemeScope",
  "ThemePreferenceControl",
  "Thumbnail",
  "Timeline",
  "toastManager",
  "ToastProvider",
  "Toggle",
  "ToggleGroup",
  "TokenSwatch",
  "ToneIcon",
  "Toolbar",
  "ToolbarButton",
  "ToolbarInput",
  "ToolbarSeparator",
  "Tooltip",
  "TopNav",
  "TrustBadge",
  "useChaseMotion",
  "useDensity",
  "useFormContext",
  "useFormState",
  "useMediaQuery",
  "usePortalRoots",
  "useReducedMotion",
  "useToast",
  "ValidationMessageList",
  "VerifiedAccountBadge",
  "ViewTransition",
  "Wizard",
  "WorkbenchSplitHeader",
  "WorkflowActionBar",
].map((symbol) => ({
  symbol,
  reason: "canonical design-system reserve surface; no production consumer yet",
}));

const defaultAllowedZeroConsumerExports = [
  ...canonicalReserveZeroConsumerExports,
  {
    symbol: "MarketStatusBadge",
    reason: "internal MarketplaceProductCard status dependency; kept as a shared commerce atom",
  },
  {
    symbol: "MarketplaceTemplateGallery",
    reason: "canonical commerce reserve surface; no production consumer yet",
  },
  {
    symbol: "MediaFrame",
    reason: "internal layout/commerce media primitive; kept after cart adopted MarketplaceCartLineItem",
  },
];

function isSourceFile(filePath) {
  return sourceExtensions.has(path.extname(filePath));
}

function isTestFile(relativePath) {
  return /(?:^|\/)__tests__\//.test(relativePath) || /\.test\.[^/]+$/i.test(relativePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(name) {
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`);
}

function namespacePropertyPattern(namespaceName, exportName) {
  return new RegExp(
    `(?<![A-Za-z0-9_$])${escapeRegExp(namespaceName)}\\s*\\.\\s*${escapeRegExp(exportName)}(?![A-Za-z0-9_$])`,
  );
}

function parseSourceFile(filePath, content) {
  const scriptKind = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
}

function resolveRelativeModuleFile(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    basePath,
    ...moduleFileExtensions.map((extension) => `${basePath}${extension}`),
    ...moduleFileExtensions.map((extension) => path.join(basePath, `index${extension}`)),
  ];

  return candidates.find((candidate) => existsSync(candidate) && isSourceFile(candidate)) ?? null;
}

function getDeclarationName(node) {
  if (!node.name || !ts.isIdentifier(node.name)) {
    return null;
  }

  return node.name.text;
}

function hasExportModifier(node) {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function cleanLeadingComment(commentText) {
  const lines = commentText
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\/\/\s?/, "")
        .replace(/^\s*\*\s?/, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith("@"));

  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }

  const sentenceMatch = text.match(/^(.+?[.!?])(?:\s|$)/);
  return sentenceMatch?.[1] ?? text;
}

function getLeadingPurpose(node, sourceFile) {
  const text = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const adjacentRanges = ranges.filter((range) => {
    const between = text.slice(range.end, node.getStart(sourceFile));
    return !/\n\s*\n/.test(between);
  });
  const commentRange = adjacentRanges.at(-1);

  if (!commentRange) {
    return null;
  }

  return cleanLeadingComment(text.slice(commentRange.pos, commentRange.end));
}

function buildLocalValueDeclarations(sourceFile) {
  const declarations = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      const name = getDeclarationName(statement);
      if (name) {
        declarations.set(name, statement);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, statement);
        }
      }
    }
  }

  return declarations;
}

function createSurfaceRecord(symbol, filePath, sourceFile, declaration) {
  return {
    symbol,
    sourceFilePath: path.resolve(filePath),
    purpose: declaration ? getLeadingPurpose(declaration, sourceFile) : null,
  };
}

function collectSurfaceFromFile(filePath, options) {
  const { cache, readFile, visiting } = options;
  const normalizedFilePath = path.resolve(filePath);

  if (cache.has(normalizedFilePath)) {
    return cache.get(normalizedFilePath);
  }

  if (visiting.has(normalizedFilePath)) {
    return new Map();
  }
  visiting.add(normalizedFilePath);

  const content = readFile(normalizedFilePath);
  if (typeof content !== "string") {
    throw new Error(`Unable to read ${normalizedFilePath}`);
  }

  const sourceFile = parseSourceFile(normalizedFilePath, content);
  const localDeclarations = buildLocalValueDeclarations(sourceFile);
  const exports = new Map();

  function addRecord(record) {
    if (record.symbol !== "default" && !exports.has(record.symbol)) {
      exports.set(record.symbol, record);
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        continue;
      }

      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) {
              continue;
            }

            const localName = element.propertyName?.text ?? element.name.text;
            addRecord(
              createSurfaceRecord(element.name.text, normalizedFilePath, sourceFile, localDeclarations.get(localName)),
            );
          }
        }
        continue;
      }

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const reexportFile = resolveRelativeModuleFile(normalizedFilePath, statement.moduleSpecifier.text);
        if (!reexportFile) {
          throw new Error(`Unable to resolve ${statement.moduleSpecifier.text} from ${normalizedFilePath}`);
        }

        const reexportedRecords = collectSurfaceFromFile(reexportFile, options);

        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) {
            continue;
          }

          const importedName = element.propertyName?.text ?? element.name.text;
          const targetRecord = reexportedRecords.get(importedName);
          addRecord(
            targetRecord
              ? { ...targetRecord, symbol: element.name.text }
              : createSurfaceRecord(element.name.text, normalizedFilePath, sourceFile, statement),
          );
        }
        continue;
      }

      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        addRecord(createSurfaceRecord(statement.exportClause.name.text, normalizedFilePath, sourceFile, statement));
        continue;
      }

      const reexportFile = resolveRelativeModuleFile(normalizedFilePath, statement.moduleSpecifier.text);
      if (!reexportFile) {
        throw new Error(`Unable to resolve ${statement.moduleSpecifier.text} from ${normalizedFilePath}`);
      }

      for (const record of collectSurfaceFromFile(reexportFile, options).values()) {
        addRecord(record);
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      const name = getDeclarationName(statement);
      if (name && hasExportModifier(statement)) {
        addRecord(createSurfaceRecord(name, normalizedFilePath, sourceFile, statement));
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          addRecord(createSurfaceRecord(declaration.name.text, normalizedFilePath, sourceFile, statement));
        }
      }
    }
  }

  visiting.delete(normalizedFilePath);
  cache.set(normalizedFilePath, exports);
  return exports;
}

export function collectDesignSystemPublicSurface(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const entryFile = path.join(rootDir, options.entryRelativePath ?? designSystemEntryRelativePath);
  const readFile = options.readFile ?? ((filePath) => ts.sys.readFile(filePath));

  return [...collectSurfaceFromFile(entryFile, { cache: new Map(), readFile, visiting: new Set() }).values()]
    .map((record) => ({
      ...record,
      sourceRelativePath: normalizeRelative(record.sourceFilePath, rootDir),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol, "en"));
}

export function collectDesignSystemPublicExports(options = {}) {
  return collectDesignSystemPublicSurface(options).map((record) => record.symbol);
}

function blankRanges(content, ranges) {
  const chars = [...content];
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      chars[index] = " ";
    }
  }
  return chars.join("");
}

function recordNamedImportUsage(statement, sourceFile, searchableContent, consumedSymbols) {
  if (!statement.importClause) {
    return;
  }

  const namedBindings = statement.importClause.namedBindings;
  if (!namedBindings) {
    return;
  }

  if (ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      if (tokenPattern(localName).test(searchableContent)) {
        consumedSymbols.add(importedName);
      }
    }
    return;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    const namespaceName = namedBindings.name.text;
    for (const exportName of sourceFile.exportNames) {
      if (namespacePropertyPattern(namespaceName, exportName).test(searchableContent)) {
        consumedSymbols.add(exportName);
      }
    }
  }
}

function recordReexportUsage(statement, consumedSymbols) {
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return;
  }

  for (const element of statement.exportClause.elements) {
    consumedSymbols.add(element.propertyName?.text ?? element.name.text);
  }
}

function collectConsumedSymbolsFromContent(filePath, content, exportNames) {
  const sourceFile = parseSourceFile(filePath, content);
  sourceFile.exportNames = exportNames;

  const importDeclarationRanges = [];
  const designSystemImports = [];
  const designSystemReexports = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === designSystemPackageName
    ) {
      designSystemImports.push(statement);
      importDeclarationRanges.push({ start: statement.getFullStart(), end: statement.getEnd() });
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === designSystemPackageName
    ) {
      designSystemReexports.push(statement);
    }
  }

  const searchableContent = blankRanges(content, importDeclarationRanges);
  const consumedSymbols = new Set();

  for (const statement of designSystemImports) {
    recordNamedImportUsage(statement, sourceFile, searchableContent, consumedSymbols);
  }

  for (const statement of designSystemReexports) {
    recordReexportUsage(statement, consumedSymbols);
  }

  return consumedSymbols;
}

async function listConsumerFiles(rootDir, roots) {
  const files = await Promise.all(
    roots.map((consumerRoot) => collectFiles(path.join(rootDir, consumerRoot), { extensions: sourceExtensions })),
  );

  return files
    .flat()
    .filter((filePath) => {
      const relativePath = normalizeRelative(filePath, rootDir);
      return !isTestFile(relativePath);
    })
    .sort((left, right) => normalizeRelative(left, rootDir).localeCompare(normalizeRelative(right, rootDir), "en"));
}

function normalizeAllowlist(allowlist) {
  const bySymbol = new Map();
  const errors = [];

  for (const entry of allowlist) {
    if (!entry || typeof entry !== "object") {
      errors.push("allowlist entries must be objects with symbol and reason.");
      continue;
    }

    if (typeof entry.symbol !== "string" || entry.symbol.length === 0) {
      errors.push("allowlist entries must include a non-empty symbol.");
      continue;
    }

    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      errors.push(`allowlist entry for ${entry.symbol} must include a one-line reason.`);
      continue;
    }

    if (entry.reason.includes("\n")) {
      errors.push(`allowlist entry for ${entry.symbol} reason must be one line.`);
      continue;
    }

    bySymbol.set(entry.symbol, entry.reason);
  }

  return { bySymbol, errors };
}

export async function checkDesignSystemDeadExports(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const publicSurface = collectDesignSystemPublicSurface(options);
  const publicExports = publicSurface.map((record) => record.symbol);
  const exportNames = new Set(publicExports);
  const consumersBySymbol = new Map(publicExports.map((exportName) => [exportName, new Set()]));
  const readFile = options.readFile ?? ((filePath) => ts.sys.readFile(filePath));
  const consumerFiles = await listConsumerFiles(rootDir, options.consumerRoots ?? consumerRoots);

  for (const filePath of consumerFiles) {
    const content = readFile(filePath);
    if (typeof content !== "string" || !content.includes(designSystemPackageName)) {
      continue;
    }

    const relativePath = normalizeRelative(filePath, rootDir);
    for (const symbol of collectConsumedSymbolsFromContent(filePath, content, exportNames)) {
      if (consumersBySymbol.has(symbol)) {
        consumersBySymbol.get(symbol).add(relativePath);
      }
    }
  }

  const zeroConsumerExports = publicExports.filter((exportName) => consumersBySymbol.get(exportName)?.size === 0);
  const { bySymbol: allowlistBySymbol, errors: allowlistErrors } = normalizeAllowlist(
    options.allowedZeroConsumerExports ?? defaultAllowedZeroConsumerExports,
  );
  const allowlistedExports = zeroConsumerExports
    .filter((exportName) => allowlistBySymbol.has(exportName))
    .map((exportName) => ({ symbol: exportName, reason: allowlistBySymbol.get(exportName) }));
  const unlistedZeroConsumerExports = zeroConsumerExports.filter((exportName) => !allowlistBySymbol.has(exportName));
  const staleAllowlistEntries = [...allowlistBySymbol.keys()].filter(
    (exportName) => !zeroConsumerExports.includes(exportName),
  );
  const violations = [
    ...allowlistErrors.map((error) => `scripts/check-design-system-dead-exports.mjs: ${error}`),
    ...unlistedZeroConsumerExports.map(
      (exportName) =>
        `${designSystemEntryRelativePath}: ${exportName} has zero production consumers; delete it or add an allowlist reason.`,
    ),
    ...staleAllowlistEntries.map(
      (exportName) =>
        `scripts/check-design-system-dead-exports.mjs: allowlist entry for ${exportName} is stale; remove it.`,
    ),
  ];

  return {
    passed: violations.length === 0,
    files: consumerFiles.map((filePath) => normalizeRelative(filePath, rootDir)),
    publicSurface,
    publicExports,
    zeroConsumerExports,
    allowlistedExports,
    unlistedZeroConsumerExports,
    staleAllowlistEntries,
    consumersBySymbol: Object.fromEntries(
      [...consumersBySymbol.entries()].map(([symbol, files]) => [
        symbol,
        [...files].sort((left, right) => left.localeCompare(right, "en")),
      ]),
    ),
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkDesignSystemDeadExports();

  if (!result.passed) {
    console.error("Design-system dead-export check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  const allowlistSummary =
    result.allowlistedExports.length === 0
      ? ""
      : ` (${result.allowlistedExports.length} zero-consumer exports allowlisted)`;
  console.log(
    `Design-system dead-export check passed for ${result.publicExports.length} exports across ${result.files.length} production files${allowlistSummary}.`,
  );
}
