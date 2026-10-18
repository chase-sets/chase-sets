import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// Rendered-copy guard: a page-level classifier for machine values leaking into
// seeded UI copy, a selector-scoped owner map, and the captured-base lifecycle
// (PROPOSED -> CAPTURED -> INTEGRATED -> LANDED -> STEADY_STATE) whose
// committed record is checked by validateRenderedCopyProvenance.

export const renderedCopyClasses = [
  "typed-id",
  "seed-id",
  "object-string",
  "template-placeholder",
  "hedged-plural",
  "iso-instant",
] as const;
export type RenderedCopyClass = (typeof renderedCopyClasses)[number];
export type RenderedCopyViolation = Readonly<{ class: RenderedCopyClass; text: string }>;
export type RenderedCopyCounts = Readonly<Record<RenderedCopyClass, number>>;

const patternSources: Readonly<Record<RenderedCopyClass, string>> = {
  "typed-id": String.raw`\b[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}\b`,
  "seed-id": String.raw`\b[a-z]{2,4}_seed_[a-z0-9_]+\b`,
  "object-string": String.raw`(?<![A-Za-z0-9_])(?:\[object Object\]|NaN|undefined)(?![A-Za-z0-9_])`,
  "template-placeholder": String.raw`\{[A-Za-z_][A-Za-z0-9_]*\}`,
  "hedged-plural": String.raw`\b[A-Za-z]+\(s\)`,
  "iso-instant": String.raw`\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`,
};

export function classifyRenderedCopy(text: string): RenderedCopyViolation[] {
  return renderedCopyClasses.flatMap((kind) =>
    [...text.matchAll(new RegExp(patternSources[kind], "g"))].map((match) => ({ class: kind, text: match[0] })),
  );
}

export const renderedCopyExclusions = ["code", "pre", "[data-raw-identifier]"] as const;

// The sweep census: 32 page/persona tuples, each owned by exactly one of the
// eight browser suites whose batches run the two sweep specs.
export const renderedCopySweepSpecs = {
  marketplace: "deployables/marketplace/e2e/rendered-copy-sweep.spec.ts",
  "admin-web": "deployables/admin-web/e2e/rendered-copy-sweep.spec.ts",
} as const;
export type RenderedCopyDeployable = keyof typeof renderedCopySweepSpecs;
export type RenderedCopyTuple = Readonly<{
  deployable: RenderedCopyDeployable;
  persona: "collector" | "demo" | "owner" | "platform-admin";
  page: string;
  suite: string;
  tag: string;
}>;

const marketplaceAccount = {
  deployable: "marketplace",
  persona: "collector",
  suite: "marketplace_account",
  tag: "@marketplace-account",
} as const;
const marketplaceSeller = {
  deployable: "marketplace",
  persona: "demo",
  suite: "marketplace_seller",
  tag: "@marketplace-seller",
} as const;
const admin = (persona: "owner" | "platform-admin", suite: string, page: string): RenderedCopyTuple => ({
  deployable: "admin-web",
  persona,
  page,
  suite,
  tag: `@${suite.replaceAll("_", "-")}`,
});

export const renderedCopyTuples: readonly RenderedCopyTuple[] = [
  { ...marketplaceAccount, page: "/account/notifications" },
  { ...marketplaceAccount, page: "/account/offers/submitted" },
  { ...marketplaceAccount, page: "/account/sessions" },
  { ...marketplaceAccount, page: "/account/support" },
  { ...marketplaceAccount, page: "/account/payments/pay_seed_checkout_pending" },
  { ...marketplaceAccount, page: "/account/payments/pay_seed_review_eligible_captured" },
  { ...marketplaceAccount, page: "/account/shipments/shp_seed_review_eligible" },
  { ...marketplaceSeller, page: "/account/desk/money" },
  { ...marketplaceSeller, page: "/account/listings" },
  { ...marketplaceSeller, page: "/account/sell-list" },
  { ...marketplaceSeller, page: "/account/sales/shipments" },
  { ...marketplaceSeller, page: "/account/sales/shipments/packing-slips?shipmentIds=shp_seed_awaiting_label" },
  { ...marketplaceSeller, page: "/account/sales/shipments/shp_seed_awaiting_label" },
  { ...marketplaceSeller, page: "/account/channels/connection-seed-tcgplayer-manual" },
  { ...marketplaceSeller, page: "/account/channels/publication/connection-seed-tcgplayer-manual" },
  admin("owner", "admin_access", "/access/accounts/acc_seed_demo_account?tab=audit"),
  admin("owner", "admin_access", "/access/sessions"),
  admin("owner", "catalog_admin_modeling", "/catalog/dimensions/dim_seed_condition"),
  admin("owner", "catalog_admin_modeling", "/catalog/display-templates"),
  admin("owner", "catalog_admin_integrations", "/catalog/integrations"),
  admin("owner", "catalog_admin_integrations", "/catalog/scopes/ref_seed_expansion_base_set"),
  admin("owner", "catalog_admin_integrations", "/catalog/source-observations/tcgdex_en_base2_60"),
  admin("owner", "admin_commerce", "/commerce/postage-policies"),
  admin("owner", "admin_growth", "/growth/google-shopping"),
  admin("platform-admin", "admin_access", "/access/accounts/acc_seed_suspended_account?tab=audit"),
  admin("platform-admin", "admin_commerce", "/commerce/money-health"),
  admin("platform-admin", "admin_commerce", "/commerce/payout-operations"),
  admin("platform-admin", "admin_commerce", "/commerce/wallet-workbench/acc_seed_demo_account"),
  admin("platform-admin", "admin_support", "/support"),
  admin("platform-admin", "admin_support", "/support/platform-feedback"),
  admin("platform-admin", "admin_support", "/support/platform-feedback/pfb_seed_checkout"),
  admin("platform-admin", "admin_support", "/support/reference-lookup"),
];

export const renderedCopyTupleKey = (tuple: Pick<RenderedCopyTuple, "deployable" | "persona" | "page">) =>
  `${tuple.deployable} ${tuple.persona} ${tuple.page}`;

// The reviewed mechanical substitution rule: a captured occurrence belongs to
// the token's owner exactly when it renders on the page, inside the selector,
// under the dt/th label (when set) and with the identifier prefix (when set).
// Anything else is an unanticipated field the host files before INTEGRATED.
export type RenderedCopyOwnerRule = Readonly<{
  token: string;
  field: string;
  page: string;
  class: RenderedCopyClass;
  selector: string;
  label: string | null;
  prefix: string | null;
  issue: number;
}>;

export const renderedCopyOwnerRules: readonly RenderedCopyOwnerRule[] = [
  {
    token: "SB8-COPY-01",
    field: "Submitted Offer identity",
    page: "/account/offers/submitted",
    class: "seed-id",
    selector: "main",
    label: null,
    prefix: "off_",
    issue: 9937,
  },
  {
    token: "SB8-COPY-02",
    field: "manual-sync Channel Connection instant",
    page: "/account/channels/connection-seed-tcgplayer-manual",
    class: "iso-instant",
    selector: '[data-testid="manual-sync-lease-facts"], [data-testid="manual-sync-ingest-probe"]',
    label: null,
    prefix: null,
    issue: 9938,
  },
  {
    token: "SB8-COPY-03",
    field: "publication blocked-listing identity",
    page: "/account/channels/publication/connection-seed-tcgplayer-manual",
    class: "seed-id",
    selector: "main",
    label: null,
    prefix: "lst_",
    issue: 8776,
  },
  {
    token: "SB8-COPY-04",
    field: "Google Shopping listing identity",
    page: "/growth/google-shopping",
    class: "seed-id",
    selector: "main",
    label: null,
    prefix: "lst_",
    issue: 8867,
  },
  {
    token: "SB8-COPY-05",
    field: "Owner Audit invitation subject",
    page: "/access/accounts/acc_seed_demo_account?tab=audit",
    class: "typed-id",
    selector: '[role="tabpanel"]',
    label: null,
    prefix: "ivt_",
    issue: 8721,
  },
  {
    token: "SB8-COPY-06",
    field: "attention-queue freshness generatedAt",
    page: "/catalog/integrations",
    class: "iso-instant",
    selector: '[data-catalog-attention-queue="true"]',
    label: null,
    prefix: null,
    issue: 8720,
  },
  {
    token: "SB8-COPY-06",
    field: "count-spend observedAt/expiresAt",
    page: "/catalog/integrations",
    class: "iso-instant",
    selector: "main",
    label: "Recent count spend",
    prefix: null,
    issue: 9939,
  },
];

// B..checkout may differ only inside this footprint; anything else is a
// product diff that makes the capture unattributable to B.
export const renderedCopyGuardFootprint: readonly string[] = [
  ".github/workflows/platform-pr.yml",
  "bounded-contexts/catalog/features/attention-queue/ui/attention-queue-panel.tsx",
  "bounded-contexts/marketplace/features/offers/ui/submitted-offer-list-page.tsx",
  "bounded-contexts/public-presence/features/policies/domain/canonical-claim-guard.test.ts",
  "deployables/admin-web/e2e/rendered-copy-sweep.spec.ts",
  "deployables/marketplace/app/smoke-auth-support.test.ts",
  "deployables/marketplace/e2e/rendered-copy-sweep.spec.ts",
  "infrastructure/playwright-evidence/package.json",
  "infrastructure/playwright-evidence/rendered-copy-baseline.json",
  "infrastructure/playwright-evidence/rendered-copy-capture.json",
  "infrastructure/playwright-evidence/rendered-copy-collect.json",
  "infrastructure/playwright-evidence/rendered-copy.ts",
  "scripts/ci-gate-plan.test.mjs",
  "scripts/e2e-suites.mjs",
  "scripts/fixtures/ci-e2e-selection.json",
  "scripts/rendered-copy-provenance.test.mjs",
  "scripts/run-e2e-suite.mjs",
  "scripts/run-e2e-suite.test.mjs",
  "scripts/verify-static-scoped.test.mjs",
  "scripts/verify-static-surfaces.mjs",
  "tsconfig.base.json",
];

// Tool blobs bound by a capture; an INTEGRATED head must carry them unchanged.
export const renderedCopyToolPaths: readonly string[] = [
  "deployables/admin-web/e2e/rendered-copy-sweep.spec.ts",
  "deployables/marketplace/e2e/rendered-copy-sweep.spec.ts",
  "infrastructure/playwright-evidence/rendered-copy.ts",
  "playwright.config.ts",
  "scripts/e2e-suites.mjs",
  "scripts/run-e2e-suite.mjs",
];

export const renderedCopyFiles = {
  baseline: "infrastructure/playwright-evidence/rendered-copy-baseline.json",
  capture: "infrastructure/playwright-evidence/rendered-copy-capture.json",
  collect: "infrastructure/playwright-evidence/rendered-copy-collect.json",
} as const;

export const renderedCopyObservationDirectory = "artifacts/rendered-copy-collect";
export const renderedCopyCaptureArtifactRoot = ".artifacts/rendered-copy-capture";
export const renderedCopyCaptureArtifactName = (runId: number, attempt: number, jobIndex: number) =>
  `rendered-copy-capture-${runId}-${attempt}-${jobIndex}`;

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const maxTupleDurationMs = 25 * 60 * 1000;
const shaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const tokenPattern = /^SB8-COPY-0[1-6]$/;

// ---------------------------------------------------------------------------
// Committed files and closed schemas.

export type RenderedCopyToggle = Readonly<{ schema: "rendered-copy-collect/v1"; enabled: boolean }>;
export type RenderedCopyField = Readonly<{
  page: string;
  class: RenderedCopyClass;
  selector: string;
  label: string | null;
  prefix: string | null;
  token: string | null;
}>;
export type RenderedCopyBaselineRow = RenderedCopyField & Readonly<{ issue: number; maxCount: number }>;
export type RenderedCopyBaseline = Readonly<{
  schema: "rendered-copy-baseline/v1";
  rows: readonly RenderedCopyBaselineRow[];
}>;
export type RenderedCopyObservedField = RenderedCopyField &
  Readonly<{ issue: number | null; count: number; samples: readonly string[] }>;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const ordinal = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function closedKeys(value: unknown, where: string, keys: readonly string[], violations: string[]): value is JsonObject {
  if (!isObject(value)) {
    violations.push(`${where}: must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) violations.push(`${where}: unknown key "${key}"`);
  for (const key of keys) if (!(key in value)) violations.push(`${where}: missing key "${key}"`);
  return true;
}

const boundedInt = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const boundedString = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const nullableString = (value: unknown, max: number) => value === null || boundedString(value, max);
const isClass = (value: unknown): value is RenderedCopyClass => renderedCopyClasses.some((kind) => kind === value);
const isInstant = (value: unknown) =>
  typeof value === "string" && instantPattern.test(value) && !Number.isNaN(Date.parse(value));

export const renderedCopyFieldKey = (field: RenderedCopyField) =>
  JSON.stringify([field.page, field.class, field.selector, field.label, field.prefix, field.token]);
const fieldName = (field: RenderedCopyField) =>
  `${field.page} ${field.class} field selector=${JSON.stringify(field.selector)}` +
  `${field.label === null ? "" : ` label=${JSON.stringify(field.label)}`}` +
  `${field.prefix === null ? "" : ` prefix=${JSON.stringify(field.prefix)}`}` +
  `${field.token === null ? " (unanticipated)" : ` ${field.token}`}`;

function checkFieldShape(value: JsonObject, where: string, violations: string[]) {
  if (!boundedString(value.page, 300)) violations.push(`${where}.page: invalid`);
  if (!isClass(value.class)) violations.push(`${where}.class: unknown class ${JSON.stringify(value.class)}`);
  if (!boundedString(value.selector, 300)) violations.push(`${where}.selector: invalid`);
  if (!nullableString(value.label, 120)) violations.push(`${where}.label: invalid`);
  if (!nullableString(value.prefix, 8)) violations.push(`${where}.prefix: invalid`);
  if (value.token !== null && !(typeof value.token === "string" && tokenPattern.test(value.token))) {
    violations.push(`${where}.token: invalid`);
  }
}

const baselineRowKeys = ["page", "class", "selector", "label", "prefix", "token", "issue", "maxCount"] as const;

export function validateRenderedCopyToggle(value: unknown): string[] {
  const violations: string[] = [];
  if (!closedKeys(value, "rendered-copy-collect", ["schema", "enabled"], violations)) return violations;
  if (value.schema !== "rendered-copy-collect/v1") violations.push("rendered-copy-collect.schema: unsupported");
  if (value.enabled !== true) violations.push("rendered-copy-collect.enabled: a present toggle must enable capture");
  return violations;
}

export function validateRenderedCopyBaseline(value: unknown): string[] {
  const violations: string[] = [];
  if (!closedKeys(value, "rendered-copy-baseline", ["schema", "rows"], violations)) return violations;
  if (value.schema !== "rendered-copy-baseline/v1") violations.push("rendered-copy-baseline.schema: unsupported");
  if (!Array.isArray(value.rows) || value.rows.length > 500) {
    violations.push("rendered-copy-baseline.rows: must be an array of at most 500 rows");
    return violations;
  }
  const ownerKeys = new Set<string>();
  const fieldKeys = new Set<string>();
  let previous: JsonObject | null = null;
  value.rows.forEach((row, index) => {
    const where = `rendered-copy-baseline.rows[${index}]`;
    if (!closedKeys(row, where, baselineRowKeys, violations)) return;
    checkFieldShape(row, where, violations);
    if (!boundedInt(row.issue, 1, 1_000_000)) violations.push(`${where}.issue: must cite a positive issue`);
    if (!boundedInt(row.maxCount, 1, 100_000)) violations.push(`${where}.maxCount: invalid maxCount`);
    const ownerKey = JSON.stringify([row.page, row.class, row.issue]);
    if (ownerKeys.has(ownerKey)) violations.push(`${where}: duplicate (page, class, issue) ${ownerKey}`);
    ownerKeys.add(ownerKey);
    const fieldKey = renderedCopyFieldKey(row as unknown as RenderedCopyField);
    if (fieldKeys.has(fieldKey)) violations.push(`${where}: duplicate field ${fieldKey}`);
    fieldKeys.add(fieldKey);
    if (previous !== null && compareBaselineRows(previous, row) > 0) {
      violations.push(`${where}: rows must be sorted by page, class, issue`);
    }
    previous = row;
  });
  return violations;
}

export function compareBaselineRows(
  left: Readonly<{ page?: Json; class?: Json; issue?: Json }>,
  right: Readonly<{ page?: Json; class?: Json; issue?: Json }>,
): number {
  return (
    ordinal(String(left.page), String(right.page)) ||
    ordinal(String(left.class), String(right.class)) ||
    Number(left.issue) - Number(right.issue)
  );
}

// ---------------------------------------------------------------------------
// In-page observation and field attribution.

export type RenderedCopyOccurrence = Readonly<{
  class: RenderedCopyClass;
  text: string;
  region: string;
  label: string | null;
  path: string;
  within: readonly boolean[];
}>;

// innerText preserves rendered whitespace and inline token boundaries. Each
// match is attributed to the deepest element whose own text holds it; the
// exclusions are restored before control returns to the application.
export async function readRenderedCopyOccurrences(
  page: Page,
  selectors: readonly string[],
  additionalExclusions: readonly string[] = [],
): Promise<{ counts: RenderedCopyCounts; occurrences: RenderedCopyOccurrence[] }> {
  const result = await page.evaluate(
    ({ exclusions, patterns, selectors }) => {
      const classify = (text: string) =>
        patterns.flatMap(([kind, source]) =>
          [...text.matchAll(new RegExp(source, "g"))].map((match) => ({ kind, text: match[0] })),
        );
      const normalize = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
      const volatileData = new Set([
        "data-state",
        "data-highlighted",
        "data-disabled",
        "data-orientation",
        "data-side",
        "data-align",
      ]);
      const region = (element: Element) => {
        for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
          const testId = node.getAttribute("data-testid");
          if (testId) return `[data-testid=${JSON.stringify(testId)}]`;
          const ariaLabel = node.getAttribute("aria-label");
          if (ariaLabel) return `${node.tagName.toLowerCase()}[aria-label=${JSON.stringify(ariaLabel)}]`;
          const data = [...node.attributes]
            .map((attribute) => attribute.name)
            .filter((name) => name.startsWith("data-") && !volatileData.has(name))
            .sort()[0];
          if (data) return `[${data}=${JSON.stringify(node.getAttribute(data))}]`;
          if (node.tagName === "MAIN") return "main";
        }
        return "body";
      };
      const label = (element: Element) => {
        for (let node: Element | null = element, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
          if (node.tagName === "DD") {
            let term = node.previousElementSibling;
            while (term && term.tagName !== "DT") term = term.previousElementSibling;
            return term ? normalize(term.textContent) || null : null;
          }
          if (node instanceof HTMLTableCellElement) {
            const header = node.closest("table")?.tHead?.rows[0]?.cells[node.cellIndex];
            return header && header !== node ? normalize(header.textContent) || null : null;
          }
        }
        return null;
      };
      const elementPath = (element: Element) => {
        const parts: string[] = [];
        for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
          const siblings = [...(node.parentElement?.children ?? [])].filter((entry) => entry.tagName === node!.tagName);
          const tag = node.tagName.toLowerCase();
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        }
        return ["body", ...parts].join(" > ").slice(-300);
      };

      const excluded = [
        ...new Set(exclusions.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])),
      ];
      const styles = excluded.map((element) => element.getAttribute("style"));
      try {
        excluded.forEach((element) => element.style.setProperty("display", "none", "important"));
        const total = classify(document.body.innerText);
        const found: Array<{ element: Element; kind: string; text: string }> = [];
        // Each visited element attributes exactly its own matches, so the
        // attributed total always equals the page count. A child whose
        // innerText shows more than the parent renders (a closed select's
        // options, merged inline tokens) is not descended into.
        const visit = (element: HTMLElement, matches: Array<{ kind: string; text: string }>) => {
          const children: Array<[HTMLElement, Array<{ kind: string; text: string }>]> = [];
          for (const child of element.children) {
            if (!(child instanceof HTMLElement) || !child.checkVisibility({ visibilityProperty: true })) continue;
            const childMatches = classify(child.innerText);
            if (childMatches.length > 0) children.push([child, childMatches]);
          }
          const consumed = children.flatMap(([, childMatches]) => childMatches);
          const overdrawn = patterns.some(
            ([kind]) =>
              consumed.filter((match) => match.kind === kind).length >
              matches.filter((match) => match.kind === kind).length,
          );
          if (overdrawn) {
            for (const match of matches) found.push({ element, ...match });
            return;
          }
          for (const [child, childMatches] of children) visit(child, childMatches);
          for (const [kind] of patterns) {
            const own = matches.filter((match) => match.kind === kind);
            const residual = own.length - consumed.filter((match) => match.kind === kind).length;
            if (residual <= 0) continue;
            const remaining = [...own];
            for (const match of consumed.filter((entry) => entry.kind === kind)) {
              const index = remaining.findIndex((entry) => entry.text === match.text);
              if (index >= 0) remaining.splice(index, 1);
            }
            for (const match of [...remaining, ...own].slice(0, residual)) found.push({ element, ...match });
          }
        };
        visit(document.body, total);
        return {
          total: total.map((match) => match.kind),
          occurrences: found.map(({ element, kind, text }) => ({
            class: kind,
            text,
            region: region(element),
            label: label(element),
            path: elementPath(element),
            within: selectors.map((selector) => element.closest(selector) !== null),
          })),
        };
      } finally {
        excluded.forEach((element, index) => {
          const style = styles[index];
          // Reset CSSOM before removing an originally absent style attribute.
          element.setAttribute("style", style ?? "");
          if (style === null) element.removeAttribute("style");
        });
      }
    },
    {
      exclusions: [...renderedCopyExclusions, ...additionalExclusions],
      patterns: renderedCopyClasses.map((kind) => [kind, patternSources[kind]] as [string, string]),
      selectors: [...selectors],
    },
  );
  const counts = countClasses(result.total);
  const attributed = countClasses(result.occurrences.map((occurrence) => occurrence.class));
  for (const kind of renderedCopyClasses) {
    if (counts[kind] !== attributed[kind]) {
      throw new Error(
        `rendered copy ${kind}: attribution mismatch, page count ${counts[kind]} but ${attributed[kind]} attributed`,
      );
    }
  }
  return { counts, occurrences: result.occurrences as RenderedCopyOccurrence[] };
}

function countClasses(kinds: readonly string[]): RenderedCopyCounts {
  return Object.fromEntries(
    renderedCopyClasses.map((kind) => [kind, kinds.filter((entry) => entry === kind).length]),
  ) as Record<RenderedCopyClass, number>;
}

type OwnedRow = Pick<RenderedCopyBaselineRow, "selector" | "label" | "prefix" | "token" | "class">;

// Token rows match by containment, label and prefix; unanticipated rows match
// only their exact captured region and label. A second token match is a
// duplicate owner, never a silent choice.
function ownerOf(occurrence: RenderedCopyOccurrence, rows: readonly OwnedRow[], selectors: readonly string[]) {
  const candidates = rows.filter((row) => {
    if (row.class !== occurrence.class) return false;
    if (row.token === null) return false;
    if (!occurrence.within[selectors.indexOf(row.selector)]) return false;
    if (row.label !== null && row.label !== occurrence.label) return false;
    return row.prefix === null || occurrence.text.startsWith(row.prefix);
  });
  if (candidates.length > 1) return { error: "duplicate owners" as const, rows: candidates };
  if (candidates.length === 1) return { row: candidates[0] };
  const exact = rows.filter(
    (row) =>
      row.token === null &&
      row.class === occurrence.class &&
      row.selector === occurrence.region &&
      row.label === occurrence.label &&
      row.prefix === null,
  );
  return exact.length === 1 ? { row: exact[0] } : { row: undefined };
}

export function attributeRenderedCopy(
  pageKey: string,
  occurrences: readonly RenderedCopyOccurrence[],
  rules: readonly RenderedCopyOwnerRule[],
): { fields: RenderedCopyObservedField[]; violations: string[] } {
  const pageRules = rules.filter((rule) => rule.page === pageKey);
  const selectors = [...new Set(pageRules.map((rule) => rule.selector))];
  const fields = new Map<string, RenderedCopyObservedField & { count: number; samples: string[] }>();
  const violations: string[] = [];
  for (const occurrence of occurrences) {
    const owner = ownerOf(occurrence, pageRules, selectors);
    if ("error" in owner) {
      violations.push(
        `${pageKey} ${occurrence.class}: duplicate owners for ${JSON.stringify(occurrence.text)} at ${occurrence.path}`,
      );
      continue;
    }
    const rule = owner.row as RenderedCopyOwnerRule | undefined;
    const field: RenderedCopyField = rule
      ? {
          page: pageKey,
          class: rule.class,
          selector: rule.selector,
          label: rule.label,
          prefix: rule.prefix,
          token: rule.token,
        }
      : {
          page: pageKey,
          class: occurrence.class,
          selector: occurrence.region,
          label: occurrence.label,
          prefix: null,
          token: null,
        };
    const key = renderedCopyFieldKey(field);
    const entry = fields.get(key) ?? { ...field, issue: rule?.issue ?? null, count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 5 && !entry.samples.includes(occurrence.text)) entry.samples.push(occurrence.text);
    fields.set(key, entry);
  }
  return {
    fields: [...fields.values()].sort((left, right) =>
      ordinal(renderedCopyFieldKey(left), renderedCopyFieldKey(right)),
    ),
    violations,
  };
}

// Enforcement: every observed occurrence belongs to exactly one row and every
// row's count equals its maxCount. Stale-low rows are all named together.
export function compareRenderedCopy(
  pageKey: string,
  occurrences: readonly RenderedCopyOccurrence[],
  rows: readonly RenderedCopyBaselineRow[],
  selectors: readonly string[],
): string[] {
  const pageRows = rows.filter((row) => row.page === pageKey);
  const counts = new Map<RenderedCopyBaselineRow, { count: number; text: string }>();
  const violations: string[] = [];
  for (const occurrence of occurrences) {
    const owner = ownerOf(occurrence, pageRows, selectors);
    if ("error" in owner) {
      violations.push(`${pageKey} ${occurrence.class}: duplicate owners for ${JSON.stringify(occurrence.text)}`);
      continue;
    }
    if (!owner.row) {
      const classRows = pageRows.filter((row) => row.class === occurrence.class);
      violations.push(
        classRows.length === 0
          ? `${pageKey} ${occurrence.class}: unbaselined violation ${JSON.stringify(occurrence.text)} at ${occurrence.region}`
          : `${pageKey} ${occurrence.class}: violation ${JSON.stringify(occurrence.text)} outside selector ${classRows
              .map((row) => JSON.stringify(row.selector))
              .join(", ")} (region ${JSON.stringify(occurrence.region)}, label ${JSON.stringify(occurrence.label)})`,
      );
      continue;
    }
    const row = owner.row as RenderedCopyBaselineRow;
    const entry = counts.get(row) ?? { count: 0, text: occurrence.text };
    entry.count += 1;
    counts.set(row, entry);
  }
  const stale: string[] = [];
  for (const row of pageRows) {
    const observed = counts.get(row) ?? { count: 0, text: "" };
    if (observed.count > row.maxCount) {
      violations.push(
        `${pageKey} ${row.class}: count ${observed.count} above maxCount ${row.maxCount}; text ${JSON.stringify(observed.text)}; ${fieldName(row)} issue ${row.issue}`,
      );
    } else if (observed.count < row.maxCount) {
      stale.push(`${fieldName(row)} issue ${row.issue}: count ${observed.count} below maxCount ${row.maxCount}`);
    }
  }
  if (stale.length > 0) {
    violations.push(
      `${pageKey}: stale-low entries; the fix has landed, so lower or delete each:\n  ${stale.join("\n  ")}`,
    );
  }
  return violations;
}

const selectorsFor = (rows: readonly { selector: string; token: string | null }[]) => [
  ...new Set(rows.filter((row) => row.token !== null).map((row) => row.selector)),
];

export async function assertRenderedCopy(
  page: Page,
  pageKey: string,
  rows: readonly RenderedCopyBaselineRow[],
  drift?: string,
): Promise<void> {
  const baselineViolations = validateRenderedCopyBaseline({ schema: "rendered-copy-baseline/v1", rows });
  if (baselineViolations.length > 0) throw new Error(`${pageKey}: invalid baseline\n${baselineViolations.join("\n")}`);
  const pageRows = rows.filter((row) => row.page === pageKey);
  const selectors = selectorsFor(pageRows);
  const { occurrences } = await readRenderedCopyOccurrences(page, selectors);
  const violations = compareRenderedCopy(pageKey, occurrences, pageRows, selectors);
  if (violations.length > 0) throw new Error([...violations, ...(drift ? [drift] : [])].join("\n"));
}

// ---------------------------------------------------------------------------
// Collect or enforce: the sweep entry point.

export type RenderedCopyObservation = Readonly<{
  schema: "rendered-copy-observation/v1";
  tuple: RenderedCopyTuple;
  retry: number;
  durationMs: number;
  witness: string;
  counts: RenderedCopyCounts;
  fields: readonly RenderedCopyObservedField[];
}>;

function readJson(relativePath: string, root = repoRoot): unknown {
  const file = path.join(root, relativePath);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

export function renderedCopyCollectEnabled(root = repoRoot): boolean {
  const toggle = readJson(renderedCopyFiles.collect, root);
  if (toggle === undefined) return false;
  const violations = validateRenderedCopyToggle(toggle);
  if (violations.length > 0) throw new Error(violations.join("\n"));
  return true;
}

export async function sweepRenderedCopy(
  page: Page,
  tuple: RenderedCopyTuple,
  context: { retry: number; startedAt: number; witness: string },
): Promise<void> {
  if (renderedCopyCollectEnabled()) {
    const pageRules = renderedCopyOwnerRules.filter((rule) => rule.page === tuple.page);
    const { counts, occurrences } = await readRenderedCopyOccurrences(page, selectorsFor(pageRules));
    const { fields, violations } = attributeRenderedCopy(tuple.page, occurrences, renderedCopyOwnerRules);
    if (violations.length > 0) throw new Error(violations.join("\n"));
    const observation: RenderedCopyObservation = {
      schema: "rendered-copy-observation/v1",
      tuple,
      retry: context.retry,
      durationMs: Math.max(1, Date.now() - context.startedAt),
      witness: context.witness,
      counts,
      fields,
    };
    const directory = path.join(repoRoot, renderedCopyObservationDirectory);
    mkdirSync(directory, { recursive: true });
    const name = `${tuple.deployable}--${tuple.persona}--${createHash("sha256").update(tuple.page).digest("hex").slice(0, 16)}--retry${context.retry}.json`;
    const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(observation)}\n`);
    renameSync(temporary, path.join(directory, name));
    console.log(
      `RENDERED_COPY_CAPTURE ${JSON.stringify({ key: renderedCopyTupleKey(tuple), retry: context.retry, counts })}`,
    );
    return;
  }
  const baseline = readJson(renderedCopyFiles.baseline) as RenderedCopyBaseline | undefined;
  const baselineViolations = validateRenderedCopyBaseline(baseline);
  if (baselineViolations.length > 0) throw new Error(baselineViolations.join("\n"));
  const record = readJson(renderedCopyFiles.capture) as { base?: { commit?: string } } | undefined;
  const drift = record?.base?.commit
    ? `Baseline was captured at ${record.base.commit}. If this head has no product diff against main, the drift came from ${record.base.commit}..main: the record is INVALIDATED and returns to PROPOSED at a new base.`
    : "No capture record is committed: only an authorized capture may introduce baseline rows.";
  await assertRenderedCopy(page, tuple.page, baseline!.rows, drift);
}

// ---------------------------------------------------------------------------
// Witnesses: a page is swept only after its owning seeded state has rendered.

export type RenderedCopyWitness =
  | Readonly<{ kind: "populated"; selector: string; text: string }>
  | Readonly<{ kind: "sell-list-empty" }>
  | Readonly<{ kind: "reference-lookup-form" }>;

export async function expectRenderedCopyWitness(
  page: Page,
  pageKey: string,
  witness: RenderedCopyWitness,
  options: { timeout?: number; root?: string } = {},
): Promise<void> {
  // Loaded lazily so the pure validators stay importable outside the runner.
  const { expect } = await import("@playwright/test");
  const check = expect.configure({ timeout: options.timeout });
  const label = `${pageKey}: required ${witness.kind} witness`;
  const root = page.locator(options.root ?? "main").first();
  await check(root, label).toBeVisible();
  await check(
    page.getByRole("heading", {
      name: /^(?:Admin Error|Marketplace error|Application error|Unexpected application error!?|.*not found|.*unavailable|.*access required|Loading.*)$/i,
    }),
    `${pageKey}: error/loading/access state`,
  ).toHaveCount(0);
  await check(
    root.locator('[aria-busy="true"], [role="progressbar"], [role="status"][aria-label*="loading" i]'),
    `${pageKey}: unsettled content`,
  ).toHaveCount(0);
  if (witness.kind === "populated") {
    const component = root.locator(witness.selector);
    await check(component.first(), label).toBeVisible();
    await check(component.getByText(witness.text, { exact: true }).first(), label).toBeVisible();
    return;
  }
  if (witness.kind === "reference-lookup-form") {
    const form = root.locator('form:has(input[name="reference"])');
    await check(form, label).toHaveCount(1);
    await check(form.locator('input[name="reference"]'), label).toBeVisible();
    await check(form.locator('input[name="reference"]'), label).toHaveValue("");
    await check(form.locator('button[type="submit"]'), label).toBeVisible();
    await check(form.locator('button[type="submit"]'), label).toBeEnabled();
    return;
  }
  // The seeded demo seller has no Sell List lines; the owning empty state is
  // one section with its title, description and Browse products link.
  const empty = root.locator("section").filter({
    has: page.getByRole("heading", { name: "Your Sell List is empty", exact: true }),
  });
  await check(empty, label).toHaveCount(1);
  await check(empty.getByRole("heading", { name: "Your Sell List is empty", exact: true }), label).toBeVisible();
  await check(
    empty.getByText("Add selected offers or products from item pages before reviewing seller checkout.", {
      exact: true,
    }),
    label,
  ).toBeVisible();
  const browse = empty.getByRole("link", { name: "Browse products", exact: true });
  await check(browse, label).toBeVisible();
  await check(browse, label).toHaveAttribute("href", "/search");
  await check(
    root.getByText(
      /^(?:Updating Sell List|Refreshing Sell List|Your Sell List is catching up|Sell List line not visible yet|Sell List issue)$/,
    ),
    `${pageKey}: recovery is not seeded empty state`,
  ).toHaveCount(0);
  await check(
    root.locator('aside[aria-label="Sale checkout summary"], table tbody tr, [role="row"], input[name="lineId"]'),
    `${pageKey}: unexpected populated state`,
  ).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Capture parts (one per eligible owning batch) and the committed record.

export type RenderedCopyListingGroup = Readonly<{ path: string; blob: string; tests: number }>;
export type RenderedCopyIdentity = Readonly<{
  checkout: Readonly<{ commit: string; tree: string; parents: readonly string[] }>;
  base: Readonly<{ commit: string; tree: string }>;
  head: Readonly<{ commit: string; tree: string }>;
  diff: readonly string[];
  tools: readonly Readonly<{ path: string; blob: string }>[];
}>;
export type RenderedCopyPartTuple = RenderedCopyTuple &
  Readonly<{ retry: number; durationMs: number; position: number; witness: string; counts: RenderedCopyCounts }>;
export type RenderedCopyPart = RenderedCopyIdentity &
  Readonly<{
    schema: "rendered-copy-capture-part/v1";
    run: Readonly<{
      workflow: string;
      event: string;
      id: number;
      attempt: number;
      jobIndex: number;
      batch: string;
      capturedAt: string;
    }>;
    listing: readonly RenderedCopyListingGroup[];
    tuples: readonly RenderedCopyPartTuple[];
    fields: readonly RenderedCopyObservedField[];
  }>;
export type RenderedCopyBatch = Readonly<{
  batch: string;
  jobIndex: number;
  eligibility: "owning" | "nonowning" | "scope-skipped";
  attempt: number | null;
  checkout: string | null;
  artifact: Readonly<{ name: string; sha256: string; bytes: number }> | null;
  listing: readonly RenderedCopyListingGroup[];
}>;
export type RenderedCopyCapture = RenderedCopyIdentity &
  Readonly<{
    schema: "rendered-copy-capture/v1";
    run: Readonly<{ workflow: string; event: string; id: number; attempt: number; capturedAt: string }>;
    batches: readonly RenderedCopyBatch[];
    tuples: readonly (RenderedCopyPartTuple & Readonly<{ batch: string; jobIndex: number }>)[];
    fields: readonly RenderedCopyObservedField[];
    baseAbsent: readonly Readonly<{ token: string; page: string; class: RenderedCopyClass; issue: number }>[];
  }>;

const batchSuites = (batch: string) => batch.split(",").filter(Boolean);
export const renderedCopyOwningBatch = (batch: string) =>
  batchSuites(batch).some((suite) => renderedCopyTuples.some((tuple) => tuple.suite === suite));

// Observation files from every attempt; the highest Playwright retry of each
// tuple is authoritative and earlier attempts never add counts.
export function finalRenderedCopyObservations(observations: readonly RenderedCopyObservation[]) {
  const final = new Map<string, RenderedCopyObservation>();
  for (const observation of observations) {
    const key = renderedCopyTupleKey(observation.tuple);
    const current = final.get(key);
    if (current && current.retry === observation.retry)
      throw new Error(`${key}: duplicate observation for retry ${observation.retry}`);
    if (!current || observation.retry > current.retry) final.set(key, observation);
  }
  return final;
}

export function readRenderedCopyObservations(root = repoRoot): RenderedCopyObservation[] {
  const directory = path.join(root, renderedCopyObservationDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as RenderedCopyObservation);
}

function checkIdentity(value: JsonObject, where: string, violations: string[]) {
  if (closedKeys(value.checkout, `${where}.checkout`, ["commit", "tree", "parents"], violations)) {
    const checkout = value.checkout;
    if (!shaPattern.test(String(checkout.commit))) violations.push(`${where}.checkout.commit: invalid`);
    if (!shaPattern.test(String(checkout.tree))) violations.push(`${where}.checkout.tree: invalid`);
    if (!Array.isArray(checkout.parents) || checkout.parents.some((parent) => !shaPattern.test(String(parent)))) {
      violations.push(`${where}.checkout.parents: invalid`);
    }
  }
  for (const side of ["base", "head"] as const) {
    if (!closedKeys(value[side], `${where}.${side}`, ["commit", "tree"], violations)) continue;
    const entry = value[side] as JsonObject;
    if (!shaPattern.test(String(entry.commit))) violations.push(`${where}.${side}.commit: invalid`);
    if (!shaPattern.test(String(entry.tree))) violations.push(`${where}.${side}.tree: invalid`);
  }
  const checkout = isObject(value.checkout) ? value.checkout : {};
  const parents = Array.isArray(checkout.parents) ? checkout.parents : [];
  const base = isObject(value.base) ? value.base.commit : undefined;
  const head = isObject(value.head) ? value.head.commit : undefined;
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    violations.push(
      `${where}.checkout.parents: must be [B, PR head] = [${base}, ${head}], got ${JSON.stringify(parents)}`,
    );
  }
  if (!Array.isArray(value.diff) || value.diff.some((file) => typeof file !== "string")) {
    violations.push(`${where}.diff: must list changed paths`);
  } else {
    const diff = value.diff as string[];
    if (JSON.stringify(diff) !== JSON.stringify([...new Set(diff)].sort()))
      violations.push(`${where}.diff: must be sorted and unique`);
    const product = diff.filter((file) => !renderedCopyGuardFootprint.includes(file));
    if (product.length > 0)
      violations.push(`${where}.diff: product diff outside the guard footprint: ${product.join(", ")}`);
  }
  if (!Array.isArray(value.tools)) {
    violations.push(`${where}.tools: must list tool blobs`);
  } else {
    value.tools.forEach((tool, index) => {
      if (!closedKeys(tool, `${where}.tools[${index}]`, ["path", "blob"], violations)) return;
      if (!shaPattern.test(String(tool.blob))) violations.push(`${where}.tools[${index}].blob: invalid`);
    });
    const paths = value.tools.map((tool) => (isObject(tool) ? tool.path : null));
    if (JSON.stringify(paths) !== JSON.stringify(renderedCopyToolPaths)) {
      violations.push(`${where}.tools: must bind exactly ${renderedCopyToolPaths.join(", ")}`);
    }
  }
}

// A batch declares tests in deployable specs and in bounded-context browser
// suites alike, so a predecessor is any repo-relative POSIX TypeScript path;
// its blob, not its location, binds the bytes that ran.
function isRepoRelativeTypeScriptPath(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.endsWith(".ts") &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\"))
  );
}

function checkListing(value: unknown, where: string, violations: string[]): RenderedCopyListingGroup[] {
  if (!Array.isArray(value) || value.length > 2_000) {
    violations.push(`${where}: must be an ordered list of at most 2000 spec groups`);
    return [];
  }
  value.forEach((group, index) => {
    if (!closedKeys(group, `${where}[${index}]`, ["path", "blob", "tests"], violations)) return;
    if (!isRepoRelativeTypeScriptPath(group.path)) violations.push(`${where}[${index}].path: invalid`);
    if (!shaPattern.test(String(group.blob))) violations.push(`${where}[${index}].blob: missing predecessor blob`);
    if (!boundedInt(group.tests, 1, 5_000)) violations.push(`${where}[${index}].tests: invalid`);
  });
  return value as RenderedCopyListingGroup[];
}

// The group that contains a tuple's listed position must be its sweep spec;
// a dropped or reordered predecessor moves the tuple out of that group.
function checkPositions(
  listing: readonly RenderedCopyListingGroup[],
  tuples: readonly { deployable: RenderedCopyDeployable; position: number; page: string }[],
  where: string,
  violations: string[],
) {
  for (const tuple of tuples) {
    let offset = 0;
    const group = listing.find((entry) => {
      const contains = tuple.position >= offset && tuple.position < offset + entry.tests;
      offset += entry.tests;
      return contains;
    });
    if (group?.path !== renderedCopySweepSpecs[tuple.deployable]) {
      violations.push(
        `${where}: ${tuple.page} position ${tuple.position} is not inside its sweep spec; a predecessor is missing or reordered`,
      );
    }
  }
}

function checkCounts(value: unknown, where: string, violations: string[]) {
  if (!closedKeys(value, where, renderedCopyClasses, violations)) return;
  for (const kind of renderedCopyClasses) {
    if (!boundedInt(value[kind], 0, 100_000)) violations.push(`${where}.${kind}: out of range`);
  }
}

const tupleKeys = [
  "deployable",
  "persona",
  "page",
  "suite",
  "tag",
  "retry",
  "durationMs",
  "position",
  "witness",
  "counts",
] as const;

function checkTuple(value: unknown, where: string, keys: readonly string[], violations: string[]) {
  if (!closedKeys(value, where, keys, violations)) return;
  const census = renderedCopyTuples.find(
    (tuple) => renderedCopyTupleKey(tuple) === renderedCopyTupleKey(value as unknown as RenderedCopyTuple),
  );
  if (!census || census.suite !== value.suite || census.tag !== value.tag)
    violations.push(`${where}: not a census tuple`);
  if (!boundedInt(value.retry, 0, 2)) violations.push(`${where}.retry: out of range`);
  if (!boundedInt(value.durationMs, 1, maxTupleDurationMs - 1))
    violations.push(`${where}.durationMs: must be under 25 minutes`);
  if (!boundedInt(value.position, 0, 100_000)) violations.push(`${where}.position: out of range`);
  if (!["populated", "sell-list-empty", "reference-lookup-form"].includes(String(value.witness))) {
    violations.push(`${where}.witness: unknown witness`);
  }
  checkCounts(value.counts, `${where}.counts`, violations);
}

function checkFields(value: unknown, where: string, violations: string[]) {
  if (!Array.isArray(value) || value.length > 1_000) {
    violations.push(`${where}: must be an array of at most 1000 fields`);
    return;
  }
  value.forEach((field, index) => {
    const at = `${where}[${index}]`;
    if (
      !closedKeys(
        field,
        at,
        ["page", "class", "selector", "label", "prefix", "token", "issue", "count", "samples"],
        violations,
      )
    )
      return;
    checkFieldShape(field, at, violations);
    if (field.token === null ? field.issue !== null : !boundedInt(field.issue, 1, 1_000_000)) {
      violations.push(`${at}.issue: a token field cites its owner issue; an unanticipated field cites none`);
    }
    if (!boundedInt(field.count, 1, 100_000)) violations.push(`${at}.count: out of range`);
    const samples = field.samples;
    if (
      !Array.isArray(samples) ||
      samples.length < 1 ||
      samples.length > 5 ||
      samples.some(
        (sample) =>
          !isClass(field.class) || classifyRenderedCopy(String(sample)).every((match) => match.class !== field.class),
      )
    ) {
      violations.push(`${at}.samples: must hold one to five witnessed ${String(field.class)} values`);
    }
  });
}

export function validateCapturePart(value: unknown): string[] {
  const violations: string[] = [];
  const keys = ["schema", "run", "checkout", "base", "head", "diff", "tools", "listing", "tuples", "fields"];
  if (!closedKeys(value, "part", keys, violations)) return violations;
  if (value.schema !== "rendered-copy-capture-part/v1") violations.push("part.schema: unsupported");
  if (
    closedKeys(
      value.run,
      "part.run",
      ["workflow", "event", "id", "attempt", "jobIndex", "batch", "capturedAt"],
      violations,
    )
  ) {
    const run = value.run;
    if (run.workflow !== "platform-pr.yml") violations.push("part.run.workflow: must be platform-pr.yml");
    if (run.event !== "pull_request") violations.push("part.run.event: capture runs on pull_request only");
    if (!boundedInt(run.id, 1, Number.MAX_SAFE_INTEGER)) violations.push("part.run.id: invalid");
    if (!boundedInt(run.attempt, 1, 100)) violations.push("part.run.attempt: invalid");
    if (!boundedInt(run.jobIndex, 0, 255)) violations.push("part.run.jobIndex: invalid");
    if (!isInstant(run.capturedAt)) violations.push("part.run.capturedAt: must be a timezone-bearing instant");
    if (typeof run.batch !== "string" || !renderedCopyOwningBatch(run.batch))
      violations.push("part.run.batch: not an owning batch");
  }
  checkIdentity(value, "part", violations);
  const listing = checkListing(value.listing, "part.listing", violations);
  if (!Array.isArray(value.tuples)) {
    violations.push("part.tuples: must be an array");
    return violations;
  }
  value.tuples.forEach((tuple, index) => checkTuple(tuple, `part.tuples[${index}]`, tupleKeys, violations));
  const batch = isObject(value.run) ? String(value.run.batch) : "";
  const expected = renderedCopyTuples
    .filter((tuple) => batchSuites(batch).includes(tuple.suite))
    .map(renderedCopyTupleKey)
    .sort();
  const observed = value.tuples.map((tuple) => renderedCopyTupleKey(tuple as unknown as RenderedCopyTuple)).sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    violations.push(
      `part.tuples: batch ${batch} must cover each owned tuple exactly once; expected ${expected.length}, observed ${observed.length}`,
    );
  }
  checkPositions(listing, value.tuples as unknown as RenderedCopyPartTuple[], "part.listing", violations);
  checkFields(value.fields, "part.fields", violations);
  if (violations.length === 0) {
    violations.push(
      ...validateOwnerMap({
        fields: value.fields as unknown as RenderedCopyObservedField[],
        tuples: value.tuples as unknown as RenderedCopyPartTuple[],
      }),
    );
  }
  return violations;
}

export function buildCapturePart(input: {
  run: RenderedCopyPart["run"];
  identity: RenderedCopyIdentity;
  listing: readonly RenderedCopyListingGroup[];
  positions: ReadonlyMap<string, number>;
  observations: readonly RenderedCopyObservation[];
}): RenderedCopyPart {
  const final = finalRenderedCopyObservations(input.observations);
  const owned = renderedCopyTuples.filter((tuple) => batchSuites(input.run.batch).includes(tuple.suite));
  const missing = owned.filter((tuple) => !final.has(renderedCopyTupleKey(tuple)));
  if (missing.length > 0) {
    throw new Error(
      `rendered-copy capture: eligible tuples missing a final observation: ${missing.map(renderedCopyTupleKey).join(", ")}`,
    );
  }
  const tuples = owned.map((tuple) => {
    const observation = final.get(renderedCopyTupleKey(tuple))!;
    const position = input.positions.get(renderedCopyTupleKey(tuple));
    if (position === undefined)
      throw new Error(`rendered-copy capture: ${renderedCopyTupleKey(tuple)} is not in the batch listing`);
    return {
      ...tuple,
      retry: observation.retry,
      durationMs: observation.durationMs,
      position,
      witness: observation.witness,
      counts: observation.counts,
    };
  });
  const fields = owned
    .flatMap((tuple) => final.get(renderedCopyTupleKey(tuple))!.fields)
    .sort((left, right) => ordinal(renderedCopyFieldKey(left), renderedCopyFieldKey(right)));
  return {
    schema: "rendered-copy-capture-part/v1",
    run: input.run,
    ...input.identity,
    listing: input.listing,
    tuples,
    fields,
  };
}

// The integrating lane assembles the record from one run/attempt/checkout:
// every eligible owning batch's validated part plus each part's digest.
export function assembleCaptureRecord(input: {
  parts: readonly RenderedCopyPart[];
  artifacts: ReadonlyMap<number, Readonly<{ name: string; sha256: string; bytes: number }>>;
  batches: readonly Readonly<{ batch: string; jobIndex: number; eligibility?: "scope-skipped" }>[];
}): RenderedCopyCapture {
  const [first] = input.parts;
  if (!first) throw new Error("rendered-copy capture: no parts");
  for (const part of input.parts) {
    const violations = validateCapturePart(part);
    if (violations.length > 0) throw new Error(violations.join("\n"));
    if (part.run.id !== first.run.id || part.run.attempt !== first.run.attempt) {
      throw new Error("rendered-copy capture: parts mix runs or attempts");
    }
    if (part.checkout.commit !== first.checkout.commit) throw new Error("rendered-copy capture: parts mix checkouts");
  }
  const partByJob = new Map(input.parts.map((part) => [part.run.jobIndex, part]));
  const batches: RenderedCopyBatch[] = [...input.batches]
    .sort((left, right) => left.jobIndex - right.jobIndex)
    .map(({ batch, jobIndex, eligibility }) => {
      const part = partByJob.get(jobIndex);
      if (eligibility === "scope-skipped" || !renderedCopyOwningBatch(batch)) {
        return {
          batch,
          jobIndex,
          eligibility: eligibility ?? "nonowning",
          attempt: null,
          checkout: null,
          artifact: null,
          listing: [],
        };
      }
      return {
        batch,
        jobIndex,
        eligibility: "owning",
        attempt: part?.run.attempt ?? null,
        checkout: part?.checkout.commit ?? null,
        artifact: input.artifacts.get(jobIndex) ?? null,
        listing: part?.listing ?? [],
      };
    });
  const owned = new Set(renderedCopyRulesKeys(renderedCopyOwnerRules));
  const fields = input.parts
    .flatMap((part) => part.fields)
    .sort((left, right) => ordinal(renderedCopyFieldKey(left), renderedCopyFieldKey(right)));
  for (const field of fields) owned.delete(JSON.stringify([field.token, field.page, field.class, field.issue]));
  return {
    schema: "rendered-copy-capture/v1",
    run: {
      workflow: first.run.workflow,
      event: first.run.event,
      id: first.run.id,
      attempt: first.run.attempt,
      capturedAt: first.run.capturedAt,
    },
    checkout: first.checkout,
    base: first.base,
    head: first.head,
    diff: first.diff,
    tools: first.tools,
    batches,
    tuples: input.parts
      .flatMap((part) => part.tuples.map((tuple) => ({ ...tuple, batch: part.run.batch, jobIndex: part.run.jobIndex })))
      .sort((left, right) => ordinal(renderedCopyTupleKey(left), renderedCopyTupleKey(right))),
    fields,
    baseAbsent: [...owned].map((key) => {
      const [token, page, kind, issue] = JSON.parse(key) as [string, string, RenderedCopyClass, number];
      return { token, page, class: kind, issue };
    }),
  };
}

const renderedCopyRulesKeys = (rules: readonly RenderedCopyOwnerRule[]) =>
  rules.map((rule) => JSON.stringify([rule.token, rule.page, rule.class, rule.issue]));

// Each field has one owner (or is unanticipated), each (page, class, issue) is
// unique, and the fields of a page/class sum to the tuple's observed count.
export function validateOwnerMap(input: {
  fields: readonly RenderedCopyObservedField[];
  tuples: readonly Readonly<{ page: string; counts: RenderedCopyCounts }>[];
  baseline?: readonly RenderedCopyBaselineRow[];
}): string[] {
  const violations: string[] = [];
  const fieldKeys = new Set<string>();
  const ownerKeys = new Set<string>();
  for (const field of input.fields) {
    const key = renderedCopyFieldKey(field);
    if (fieldKeys.has(key)) violations.push(`owner map: duplicate field ${fieldName(field)}`);
    fieldKeys.add(key);
    if (field.issue !== null) {
      const ownerKey = JSON.stringify([field.page, field.class, field.issue]);
      if (ownerKeys.has(ownerKey)) violations.push(`owner map: duplicate owner ${ownerKey}`);
      ownerKeys.add(ownerKey);
    }
  }
  for (const tuple of input.tuples) {
    for (const kind of renderedCopyClasses) {
      const sum = input.fields
        .filter((field) => field.page === tuple.page && field.class === kind)
        .reduce((total, field) => total + field.count, 0);
      if (sum !== tuple.counts[kind]) {
        violations.push(
          `owner map: ${tuple.page} ${kind} fields sum to ${sum} but ${tuple.counts[kind]} were observed`,
        );
      }
    }
  }
  const pages = new Set(input.tuples.map((tuple) => tuple.page));
  for (const field of input.fields)
    if (!pages.has(field.page)) violations.push(`owner map: ${fieldName(field)} has no tuple`);
  if (input.baseline) {
    for (const field of input.fields.filter((entry) => entry.issue === null)) {
      if (!input.baseline.some((row) => renderedCopyFieldKey(row) === renderedCopyFieldKey(field))) {
        violations.push(
          `owner map: unanticipated ${fieldName(field)} requires a filed fixed-scope gap cited by the baseline before INTEGRATED`,
        );
      }
    }
  }
  return violations;
}

export function validateCaptureRecord(value: unknown): string[] {
  const violations: string[] = [];
  const keys = [
    "schema",
    "run",
    "checkout",
    "base",
    "head",
    "diff",
    "tools",
    "batches",
    "tuples",
    "fields",
    "baseAbsent",
  ];
  if (!closedKeys(value, "capture", keys, violations)) return violations;
  if (value.schema !== "rendered-copy-capture/v1") violations.push("capture.schema: unsupported");
  let runId = 0;
  let attempt = 0;
  if (closedKeys(value.run, "capture.run", ["workflow", "event", "id", "attempt", "capturedAt"], violations)) {
    const run = value.run;
    if (run.workflow !== "platform-pr.yml") violations.push("capture.run.workflow: must be platform-pr.yml");
    if (run.event !== "pull_request") violations.push("capture.run.event: capture runs on pull_request only");
    if (!boundedInt(run.id, 1, Number.MAX_SAFE_INTEGER)) violations.push("capture.run.id: invalid");
    if (!boundedInt(run.attempt, 1, 100)) violations.push("capture.run.attempt: invalid");
    if (!isInstant(run.capturedAt)) violations.push("capture.run.capturedAt: must be a timezone-bearing instant");
    runId = Number(run.id);
    attempt = Number(run.attempt);
  }
  checkIdentity(value, "capture", violations);
  const checkout = isObject(value.checkout) ? value.checkout.commit : undefined;
  if (!Array.isArray(value.batches) || value.batches.length === 0 || value.batches.length > 64) {
    violations.push("capture.batches: must list every batch of the run");
    return violations;
  }
  const batches = new Map<string, RenderedCopyBatch>();
  const jobIndexes = new Set<number>();
  value.batches.forEach((batch, index) => {
    const where = `capture.batches[${index}]`;
    if (
      !closedKeys(
        batch,
        where,
        ["batch", "jobIndex", "eligibility", "attempt", "checkout", "artifact", "listing"],
        violations,
      )
    )
      return;
    if (typeof batch.batch !== "string" || batches.has(batch.batch))
      violations.push(`${where}.batch: invalid or duplicate`);
    if (!boundedInt(batch.jobIndex, 0, 255) || jobIndexes.has(Number(batch.jobIndex)))
      violations.push(`${where}.jobIndex: invalid or duplicate`);
    jobIndexes.add(Number(batch.jobIndex));
    const owning = renderedCopyOwningBatch(String(batch.batch));
    if (batch.eligibility === "owning") {
      if (!owning) violations.push(`${where}: a nonowning batch cannot be eligible`);
      if (batch.attempt !== attempt)
        violations.push(`${where}.attempt: mixed attempts (${batch.attempt} vs ${attempt})`);
      if (batch.checkout !== checkout) violations.push(`${where}.checkout: mixed checkouts`);
      const expectedName = renderedCopyCaptureArtifactName(runId, attempt, Number(batch.jobIndex));
      if (!closedKeys(batch.artifact, `${where}.artifact`, ["name", "sha256", "bytes"], violations)) {
        violations.push(`${where}: eligible owning batch is missing its capture artifact`);
      } else {
        const artifact = batch.artifact;
        if (artifact.name !== expectedName) {
          violations.push(
            `${where}.artifact.name: ${JSON.stringify(artifact.name)} is not the capture artifact ${expectedName}; diagnostics cannot substitute`,
          );
        }
        if (!sha256Pattern.test(String(artifact.sha256))) violations.push(`${where}.artifact.sha256: missing digest`);
        if (!boundedInt(artifact.bytes, 2, 10_000_000)) violations.push(`${where}.artifact.bytes: out of range`);
      }
      if (checkListing(batch.listing, `${where}.listing`, violations).length === 0)
        violations.push(`${where}.listing: missing predecessors`);
    } else if (batch.eligibility === "nonowning" || batch.eligibility === "scope-skipped") {
      if (batch.eligibility === "nonowning" && owning)
        violations.push(`${where}: an owning batch is eligible, not nonowning`);
      if (
        batch.attempt !== null ||
        batch.checkout !== null ||
        batch.artifact !== null ||
        !Array.isArray(batch.listing) ||
        batch.listing.length > 0
      ) {
        violations.push(`${where}: an ineligible batch carries no attempt, checkout, artifact or listing`);
      }
    } else {
      violations.push(`${where}.eligibility: unknown`);
    }
    batches.set(String(batch.batch), batch as unknown as RenderedCopyBatch);
  });
  const owningBatches = [...batches.values()].filter((batch) => batch.eligibility === "owning");
  for (const suite of new Set(renderedCopyTuples.map((tuple) => tuple.suite))) {
    if (!owningBatches.some((batch) => batchSuites(batch.batch).includes(suite))) {
      violations.push(`capture.batches: suite ${suite} has no eligible owning batch`);
    }
  }
  if (!Array.isArray(value.tuples)) {
    violations.push("capture.tuples: must be an array");
    return violations;
  }
  value.tuples.forEach((tuple, index) =>
    checkTuple(tuple, `capture.tuples[${index}]`, [...tupleKeys, "batch", "jobIndex"], violations),
  );
  const observed = value.tuples.map((tuple) => renderedCopyTupleKey(tuple as unknown as RenderedCopyTuple));
  const expected = renderedCopyTuples.map(renderedCopyTupleKey);
  const duplicates = observed.filter((key, index) => observed.indexOf(key) !== index);
  const missing = expected.filter((key) => !observed.includes(key));
  if (duplicates.length > 0)
    violations.push(`capture.tuples: retried tuples must count once: ${duplicates.join(", ")}`);
  if (missing.length > 0) violations.push(`capture.tuples: incomplete census, missing ${missing.join(", ")}`);
  for (const tuple of value.tuples.filter(isObject)) {
    const batch = batches.get(String(tuple.batch));
    if (
      !batch ||
      batch.eligibility !== "owning" ||
      batch.jobIndex !== tuple.jobIndex ||
      !batchSuites(batch.batch).includes(String(tuple.suite))
    ) {
      violations.push(`capture.tuples: ${String(tuple.page)} is not bound to its eligible owning batch`);
    }
  }
  for (const batch of owningBatches) {
    const tuples = value.tuples.filter(
      (tuple) => isObject(tuple) && tuple.batch === batch.batch,
    ) as unknown as RenderedCopyPartTuple[];
    if (Array.isArray(batch.listing))
      checkPositions(batch.listing, tuples, `capture.batches[${batch.batch}].listing`, violations);
  }
  checkFields(value.fields, "capture.fields", violations);
  if (!Array.isArray(value.baseAbsent)) {
    violations.push("capture.baseAbsent: must be an array");
  } else {
    value.baseAbsent.forEach((entry, index) => {
      const where = `capture.baseAbsent[${index}]`;
      if (!closedKeys(entry, where, ["token", "page", "class", "issue"], violations)) return;
      if (!tokenPattern.test(String(entry.token))) violations.push(`${where}.token: invalid`);
      if (!isClass(entry.class) || !boundedInt(entry.issue, 1, 1_000_000)) violations.push(`${where}: invalid owner`);
      const present =
        Array.isArray(value.fields) &&
        value.fields.some(
          (field) =>
            isObject(field) &&
            field.token === entry.token &&
            field.page === entry.page &&
            field.class === entry.class &&
            field.issue === entry.issue,
        );
      if (present) violations.push(`${where}: a base-absent owner cannot also own a captured field`);
    });
  }
  if (violations.length === 0) {
    violations.push(
      ...validateOwnerMap({
        fields: value.fields as unknown as RenderedCopyObservedField[],
        tuples: value.tuples as unknown as RenderedCopyPartTuple[],
      }),
    );
  }
  return violations;
}

// Baseline values come only from the base-captured record: no row may exceed
// its captured count or name a key the capture never observed, and a steady
// state baseline may only lower or delete rows of the frozen baseline.
export function rejectCandidateDerivedBaseline(input: {
  baseline: RenderedCopyBaseline;
  record: RenderedCopyCapture;
  frozenBaseline?: RenderedCopyBaseline | null;
}): string[] {
  const violations: string[] = [];
  const fields = new Map(input.record.fields.map((field) => [renderedCopyFieldKey(field), field]));
  const frozen = input.frozenBaseline
    ? new Map(input.frozenBaseline.rows.map((row) => [renderedCopyFieldKey(row), row]))
    : null;
  for (const row of input.baseline.rows) {
    const key = renderedCopyFieldKey(row);
    const field = fields.get(key);
    if (!field) {
      violations.push(`baseline: new key ${fieldName(row)} without an authorized capture`);
      continue;
    }
    if (row.maxCount > field.count) {
      violations.push(
        `baseline: ${fieldName(row)} maxCount ${row.maxCount} increases above captured count ${field.count}`,
      );
    }
    if (field.issue !== null && row.issue !== field.issue) {
      violations.push(`baseline: ${fieldName(row)} cites issue ${row.issue} but its captured owner is ${field.issue}`);
    }
    if (frozen) {
      const previous = frozen.get(key);
      if (!previous) violations.push(`baseline: new key ${fieldName(row)} without an authorized capture`);
      else if (row.maxCount > previous.maxCount) {
        violations.push(
          `baseline: ${fieldName(row)} increases from ${previous.maxCount} to ${row.maxCount} without an authorized capture`,
        );
      }
    }
  }
  return violations;
}

export function baselineEqualsRecord(baseline: RenderedCopyBaseline, record: RenderedCopyCapture): string[] {
  const violations: string[] = [];
  const rows = new Map(baseline.rows.map((row) => [renderedCopyFieldKey(row), row]));
  for (const field of record.fields) {
    const row = rows.get(renderedCopyFieldKey(field));
    if (!row) violations.push(`INTEGRATED: baseline is missing captured ${fieldName(field)}`);
    else if (row.maxCount !== field.count) {
      violations.push(
        `INTEGRATED: ${fieldName(field)} maxCount ${row.maxCount} must equal captured count ${field.count}`,
      );
    }
  }
  if (baseline.rows.length !== record.fields.length)
    violations.push("INTEGRATED: baseline rows must equal the record's fields");
  return violations;
}

// ---------------------------------------------------------------------------
// Lifecycle over committed files. Pure: git facts come through `repo`.

export type RenderedCopyRepo = Readonly<{
  head: string;
  objectType(sha: string): string | null;
  treeOf(commit: string): string | null;
  blobAt(commit: string, file: string): string | null;
  isAncestor(ancestor: string, descendant: string): boolean;
  diffNames(base: string, head: string): string[] | null;
}>;
export type RenderedCopyCommitted = Readonly<{ toggle?: unknown; baseline?: unknown; record?: unknown }>;
export type RenderedCopyState = "ABSENT" | "PROPOSED" | "INTEGRATED" | "LANDED" | "STEADY_STATE";

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const emptyBaseline: RenderedCopyBaseline = { schema: "rendered-copy-baseline/v1", rows: [] };

function checkRecordObjects(
  record: RenderedCopyCapture,
  repo: RenderedCopyRepo,
  changed: boolean,
  violations: string[],
) {
  if (repo.objectType(record.base.commit) !== "commit")
    violations.push(`capture.base: B ${record.base.commit} is missing`);
  else if (repo.treeOf(record.base.commit) !== record.base.tree) {
    violations.push(`capture.base.tree: ${record.base.tree} is not the tree of B ${record.base.commit}`);
  }
  if (!repo.isAncestor(record.base.commit, repo.head)) {
    violations.push(`capture.base: B ${record.base.commit} is not an ancestor of ${repo.head}`);
  }
  const blobs = [
    ...record.tools.map((tool) => ({ where: `tool ${tool.path}`, blob: tool.blob })),
    ...record.batches.flatMap((batch) =>
      batch.listing.map((group) => ({ where: `predecessor ${group.path}`, blob: group.blob })),
    ),
  ];
  for (const { where, blob } of blobs) {
    if (repo.objectType(blob) !== "blob") violations.push(`capture: ${where} blob ${blob} is missing`);
  }
  if (!changed) return;
  if (repo.objectType(record.head.commit) !== "commit")
    violations.push(`capture.head: PR head ${record.head.commit} is missing`);
  else if (repo.treeOf(record.head.commit) !== record.head.tree) {
    violations.push(`capture.head.tree: ${record.head.tree} is not the tree of PR head ${record.head.commit}`);
  }
  const diff = repo.diffNames(record.base.commit, record.head.commit);
  if (!diff || !sameJson(diff, record.diff)) {
    violations.push(
      `capture.diff: recorded diff does not equal git diff --name-only ${record.base.commit}...${record.head.commit}`,
    );
  }
  for (const tool of record.tools) {
    if (repo.blobAt(record.head.commit, tool.path) !== tool.blob) {
      violations.push(`capture.tools: ${tool.path} blob ${tool.blob} is substituted at PR head ${record.head.commit}`);
    }
    if (repo.blobAt(repo.head, tool.path) !== tool.blob) {
      violations.push(
        `capture.tools: ${tool.path} changed after capture; an INTEGRATED head carries the captured tools`,
      );
    }
  }
}

export function validateRenderedCopyProvenance(input: {
  event: string;
  head: RenderedCopyCommitted;
  main: RenderedCopyCommitted;
  repo: RenderedCopyRepo;
}): { state: RenderedCopyState | "INVALID"; violations: string[] } {
  const violations: string[] = [];
  const { head, main, repo } = input;
  if (head.toggle !== undefined) violations.push(...validateRenderedCopyToggle(head.toggle));
  if (head.baseline !== undefined) violations.push(...validateRenderedCopyBaseline(head.baseline));
  if (head.record !== undefined) violations.push(...validateCaptureRecord(head.record));
  if (violations.length > 0) return { state: "INVALID", violations };
  const baseline = (head.baseline ?? emptyBaseline) as RenderedCopyBaseline;
  const mainBaseline = (main.baseline ?? emptyBaseline) as RenderedCopyBaseline;
  const record = head.record as RenderedCopyCapture | undefined;
  const mainRecord = main.record as RenderedCopyCapture | undefined;
  const recordChanged = !sameJson(record, mainRecord);

  if (head.toggle !== undefined) {
    if (input.event === "merge_group")
      violations.push("rendered-copy-collect.json: every merge_group requires its absence");
    if (recordChanged)
      violations.push("rendered-copy-collect.json: an enforced committed-record head requires its absence");
    if (!sameJson(baseline, mainBaseline))
      violations.push("PROPOSED: the baseline cannot change while capture is enabled");
    return { state: violations.length === 0 ? "PROPOSED" : "INVALID", violations };
  }
  if (record === undefined) {
    if (mainRecord !== undefined) violations.push("rendered-copy-capture.json: the frozen record cannot be deleted");
    if (baseline.rows.length > 0)
      violations.push("rendered-copy-baseline.json: rows require a committed capture record");
    return { state: violations.length === 0 ? "ABSENT" : "INVALID", violations };
  }
  if (recordChanged) {
    if (mainRecord && mainRecord.run.id === record.run.id && mainRecord.run.attempt === record.run.attempt) {
      violations.push(
        "rendered-copy-capture.json: history is immutable; a changed record needs a new authorized capture",
      );
    }
    checkRecordObjects(record, repo, true, violations);
    violations.push(...rejectCandidateDerivedBaseline({ baseline, record }));
    violations.push(...baselineEqualsRecord(baseline, record));
    violations.push(...validateOwnerMap({ fields: record.fields, tuples: record.tuples, baseline: baseline.rows }));
    const state = input.event === "merge_group" ? "LANDED" : "INTEGRATED";
    return { state: violations.length === 0 ? state : "INVALID", violations };
  }
  checkRecordObjects(record, repo, false, violations);
  violations.push(...rejectCandidateDerivedBaseline({ baseline, record, frozenBaseline: mainBaseline }));
  violations.push(...validateOwnerMap({ fields: record.fields, tuples: record.tuples }));
  return { state: violations.length === 0 ? "STEADY_STATE" : "INVALID", violations };
}

// Hosted drift on an integrated head: with no product diff against main the
// record is INVALIDATED and returns to PROPOSED at a new base; otherwise the
// candidate owns the change.
export function classifyRenderedCopyDrift(input: {
  record: RenderedCopyCapture;
  baseline: RenderedCopyBaseline;
  observed: readonly (RenderedCopyField & { count: number })[];
  productDiff: readonly string[];
  main: string;
}): { state: "MATCH" | "INVALIDATED" | "CANDIDATE_DRIFT"; next?: "PROPOSED"; range?: string; drift: string[] } {
  const observed = new Map(input.observed.map((field) => [renderedCopyFieldKey(field), field]));
  const drift: string[] = [];
  for (const row of input.baseline.rows) {
    const count = observed.get(renderedCopyFieldKey(row))?.count ?? 0;
    if (count !== row.maxCount) drift.push(`${fieldName(row)}: baseline ${row.maxCount}, observed ${count}`);
    observed.delete(renderedCopyFieldKey(row));
  }
  for (const field of observed.values()) drift.push(`${fieldName(field)}: baseline 0, observed ${field.count}`);
  if (drift.length === 0) return { state: "MATCH", drift };
  const range = `${input.record.base.commit}..${input.main}`;
  const product = input.productDiff.filter((file) => !renderedCopyGuardFootprint.includes(file));
  return product.length === 0
    ? { state: "INVALIDATED", next: "PROPOSED", range, drift }
    : { state: "CANDIDATE_DRIFT", range, drift };
}
