import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
  "BottomNav",
  "BottomSheet",
  "Box",
  "ButtonGroup",
  "Caption",
  "CategoryTile",
  "Center",
  "chaseDarkTheme",
  "ChaseSetsLogo",
  "chaseTheme",
  "CheckoutExpressActions",
  "CheckoutSummaryLineItem",
  "CheckoutTotals",
  "CheckoutTrustPanel",
  "clearFieldError",
  "cn",
  "ColorModeToggle",
  "CommentsSheet",
  "ComparisonModule",
  "ConditionBadge",
  "CopyButton",
  "cx",
  "defaultToastManager",
  "DenseAdminWorkbenchProof",
  "EmptyStateIllustration",
  "EvidenceCodeBlock",
  "FeatureCard",
  "Field",
  "Fieldset",
  "FilterBottomSheet",
  "firstFieldError",
  "FlexItem",
  "formatProductOptionsAriaLabel",
  "formatProductOptionsText",
  "FormSection",
  "FullPage",
  "hasFormErrors",
  "HelperText",
  "HelpSheet",
  "IconButton",
  "InlineMessage",
  "InspectorLayout",
  "Label",
  "layoutWidthClasses",
  "MarketplaceActionSheet",
  "MarketplaceCartLineItem",
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
  "Pagination",
  "Popover",
  "PriceDisplay",
  "ProductCard",
  "ProductMediaImage",
  "ProductMediaModule",
  "Progress",
  "ProgressBar",
  "ProgressiveDisclosureGroup",
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
  "SelectionToolbar",
  "showToast",
  "Sidebar",
  "sidebarWidthClasses",
  "SideNav",
  "Skeleton",
  "Slider",
  "Spacer",
  "SplitPane",
  "Stagger",
  "Subheading",
  "Switch",
  "Table",
  "Tag",
  "TagInput",
  "ThemeScope",
  "ThemeToggle",
  "Thumbnail",
  "Timeline",
  "toastManager",
  "ToastProvider",
  "Toggle",
  "ToggleGroup",
  "TokenSwatch",
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

function addDeclarationName(node, exports) {
  if (!node.name || !ts.isIdentifier(node.name)) {
    return;
  }

  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    exports.add(node.name.text);
  }
}

function collectExportsFromFile(filePath, options) {
  const { visited, readFile } = options;
  const normalizedFilePath = path.resolve(filePath);

  if (visited.has(normalizedFilePath)) {
    return new Set();
  }
  visited.add(normalizedFilePath);

  const content = readFile(normalizedFilePath);
  if (typeof content !== "string") {
    throw new Error(`Unable to read ${normalizedFilePath}`);
  }

  const sourceFile = parseSourceFile(normalizedFilePath, content);
  const exports = new Set();

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
            exports.add(element.name.text);
          }
        }
        continue;
      }

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          exports.add(element.name.text);
        }
        continue;
      }

      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        exports.add(statement.exportClause.name.text);
        continue;
      }

      const reexportFile = resolveRelativeModuleFile(normalizedFilePath, statement.moduleSpecifier.text);
      if (!reexportFile) {
        throw new Error(`Unable to resolve ${statement.moduleSpecifier.text} from ${normalizedFilePath}`);
      }

      for (const exportName of collectExportsFromFile(reexportFile, options)) {
        if (exportName !== "default") {
          exports.add(exportName);
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      addDeclarationName(statement, exports);
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      addDeclarationName(statement, exports);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
      if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exports.add(declaration.name.text);
        }
      }
    }
  }

  return exports;
}

export function collectDesignSystemPublicExports(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const entryFile = path.join(rootDir, options.entryRelativePath ?? designSystemEntryRelativePath);
  const readFile = options.readFile ?? ((filePath) => ts.sys.readFile(filePath));

  return [...collectExportsFromFile(entryFile, { visited: new Set(), readFile })].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
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
  const publicExports = collectDesignSystemPublicExports(options);
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
