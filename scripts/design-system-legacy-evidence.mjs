#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repo.mjs";
import { readOption } from "./lib/cli-options.mjs";

export const DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION = "design-system-legacy-visual-accessibility-evidence/v1";
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
    file: "packages/design-system/src/components/print/packing-slip.tsx",
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
    file: "bounded-contexts/platform-operations/features/support-requests/ui/support-request-list-page.tsx",
    visualEvidence: ["Support request lists render through DataTable instead of legacy responsive table markup."],
    accessibilityEvidence: ["Table headers and row identity are owned by DataTable column metadata and getRowId."],
    mustInclude: ["DataTable", "getRowId", "columns"],
    mustNotInclude: ["UiTable", "<table", "className="],
  },
  {
    id: "catalog-authoring-controls",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.tsx",
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
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion/primary-steps-module.tsx",
    visualEvidence: [
      "The import-to-promotion steps module renders dense tables and step evidence drawers from design-system primitives.",
    ],
    accessibilityEvidence: [
      "Step tables and evidence drawers expose row identity and accessible structure via DataTable and SideSheet.",
    ],
    mustInclude: ["DataTable", "SideSheet"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-authoring-command-controls",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion/command-controls.tsx",
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
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion/workbench-formatting.tsx",
    visualEvidence: ["Blocker and status presentation uses the shared StatusReasonList primitive."],
    accessibilityEvidence: ["Status reasons render as structured lists owned by the design system."],
    mustInclude: ["StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-authoring-review-module",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/source-observation-review/source-observation-review-module.tsx",
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
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/profiles/profile-authoring-workspace.tsx",
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
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/validation/validation-readiness-workspace.tsx",
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
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/health/integration-health-dashboard.tsx",
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
    id: "catalog-governance-workspace-patterns",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/governance/governance-controls-workspace.tsx",
    visualEvidence: [
      "Governance controls use workbench cells, link lists, value lists, and blocker reason patterns instead of raw table-cell markup.",
    ],
    accessibilityEvidence: [
      "Evidence links use LinkText and blockers use StatusReasonList so link and status semantics stay centralized.",
    ],
    mustInclude: ["LinkText", "WorkbenchLinkList", "WorkbenchValueList", "StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-conflict-workspace-patterns",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/conflicts/conflict-resolution-workspace.tsx",
    visualEvidence: ["Conflict resolution uses workbench grids, stacks, data cells, and shared blocker reason lists."],
    accessibilityEvidence: [
      "Conflict evidence, precedence, and override blockers use DataTable row metadata and StatusReasonList.",
    ],
    mustInclude: ["WorkbenchGrid", "WorkbenchDataCell", "WorkbenchText", "StatusReasonList"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "catalog-lifecycle-workspace-patterns",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/lifecycle/lifecycle-recovery-workspace.tsx",
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
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/evidence/audit-evidence-workspace.tsx",
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
    id: "catalog-clean-reset-workspace-patterns",
    owner: "Catalog",
    file: "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/evidence/clean-reset-release-workspace.tsx",
    visualEvidence: [
      "Clean reset release tables use workbench action rows, stacks, and data cells instead of raw release-proof markup.",
    ],
    accessibilityEvidence: [
      "Release proof links remain buttons while surrounding evidence text is centralized in dense workbench cells.",
    ],
    mustInclude: ["WorkbenchActionRow", "WorkbenchDataCell", "WorkbenchStack", "LinkButton"],
    mustNotInclude: catalogControlPlaneForbiddenSignals,
  },
  {
    id: "discovery-commerce-comparison-list",
    owner: "Discovery",
    file: "bounded-contexts/discovery/features/item-detail/ui/item-detail-market-book.tsx",
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
    file: "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx",
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
    file: "bounded-contexts/identity/features/accounts/ui/account-badges.tsx",
    visualEvidence: ["Account badge icon sizing is owned by SVG attributes and Badge/Inline composition."],
    accessibilityEvidence: ["Compact badge labels use the shared VisuallyHidden primitive."],
    mustInclude: ["VisuallyHidden", "height={16}", "width={16}", 'aria-hidden="true"'],
    mustNotInclude: ['className="h-4 w-4', 'className="sr-only"'],
  },
  {
    id: "design-system-primitives",
    owner: "Design System",
    file: "packages/design-system/src/components/forms/validation-summary.tsx",
    visualEvidence: ["Validation message visuals are centralized under design-system form primitives."],
    accessibilityEvidence: ["ValidationSummary keeps role=alert, aria-live, and focusable error-link behavior."],
    mustInclude: ["ValidationMessageList", 'role="alert"', 'aria-live="assertive"', "focusValidationTarget"],
    mustNotInclude: [],
  },
  {
    id: "hidden-input-policy",
    owner: "Design System",
    file: "packages/design-system/src/components/forms/hidden-input.tsx",
    visualEvidence: ["Non-visible form metadata is centralized as a design-system form primitive."],
    accessibilityEvidence: ["Honeypot inputs are aria-hidden, hidden, non-tabbable, and autocomplete off by default."],
    mustInclude: ["HiddenInput", "HoneypotInput", "aria-hidden", "hidden", "tabIndex = -1", 'autoComplete = "off"'],
    mustNotInclude: ["className=", "style="],
  },
];

const verificationCommands = [
  "pnpm run ops design-system:legacy-inventory --write-ledger",
  "pnpm run ops design-system:legacy-evidence --write",
  "pnpm run test:design-system-legacy-inventory",
  "pnpm run test:design-system-legacy-evidence",
  "pnpm exec tsc -p ./tsconfig.json --noEmit",
  "pnpm run verify:static",
];

export function parseDesignSystemLegacyEvidenceArgs(argv, env = process.env) {
  return {
    write: argv.includes("--write") || readBooleanEnv("DESIGN_SYSTEM_LEGACY_EVIDENCE_WRITE", env),
    out: readOption(argv, "--out") ?? env.DESIGN_SYSTEM_LEGACY_EVIDENCE_OUT ?? defaultEvidencePath,
    checkedAt:
      readOption(argv, "--checked-at") ?? env.DESIGN_SYSTEM_LEGACY_EVIDENCE_CHECKED_AT ?? new Date().toISOString(),
  };
}

export function collectDesignSystemLegacyEvidence(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const ledgerPath =
    options.ledgerPath ?? path.join(rootDir, "packages/design-system/DESIGN_SYSTEM_LEGACY_INVENTORY.json");
  const checks = surfaceChecks.map((check) => evaluateSurfaceCheck(check, rootDir));
  const ledger = readJson(ledgerPath);
  const ledgerErrors = validateLedger(ledger);
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
      legacyInventoryFileCount: ledger.summary?.fileCount ?? null,
      legacyInventoryEntryCount: Array.isArray(ledger.entries) ? ledger.entries.length : null,
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
  const absoluteFile = path.join(rootDir, check.file);
  const errors = [];
  let source = "";

  if (!existsSync(absoluteFile)) {
    errors.push(`${check.id}: ${check.file} does not exist.`);
  } else {
    source = readFileSync(absoluteFile, "utf8");
  }

  for (const required of check.mustInclude) {
    if (!source.includes(required)) {
      errors.push(`${check.id}: ${check.file} must include ${JSON.stringify(required)}.`);
    }
  }

  for (const forbidden of check.mustNotInclude) {
    if (source.includes(forbidden)) {
      errors.push(`${check.id}: ${check.file} must not include ${JSON.stringify(forbidden)}.`);
    }
  }

  return {
    id: check.id,
    owner: check.owner,
    file: check.file,
    visualEvidence: check.visualEvidence,
    accessibilityEvidence: check.accessibilityEvidence,
    requiredSignals: check.mustInclude,
    forbiddenSignals: check.mustNotInclude,
    status: errors.length === 0 ? "passed" : "failed",
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function validateLedger(ledger) {
  const errors = [];
  if (!ledger || typeof ledger !== "object") {
    return ["Legacy inventory ledger must be a JSON object."];
  }
  if (ledger.summary?.fileCount !== 0) {
    errors.push("Legacy inventory ledger summary.fileCount must be 0.");
  }
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== 0) {
    errors.push("Legacy inventory ledger entries must be an empty array.");
  }
  if (Object.keys(ledger.summary?.categories ?? {}).length !== 0) {
    errors.push("Legacy inventory ledger summary.categories must be empty.");
  }
  return errors;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readBooleanEnv(name, env) {
  return ["1", "true", "yes"].includes(String(env[name] ?? "").toLowerCase());
}

function normalizeRelativePath(filePath, rootDir) {
  return path.relative(rootDir, filePath).replaceAll("\\", "/");
}

async function main(argv, env = process.env) {
  const options = parseDesignSystemLegacyEvidenceArgs(argv, env);
  const report = collectDesignSystemLegacyEvidence(options);
  if (options.write) {
    writeDesignSystemLegacyEvidence(report, options.out);
  }
  console.log(JSON.stringify(report, null, 2));
  return report.passesDesignSystemLegacyEvidence ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
