// Whole-game rehearsal decisions for the Catalog staging provider UAT.
// The UAT spec drives the admin UI; this module owns every decision the
// journeys make from what the UI and its admin API reads return, so the
// decisions stay pure and are pinned by scripts/catalog-whole-game-rehearsal.test.mjs.
// It must not import Playwright or any bounded-context runtime.

export const wholeGameJourneyScopes = ["full-game-start", "full-game-settle"] as const;
export type WholeGameJourneyScope = (typeof wholeGameJourneyScopes)[number];

export const wholeGameReceiptPath = "artifacts/catalog-whole-game-rehearsal/receipt.json";
export const wholeGameReceiptSchemaVersion = "catalog-whole-game-rehearsal-receipt/v1";

export class WholeGameRehearsalRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Whole-game rehearsal refused: ${code}.`);
    this.name = "WholeGameRehearsalRefusal";
    this.code = code;
  }
}

export type WholeGameBudget = Readonly<{
  maxScopesPerTurn: number;
  tcgdexRequestLimit: number;
  scrydexRateRequestLimit: number;
  scrydexRequestLimit: number;
  providerFailureThreshold: number;
}>;

export const defaultWholeGameBudget: WholeGameBudget = {
  maxScopesPerTurn: 1,
  tcgdexRequestLimit: 1000,
  scrydexRateRequestLimit: 1000,
  scrydexRequestLimit: 0,
  providerFailureThreshold: 3,
};

export type WholeGameStartInput = Readonly<{
  productDomain: string;
  languageCode: string | null;
  budget: WholeGameBudget;
}>;

export type WholeGameSettleInput = Readonly<{
  batchId: string;
  retryFailed: boolean;
  resumeCancelled: boolean;
}>;

type Env = Readonly<Record<string, string | undefined>>;

const budgetKeys = Object.keys(defaultWholeGameBudget) as (keyof WholeGameBudget)[];
const tokenPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const batchIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function parseWholeGameStartInput(env: Env): WholeGameStartInput {
  const productDomain = env.CATALOG_WHOLE_GAME_PRODUCT_DOMAIN?.trim() ?? "";
  if (!tokenPattern.test(productDomain)) throw new WholeGameRehearsalRefusal("product-domain-required");
  const languageCode = env.CATALOG_WHOLE_GAME_LANGUAGE_CODE?.trim() || null;
  if (languageCode !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(languageCode)) {
    throw new WholeGameRehearsalRefusal("language-code-invalid");
  }
  return { productDomain, languageCode, budget: parseWholeGameBudget(env.CATALOG_WHOLE_GAME_BUDGET ?? "") };
}

/** Budget input is `key=value` pairs separated by commas; omitted keys keep the Admin form defaults. */
export function parseWholeGameBudget(value: string): WholeGameBudget {
  const budget: Record<string, number> = { ...defaultWholeGameBudget };
  for (const pair of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [key, raw, ...rest] = pair.split("=").map((part) => part.trim());
    const parsed = Number(raw);
    if (
      rest.length > 0 ||
      !budgetKeys.includes(key as keyof WholeGameBudget) ||
      !Number.isInteger(parsed) ||
      parsed < 0
    ) {
      throw new WholeGameRehearsalRefusal("budget-invalid");
    }
    budget[key as keyof WholeGameBudget] = parsed;
  }
  return budget as WholeGameBudget;
}

export function parseWholeGameSettleInput(env: Env): WholeGameSettleInput {
  const batchId = env.CATALOG_WHOLE_GAME_BATCH_ID?.trim() ?? "";
  if (!batchIdPattern.test(batchId)) throw new WholeGameRehearsalRefusal("batch-id-required");
  return {
    batchId,
    retryFailed: booleanInput(env.CATALOG_WHOLE_GAME_RETRY_FAILED),
    resumeCancelled: booleanInput(env.CATALOG_WHOLE_GAME_RESUME_CANCELLED),
  };
}

function booleanInput(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new WholeGameRehearsalRefusal("boolean-input-invalid");
}

// AC1 — the preview exactly as the Scope Sync Batch page renders it.
export type WholeGameProviderParticipation = Readonly<{
  providerKey: string;
  units: number;
  plannedRequests: number | null;
}>;

export type WholeGamePreviewRecord = Readonly<{
  planFingerprint: string;
  scopeCount: number;
  confirmAllowed: boolean;
  providers: readonly WholeGameProviderParticipation[];
}>;

/** Parses one rendered "<provider> units / requests" row value, e.g. `12 / 340` or `12 / Unavailable`. */
export function parseProviderParticipation(providerKey: string, value: string): WholeGameProviderParticipation {
  const match = /^\s*(\d+)\s*\/\s*(\d+|[^\d].*)\s*$/.exec(value);
  if (!match || !tokenPattern.test(providerKey))
    throw new WholeGameRehearsalRefusal("preview-participation-unreadable");
  return {
    providerKey,
    units: Number(match[1]),
    plannedRequests: /^\d+$/.test(match[2] ?? "") ? Number(match[2]) : null,
  };
}

/** Returns the refusal code that must stop confirmation, or null when the preview may be confirmed. */
export function startConfirmationRefusal(preview: WholeGamePreviewRecord, budget: WholeGameBudget): string | null {
  if (!/^[A-Za-z0-9:_-]{8,200}$/.test(preview.planFingerprint)) return "preview-fingerprint-unreadable";
  if (!Number.isInteger(preview.scopeCount)) return "preview-scope-count-unreadable";
  if (preview.scopeCount <= 0) return "preview-empty";
  const scrydex = preview.providers.find((provider) => provider.providerKey === "scrydex");
  if (scrydex && scrydex.units > 0 && budget.scrydexRequestLimit === 0) return "scrydex-credit-limit-zero";
  if (!preview.confirmAllowed) return "preview-not-confirmable";
  return null;
}

// AC2 — one batch per settle, decided from that batch's own snapshot.
export type WholeGameBatchStatus = "queued" | "running" | "cancelled" | "completed" | "partial" | "failed";
export type WholeGameUnitState = "queued" | "running" | "completed" | "failed" | "cancelled";

export type WholeGameBatchView = Readonly<{
  batchId: string;
  status: WholeGameBatchStatus;
  circuitOpenProviders: readonly string[];
  units: readonly Readonly<{ scopeRecordId: string; state: WholeGameUnitState; providerKeys: readonly string[] }>[];
}>;

export type WholeGameSettleStep =
  | Readonly<{ kind: "exit-running"; reason: "in-progress" | "retried-failed-units" | "resumed" }>
  | Readonly<{ kind: "retry-failed-units"; scopeRecordIds: readonly string[] }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "exit-cancelled" }>
  | Readonly<{ kind: "promote-and-publish"; scopeRecordIds: readonly string[]; failedUnits: number }>;

/** Refuses any snapshot that is not the requested batch, so a newer batch on the page is never adopted. */
export function assertRequestedBatch(requestedBatchId: string, observedBatchId: string | null | undefined): void {
  if (observedBatchId !== requestedBatchId) throw new WholeGameRehearsalRefusal("batch-id-mismatch");
}

export function planWholeGameSettle(batch: WholeGameBatchView, input: WholeGameSettleInput): WholeGameSettleStep {
  assertRequestedBatch(input.batchId, batch.batchId);
  const failed = batch.units.filter((unit) => unit.state === "failed").map((unit) => unit.scopeRecordId);
  const completed = batch.units.filter((unit) => unit.state === "completed").map((unit) => unit.scopeRecordId);
  const circuitOpen = batch.circuitOpenProviders.length > 0;

  if (batch.status === "cancelled") return input.resumeCancelled ? { kind: "resume" } : { kind: "exit-cancelled" };
  if (batch.status === "queued" || (batch.status === "running" && !circuitOpen)) {
    return { kind: "exit-running", reason: "in-progress" };
  }
  // running with an open circuit, partial or failed: retry only when this dispatch asks, once per unit.
  if (batch.status !== "completed" && input.retryFailed && failed.length > 0) {
    return { kind: "retry-failed-units", scopeRecordIds: failed };
  }
  return { kind: "promote-and-publish", scopeRecordIds: completed, failedUnits: failed.length };
}

// AC3 — promotion and publication progress is read back from the server, never remembered.
export type WholeGamePromoteJob = Readonly<{
  jobId: string;
  kind: string;
  scopeRecordId: string;
  status: "queued" | "running" | "completed" | "failed";
  result: Readonly<{
    promoted: number;
    outcomes: readonly Readonly<{ status: string; catalogItemId: string | null }>[];
  }> | null;
}>;

export type WholeGameJobPage = Readonly<{ items: readonly WholeGamePromoteJob[]; cursor?: string }>;

export type WholeGameScopePromotionStep =
  | Readonly<{ kind: "adopt-active-job"; jobIds: readonly string[] }>
  | Readonly<{ kind: "submit-promote-all-ready" }>
  | Readonly<{ kind: "none-ready" }>;

/** A killed dispatch leaves its job running server-side; adopting it instead of resubmitting prevents double promotion. */
export function planScopePromotion(
  scopeRecordId: string,
  activeJobs: readonly WholeGamePromoteJob[],
  readyCandidates: number,
): WholeGameScopePromotionStep {
  const active = activeJobs.filter(
    (job) => job.scopeRecordId === scopeRecordId && job.kind === "merge-candidate-promote",
  );
  if (active.length > 0) return { kind: "adopt-active-job", jobIds: active.map((job) => job.jobId) };
  return readyCandidates > 0 ? { kind: "submit-promote-all-ready" } : { kind: "none-ready" };
}

/** Reads every completed promote job for a scope, following `cursor` until it is absent. */
export async function readAllCompletedPromoteJobs(
  scopeRecordId: string,
  readPage: (cursor: string | null) => Promise<WholeGameJobPage>,
  maxPages = 200,
): Promise<readonly WholeGamePromoteJob[]> {
  const jobs: WholeGamePromoteJob[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await readPage(cursor);
    for (const job of result.items) {
      if (job.scopeRecordId !== scopeRecordId) throw new WholeGameRehearsalRefusal("job-scope-mismatch");
      if (job.kind === "merge-candidate-promote" && job.status === "completed") jobs.push(job);
    }
    if (!result.cursor) return jobs;
    if (seenCursors.has(result.cursor)) throw new WholeGameRehearsalRefusal("job-cursor-repeated");
    seenCursors.add(result.cursor);
    cursor = result.cursor;
  }
  throw new WholeGameRehearsalRefusal("job-pages-exhausted");
}

export type WholeGamePromotedItems = Readonly<{
  catalogItemIds: readonly string[];
  promotedOutcomes: number;
  promotedWithoutCatalogItem: number;
}>;

export function promotedCatalogItems(jobs: readonly WholeGamePromoteJob[]): WholeGamePromotedItems {
  const ids = new Set<string>();
  let promotedOutcomes = 0;
  let promotedWithoutCatalogItem = 0;
  for (const job of jobs) {
    for (const outcome of job.result?.outcomes ?? []) {
      if (outcome.status !== "promoted") continue;
      promotedOutcomes += 1;
      if (outcome.catalogItemId) ids.add(outcome.catalogItemId);
      else promotedWithoutCatalogItem += 1;
    }
  }
  return { catalogItemIds: [...ids].sort(), promotedOutcomes, promotedWithoutCatalogItem };
}

export type WholeGamePublishFilter = Readonly<{
  blueprintId: string;
  source: string;
  language: string;
  status: "draft";
}>;

/** One draft filter per blueprint x batch provider source x language, in a stable order. */
export function publishFilters(
  items: readonly Readonly<{ blueprintId: string | null; languageCode: string | null }>[],
  providerSources: readonly string[],
): readonly WholeGamePublishFilter[] {
  const pairs = new Map<string, Readonly<{ blueprintId: string; language: string }>>();
  for (const item of items) {
    if (!item.blueprintId || !item.languageCode) continue;
    pairs.set(`${item.blueprintId}\u0000${item.languageCode}`, {
      blueprintId: item.blueprintId,
      language: item.languageCode,
    });
  }
  const filters: WholeGamePublishFilter[] = [];
  for (const pair of [...pairs.values()].sort(
    (a, b) => a.blueprintId.localeCompare(b.blueprintId) || a.language.localeCompare(b.language),
  )) {
    for (const source of [...new Set(providerSources)].sort()) {
      filters.push({ blueprintId: pair.blueprintId, source, language: pair.language, status: "draft" });
    }
  }
  return filters;
}

// AC4 — the publish guard reads the complete preview response, not the rendered rows.
export type WholeGamePublishPreview = Readonly<{
  item_ids: readonly string[];
  total: number;
  candidates: readonly Readonly<{
    catalog_item_id: string;
    blueprint_id: string | null;
    source_providers: readonly string[];
  }>[];
}>;

export function assertPublishPreviewGuard(
  preview: WholeGamePublishPreview,
  filter: WholeGamePublishFilter,
  collectedBlueprintIds: ReadonlySet<string>,
): void {
  if (
    preview.total !== preview.candidates.length ||
    preview.item_ids.length !== preview.candidates.length ||
    preview.candidates.some((candidate, index) => candidate.catalog_item_id !== preview.item_ids[index])
  ) {
    throw new WholeGameRehearsalRefusal("publish-preview-incomplete");
  }
  preview.candidates.forEach((candidate, index) => {
    if (!candidate.source_providers.includes(filter.source)) {
      throw new WholeGameRehearsalRefusal(`publish-preview-row-${index + 1}-missing-provider-source`);
    }
    if (
      candidate.blueprint_id === null ||
      candidate.blueprint_id !== filter.blueprintId ||
      !collectedBlueprintIds.has(candidate.blueprint_id)
    ) {
      throw new WholeGameRehearsalRefusal(`publish-preview-row-${index + 1}-foreign-blueprint`);
    }
  });
}

// AC5 — support-safe receipt: counts, states and opaque ids only.
export type WholeGameReceipt = Readonly<{
  schemaVersion: typeof wholeGameReceiptSchemaVersion;
  journeyScope: WholeGameJourneyScope;
  sha: string;
  runId: string;
  runAttempt: string;
  batchId: string;
  state: "confirmed" | "running" | "cancelled" | "settled";
  preview: Readonly<{
    planFingerprint: string;
    scopeCount: number;
    providers: readonly WholeGameProviderParticipation[];
  }> | null;
  settle: Readonly<{
    batchStatus: WholeGameBatchStatus;
    units: Readonly<Record<WholeGameUnitState, number>>;
    retriedUnits: number;
    resumed: boolean;
    scopesPromoted: number;
    promoteJobsSubmitted: number;
    promoteJobsAdopted: number;
    promotedThisDispatch: number;
    promotedOutcomes: number;
    promotedWithoutCatalogItem: number;
    blueprints: number;
    publishFilters: number;
    publishPreviewed: number;
    published: number;
    readyRemaining: number;
    draftsRemaining: number;
  }> | null;
}>;

const receiptKeys = [
  "schemaVersion",
  "journeyScope",
  "sha",
  "runId",
  "runAttempt",
  "batchId",
  "state",
  "preview",
  "settle",
];
const previewKeys = ["planFingerprint", "scopeCount", "providers"];
const providerKeys = ["providerKey", "units", "plannedRequests"];
const settleCountKeys = [
  "retriedUnits",
  "scopesPromoted",
  "promoteJobsSubmitted",
  "promoteJobsAdopted",
  "promotedThisDispatch",
  "promotedOutcomes",
  "promotedWithoutCatalogItem",
  "blueprints",
  "publishFilters",
  "publishPreviewed",
  "published",
  "readyRemaining",
  "draftsRemaining",
];
const settleKeys = ["batchStatus", "units", "resumed", ...settleCountKeys];
const unitStates: readonly WholeGameUnitState[] = ["queued", "running", "completed", "failed", "cancelled"];
const batchStatuses: readonly WholeGameBatchStatus[] = [
  "queued",
  "running",
  "cancelled",
  "completed",
  "partial",
  "failed",
];
const receiptStates = ["confirmed", "running", "cancelled", "settled"];

/** Returns every schema violation; an empty list is the only publishable receipt. */
export function validateWholeGameReceipt(value: unknown): readonly string[] {
  const errors: string[] = [];
  const receipt = record(value, "receipt", receiptKeys, errors);
  if (!receipt) return errors;
  if (receipt.schemaVersion !== wholeGameReceiptSchemaVersion) errors.push("schemaVersion");
  if (!wholeGameJourneyScopes.includes(receipt.journeyScope as WholeGameJourneyScope)) errors.push("journeyScope");
  if (typeof receipt.sha !== "string" || !/^[0-9a-f]{40}$/.test(receipt.sha)) errors.push("sha");
  if (typeof receipt.runId !== "string" || !/^\d{1,20}$/.test(receipt.runId)) errors.push("runId");
  if (typeof receipt.runAttempt !== "string" || !/^\d{1,4}$/.test(receipt.runAttempt)) errors.push("runAttempt");
  if (typeof receipt.batchId === "string" && !batchIdPattern.test(receipt.batchId)) errors.push("batchId");
  if (!receiptStates.includes(receipt.state as string)) errors.push("state");
  if (typeof receipt.batchId !== "string") errors.push("batchId-required");

  if (receipt.preview !== null) {
    const preview = record(receipt.preview, "preview", previewKeys, errors);
    if (preview) {
      if (typeof preview.planFingerprint !== "string" || !/^[A-Za-z0-9:_-]{8,200}$/.test(preview.planFingerprint)) {
        errors.push("preview.planFingerprint");
      }
      if (!count(preview.scopeCount)) errors.push("preview.scopeCount");
      if (!Array.isArray(preview.providers)) errors.push("preview.providers");
      else {
        preview.providers.forEach((entry, index) => {
          const provider = record(entry, `preview.providers.${index}`, providerKeys, errors);
          if (!provider) return;
          if (typeof provider.providerKey !== "string" || !tokenPattern.test(provider.providerKey)) {
            errors.push(`preview.providers.${index}.providerKey`);
          }
          if (!count(provider.units)) errors.push(`preview.providers.${index}.units`);
          if (provider.plannedRequests !== null && !count(provider.plannedRequests)) {
            errors.push(`preview.providers.${index}.plannedRequests`);
          }
        });
      }
    }
  }

  if (receipt.settle !== null) {
    const settle = record(receipt.settle, "settle", settleKeys, errors);
    if (settle) {
      if (!batchStatuses.includes(settle.batchStatus as WholeGameBatchStatus)) errors.push("settle.batchStatus");
      if (typeof settle.resumed !== "boolean") errors.push("settle.resumed");
      const units = record(settle.units, "settle.units", unitStates, errors);
      if (units) for (const state of unitStates) if (!count(units[state])) errors.push(`settle.units.${state}`);
      for (const key of settleCountKeys) if (!count(settle[key])) errors.push(`settle.${key}`);
    }
  }
  if (receipt.state === "settled") {
    const settle = receipt.settle as Record<string, unknown> | null;
    if (
      !settle ||
      settle.readyRemaining !== 0 ||
      settle.draftsRemaining !== 0 ||
      settle.promotedWithoutCatalogItem !== 0
    ) {
      errors.push("settled-with-remaining-work");
    }
  }
  if (/https?:|@|bearer|cookie|authorization|password|secret|token/i.test(JSON.stringify(value))) {
    errors.push("support-unsafe-text");
  }
  return errors;
}

function record(
  value: unknown,
  path: string,
  keys: readonly string[],
  errors: string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(path);
    return null;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    errors.push(`${path}.keys`);
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
