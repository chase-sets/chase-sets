#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repo.mjs";

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
    file: "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx",
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
      "The rebuilt Catalog primary workbench uses grouped section navigation, dense tables, bulk actions, and evidence drawers.",
    ],
    accessibilityEvidence: [
      "Workflow navigation, command actions, and evidence drawers expose accessible names and preserve primary-path context.",
    ],
    mustInclude: ["SectionNavigation", "BulkActionSurface", "DataTable", "SideSheet", "aria-label"],
    mustNotInclude: ['<input type="checkbox"', 'className="text-sm text-danger"'],
  },
  {
    id: "discovery-commerce-comparison-list",
    owner: "Discovery",
    file: "bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx",
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
  "pnpm run design-system:legacy-inventory -- --write-ledger",
  "pnpm run design-system:legacy-evidence -- --write",
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
    generatedBy: "pnpm run design-system:legacy-evidence -- --write",
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

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
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
