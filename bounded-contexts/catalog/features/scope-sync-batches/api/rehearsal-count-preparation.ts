import type { z } from "zod";
import {
  countFingerprint,
  countPreparationViewSchema,
  countQueryKey,
  countQuoteSchema,
  countTimeIsCurrent,
} from "../domain/count-acquisition";
import {
  parseRehearsalCountPreparationApproval,
  rehearsalCountAcquisitionOutcome,
  rehearsalCountAdmissionRefusal,
  rehearsalCountPreparationMaxScopes,
  rehearsalCountPreparationMaxTargets,
  rehearsalCountPreparationReceiptSchemaVersion,
  rehearsalCountPreparationSelection,
  RehearsalCountPreparationRefusal,
  type RehearsalCountPreparationAccounting,
  type RehearsalCountPreparationApproval,
  type RehearsalCountPreparationOutcome,
  type RehearsalCountPreparationPass,
  type RehearsalCountPreparationReceipt,
  type RehearsalCountPreparationRefusalCode,
} from "../domain/rehearsal-count-preparation-receipt";

// Staging-only preparation of governed Scrydex counts before a whole-game
// rehearsal pass reserves and starts its batch. It drives only the existing
// count routes: one quote, or one host-approved whole-quote acquisition between
// two preparation reads of current authority and quote debits. It never
// previews, confirms, enqueues, refreshes usage, discovers, retries, follows
// redirects or reads a second page, and it never holds provider credentials;
// the server's locked admission and claims own every debit and send.

// A maximum 10000-target quote with 10000 debits and long but valid query fields
// serializes to roughly 15 MiB; anything larger is refused rather than truncated.
export const rehearsalCountAdminMaxResponseBytes = 32 * 1024 * 1024;
const readTimeoutMs = 120_000;
// The acquisition sends serially server-side, so its single submission waits longer
// (inside the 10-minute workflow step); a timeout is still an uncertain stop.
const acquireTimeoutMs = 8 * 60 * 1000;
const ageLimitMs = 15 * 60 * 1000;

export type RehearsalCountAdminResponse = Readonly<{ status: number; body: unknown }>;
export type RehearsalCountAdmin = Readonly<{
  quote(input: { selection: unknown; cap?: number }): Promise<RehearsalCountAdminResponse>;
  readPreparation(quoteId: string): Promise<RehearsalCountAdminResponse>;
  acquire(input: { quoteId: string; fingerprint: string }): Promise<RehearsalCountAdminResponse>;
}>;
export type RehearsalCountRunIdentity = Readonly<{ sha: string; runId: string; runAttempt: string }>;

export class RehearsalCountResponseOverflow extends Error {
  constructor() {
    super("Count preparation response exceeded its bound.");
    this.name = "RehearsalCountResponseOverflow";
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RehearsalCountResponseOverflow();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Same-origin Admin client for the existing count routes; redirects are returned, never followed. */
export function createRehearsalCountAdminClient(deps: {
  origin: string;
  cookie: string;
  fetch: typeof globalThis.fetch;
  maxResponseBytes?: number;
}): RehearsalCountAdmin {
  const base = `${deps.origin}/api/catalog/scope-sync-batches/counts`;
  async function call(path: string, body?: unknown, timeoutMs = readTimeoutMs): Promise<RehearsalCountAdminResponse> {
    const response = await deps.fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: deps.cookie,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", origin: deps.origin, "sec-fetch-site": "same-origin" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: null };
    }
    const text = await readBounded(response, deps.maxResponseBytes ?? rehearsalCountAdminMaxResponseBytes);
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  }
  return {
    quote: (input) => call("/quote", input.cap === undefined ? { selection: input.selection } : input),
    readPreparation: (quoteId) => call(`/quote/${encodeURIComponent(quoteId)}?view=preparation`),
    // Preparation only ever submits whole-quote admission; stripping it is the server's to refuse.
    acquire: (input) =>
      call(
        "/acquire",
        { quoteId: input.quoteId, fingerprint: input.fingerprint, admission: "whole-quote" },
        acquireTimeoutMs,
      ),
  };
}

type ParsedQuote = z.infer<typeof countQuoteSchema>;
type ParsedView = z.infer<typeof countPreparationViewSchema>;
type ParsedTarget = ParsedQuote["targets"][number];
type ReceiptSource = RehearsalCountPreparationReceipt["sources"][number];
type Inspection = Readonly<{
  roster: RehearsalCountPreparationReceipt["roster"];
  sources: readonly ReceiptSource[];
  scopeCount: number;
  unpaid: Readonly<{ cards: number; sealed: number }>;
  refusal: RehearsalCountPreparationRefusalCode | null;
}>;

const entryKey = (entry: { scopeRecordId: string; kind: string }) => `${entry.scopeRecordId}\u0000${entry.kind}`;

/** A target's source counts only when it answers that exact query and is current at `at`. */
function receiptSource(target: ParsedTarget, at: string): ReceiptSource | null {
  const source = target.source;
  if (!source || countQueryKey(source.query) !== countQueryKey(target.query) || !countTimeIsCurrent(source, at))
    return null;
  const returnedItemCount = source.validationKind === "page-1-count" ? source.returnedItemCount : null;
  // Page 1 proves a count only when it returned exactly min(total, page size) items.
  if (
    returnedItemCount === undefined ||
    (returnedItemCount !== null && returnedItemCount !== Math.min(source.totalCount, source.pageSize))
  )
    return null;
  return {
    scopeRecordId: target.scopeRecordId,
    kind: target.query.kind,
    queryFingerprint: countQueryKey(target.query),
    sourceId: source.sourceId,
    validationKind: source.validationKind,
    totalCount: source.totalCount,
    pageSize: source.pageSize,
    returnedItemCount,
    observedAt: source.observedAt,
    expiresAt: source.expiresAt,
  };
}

/** Roster checks shared by quote and pre-acquire reads: complete, in-pass, one claim per kind, no blockers. */
function inspect(quote: ParsedQuote, pass: RehearsalCountPreparationPass, at: string): Inspection {
  const roster: RehearsalCountPreparationReceipt["roster"][number][] = [];
  const sources: ReceiptSource[] = [];
  const keys = new Set<string>();
  const scopes = new Set<string>();
  const unpaid = { cards: 0, sealed: 0 };
  let refusal: RehearsalCountPreparationRefusalCode | null = null;
  const refuse = (code: RehearsalCountPreparationRefusalCode) => {
    refusal ??= code;
  };
  // Retained quotes come back from JSONB, which reorders keys; compare canonically.
  if (countFingerprint(quote.selection) !== countFingerprint(rehearsalCountPreparationSelection(pass)))
    refuse("quote-selection-mismatch");
  if (quote.targets.length > rehearsalCountPreparationMaxTargets) refuse("roster-overflow");
  for (const target of quote.targets) {
    const key = entryKey({ scopeRecordId: target.scopeRecordId, kind: target.query.kind });
    scopes.add(target.scopeRecordId);
    if (target.query.productDomain !== pass.productDomain) refuse("roster-domain-mismatch");
    if (target.query.languageCode !== (pass.languageCode ?? "en")) refuse("roster-language-mismatch");
    if (target.query.productDomain === "lorcana" && target.query.kind === "sealed") refuse("lorcana-sealed");
    if (keys.has(key)) refuse("roster-duplicate-kind");
    keys.add(key);
    const source = receiptSource(target, at);
    if (target.source && !source) refuse("reused-source-expired");
    if (target.blocked && !target.source) refuse("blocked-targets");
    if (source) sources.push(source);
    else unpaid[target.query.kind] += 1;
    roster.push({
      scopeRecordId: target.scopeRecordId,
      kind: target.query.kind,
      parentValue: target.query.parentValue,
      queryFingerprint: countQueryKey(target.query),
      state: source ? "reused" : target.blocked ? "blocked" : "missing",
    });
  }
  if (scopes.size > rehearsalCountPreparationMaxScopes) refuse("roster-overflow");
  if (quote.plannedCredits > 2 * scopes.size) refuse("per-set-limit");
  return { roster, sources, scopeCount: scopes.size, unpaid, refusal };
}

function authorityRefusal(quote: ParsedQuote, at: string): RehearsalCountPreparationRefusalCode | null {
  if (!quote.authority.allowed || quote.authority.headroom === null) return "authority-unavailable";
  if (quote.authority.headroom < quote.plannedCredits) return "headroom-below-planned";
  if (quote.cap < quote.plannedCredits) return "cap-below-planned";
  if (Date.parse(quote.expiresAt) < Date.parse(at)) return "quote-expired";
  return null;
}

function parseQuote(response: RehearsalCountAdminResponse): ParsedQuote | null {
  if (response.status !== 200) return null;
  const parsed = countQuoteSchema.safeParse(response.body);
  return parsed.success ? parsed.data : null;
}

function parseView(response: RehearsalCountAdminResponse): ParsedView | null {
  if (response.status !== 200) return null;
  const parsed = countPreparationViewSchema.safeParse(response.body);
  return parsed.success ? parsed.data : null;
}

// These refusals mean the server quote itself breaks the preparation invariants
// (or is not the approved quote), so the receipt records the code without it.
const quoteWithheld = new Set<RehearsalCountPreparationRefusalCode>([
  "quote-invalid",
  "quote-selection-mismatch",
  "quote-binding-mismatch",
  "roster-overflow",
  "roster-domain-mismatch",
  "roster-language-mismatch",
  "roster-duplicate-kind",
  "lorcana-sealed",
  "per-set-limit",
  "reused-source-expired",
]);

type ReceiptBase = Pick<RehearsalCountPreparationReceipt, "mode" | "dispatchId" | "pass" | "approval">;

function receipt(
  run: RehearsalCountRunIdentity,
  base: ReceiptBase,
  completedAt: string,
  fields: Partial<RehearsalCountPreparationReceipt> & { outcome: RehearsalCountPreparationOutcome },
): RehearsalCountPreparationReceipt {
  return {
    schemaVersion: rehearsalCountPreparationReceiptSchemaVersion,
    mode: base.mode,
    sha: run.sha,
    runId: run.runId,
    runAttempt: run.runAttempt,
    dispatchId: base.dispatchId,
    pass: base.pass,
    selection: rehearsalCountPreparationSelection(base.pass),
    approval: base.approval,
    quote: null,
    authority: null,
    roster: [],
    acquisition: null,
    sources: [],
    accounting: null,
    refusal: null,
    completedAt,
    ...fields,
  };
}

function quoteSummary(
  quote: ParsedQuote,
  inspection: Inspection,
  perKindCost: Readonly<{ cards: number; sealed: number }>,
): NonNullable<RehearsalCountPreparationReceipt["quote"]> {
  return {
    quoteId: quote.quoteId,
    fingerprint: quote.fingerprint,
    membershipFingerprint: quote.membershipFingerprint,
    expiresAt: quote.expiresAt,
    plannedCredits: quote.plannedCredits,
    cap: quote.cap,
    perKindCost: { cards: perKindCost.cards, sealed: perKindCost.sealed },
    scopeCount: inspection.scopeCount,
    targetCount: quote.targets.length,
    authority: quote.authority,
  };
}

/**
 * Quote mode: one zero-provider quote of the pass's complete selection, for the
 * host's pre-spend notice. It spends nothing and approves nothing.
 */
export async function quoteRehearsalCounts(input: {
  admin: RehearsalCountAdmin;
  run: RehearsalCountRunIdentity;
  dispatchId: string;
  pass: RehearsalCountPreparationPass;
  cap?: number;
  now: () => string;
}): Promise<RehearsalCountPreparationReceipt> {
  const base: ReceiptBase = { mode: "quote", dispatchId: input.dispatchId, pass: input.pass, approval: null };
  if (input.cap !== undefined && (!Number.isSafeInteger(input.cap) || input.cap < 0 || input.cap > 10_000))
    throw new RehearsalCountPreparationRefusal("cap-invalid");
  let response: RehearsalCountAdminResponse;
  try {
    response = await input.admin.quote({ selection: rehearsalCountPreparationSelection(input.pass), cap: input.cap });
  } catch (error) {
    const refusal = error instanceof RehearsalCountResponseOverflow ? "response-overflow" : "quote-unavailable";
    return receipt(input.run, base, input.now(), { outcome: "refused", refusal });
  }
  const quote = parseQuote(response);
  if (!quote)
    return receipt(input.run, base, input.now(), {
      outcome: "refused",
      refusal: response.status === 200 ? "quote-invalid" : "quote-unavailable",
    });
  const at = input.now();
  const inspection = inspect(quote, input.pass, at);
  const unpaid = inspection.unpaid.cards + inspection.unpaid.sealed;
  const refusal =
    inspection.refusal ??
    (unpaid !== quote.plannedCredits || quote.state !== "quoted"
      ? "quote-invalid"
      : quote.plannedCredits === 0
        ? null
        : authorityRefusal(quote, at));
  if (refusal && quoteWithheld.has(refusal)) return receipt(input.run, base, at, { outcome: "refused", refusal });
  return receipt(input.run, base, at, {
    quote: quoteSummary(quote, inspection, inspection.unpaid),
    roster: inspection.roster,
    sources: [...inspection.sources],
    outcome: refusal ? "refused" : quote.plannedCredits === 0 ? "not-required" : "quoted",
    refusal,
  });
}

function currentAt(value: string, now: string): boolean {
  const age = Date.parse(now) - Date.parse(value);
  return age >= 0 && age <= ageLimitMs;
}

/**
 * Admits the host approval before any network access: closed shape, bound to
 * this pass and dispatch, fresh approval and Admin usage authority, and a cap and
 * headroom that cover every planned credit (no intentional partial purchase).
 */
export function admitRehearsalCountAcquisition(input: {
  approval: string;
  pass: RehearsalCountPreparationPass;
  dispatchId: string;
  now: string;
}): RehearsalCountPreparationApproval {
  const approval = parseRehearsalCountPreparationApproval(input.approval);
  if (countFingerprint(approval.pass) !== countFingerprint(input.pass))
    throw new RehearsalCountPreparationRefusal("approval-pass-mismatch");
  if (approval.dispatchId !== input.dispatchId)
    throw new RehearsalCountPreparationRefusal("approval-dispatch-mismatch");
  if (approval.perKindCost.cards + approval.perKindCost.sealed !== approval.plannedCredits)
    throw new RehearsalCountPreparationRefusal("approval-invalid");
  if (approval.plannedCredits < 1) throw new RehearsalCountPreparationRefusal("nothing-to-acquire");
  if (approval.pass.productDomain === "lorcana" && approval.perKindCost.sealed > 0)
    throw new RehearsalCountPreparationRefusal("lorcana-sealed");
  if (approval.cap < approval.plannedCredits) throw new RehearsalCountPreparationRefusal("cap-below-planned");
  if (approval.authority.headroom < approval.plannedCredits)
    throw new RehearsalCountPreparationRefusal("headroom-below-planned");
  if (!currentAt(approval.approvedAt, input.now)) throw new RehearsalCountPreparationRefusal("approval-stale");
  if (!currentAt(approval.authority.observedAt, input.now))
    throw new RehearsalCountPreparationRefusal("authority-stale");
  if (Date.parse(approval.quote.expiresAt) < Date.parse(input.now))
    throw new RehearsalCountPreparationRefusal("quote-expired");
  return approval;
}

function boundRefusal(
  quote: ParsedQuote,
  approval: RehearsalCountPreparationApproval,
  inspection: Inspection,
  at: string,
): RehearsalCountPreparationRefusalCode | null {
  if (
    quote.quoteId !== approval.quote.quoteId ||
    quote.fingerprint !== approval.quote.fingerprint ||
    quote.membershipFingerprint !== approval.quote.membershipFingerprint ||
    quote.expiresAt !== approval.quote.expiresAt ||
    quote.plannedCredits !== approval.plannedCredits ||
    quote.cap !== approval.cap ||
    quote.authority.fingerprint !== approval.authority.fingerprint
  )
    return "quote-binding-mismatch";
  if (inspection.refusal) return inspection.refusal;
  // A concurrent fill may only lower the approved per-kind cost.
  if (inspection.unpaid.cards > approval.perKindCost.cards || inspection.unpaid.sealed > approval.perKindCost.sealed)
    return "quote-binding-mismatch";
  if (quote.state !== "quoted") return "quote-not-pending";
  return authorityRefusal(quote, at);
}

/** The retained read counts only when it is the same quote with the same exact-query roster. */
function unchangedReadback(pending: ParsedQuote, retained: ParsedView | null): ParsedView | null {
  return retained &&
    retained.quote.quoteId === pending.quoteId &&
    retained.quote.fingerprint === pending.fingerprint &&
    retained.quote.targets.length === pending.targets.length &&
    retained.quote.targets.every(
      (target, index) =>
        target.scopeRecordId === pending.targets[index]!.scopeRecordId &&
        countQueryKey(target.query) === countQueryKey(pending.targets[index]!.query),
    )
    ? retained
    : null;
}

/**
 * The quote's debits exactly as the server projected them. A row must answer one
 * of this quote's exact queries, and an entry it already reuses only through
 * that debit's own result; any other row makes the accounting unknown rather
 * than being carried into the receipt.
 */
function accountingOf(view: ParsedView, inspection: Inspection): RehearsalCountPreparationAccounting {
  const roster = new Map(inspection.roster.map((entry) => [entryKey(entry), entry]));
  const sources = new Map(inspection.sources.map((source) => [entryKey(source), source]));
  const debits = view.debits.rows.filter((row) => {
    const entry = roster.get(entryKey(row));
    return (
      row.quoteId === view.quote.quoteId &&
      entry?.queryFingerprint === row.queryFingerprint &&
      (entry.state !== "reused" || sources.get(entryKey(row))?.sourceId === row.debitId)
    );
  });
  const complete =
    view.debits.status === "complete" &&
    debits.length === view.debits.rows.length &&
    view.debits.fingerprint === countFingerprint(view.debits.rows);
  return complete
    ? { status: "complete", reason: null, readAt: view.debits.readAt, fingerprint: view.debits.fingerprint, debits }
    : {
        status: "unknown",
        reason: view.debits.status === "unknown" ? (view.debits.reason ?? "invalid-row") : "invalid-row",
        readAt: view.debits.readAt,
        fingerprint: null,
        debits,
      };
}

const unknownAccounting = (
  readAt: string,
  reason: "pre-read-failed" | "quote-withheld" | "readback-failed",
): RehearsalCountPreparationAccounting => ({ status: "unknown", reason, readAt, fingerprint: null, debits: [] });

/**
 * Acquire mode: read current authority and quote debits, submit whole-quote
 * admission once, then read them once more. Anything short of a complete
 * response, accounting and current exact-source readback stops with every
 * possible-send debit retained server-side and listed in the receipt.
 */
export async function acquireRehearsalCounts(input: {
  admin: RehearsalCountAdmin;
  run: RehearsalCountRunIdentity;
  approval: RehearsalCountPreparationApproval;
  now: () => string;
}): Promise<RehearsalCountPreparationReceipt> {
  const { approval } = input;
  const base: ReceiptBase = {
    mode: "acquire",
    dispatchId: approval.dispatchId,
    pass: approval.pass,
    approval: {
      approvalId: approval.approvalId,
      approvedAt: approval.approvedAt,
      authorityObservedAt: approval.authority.observedAt,
      authorityHeadroom: approval.authority.headroom,
      authorityFingerprint: approval.authority.fingerprint,
    },
  };
  let pending: ParsedView | null;
  try {
    pending = parseView(await input.admin.readPreparation(approval.quote.quoteId));
  } catch {
    pending = null;
  }
  if (!pending) {
    const at = input.now();
    return receipt(input.run, base, at, {
      outcome: "refused",
      refusal: "quote-readback-failed",
      accounting: unknownAccounting(at, "pre-read-failed"),
    });
  }
  const before = input.now();
  const inspection = inspect(pending.quote, approval.pass, before);
  const refusal =
    boundRefusal(pending.quote, approval, inspection, before) ?? rehearsalCountAdmissionRefusal(pending, approval);
  if (refusal && quoteWithheld.has(refusal))
    return receipt(input.run, base, before, {
      outcome: "refused",
      refusal,
      accounting: unknownAccounting(before, "quote-withheld"),
    });
  // The displayed per-kind cost is the approved one; the quote's P and cap equal the approval's here.
  const quote = quoteSummary(pending.quote, inspection, approval.perKindCost);
  const authority = pending.currentAuthority;
  if (refusal)
    return receipt(input.run, base, before, {
      quote,
      authority,
      roster: inspection.roster,
      sources: [...inspection.sources],
      accounting: accountingOf(pending, inspection),
      outcome: "refused",
      refusal,
    });

  const submittedAt = input.now();
  let response: NonNullable<RehearsalCountPreparationReceipt["acquisition"]>["response"] = {
    status: null,
    state: null,
  };
  try {
    const result = await input.admin.acquire({
      quoteId: pending.quote.quoteId,
      fingerprint: pending.quote.fingerprint,
    });
    response = { status: result.status, state: parseQuote(result)?.state ?? null };
  } catch {
    // An interrupted or overflowing submission may have sent; it stays uncertain.
  }
  let retained: ParsedView | null;
  try {
    retained = unchangedReadback(pending.quote, parseView(await input.admin.readPreparation(pending.quote.quoteId)));
  } catch {
    retained = null;
  }
  const readAt = input.now();
  const sources = (retained?.quote.targets ?? []).flatMap((target) => {
    const source = receiptSource(target, readAt);
    return source ? [source] : [];
  });
  const accounting = retained ? accountingOf(retained, inspection) : unknownAccounting(readAt, "readback-failed");
  const readback = retained
    ? { readAt, status: "read" as const, state: retained.quote.state, admission: retained.admission.state }
    : { readAt, status: "failed" as const, state: null, admission: null };
  return receipt(input.run, base, readAt, {
    quote,
    authority,
    roster: inspection.roster,
    acquisition: { admission: "whole-quote", submittedAt, response, readback },
    sources,
    accounting,
    outcome: rehearsalCountAcquisitionOutcome({
      response,
      readback,
      accounting,
      sourced: sources.length === inspection.roster.length,
    }),
  });
}
