#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repo.mjs";
import { readOption } from "./lib/cli-options.mjs";
import {
  collectDesignSystemLegacyInventoryDocument,
  compareDesignSystemLegacyInventoryLedger,
} from "./design-system-legacy-inventory.mjs";

export const DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION = "design-system-legacy-visual-accessibility-evidence/v2";
export const defaultEvidencePath = path.join(
  repoRoot,
  "packages",
  "design-system",
  "DESIGN_SYSTEM_LEGACY_VISUAL_ACCESSIBILITY_EVIDENCE.json",
);
export const defaultLedgerPath = path.join(
  repoRoot,
  "packages",
  "design-system",
  "DESIGN_SYSTEM_LEGACY_INVENTORY.json",
);

const catalogControlPlaneForbiddenSignals = [
  "className=",
  "<div",
  "<section",
  "<span",
  "<input",
  "<label",
  "<select",
  "<textarea",
  "<nav",
  "<a ",
  "<ul",
  "<li",
  "<Form",
];

const surfaceChecks = [
  {
    id: "fulfillment-print-document",
    owner: "Fulfillment",
    scope: "packages/design-system/src/components/print",
    visualEvidence: [
      "Design-system-owned print stylesheet includes paged print media.",
      "Packing slip document owns print table, page sizing, toolbar, and print action layout.",
    ],
    accessibilityEvidence: [
      "Print document uses semantic headings, sections, article pages, table headers, and labeled format control.",
    ],
    mustInclude: [
      "@media print",
      "PackingSlipPrintDocument",
      "PackingSlipPrintToolbar",
      "<Button",
      "<HiddenInput",
      "<NativeSelect",
      "<article",
      "<table",
      "<th>",
    ],
    mustNotInclude: ["UiTable", "UiButton", "<button", '<input key={shipmentId} type="hidden"'],
  },
  {
    id: "support-request-tables",
    owner: "Support",
    scope: "bounded-contexts/platform-operations/features/support-requests/ui",
    visualEvidence: ["Support request lists render through DataTable instead of legacy responsive table markup."],
    accessibilityEvidence: ["Table headers and row identity are owned by DataTable column metadata and getRowId."],
    mustInclude: ["DataTable", "getRowId", "columns"],
    mustNotInclude: ["UiTable", "<table", "className="],
  },
  {
    id: "catalog-authoring-controls",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui",
    visualEvidence: [
      "The rebuilt Catalog primary workbench container uses grouped section navigation, dense-admin layout, and bulk action surfaces.",
    ],
    accessibilityEvidence: [
      "Workflow navigation and workspace selection preserve primary-path context through design-system shell components.",
    ],
    mustInclude: ["DenseAdminWorkbench", "DenseAdminWorkbenchLayout", "BulkActionSurface"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-authoring-steps-module",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion",
    visualEvidence: [
      "The import-to-promotion flow renders an explicit three-stage path with the design-system PageStepper and an Accordion that keeps only the active stage expanded.",
    ],
    accessibilityEvidence: [
      "The ordered stage flow exposes step status and one-expanded-at-a-time disclosure structure via PageStepper and Accordion.",
    ],
    mustInclude: ["PageStepper", "Accordion"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-authoring-command-controls",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion",
    visualEvidence: [
      "Workbench command actions render through shared WorkbenchForm controls with hidden command metadata.",
    ],
    accessibilityEvidence: ["Command forms carry hidden inputs and design-system buttons with accessible labels."],
    mustInclude: ["WorkbenchForm", "HiddenInput"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-authoring-status-formatting",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion",
    visualEvidence: ["Blocker and status presentation uses the shared StatusReasonList primitive."],
    accessibilityEvidence: ["Status reasons render as structured lists owned by the design system."],
    mustInclude: ["StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-authoring-review-module",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/source-observation-review",
    visualEvidence: [
      "Source observation review renders dense tables, detail panels, and evidence sheets from design-system primitives.",
    ],
    accessibilityEvidence: [
      "Review tables and evidence drawers expose accessible names, including explicit aria-label usage.",
    ],
    mustInclude: ["DataTable", "SideSheet", "aria-label"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-profile-authoring-controls",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/profiles",
    visualEvidence: [
      "Profile authoring uses dense-admin navigation, evidence panels, workbench forms, and design-system field controls.",
    ],
    accessibilityEvidence: [
      "Profile section navigation, hidden command metadata, text inputs, textareas, selects, and checkboxes are owned by the design system.",
    ],
    mustInclude: [
      "DenseAdminWorkbenchLayout",
      "EvidencePanel",
      "WorkbenchForm",
      "TextInput",
      "Textarea",
      "NativeSelect",
      "Checkbox",
      "HiddenInput",
    ],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-validation-readiness-controls",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/validation",
    visualEvidence: [
      "Validation readiness uses workbench grids, dense cells, evidence lists, and workbench forms for activation evidence.",
    ],
    accessibilityEvidence: [
      "Migration evidence and activation commands use design-system forms, hidden inputs, textarea, text input, and blocker patterns.",
    ],
    mustInclude: ["WorkbenchForm", "Textarea", "TextInput", "HiddenInput", "EvidenceStringList", "StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-health-workspace-patterns",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/health",
    visualEvidence: [
      "Health triage support tables use shared dense workbench data cells, stacks, text, and badge clusters.",
    ],
    accessibilityEvidence: [
      "Support workflow cells no longer recreate layout markup; row identity and status remain in DataTable and Badge metadata.",
    ],
    mustInclude: ["WorkbenchDataCell", "WorkbenchStack", "BadgeCluster", "DataTable"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-settings-workspace-patterns",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/settings",
    visualEvidence: [
      "Settings (governance controls become Settings) uses workbench cells, link lists, value lists, and blocker reason patterns instead of raw table-cell markup.",
    ],
    accessibilityEvidence: [
      "Evidence links use LinkText and blockers use StatusReasonList so link and status semantics stay centralized.",
    ],
    mustInclude: ["LinkText", "WorkbenchLinkList", "WorkbenchValueList", "StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-merge-candidate-conflict-resolution-patterns",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion",
    visualEvidence: [
      "Conflict resolution dissolved into candidate review uses workbench grids, stacks, data cells, and shared blocker reason lists instead of a standalone workspace.",
    ],
    accessibilityEvidence: [
      "Conflict evidence, resolution choices, and reasons use RadioGroup/Textarea form primitives and StatusReasonList blockers.",
    ],
    mustInclude: ["WorkbenchGrid", "WorkbenchDataCell", "WorkbenchText", "StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-lifecycle-workspace-patterns",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/lifecycle",
    visualEvidence: [
      "Lifecycle recovery uses workbench grids, workbench forms, hidden inputs, evidence string lists, and shared blocker reasons.",
    ],
    accessibilityEvidence: [
      "Lifecycle command confirmation and hidden command metadata are owned by design-system form primitives.",
    ],
    mustInclude: ["WorkbenchForm", "HiddenInput", "EvidenceStringList", "StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-audit-evidence-workspace-patterns",
    owner: "Catalog",
    scope: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/evidence",
    visualEvidence: [
      "Audit evidence uses workbench stacks, data cells, text, and link lists for release proof and redaction tables.",
    ],
    accessibilityEvidence: [
      "Evidence and proof links are centralized through LinkText and WorkbenchLinkList rather than raw anchors.",
    ],
    mustInclude: ["LinkText", "WorkbenchLinkList", "WorkbenchDataCell", "WorkbenchStack"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "discovery-commerce-comparison-list",
    owner: "Discovery",
    scope: "bounded-contexts/discovery/features/item-detail/ui",
    visualEvidence: [
      "Listing and offer rows use design-system comparison-list primitives for responsive price/account/product/action layout.",
    ],
    accessibilityEvidence: ["Selectable listing/offer rows and buttons carry aria-label and aria-pressed state."],
    mustInclude: ["ComparisonList", "ComparisonListHeader", "ComparisonListRow", "aria-label", "aria-pressed"],
    mustNotInclude: ["className={cx(", "grid-cols-[minmax(5.5rem"],
  },
  {
    id: "public-waitlist-mobile-cta",
    owner: "Public Presence",
    scope: "bounded-contexts/public-presence/features/waitlist/ui",
    visualEvidence: [
      "Public waitlist uses design-system mobile sticky layout, discounted value, segmented control, and marketing sections.",
    ],
    accessibilityEvidence: [
      "Hero intent segmented control and honeypot/hidden fields retain accessible labels and hiding rules.",
    ],
    mustInclude: [
      "MobileStickyBar",
      "MobileStickyInset",
      "DiscountValue",
      "SegmentedControl",
      'aria-label={t("publicPresence.waitlist.heroIntent.label")}',
      "HoneypotInput",
      "HiddenInput",
    ],
    mustNotInclude: [
      'className="fixed inset-x-0 bottom-0',
      '<input type="hidden"',
      '<input type="text" name="website"',
    ],
  },
  {
    id: "identity-account-badges",
    owner: "Identity",
    scope: "bounded-contexts/identity/features/accounts/ui",
    visualEvidence: ["Account badge icon sizing is owned by SVG attributes and Badge/Inline composition."],
    accessibilityEvidence: ["Compact badge labels use the shared VisuallyHidden primitive."],
    mustInclude: ["VisuallyHidden", "height={16}", "width={16}", 'aria-hidden="true"'],
    mustNotInclude: ['className="h-4 w-4', 'className="sr-only"'],
  },
  {
    id: "design-system-primitives",
    owner: "Design System",
    scope: "packages/design-system/src/components/forms",
    visualEvidence: ["Validation message visuals are centralized under design-system form primitives."],
    accessibilityEvidence: ["ValidationSummary keeps role=alert, aria-live, and focusable error-link behavior."],
    discoverySignals: ["ValidationMessageList"],
    mustInclude: ["ValidationMessageList", 'role="alert"', 'aria-live="assertive"', "focusValidationTarget"],
    mustNotInclude: [],
  },
  {
    id: "hidden-input-policy",
    owner: "Design System",
    scope: "packages/design-system/src/components/forms",
    visualEvidence: ["Non-visible form metadata is centralized as a design-system form primitive."],
    accessibilityEvidence: ["Honeypot inputs are aria-hidden, hidden, non-tabbable, and autocomplete off by default."],
    discoverySignals: ["HiddenInput", "HoneypotInput"],
    mustInclude: ["HiddenInput", "HoneypotInput", "aria-hidden", "hidden", "tabIndex = -1", 'autoComplete = "off"'],
    mustNotInclude: ["className=", "style="],
  },
];

const verificationCommands = [
  "pnpm run ops design-system:legacy-inventory --write-ledger",
  "pnpm run ops design-system:legacy-evidence --write",
  "pnpm run test:design-system-legacy-inventory",
  "pnpm run test:design-system-legacy-evidence",
  "pnpm run check:design-system-legacy-evidence",
  "pnpm exec tsc -p ./tsconfig.json --noEmit",
  "pnpm run verify:static",
];

export function parseDesignSystemLegacyEvidenceArgs(argv, env = process.env) {
  return {
    check: argv.includes("--check") || readBooleanEnv("DESIGN_SYSTEM_LEGACY_EVIDENCE_CHECK", env),
    write: argv.includes("--write") || readBooleanEnv("DESIGN_SYSTEM_LEGACY_EVIDENCE_WRITE", env),
    out: readOption(argv, "--out") ?? env.DESIGN_SYSTEM_LEGACY_EVIDENCE_OUT ?? defaultEvidencePath,
    checkedAt: readOption(argv, "--checked-at") ?? env.DESIGN_SYSTEM_LEGACY_EVIDENCE_CHECKED_AT,
  };
}

export async function collectDesignSystemLegacyEvidence(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const ledgerPath =
    options.ledgerPath ?? path.join(rootDir, "packages/design-system/DESIGN_SYSTEM_LEGACY_INVENTORY.json");
  const checks = (options.surfaceChecks ?? surfaceChecks).map((check) => evaluateSurfaceCheck(check, rootDir));
  const ledger = readJson(ledgerPath);
  const ledgerValidation = await validateLedger(ledger, { rootDir, ledgerPath });
  const ledgerErrors = ledgerValidation.errors;
  const errors = [...ledgerErrors, ...checks.flatMap((check) => check.errors ?? [])];

  return {
    schemaVersion: DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION,
    milestone: 12,
    checkedAt,
    generatedBy: "pnpm run ops design-system:legacy-evidence --write",
    retainedArtifact: normalizeRelativePath(options.out ?? defaultEvidencePath, rootDir),
    summary: {
      representativeSurfaceCount: checks.length,
      visualEvidenceCount: checks.reduce((sum, check) => sum + check.visualEvidence.length, 0),
      accessibilityEvidenceCount: checks.reduce((sum, check) => sum + check.accessibilityEvidence.length, 0),
      legacyInventoryFileCount: ledgerValidation.freshLedger.summary.fileCount,
      legacyInventoryGatingFileCount: ledgerValidation.freshLedger.summary.gatingFileCount,
      legacyInventoryEntryCount: ledgerValidation.freshLedger.entries.length,
    },
    verificationCommands,
    checks,
    passesDesignSystemLegacyEvidence: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function writeDesignSystemLegacyEvidence(report, outPath = defaultEvidencePath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

function evaluateSurfaceCheck(check, rootDir) {
  const absoluteScope = path.join(rootDir, check.scope);
  const errors = [];
  const files = [];

  if (!existsSync(absoluteScope)) {
    errors.push(`${check.id}: ${check.scope} does not exist.`);
  } else {
    files.push(...readScannableFiles(absoluteScope, rootDir));
  }

  const discoverySignals = check.discoverySignals ?? check.mustInclude;
  const discoverySignalFiles = {};
  const discoveredFiles = new Set();

  for (const signal of discoverySignals) {
    const matchedFiles = files.filter((file) => file.source.includes(signal)).map((file) => file.relativePath);
    discoverySignalFiles[signal] = matchedFiles;

    if (matchedFiles.length === 0) {
      errors.push(`${check.id}: ${check.scope} must include ${JSON.stringify(signal)} in at least one scoped file.`);
    }

    for (const matchedFile of matchedFiles) {
      discoveredFiles.add(matchedFile);
    }
  }

  const discoveredSources = files.filter((file) => discoveredFiles.has(file.relativePath));
  const requiredSignalFiles = {};

  for (const required of check.mustInclude) {
    const matchedFiles = discoveredSources
      .filter((file) => file.source.includes(required))
      .map((file) => file.relativePath);
    requiredSignalFiles[required] = matchedFiles;

    if (matchedFiles.length === 0) {
      errors.push(
        `${check.id}: ${check.scope} discovered files must include ${JSON.stringify(required)} in at least one file.`,
      );
    }
  }

  const forbiddenSignalFiles = {};

  for (const forbidden of check.mustNotInclude) {
    const matchedFiles = discoveredSources
      .filter((file) => file.source.includes(forbidden))
      .map((file) => file.relativePath);
    forbiddenSignalFiles[forbidden] = matchedFiles;

    for (const matchedFile of matchedFiles) {
      errors.push(`${check.id}: ${matchedFile} must not include ${JSON.stringify(forbidden)}.`);
    }
  }

  return {
    id: check.id,
    owner: check.owner,
    scope: check.scope,
    discoveredFiles: [...discoveredFiles].sort(),
    visualEvidence: check.visualEvidence,
    accessibilityEvidence: check.accessibilityEvidence,
    requiredSignals: check.mustInclude,
    forbiddenSignals: check.mustNotInclude,
    discoverySignals,
    discoverySignalFiles,
    requiredSignalFiles,
    forbiddenSignalFiles,
    status: errors.length === 0 ? "passed" : "failed",
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function readScannableFiles(directory, rootDir) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
      return [];
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return readScannableFiles(absolutePath, rootDir);
    }

    if (!isScannableSourceFile(entry.name)) {
      return [];
    }

    return [
      {
        relativePath: normalizeRelativePath(absolutePath, rootDir),
        source: readFileSync(absolutePath, "utf8"),
      },
    ];
  });
}

function isScannableSourceFile(fileName) {
  return [".js", ".jsx", ".mjs", ".ts", ".tsx", ".md"].includes(path.extname(fileName));
}

async function validateLedger(ledger, options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const ledgerPath =
    options.ledgerPath ?? path.join(rootDir, "packages/design-system/DESIGN_SYSTEM_LEGACY_INVENTORY.json");
  const freshLedger = await collectDesignSystemLegacyInventoryDocument({ rootDir });
  const errors = [];

  if (!ledger || typeof ledger !== "object") {
    errors.push("Legacy inventory ledger must be a JSON object.");
  } else if (!compareDesignSystemLegacyInventoryLedger(freshLedger, ledger)) {
    errors.push(
      `Legacy inventory ledger ${normalizeRelativePath(ledgerPath, rootDir)} must match a fresh design-system legacy inventory scan.`,
    );
  }

  if (freshLedger.summary.gatingFileCount !== 0) {
    errors.push("Fresh legacy inventory scan summary.gatingFileCount must be 0.");
  }

  return { errors, freshLedger };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }

  return value;
}

export function compareDesignSystemLegacyEvidence(currentReport, committedReport) {
  return JSON.stringify(stableJsonValue(currentReport)) === JSON.stringify(stableJsonValue(committedReport));
}

function readEvidenceArtifact(evidencePath, rootDir = repoRoot) {
  if (!existsSync(evidencePath)) {
    return {
      artifact: null,
      error: `Design-system legacy evidence artifact is missing at ${normalizeRelativePath(evidencePath, rootDir)}.`,
    };
  }

  try {
    return {
      artifact: readJson(evidencePath),
      error: null,
    };
  } catch (error) {
    return {
      artifact: null,
      error: `Design-system legacy evidence artifact is not valid JSON at ${normalizeRelativePath(
        evidencePath,
        rootDir,
      )}: ${error.message}`,
    };
  }
}

export async function checkDesignSystemLegacyEvidence(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const evidencePath = options.out ?? defaultEvidencePath;
  const artifactResult = readEvidenceArtifact(evidencePath, rootDir);
  const checkedAt = options.checkedAt ?? artifactResult.artifact?.checkedAt ?? new Date().toISOString();
  const report = await collectDesignSystemLegacyEvidence({ ...options, rootDir, out: evidencePath, checkedAt });
  const artifactInSync =
    artifactResult.artifact !== null && compareDesignSystemLegacyEvidence(report, artifactResult.artifact);

  return {
    passed: report.passesDesignSystemLegacyEvidence && artifactInSync,
    report,
    evidencePath,
    artifactError: artifactResult.error,
    artifactInSync,
  };
}

export function printDesignSystemLegacyEvidenceCheckResult(result) {
  const relativeEvidencePath = normalizeRelativePath(result.evidencePath, repoRoot);

  if (!result.report.passesDesignSystemLegacyEvidence) {
    console.error("Design-system legacy evidence check failed.");
    for (const error of result.report.errors ?? []) {
      console.error(`- ${error}`);
    }
  }

  if (result.artifactError) {
    console.error(result.artifactError);
    console.error("Run pnpm run ops design-system:legacy-evidence --write to regenerate it.");
  } else if (!result.artifactInSync) {
    console.error(
      `Design-system legacy evidence artifact is stale: ${relativeEvidencePath} differs from a fresh scan.`,
    );
    console.error("Run pnpm run ops design-system:legacy-evidence --write to regenerate it.");
  }

  if (result.passed) {
    console.log(
      `Design-system legacy evidence check passed: ${result.report.summary.representativeSurfaceCount} representative surface(s), ${result.report.summary.legacyInventoryEntryCount} legacy inventory entries, and ${relativeEvidencePath} is in sync.`,
    );
  }
}

function readBooleanEnv(name, env) {
  return ["1", "true", "yes"].includes(String(env[name] ?? "").toLowerCase());
}

function normalizeRelativePath(filePath, rootDir) {
  return path.relative(rootDir, filePath).replaceAll("\\", "/");
}

async function main(argv, env = process.env) {
  const options = parseDesignSystemLegacyEvidenceArgs(argv, env);
  if (options.check) {
    const result = await checkDesignSystemLegacyEvidence(options);
    printDesignSystemLegacyEvidenceCheckResult(result);
    return result.passed ? 0 : 1;
  }

  const report = await collectDesignSystemLegacyEvidence(options);
  if (options.write) {
    writeDesignSystemLegacyEvidence(report, options.out);
  }
  console.log(JSON.stringify(report, null, 2));
  return report.passesDesignSystemLegacyEvidence ? 0 : 1;
}

if (typeof process !== "undefined" && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
