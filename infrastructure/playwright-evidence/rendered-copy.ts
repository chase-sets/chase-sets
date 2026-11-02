import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export type RenderedCopyField = Readonly<{
  page: string;
  class: RenderedCopyClass;
  selector: string;
  label: string | null;
  prefix: string | null;
  token: string | null;
}>;
export type RenderedCopyObservedField = RenderedCopyField &
  Readonly<{ issue: number | null; count: number; samples: readonly string[] }>;
const ordinal = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
export const renderedCopyFieldKey = (field: RenderedCopyField) =>
  JSON.stringify([field.page, field.class, field.selector, field.label, field.prefix, field.token]);

// Observe rendered machine-copy shapes without enforcing counts.
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

// The fixed census is shared by discovery, observations and part validation.
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
// Anything else remains unattributed observation data.
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

type OwnedRow = Pick<RenderedCopyOwnerRule, "selector" | "label" | "prefix" | "token" | "class">;

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
    }
    const rule = "row" in owner ? (owner.row as RenderedCopyOwnerRule | undefined) : undefined;
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

export const renderedCopyObservationDirectory = "artifacts/rendered-copy-observations";
export const renderedCopyCaptureArtifactRoot = ".artifacts/rendered-copy-parts";
export const renderedCopyCaptureArtifactName = (runId: number, attempt: number, jobIndex: number) =>
  `rendered-copy-part-${runId}-${attempt}-${jobIndex}`;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export type RenderedCopyObservation = Readonly<{
  schema: "rendered-copy-observation/v1";
  tuple: RenderedCopyTuple;
  retry: number;
  durationMs: number;
  witness: string;
  counts: RenderedCopyCounts;
  fields: readonly RenderedCopyObservedField[];
}>;
export type RenderedCopyAttempt = Readonly<{
  key: string;
  retry: number;
  status: string;
}>;
export type RenderedCopyPart = Readonly<{
  schema: "rendered-copy-part/v1";
  candidate: Readonly<{ commit: string; tree: string; sourceHead: string }>;
  run: Readonly<{
    workflow: string;
    event: string;
    id: number;
    attempt: number;
    jobIndex: number;
    batch: string;
    capturedAt: string;
  }>;
  attempts: readonly RenderedCopyAttempt[];
  retriedTuples: readonly string[];
  observations: readonly RenderedCopyObservation[];
}>;

export async function sweepRenderedCopy(
  page: Page,
  tuple: RenderedCopyTuple,
  context: { retry: number; startedAt: number; witness: string },
  root = repoRoot,
): Promise<RenderedCopyObservation> {
  const rules = renderedCopyOwnerRules.filter((rule) => rule.page === tuple.page);
  const { counts, occurrences } = await readRenderedCopyOccurrences(page, [
    ...new Set(rules.map((rule) => rule.selector)),
  ]);
  const { fields } = attributeRenderedCopy(tuple.page, occurrences, rules);
  const observation: RenderedCopyObservation = {
    schema: "rendered-copy-observation/v1",
    tuple,
    retry: context.retry,
    durationMs: Math.max(1, Date.now() - context.startedAt),
    witness: context.witness,
    counts,
    fields,
  };
  const directory = path.join(root, renderedCopyObservationDirectory);
  mkdirSync(directory, { recursive: true });
  const name = `${tuple.deployable}--${tuple.persona}--${createHash("sha256").update(tuple.page).digest("hex").slice(0, 16)}--retry${context.retry}.json`;
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(observation)}\n`);
  renameSync(temporary, path.join(directory, name));
  console.log(
    `RENDERED_COPY_OBSERVATION ${JSON.stringify({ key: renderedCopyTupleKey(tuple), retry: context.retry, counts })}`,
  );
  return observation;
}

export function readRenderedCopyObservations(root = repoRoot): RenderedCopyObservation[] {
  const directory = path.join(root, renderedCopyObservationDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as RenderedCopyObservation);
}

export function finalRenderedCopyObservations(
  observations: readonly RenderedCopyObservation[],
  attempts: readonly RenderedCopyAttempt[],
): RenderedCopyObservation[] {
  const keys = new Set(renderedCopyTuples.map(renderedCopyTupleKey));
  for (const entry of [
    ...observations.map((row) => ({ key: renderedCopyTupleKey(row.tuple), retry: row.retry })),
    ...attempts,
  ]) {
    if (!keys.has(entry.key) || !Number.isSafeInteger(entry.retry) || entry.retry < 0 || entry.retry > 2)
      throw new Error(`${entry.key}: invalid tuple/attempt ${entry.retry}`);
  }
  return renderedCopyTuples.map((tuple) => {
    const key = renderedCopyTupleKey(tuple);
    const terminal = attempts.filter((entry) => entry.key === key).sort((a, b) => a.retry - b.retry);
    if (!terminal.length || terminal.some((entry, index) => entry.retry !== index))
      throw new Error(`${key}: missing or conflicting terminal attempt`);
    if (terminal.some((entry) => !["passed", "failed", "timedOut", "interrupted"].includes(entry.status)))
      throw new Error(`${key}: invalid terminal status`);
    const last = terminal.at(-1)!;
    if (last.status !== "passed") throw new Error(`${key}: final attempt ${last.retry} ${last.status}; no part`);
    const rows = observations.filter((row) => renderedCopyTupleKey(row.tuple) === key);
    if (rows.some((row) => row.retry > last.retry) || new Set(rows.map((row) => row.retry)).size !== rows.length)
      throw new Error(`${key}: conflicting observation attempt`);
    const final = rows.find((row) => row.retry === last.retry);
    if (!final) throw new Error(`${key}: missing final observation for retry ${last.retry}`);
    return final;
  });
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
function closed(
  value: unknown,
  keys: readonly string[],
  where: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!object(value)) {
    errors.push(`${where}: expected object`);
    return false;
  }
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value)))
    errors.push(`${where}: wrong keys`);
  return true;
}
function validateObservation(value: unknown, index: number, errors: string[]) {
  const where = `observations[${index}]`;
  if (!closed(value, ["schema", "tuple", "retry", "durationMs", "witness", "counts", "fields"], where, errors)) return;
  if (value.schema !== "rendered-copy-observation/v1") errors.push(`${where}: schema`);
  if (JSON.stringify(value.tuple) !== JSON.stringify(renderedCopyTuples[index])) errors.push(`${where}: tuple/order`);
  if (!integer(value.retry) || (value.retry as number) > 2) errors.push(`${where}: retry`);
  if (!integer(value.durationMs, 1) || (value.durationMs as number) > 25 * 60 * 1000) errors.push(`${where}: duration`);
  if (!["populated", "sell-list-empty", "reference-lookup-form"].includes(String(value.witness)))
    errors.push(`${where}: witness`);
  if (closed(value.counts, renderedCopyClasses, `${where}.counts`, errors)) {
    if (Object.values(value.counts).some((count) => !integer(count))) errors.push(`${where}: invalid count`);
  }
  if (!Array.isArray(value.fields)) {
    errors.push(`${where}: fields`);
    return;
  }
  const seen = new Set<string>();
  for (const field of value.fields) {
    if (
      !closed(
        field,
        ["page", "class", "selector", "label", "prefix", "token", "issue", "count", "samples"],
        `${where}.field`,
        errors,
      )
    )
      continue;
    if (
      field.page !== renderedCopyTuples[index]?.page ||
      !renderedCopyClasses.includes(field.class as RenderedCopyClass) ||
      typeof field.selector !== "string" ||
      !field.selector.length ||
      !integer(field.count, 1) ||
      ![field.label, field.prefix, field.token].every((entry) => entry === null || typeof entry === "string") ||
      !(field.issue === null || integer(field.issue, 1)) ||
      !Array.isArray(field.samples) ||
      field.samples.length > 5 ||
      field.samples.some((sample) => typeof sample !== "string")
    )
      errors.push(`${where}: invalid field`);
    const key = JSON.stringify([field.class, field.selector, field.label, field.prefix, field.token]);
    if (seen.has(key)) errors.push(`${where}: duplicate field`);
    seen.add(key);
  }
  if (object(value.counts)) {
    for (const kind of renderedCopyClasses) {
      const count = value.fields
        .filter(object)
        .filter((field) => field.class === kind)
        .reduce((sum, field) => sum + Number(field.count), 0);
      if (count !== value.counts[kind]) errors.push(`${where}: ${kind} attribution total`);
    }
  }
}

export function validateCapturePart(value: unknown): string[] {
  const errors: string[] = [];
  if (!closed(value, ["schema", "candidate", "run", "attempts", "retriedTuples", "observations"], "part", errors))
    return errors;
  if (value.schema !== "rendered-copy-part/v1") errors.push("part: schema");
  if (
    closed(value.candidate, ["commit", "tree", "sourceHead"], "candidate", errors) &&
    Object.values(value.candidate).some((entry) => typeof entry !== "string" || !/^[0-9a-f]{40}$/.test(entry))
  )
    errors.push("candidate: invalid SHA");
  if (closed(value.run, ["workflow", "event", "id", "attempt", "jobIndex", "batch", "capturedAt"], "run", errors)) {
    if (
      value.run.workflow !== "platform-pr.yml" ||
      value.run.event !== "pull_request" ||
      value.run.batch !== "rendered_copy" ||
      !integer(value.run.id, 1) ||
      !integer(value.run.attempt, 1) ||
      !integer(value.run.jobIndex) ||
      typeof value.run.capturedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.run.capturedAt) ||
      !Number.isFinite(Date.parse(value.run.capturedAt))
    )
      errors.push("run: invalid producer identity");
  }
  if (!Array.isArray(value.attempts)) errors.push("part: attempts");
  else value.attempts.forEach((entry) => closed(entry, ["key", "retry", "status"], "attempt", errors));
  if (!Array.isArray(value.observations) || value.observations.length !== renderedCopyTuples.length)
    errors.push("part: exact census required");
  else value.observations.forEach((row, index) => validateObservation(row, index, errors));
  if (!errors.length) {
    try {
      const observations = value.observations as RenderedCopyObservation[];
      const attempts = value.attempts as RenderedCopyAttempt[];
      const final = finalRenderedCopyObservations(observations, attempts);
      if (JSON.stringify(final) !== JSON.stringify(observations)) errors.push("part: not final observations");
      const retried = final.filter((row) => row.retry > 0).map((row) => renderedCopyTupleKey(row.tuple));
      if (JSON.stringify(retried) !== JSON.stringify(value.retriedTuples)) errors.push("part: retried tuples mismatch");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

export function buildCapturePart(input: Omit<RenderedCopyPart, "schema" | "retriedTuples">): RenderedCopyPart {
  const observations = finalRenderedCopyObservations(input.observations, input.attempts);
  const part: RenderedCopyPart = {
    ...input,
    schema: "rendered-copy-part/v1",
    observations,
    retriedTuples: observations.filter((row) => row.retry > 0).map((row) => renderedCopyTupleKey(row.tuple)),
  };
  const errors = validateCapturePart(part);
  if (errors.length) throw new Error(`rendered-copy part invalid:\n${errors.join("\n")}`);
  return part;
}
