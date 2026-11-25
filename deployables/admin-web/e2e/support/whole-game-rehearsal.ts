// Whole-game rehearsal decisions for the Catalog staging provider UAT.
// The UAT spec drives the admin UI; this module owns every decision the
// journeys make from what the UI and its admin API reads return, so the
// decisions stay pure and are pinned by scripts/catalog-whole-game-rehearsal.test.mjs.
// It must not import Playwright or any bounded-context runtime.
import type { CatalogMergeCandidateApplicationDiagnosticCode, CatalogServices } from "@chase-sets/catalog/server";

// Catalog owns these promotion diagnostic codes. This module keeps its own closed copy
// so it imports no bounded-context runtime; typecheck fails if the copy and Catalog's
// union drift in either direction.
const promotionDiagnosticCodes = [
  "asset-processing-failed",
  "promotion-reference-target-unresolved",
  "unexpected-promotion-error",
  "promotion-plan-blocked:ambiguous-conflict-resolution",
  "promotion-plan-blocked:ambiguous-duplicate-candidates",
  "promotion-plan-blocked:ambiguous-target",
  "promotion-plan-blocked:asset-provenance-ambiguous",
  "promotion-plan-blocked:candidate-has-blocking-conflicts",
  "promotion-plan-blocked:candidate-not-ready",
  "promotion-plan-blocked:conflicting-external-reference-level",
  "promotion-plan-blocked:display-identity-unresolvable",
  "promotion-plan-blocked:duplicate-external-catalog-item-reference",
  "promotion-plan-blocked:duplicate-external-product-reference",
  "promotion-plan-blocked:external-product-reference-duplicate-dimension",
  "promotion-plan-blocked:external-product-reference-missing-selected-options",
  "promotion-plan-blocked:inactive-target",
  "promotion-plan-blocked:incompatible-target",
  "promotion-plan-blocked:member-revision-missing",
  "promotion-plan-blocked:missing-catalog-item-target",
  "promotion-plan-blocked:missing-create-catalog-item-id",
  "promotion-plan-blocked:missing-field-value",
  "promotion-plan-blocked:missing-reference-record-target",
  "promotion-plan-blocked:missing-title",
  "promotion-plan-blocked:no-promotable-member",
  "promotion-plan-blocked:profile-disagreement",
  "promotion-plan-blocked:promotion-facts-missing",
  "promotion-plan-blocked:promotion-profile-ambiguous",
  "promotion-plan-blocked:promotion-profile-inactive",
  "promotion-plan-blocked:promotion-profile-incompatible",
  "promotion-plan-blocked:promotion-profile-unavailable",
  "promotion-plan-blocked:reference-provenance-ambiguous",
  "promotion-plan-blocked:unsupported-promotion-intent",
  "promotion-application-bound-elsewhere",
  "promotion-application-conflicting-history",
  "promotion-application-invalid-plan-fingerprint",
  "promotion-application-member-history-conflict",
  "promotion-application-missing-reference-evidence",
  "promotion-application-partial-target",
  "promotion-application-profile-missing",
  "promotion-application-profile-revoked",
  "promotion-application-target-history-conflict",
  "promotion-application-unplanned-target-history",
] as const satisfies readonly CatalogMergeCandidateApplicationDiagnosticCode[];
type PromotionDiagnosticCodeMissingFromCopy = Exclude<
  CatalogMergeCandidateApplicationDiagnosticCode,
  (typeof promotionDiagnosticCodes)[number]
>;
const promotionDiagnosticCopyIsComplete: [PromotionDiagnosticCodeMissingFromCopy] extends [never] ? true : false = true;
const promotionDiagnosticCodeSet = new Set<unknown>(promotionDiagnosticCopyIsComplete ? promotionDiagnosticCodes : []);

function isCatalogMergeCandidateApplicationDiagnosticCode(
  value: unknown,
): value is CatalogMergeCandidateApplicationDiagnosticCode {
  return promotionDiagnosticCodeSet.has(value);
}

function isCatalogMergeCandidateFailureDiagnosticCode(
  value: unknown,
): value is Exclude<CatalogMergeCandidateApplicationDiagnosticCode, "asset-processing-failed"> {
  return value !== "asset-processing-failed" && isCatalogMergeCandidateApplicationDiagnosticCode(value);
}

type CatalogMergeCandidateBulkJob = NonNullable<
  Awaited<ReturnType<CatalogServices["sourceObservations"]["getCatalogMergeCandidateBulkJob"]>>
>;
type CatalogMergeCandidateBulkJobResult = NonNullable<CatalogMergeCandidateBulkJob["result"]>;
type CatalogMergeCandidateBulkUnitResult = CatalogMergeCandidateBulkJobResult["outcomes"][number];

export const wholeGameJourneyScopes = [
  "full-game-start",
  "full-game-preview",
  "full-game-confirm",
  "full-game-settle",
] as const;
export type WholeGameJourneyScope = (typeof wholeGameJourneyScopes)[number];

export const wholeGameReceiptPath = "artifacts/catalog-whole-game-rehearsal/receipt.json";
export const wholeGameReceiptSchemaVersion = "catalog-whole-game-rehearsal-receipt/v1";
export const wholeGameStagingOrigin = "https://admin.staging.chasesets.com";

export function assertWholeGameOrigin(url: string): void {
  const target = new URL(url);
  if (target.origin !== wholeGameStagingOrigin || target.username || target.password) {
    throw new WholeGameRehearsalRefusal("staging-origin-required");
  }
}

export class WholeGameDeadlineReached extends Error {}

/** Cancellation is part of the read contract, not just a check between pages. */
export async function readBeforeWholeGameDeadline<T>(
  deadlineAt: number,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new WholeGameDeadlineReached();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new WholeGameDeadlineReached());
        }, remaining);
      }),
      read(controller.signal).then((result) => {
        if (Date.now() >= deadlineAt) throw new WholeGameDeadlineReached();
        return result;
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
const paidPreviewFingerprintPattern = /^[0-9a-f]{64}$/;

export function parseWholeGameStartInput(env: Env): WholeGameStartInput {
  const productDomain = env.CATALOG_WHOLE_GAME_PRODUCT_DOMAIN?.trim() ?? "";
  if (!tokenPattern.test(productDomain)) throw new WholeGameRehearsalRefusal("product-domain-required");
  const languageCode = env.CATALOG_WHOLE_GAME_LANGUAGE_CODE?.trim() || null;
  if (languageCode !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(languageCode)) {
    throw new WholeGameRehearsalRefusal("language-code-invalid");
  }
  return { productDomain, languageCode, budget: parseWholeGameBudget(env.CATALOG_WHOLE_GAME_BUDGET ?? "") };
}

export function parseApprovedWholeGameFingerprint(env: Env): string {
  const fingerprint = env.CATALOG_WHOLE_GAME_APPROVED_PREVIEW_FINGERPRINT?.trim() ?? "";
  if (!paidPreviewFingerprintPattern.test(fingerprint)) {
    throw new WholeGameRehearsalRefusal("scrydex-approved-fingerprint-required");
  }
  return fingerprint;
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
  if (scrydex && scrydex.units > 0) {
    return budget.scrydexRequestLimit === 0 ? "scrydex-credit-limit-zero" : "scrydex-host-decision-required";
  }
  if (!preview.confirmAllowed) return "preview-not-confirmable";
  return null;
}

export function assertPaidWholeGamePreview(preview: WholeGamePreviewRecord): number {
  if (!paidPreviewFingerprintPattern.test(preview.planFingerprint)) {
    throw new WholeGameRehearsalRefusal("preview-fingerprint-unreadable");
  }
  if (!Number.isSafeInteger(preview.scopeCount) || preview.scopeCount <= 0) {
    throw new WholeGameRehearsalRefusal("paid-preview-no-scopes");
  }
  const [scrydex, ...duplicates] = preview.providers.filter(({ providerKey }) => providerKey === "scrydex");
  if (!scrydex || duplicates.length > 0 || !Number.isSafeInteger(scrydex.units) || scrydex.units <= 0) {
    throw new WholeGameRehearsalRefusal("scrydex-participation-required");
  }
  const estimate = scrydex.plannedRequests;
  if (estimate === null || !Number.isSafeInteger(estimate) || estimate <= 0) {
    throw new WholeGameRehearsalRefusal("scrydex-estimate-unavailable");
  }
  return estimate;
}

export function assertPaidWholeGameConfirmation(
  preview: WholeGamePreviewRecord,
  approvedFingerprint: string,
  approvedLimit: number,
): void {
  const estimate = assertPaidWholeGamePreview(preview);
  if (preview.planFingerprint !== approvedFingerprint) {
    throw new WholeGameRehearsalRefusal("scrydex-approved-fingerprint-mismatch");
  }
  const requiredLimit = estimate + Math.ceil(estimate / 4);
  if (!Number.isSafeInteger(requiredLimit) || approvedLimit !== requiredLimit) {
    throw new WholeGameRehearsalRefusal("scrydex-approved-limit-mismatch");
  }
  if (!preview.confirmAllowed) throw new WholeGameRehearsalRefusal("preview-not-confirmable");
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
export type WholeGamePromoteJob = Pick<CatalogMergeCandidateBulkJob, "jobId" | "kind" | "scopeRecordId" | "status"> &
  Readonly<{
    createdAt?: CatalogMergeCandidateBulkJob["createdAt"];
    // The landed API serializes an absent stored discriminator as null.
    promotionApplicationVersion?: CatalogMergeCandidateBulkJob["promotionApplicationVersion"];
    result:
      | (Pick<CatalogMergeCandidateBulkJobResult, "promoted"> &
          Readonly<{
            failed?: CatalogMergeCandidateBulkJobResult["failed"];
            outcomes: readonly (Pick<CatalogMergeCandidateBulkUnitResult, "status" | "catalogItemId"> &
              Partial<
                Pick<
                  CatalogMergeCandidateBulkUnitResult,
                  | "candidateId"
                  | "disposition"
                  | "appliedCatalogItemId"
                  | "appliedMode"
                  | "approvalVersion"
                  | "planFingerprint"
                  | "diagnosticCode"
                  | "failureDiagnosticCode"
                >
              >)[];
          }>)
      | null;
  }>;

export type WholeGameJobPage = Readonly<{ items: readonly WholeGamePromoteJob[]; cursor?: string }>;

export type WholeGameScopePromotionStep =
  | Readonly<{ kind: "adopt-active-job"; jobIds: readonly string[] }>
  | Readonly<{ kind: "reuse-completed-job"; jobIds: readonly string[] }>
  | Readonly<{ kind: "submit-promote-all-ready" }>;

/** A zero pass is reusable only while both ready and approved candidates remain unchanged. */
export function scopePromotionCheckpoint(
  scopeRecordId: string,
  completedJobs: readonly WholeGamePromoteJob[],
): WholeGamePromoteJob | null {
  const jobs = completedJobs.filter(
    (job) =>
      job.scopeRecordId === scopeRecordId && job.kind === "merge-candidate-promote" && job.status === "completed",
  );
  if (jobs.some((job) => !Number.isFinite(Date.parse(job.createdAt ?? "")))) return null;
  const latest = [...jobs].sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))[0];
  return latest?.promotionApplicationVersion === 1 &&
    latest.result?.promoted === 0 &&
    !latest.result.failed &&
    !latest.result.outcomes.some((outcome) => outcome.status === "failed")
    ? latest
    : null;
}

/** Recover active AND completed work before deciding whether another scope job is necessary. */
export function planScopePromotion(
  scopeRecordId: string,
  activeJobs: readonly WholeGamePromoteJob[],
  completedJobs: readonly WholeGamePromoteJob[] = [],
  changedCandidates = 1,
): WholeGameScopePromotionStep {
  const active = activeJobs.filter(
    (job) => job.scopeRecordId === scopeRecordId && job.kind === "merge-candidate-promote",
  );
  if (active.length > 0) return { kind: "adopt-active-job", jobIds: active.map((job) => job.jobId) };
  const checkpoint = scopePromotionCheckpoint(scopeRecordId, completedJobs);
  if (checkpoint && changedCandidates === 0) return { kind: "reuse-completed-job", jobIds: [checkpoint.jobId] };
  // The scope job also catches up approved-but-unapplied candidates, which
  // the ready projection cannot count. Its zero result proves convergence.
  return { kind: "submit-promote-all-ready" };
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
  throw new WholeGameDeadlineReached();
}

export type WholeGamePromotedItems = Readonly<{
  catalogItemIds: readonly string[];
  promotedOutcomes: number;
  promotedWithoutCatalogItem: number;
}>;

export function promotedCatalogItems(jobs: readonly WholeGamePromoteJob[]): WholeGamePromotedItems {
  const applications = new Map<
    string,
    Readonly<{ catalogItemId: string; mode: string; approvalVersion: number; fingerprint: string }>
  >();
  const legacyApprovals = new Set<string>();
  for (const job of jobs) {
    if (
      job.promotionApplicationVersion !== undefined &&
      job.promotionApplicationVersion !== null &&
      job.promotionApplicationVersion !== 1
    ) {
      throw new WholeGameRehearsalRefusal("promoted-catalog-item-unresolved");
    }
    for (const outcome of job.result?.outcomes ?? []) {
      if (outcome.status !== "promoted") continue;
      if (typeof outcome.candidateId !== "string" || !outcome.candidateId)
        throw new WholeGameRehearsalRefusal("promoted-catalog-item-unresolved");
      if (job.promotionApplicationVersion !== 1) {
        legacyApprovals.add(outcome.candidateId);
        continue;
      }
      if (
        typeof outcome.appliedCatalogItemId !== "string" ||
        !outcome.appliedCatalogItemId ||
        !["create", "refresh", "link-existing"].includes(outcome.appliedMode ?? "") ||
        !Number.isSafeInteger(outcome.approvalVersion) ||
        (outcome.approvalVersion ?? 0) <= 0 ||
        typeof outcome.planFingerprint !== "string" ||
        !outcome.planFingerprint
      ) {
        throw new WholeGameRehearsalRefusal("promoted-catalog-item-unresolved");
      }
      const identity = {
        catalogItemId: outcome.appliedCatalogItemId,
        mode: outcome.appliedMode!,
        approvalVersion: outcome.approvalVersion!,
        fingerprint: outcome.planFingerprint,
      };
      const previous = applications.get(outcome.candidateId);
      if (
        previous &&
        (previous.catalogItemId !== identity.catalogItemId ||
          previous.mode !== identity.mode ||
          previous.approvalVersion !== identity.approvalVersion ||
          previous.fingerprint !== identity.fingerprint)
      )
        throw new WholeGameRehearsalRefusal("promoted-catalog-item-unresolved");
      applications.set(outcome.candidateId, identity);
    }
  }
  return {
    catalogItemIds: [...new Set([...applications.values()].map((identity) => identity.catalogItemId))].sort(),
    promotedOutcomes: applications.size,
    promotedWithoutCatalogItem: [...legacyApprovals].filter((candidateId) => !applications.has(candidateId)).length,
  };
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
export type WholeGamePromotionFailure = Readonly<{
  code: "scope-promotion-failed";
  scopeRecordId: string;
  jobId: string;
  jobStatus: WholeGamePromoteJob["status"];
  failedOutcomes: readonly Readonly<{
    candidateId: string;
    reasonCode: CatalogMergeCandidateApplicationDiagnosticCode | "unclassified";
  }>[];
}>;

export function wholeGamePromotionFailure(job: WholeGamePromoteJob): WholeGamePromotionFailure {
  // `reason` is free text; only the API's classified diagnostic code is support-safe.
  return {
    code: "scope-promotion-failed",
    scopeRecordId: job.scopeRecordId,
    jobId: job.jobId,
    jobStatus: job.status,
    failedOutcomes: (job.result?.outcomes ?? []).flatMap((outcome) =>
      outcome.status === "failed"
        ? [
            {
              candidateId: outcome.candidateId ?? "unavailable",
              reasonCode:
                outcome.diagnosticCode === "asset-processing-failed"
                  ? outcome.diagnosticCode
                  : isCatalogMergeCandidateFailureDiagnosticCode(outcome.failureDiagnosticCode)
                    ? outcome.failureDiagnosticCode
                    : "unclassified",
            },
          ]
        : [],
    ),
  };
}

export type WholeGameScopeProgress = {
  scopeRecordId: string;
  state: "pending" | "promotion-running" | "converged";
  completedJobsObserved: number;
  promotedOutcomes: number;
  jobIds: readonly string[];
  startedAt: string;
  waitStartedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string;
  readyRemaining: number | null;
  changedPromotedRemaining: number | null;
};

export type WholeGameReceipt = Readonly<{
  schemaVersion: typeof wholeGameReceiptSchemaVersion;
  journeyScope: WholeGameJourneyScope;
  sha: string;
  runId: string;
  runAttempt: string;
  batchId: string | null;
  state: "previewed" | "confirmed" | "running" | "cancelled" | "settled" | "failed";
  promotionFailure?: WholeGamePromotionFailure;
  preview: Readonly<{
    planFingerprint: string;
    scopeCount: number;
    providers: readonly WholeGameProviderParticipation[];
    confirmAllowed?: boolean;
    scrydexRequestLimit?: number;
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
    scopeProgress?: readonly WholeGameScopeProgress[];
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
const scopeProgressKeys = [
  "scopeRecordId",
  "state",
  "completedJobsObserved",
  "promotedOutcomes",
  "jobIds",
  "startedAt",
  "waitStartedAt",
  "finishedAt",
  "deadlineAt",
  "readyRemaining",
  "changedPromotedRemaining",
];
const unitStates: readonly WholeGameUnitState[] = ["queued", "running", "completed", "failed", "cancelled"];
const batchStatuses: readonly WholeGameBatchStatus[] = [
  "queued",
  "running",
  "cancelled",
  "completed",
  "partial",
  "failed",
];
const receiptStates = ["previewed", "confirmed", "running", "cancelled", "settled", "failed"];

/** Returns every schema violation; an empty list is the only publishable receipt. */
export function validateWholeGameReceipt(value: unknown): readonly string[] {
  const errors: string[] = [];
  const hasFailure = value !== null && typeof value === "object" && Object.hasOwn(value, "promotionFailure");
  const receipt = record(value, "receipt", hasFailure ? [...receiptKeys, "promotionFailure"] : receiptKeys, errors);
  if (!receipt) return errors;
  if (receipt.schemaVersion !== wholeGameReceiptSchemaVersion) errors.push("schemaVersion");
  if (!wholeGameJourneyScopes.includes(receipt.journeyScope as WholeGameJourneyScope)) errors.push("journeyScope");
  if (typeof receipt.sha !== "string" || !/^[0-9a-f]{40}$/.test(receipt.sha)) errors.push("sha");
  if (typeof receipt.runId !== "string" || !/^\d{1,20}$/.test(receipt.runId)) errors.push("runId");
  if (typeof receipt.runAttempt !== "string" || !/^\d{1,4}$/.test(receipt.runAttempt)) errors.push("runAttempt");
  if (typeof receipt.batchId === "string" && !batchIdPattern.test(receipt.batchId)) errors.push("batchId");
  if (!receiptStates.includes(receipt.state as string)) errors.push("state");
  const previewOnly = receipt.journeyScope === "full-game-preview";
  const paid = previewOnly || receipt.journeyScope === "full-game-confirm";
  if (previewOnly) {
    if (receipt.batchId !== null) errors.push("preview-only-batch-id");
  } else if (typeof receipt.batchId !== "string") errors.push("batchId-required");
  if (previewOnly !== (receipt.state === "previewed")) errors.push("preview-only-state");
  if (
    paid &&
    (receipt.preview === null || receipt.settle !== null || (!previewOnly && receipt.state !== "confirmed"))
  ) {
    errors.push("paid-preview-receipt");
  }
  if (hasFailure !== (receipt.state === "failed")) errors.push("promotionFailure.state");
  if (hasFailure) {
    if (receipt.journeyScope !== "full-game-settle" || receipt.settle === null) errors.push("promotionFailure.settle");
    const failure = record(
      receipt.promotionFailure,
      "promotionFailure",
      ["code", "scopeRecordId", "jobId", "jobStatus", "failedOutcomes"],
      errors,
    );
    if (failure) {
      if (failure.code !== "scope-promotion-failed") errors.push("promotionFailure.code");
      for (const key of ["scopeRecordId", "jobId"])
        if (typeof failure[key] !== "string" || !batchIdPattern.test(failure[key]))
          errors.push(`promotionFailure.${key}`);
      if (!["completed", "failed"].includes(failure.jobStatus as string)) errors.push("promotionFailure.jobStatus");
      if (!Array.isArray(failure.failedOutcomes)) errors.push("promotionFailure.failedOutcomes");
      else
        failure.failedOutcomes.forEach((entry, index) => {
          const path = `promotionFailure.failedOutcomes.${index}`;
          const outcome = record(entry, path, ["candidateId", "reasonCode"], errors);
          if (!outcome) return;
          if (typeof outcome.candidateId !== "string" || !batchIdPattern.test(outcome.candidateId))
            errors.push(`${path}.candidateId`);
          if (
            outcome.reasonCode !== "unclassified" &&
            !isCatalogMergeCandidateApplicationDiagnosticCode(outcome.reasonCode)
          )
            errors.push(`${path}.reasonCode`);
        });
    }
  }

  if (receipt.preview !== null) {
    const preview = record(
      receipt.preview,
      "preview",
      paid ? [...previewKeys, "confirmAllowed", "scrydexRequestLimit"] : previewKeys,
      errors,
    );
    if (preview) {
      if (typeof preview.planFingerprint !== "string" || !/^[A-Za-z0-9:_-]{8,200}$/.test(preview.planFingerprint)) {
        errors.push("preview.planFingerprint");
      }
      if (!count(preview.scopeCount)) errors.push("preview.scopeCount");
      if (paid) {
        if (
          typeof preview.planFingerprint !== "string" ||
          !paidPreviewFingerprintPattern.test(preview.planFingerprint)
        ) {
          errors.push("preview.paidFingerprint");
        }
        if (typeof preview.confirmAllowed !== "boolean" || (!previewOnly && !preview.confirmAllowed)) {
          errors.push("preview.confirmAllowed");
        }
        if (!Number.isSafeInteger(preview.scrydexRequestLimit) || !count(preview.scrydexRequestLimit)) {
          errors.push("preview.scrydexRequestLimit");
        }
      }
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
    const hasProgress = typeof receipt.settle === "object" && Object.hasOwn(receipt.settle, "scopeProgress");
    const settle = record(
      receipt.settle,
      "settle",
      hasProgress ? [...settleKeys, "scopeProgress"] : settleKeys,
      errors,
    );
    if (settle) {
      if (!batchStatuses.includes(settle.batchStatus as WholeGameBatchStatus)) errors.push("settle.batchStatus");
      if (typeof settle.resumed !== "boolean") errors.push("settle.resumed");
      const units = record(settle.units, "settle.units", unitStates, errors);
      if (units) for (const state of unitStates) if (!count(units[state])) errors.push(`settle.units.${state}`);
      for (const key of settleCountKeys) if (!count(settle[key])) errors.push(`settle.${key}`);
      if (hasProgress) {
        if (!Array.isArray(settle.scopeProgress)) errors.push("settle.scopeProgress");
        else
          settle.scopeProgress.forEach((entry, index) => {
            const path = `settle.scopeProgress.${index}`;
            const progress = record(entry, path, scopeProgressKeys, errors);
            if (!progress) return;
            if (typeof progress.scopeRecordId !== "string" || !batchIdPattern.test(progress.scopeRecordId))
              errors.push(`${path}.scopeRecordId`);
            if (!["pending", "promotion-running", "converged"].includes(progress.state as string))
              errors.push(`${path}.state`);
            for (const key of ["completedJobsObserved", "promotedOutcomes"])
              if (!count(progress[key])) errors.push(`${path}.${key}`);
            for (const key of ["readyRemaining", "changedPromotedRemaining"])
              if (progress[key] !== null && !count(progress[key])) errors.push(`${path}.${key}`);
            if (
              !Array.isArray(progress.jobIds) ||
              progress.jobIds.some((id) => typeof id !== "string" || !batchIdPattern.test(id))
            )
              errors.push(`${path}.jobIds`);
            for (const key of ["startedAt", "waitStartedAt", "finishedAt", "deadlineAt"]) {
              if ((key === "waitStartedAt" || key === "finishedAt") && progress[key] === null) continue;
              if (typeof progress[key] !== "string" || !Number.isFinite(Date.parse(progress[key] as string)))
                errors.push(`${path}.${key}`);
            }
          });
      }
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
