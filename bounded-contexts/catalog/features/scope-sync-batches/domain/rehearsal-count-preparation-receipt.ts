import { z } from "zod";
import { countFingerprint, countTimeIsCurrent, type CountPreparationView } from "./count-acquisition";

// Governed Scrydex count preparation for a whole-game rehearsal pass. The
// receipt is the only artifact the staging workflow may upload: a closed,
// count-only record of the quote, the host approval it was bound to, the
// current authority it was admitted against, the single whole-quote acquisition
// and the exhaustive accounting of every debit the quote owns. It never carries
// URLs, payloads, account identifiers, cookies or credentials, and it never
// grants batch, preview, confirm or reservation authority.

export const rehearsalCountPreparationReceiptPath = "artifacts/catalog-count-preparation/receipt.json";
// v1 receipts derived debits from successful sources and are historical evidence only.
export const rehearsalCountPreparationReceiptSchemaVersion = "catalog-rehearsal-count-preparation-receipt/v2";
export const rehearsalCountPreparationApprovalSchemaVersion = "catalog-rehearsal-count-preparation-approval/v1";
export const rehearsalCountPreparationStagingOrigin = "https://admin.staging.chasesets.com";
export const rehearsalCountPreparationCredentialNames = [
  "CATALOG_ADMIN_E2E_EMAIL",
  "CATALOG_ADMIN_E2E_PASSWORD",
] as const;
export const rehearsalCountPreparationDomains = ["magic", "one-piece", "pokemon", "yugioh", "lorcana"] as const;
export const rehearsalCountPreparationMaxScopes = 5000;
export const rehearsalCountPreparationMaxTargets = 10_000;
const maxReceiptBytes = 16 * 1024 * 1024;

export const rehearsalCountPreparationRefusalCodes = [
  "pass-invalid",
  "dispatch-invalid",
  "cap-invalid",
  "approval-invalid",
  "approval-pass-mismatch",
  "approval-dispatch-mismatch",
  "approval-stale",
  "authority-stale",
  "nothing-to-acquire",
  "quote-unavailable",
  "quote-invalid",
  "quote-readback-failed",
  "quote-binding-mismatch",
  "quote-not-pending",
  "quote-expired",
  "quote-selection-mismatch",
  "response-overflow",
  "roster-overflow",
  "roster-domain-mismatch",
  "roster-language-mismatch",
  "roster-duplicate-kind",
  "lorcana-sealed",
  "per-set-limit",
  "reused-source-expired",
  "blocked-targets",
  "authority-unavailable",
  "authority-changed",
  "accounting-unavailable",
  "headroom-below-planned",
  "cap-below-planned",
] as const;
export type RehearsalCountPreparationRefusalCode = (typeof rehearsalCountPreparationRefusalCodes)[number];

export class RehearsalCountPreparationRefusal extends Error {
  readonly code: RehearsalCountPreparationRefusalCode;
  constructor(code: RehearsalCountPreparationRefusalCode) {
    super(`Count preparation refused: ${code}.`);
    this.name = "RehearsalCountPreparationRefusal";
    this.code = code;
  }
}

const integer = z.number().int().min(0).max(2147483647);
const credits = integer.max(rehearsalCountPreparationMaxTargets);
const instant = z.iso.datetime({ offset: true });
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const kind = z.enum(["cards", "sealed"]);
const quoteState = z.enum(["quoted", "approved", "acquiring", "complete", "failed", "uncertain"]);
const admissionState = z.enum(["none", "active", "ended", "expired"]);
const languageCode = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/)
  .nullable();
const sourceId = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[a-f0-9]{64})$/);

const passSchema = z
  .object({
    passNumber: z.union([z.literal(1), z.literal(2)]),
    productDomain: z.enum(rehearsalCountPreparationDomains),
    languageCode,
    scopeKind: z.enum(["set", "expansion"]),
  })
  .strict()
  .refine((pass) => pass.scopeKind === scopeKindFor(pass.productDomain));
export type RehearsalCountPreparationPass = z.infer<typeof passSchema>;

/** The whole-game start journey selects `set` scopes, and Pokemon `expansion` scopes. */
function scopeKindFor(productDomain: string): "set" | "expansion" {
  return productDomain === "pokemon" ? "expansion" : "set";
}

export function parseRehearsalCountPreparationPass(input: {
  passNumber: unknown;
  productDomain: unknown;
  languageCode: unknown;
}): RehearsalCountPreparationPass {
  const productDomain = typeof input.productDomain === "string" ? input.productDomain.trim() : "";
  const language = typeof input.languageCode === "string" ? input.languageCode.trim() : "";
  const parsed = passSchema.safeParse({
    passNumber:
      input.passNumber === "1" || input.passNumber === 1
        ? 1
        : input.passNumber === "2" || input.passNumber === 2
          ? 2
          : 0,
    productDomain,
    languageCode: language || null,
    scopeKind: scopeKindFor(productDomain),
  });
  if (!parsed.success) throw new RehearsalCountPreparationRefusal("pass-invalid");
  return parsed.data;
}

/** The exact matching-scope selection the start journey submits for this pass. */
export function rehearsalCountPreparationSelection(pass: RehearsalCountPreparationPass) {
  return {
    mode: "matching-scope" as const,
    query: { productDomain: pass.productDomain, scopeKind: pass.scopeKind, languageCode: pass.languageCode },
  };
}

export function parseRehearsalCountPreparationDispatchId(value: unknown): string {
  const parsed = token.safeParse(typeof value === "string" ? value.trim() : value);
  if (!parsed.success) throw new RehearsalCountPreparationRefusal("dispatch-invalid");
  return parsed.data;
}

const approvalSchema = z
  .object({
    schemaVersion: z.literal(rehearsalCountPreparationApprovalSchemaVersion),
    dispatchId: token,
    approvalId: token,
    approvedAt: instant,
    pass: passSchema,
    quote: z
      .object({ quoteId: z.uuid(), fingerprint: hex64, membershipFingerprint: hex64, expiresAt: instant })
      .strict(),
    plannedCredits: credits,
    perKindCost: z.object({ cards: credits, sealed: credits }).strict(),
    cap: credits,
    authority: z.object({ fingerprint: hex64, headroom: integer, observedAt: instant }).strict(),
  })
  .strict();
export type RehearsalCountPreparationApproval = z.infer<typeof approvalSchema>;

/** Parses the host's pre-spend approval; any shape defect refuses before network access. */
export function parseRehearsalCountPreparationApproval(value: string): RehearsalCountPreparationApproval {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new RehearsalCountPreparationRefusal("approval-invalid");
  }
  const parsed = approvalSchema.safeParse(candidate);
  if (!parsed.success) throw new RehearsalCountPreparationRefusal("approval-invalid");
  return parsed.data;
}

const rosterEntrySchema = z
  .object({
    scopeRecordId: token,
    kind,
    parentValue: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    queryFingerprint: hex64,
    state: z.enum(["reused", "missing", "blocked"]),
  })
  .strict();
const sourceSchema = z
  .object({
    scopeRecordId: token,
    kind,
    queryFingerprint: hex64,
    sourceId,
    validationKind: z.enum(["page-1-count", "complete-cache"]),
    totalCount: integer,
    pageSize: integer.min(1),
    returnedItemCount: integer.nullable(),
    observedAt: instant,
    expiresAt: instant,
  })
  .strict();
const debitSchema = z
  .object({
    quoteId: z.uuid(),
    scopeRecordId: token,
    kind,
    queryFingerprint: hex64,
    debitId: z.uuid(),
    credits: z.literal(1),
    debitedAt: instant,
    outcome: z.enum(["acquiring", "complete", "failed", "uncertain"]),
    observedAt: instant.nullable(),
    expiresAt: instant.nullable(),
  })
  .strict();
export const rehearsalCountPreparationOutcomes = [
  "quoted",
  "not-required",
  "refused",
  "admission-refused",
  "complete",
  "partial",
  "failed",
  "uncertain",
  "readback-failed",
] as const;
const receiptSchema = z
  .object({
    schemaVersion: z.literal(rehearsalCountPreparationReceiptSchemaVersion),
    mode: z.enum(["quote", "acquire"]),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    runId: z.string().regex(/^\d{1,20}$/),
    runAttempt: z.string().regex(/^\d{1,6}$/),
    dispatchId: token,
    pass: passSchema,
    selection: z
      .object({
        mode: z.literal("matching-scope"),
        query: z
          .object({
            productDomain: z.enum(rehearsalCountPreparationDomains),
            scopeKind: z.enum(["set", "expansion"]),
            languageCode,
          })
          .strict(),
      })
      .strict(),
    approval: z
      .object({
        approvalId: token,
        approvedAt: instant,
        authorityObservedAt: instant,
        authorityHeadroom: integer,
        authorityFingerprint: hex64,
      })
      .strict()
      .nullable(),
    quote: z
      .object({
        quoteId: z.uuid(),
        fingerprint: hex64,
        membershipFingerprint: hex64,
        expiresAt: instant,
        plannedCredits: credits,
        cap: credits,
        perKindCost: z.object({ cards: credits, sealed: credits }).strict(),
        scopeCount: integer.max(rehearsalCountPreparationMaxScopes),
        targetCount: integer.max(rehearsalCountPreparationMaxTargets),
        authority: z.object({ fingerprint: hex64, headroom: integer.nullable(), allowed: z.boolean() }).strict(),
      })
      .strict()
      .nullable(),
    // Current net authority from the pre-acquire read, never the quote's stored authority.
    authority: z
      .object({
        readAt: instant,
        usageFingerprint: hex64,
        usageObservedAt: instant.nullable(),
        state: z.enum(["allowed", "unknown"]),
        headroom: integer.nullable(),
      })
      .strict()
      .nullable(),
    roster: z.array(rosterEntrySchema).max(rehearsalCountPreparationMaxTargets),
    acquisition: z
      .object({
        admission: z.literal("whole-quote"),
        submittedAt: instant,
        response: z
          .object({ status: z.number().int().min(100).max(599).nullable(), state: quoteState.nullable() })
          .strict(),
        readback: z
          .object({
            readAt: instant,
            status: z.enum(["read", "failed"]),
            state: quoteState.nullable(),
            admission: admissionState.nullable(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    sources: z.array(sourceSchema).max(rehearsalCountPreparationMaxTargets),
    // Every debit the quote owns, independent of sources: complete is an exhaustive
    // ledger snapshot at readAt, unknown keeps only the rows that could be read.
    accounting: z
      .object({
        status: z.enum(["complete", "unknown"]),
        reason: z.enum(["pre-read-failed", "quote-withheld", "readback-failed", "overflow", "invalid-row"]).nullable(),
        readAt: instant,
        fingerprint: hex64.nullable(),
        debits: z.array(debitSchema).max(rehearsalCountPreparationMaxTargets),
      })
      .strict()
      .nullable(),
    outcome: z.enum(rehearsalCountPreparationOutcomes),
    refusal: z.enum(rehearsalCountPreparationRefusalCodes).nullable(),
    completedAt: instant,
  })
  .strict();
export type RehearsalCountPreparationReceipt = z.infer<typeof receiptSchema>;
export type RehearsalCountPreparationOutcome = RehearsalCountPreparationReceipt["outcome"];
export type RehearsalCountPreparationAccounting = NonNullable<RehearsalCountPreparationReceipt["accounting"]>;

export type RehearsalCountPreparationExpectation = Readonly<{
  sha?: string;
  runId?: string;
  runAttempt?: string;
  forbiddenValues: readonly string[];
}>;

/**
 * The pre-acquire admission check over the immediate preparation read: the quote
 * is untouched, its debits are fully accounted, and current net authority under
 * the approved usage fingerprint still covers the whole approved P.
 */
export function rehearsalCountAdmissionRefusal(
  view: CountPreparationView,
  approval: Pick<RehearsalCountPreparationApproval, "plannedCredits" | "authority">,
): RehearsalCountPreparationRefusalCode | null {
  if (view.admission.state !== "none" || view.quote.state !== "quoted" || view.debits.rows.length > 0)
    return "quote-not-pending";
  if (view.debits.status !== "complete") return "accounting-unavailable";
  const current = view.currentAuthority;
  if (current.state !== "allowed" || current.headroom === null) return "authority-unavailable";
  if (current.usageFingerprint !== approval.authority.fingerprint) return "authority-changed";
  if (current.headroom < approval.plannedCredits) return "headroom-below-planned";
  return null;
}

/**
 * Classifies one submitted acquisition. A 409 is the locked admission refusing
 * this submission before any allocation, debit or send; debits a concurrent
 * execution of the same quote still has in flight stay in the accounting.
 * Otherwise any possible send left uncertain or acquiring is uncertain; only a
 * complete response, readback, accounting and every roster source is complete.
 */
export function rehearsalCountAcquisitionOutcome(input: {
  response: NonNullable<RehearsalCountPreparationReceipt["acquisition"]>["response"];
  readback: NonNullable<RehearsalCountPreparationReceipt["acquisition"]>["readback"];
  accounting: RehearsalCountPreparationAccounting;
  sourced: boolean;
}): RehearsalCountPreparationOutcome {
  const { response, readback, accounting } = input;
  if (response.status === 409) return "admission-refused";
  if (
    response.status === null ||
    response.status >= 500 ||
    response.state === "uncertain" ||
    (response.status === 200 && response.state === null) ||
    accounting.debits.some((debit) => debit.outcome === "uncertain" || debit.outcome === "acquiring")
  )
    return "uncertain";
  if (response.status !== 200 || response.state !== "complete") return "failed";
  if (readback.status !== "read") return "readback-failed";
  if (
    accounting.status !== "complete" ||
    readback.state !== "complete" ||
    readback.admission !== "ended" ||
    accounting.debits.some((debit) => debit.outcome !== "complete") ||
    !input.sourced
  )
    return "partial";
  return "complete";
}

const quoteOutcomes = new Set<RehearsalCountPreparationOutcome>(["quoted", "not-required", "refused"]);
const acquireOutcomes = new Set<RehearsalCountPreparationOutcome>([
  "refused",
  "admission-refused",
  "complete",
  "partial",
  "failed",
  "uncertain",
  "readback-failed",
]);
const entryKey = (entry: { scopeRecordId: string; kind: string }) => `${entry.scopeRecordId}\u0000${entry.kind}`;

/** Cross-field rules a closed shape cannot express; returns stable error codes, never values. */
function consistencyErrors(receipt: RehearsalCountPreparationReceipt): string[] {
  const errors: string[] = [];
  const expectedSelection = rehearsalCountPreparationSelection(receipt.pass);
  if (countFingerprint(receipt.selection) !== countFingerprint(expectedSelection)) errors.push("selection-not-pass");
  if ((receipt.outcome === "refused") !== (receipt.refusal !== null)) errors.push("refusal-code-mismatch");
  if (
    (receipt.mode === "quote" &&
      (receipt.approval !== null ||
        receipt.authority !== null ||
        receipt.accounting !== null ||
        !quoteOutcomes.has(receipt.outcome))) ||
    (receipt.mode === "acquire" &&
      (receipt.approval === null || receipt.accounting === null || !acquireOutcomes.has(receipt.outcome)))
  )
    errors.push("mode-shape-mismatch");
  if (
    (receipt.mode === "quote" && receipt.acquisition !== null) ||
    (receipt.mode === "acquire" && (receipt.acquisition === null) !== (receipt.outcome === "refused"))
  )
    errors.push("acquisition-shape-mismatch");
  if (receipt.outcome !== "refused" && receipt.quote === null) errors.push("quote-required");

  const roster = new Map(receipt.roster.map((entry) => [entryKey(entry), entry]));
  if (roster.size !== receipt.roster.length) errors.push("roster-duplicate-kind");
  if (receipt.pass.productDomain === "lorcana" && receipt.roster.some((entry) => entry.kind === "sealed"))
    errors.push("lorcana-sealed");
  const quote = receipt.quote;
  if (quote) {
    const scopes = new Set(receipt.roster.map((entry) => entry.scopeRecordId));
    if (quote.targetCount !== receipt.roster.length) errors.push("roster-count-mismatch");
    if (quote.scopeCount !== scopes.size) errors.push("scope-count-mismatch");
    if (quote.plannedCredits > 2 * quote.scopeCount) errors.push("per-set-limit");
    if (quote.perKindCost.cards + quote.perKindCost.sealed !== quote.plannedCredits || quote.cap > quote.plannedCredits)
      errors.push("per-kind-cost-mismatch");
    for (const entryKind of ["cards", "sealed"] as const) {
      const unpaid = receipt.roster.filter((entry) => entry.kind === entryKind && entry.state !== "reused").length;
      // A concurrent fill can only lower the remaining cost after approval; the quote itself is exact.
      if (receipt.mode === "quote" ? unpaid !== quote.perKindCost[entryKind] : unpaid > quote.perKindCost[entryKind])
        errors.push("per-kind-cost-mismatch");
    }
    if (
      receipt.outcome === "quoted" &&
      (quote.plannedCredits < 1 ||
        !quote.authority.allowed ||
        quote.authority.headroom === null ||
        quote.authority.headroom < quote.plannedCredits ||
        quote.cap < quote.plannedCredits ||
        receipt.roster.some((entry) => entry.state === "blocked"))
    )
      errors.push("quoted-requires-cap-and-headroom");
    if (
      receipt.outcome === "not-required" &&
      (quote.plannedCredits !== 0 || receipt.roster.some((entry) => entry.state !== "reused"))
    )
      errors.push("not-required-requires-zero-planned");
    if (
      receipt.approval &&
      (receipt.approval.authorityHeadroom < quote.plannedCredits ||
        receipt.approval.authorityFingerprint !== quote.authority.fingerprint ||
        quote.cap < quote.plannedCredits)
    )
      errors.push("approval-does-not-cover-planned");
  }
  // Submitting is admitted only against current authority that covers the whole P.
  const current = receipt.authority;
  if (
    receipt.acquisition &&
    (!current ||
      !quote ||
      current.state !== "allowed" ||
      current.headroom === null ||
      current.headroom < quote.plannedCredits ||
      current.usageFingerprint !== quote.authority.fingerprint ||
      current.usageFingerprint !== receipt.approval?.authorityFingerprint)
  )
    errors.push("submission-requires-current-authority");

  const sources = new Map<string, (typeof receipt.sources)[number]>();
  for (const source of receipt.sources) {
    const key = entryKey(source);
    if (!roster.has(key) || sources.has(key) || roster.get(key)!.queryFingerprint !== source.queryFingerprint)
      errors.push("source-not-in-roster");
    sources.set(key, source);
    if (Date.parse(source.observedAt) > Date.parse(source.expiresAt)) errors.push("source-time-invalid");
    if ((source.validationKind === "page-1-count") !== (source.returnedItemCount !== null))
      errors.push("source-shape-mismatch");
    if (source.returnedItemCount !== null && source.returnedItemCount !== Math.min(source.totalCount, source.pageSize))
      errors.push("source-shape-mismatch");
  }
  if (receipt.mode === "quote") {
    const reused = receipt.roster.filter((entry) => entry.state === "reused");
    if (reused.length !== receipt.sources.length || reused.some((entry) => !sources.has(entryKey(entry))))
      errors.push("quote-sources-mismatch");
  }

  const accounting = receipt.accounting;
  const debits = new Map<string, RehearsalCountPreparationAccounting["debits"][number]>();
  if (accounting) {
    if (
      (accounting.status === "complete") !== (accounting.reason === null) ||
      (accounting.status === "complete") !== (accounting.fingerprint !== null)
    )
      errors.push("accounting-shape-mismatch");
    if (accounting.fingerprint !== null && accounting.fingerprint !== countFingerprint(accounting.debits))
      errors.push("accounting-fingerprint-mismatch");
    const ids = new Set<string>();
    for (const debit of accounting.debits) {
      const entry = roster.get(entryKey(debit));
      if (ids.has(debit.debitId) || debits.has(entryKey(debit))) errors.push("debit-duplicate");
      ids.add(debit.debitId);
      debits.set(entryKey(debit), debit);
      // A quote's debits are only ever for its own exact queries. An entry that is
      // reused can carry one only through that debit's own result: reuse from any
      // other source is never this quote's new debit.
      if (
        !quote ||
        debit.quoteId !== quote.quoteId ||
        !entry ||
        entry.queryFingerprint !== debit.queryFingerprint ||
        (entry.state === "reused" && sources.get(entryKey(debit))?.sourceId !== debit.debitId)
      )
        errors.push("debit-outside-roster");
      if (
        (debit.outcome === "complete") !== (debit.observedAt !== null) ||
        (debit.observedAt === null) !== (debit.expiresAt === null) ||
        (debit.observedAt !== null && Date.parse(debit.observedAt) > Date.parse(debit.expiresAt!))
      )
        errors.push("debit-shape-mismatch");
    }
    if (quote && accounting.debits.length > quote.plannedCredits) errors.push("debits-exceed-planned");
    // A page-1 source carrying one of this quote's debit ids must be that debit's completed result.
    for (const source of receipt.sources) {
      const owner = accounting.debits.find((debit) => debit.debitId === source.sourceId);
      if (owner && (entryKey(owner) !== entryKey(source) || owner.outcome !== "complete"))
        errors.push("source-debit-mismatch");
    }
  }

  if (receipt.outcome === "complete") {
    const acquisition = receipt.acquisition;
    if (
      !acquisition ||
      acquisition.response.status !== 200 ||
      acquisition.response.state !== "complete" ||
      acquisition.readback.status !== "read" ||
      acquisition.readback.state !== "complete" ||
      acquisition.readback.admission !== "ended"
    )
      errors.push("complete-requires-complete-acquisition");
    if (!accounting || accounting.status !== "complete") errors.push("complete-requires-complete-accounting");
    if (accounting?.debits.some((debit) => debit.outcome !== "complete"))
      errors.push("complete-requires-complete-debits");
    // Every debit of a complete acquisition is backed by its own page-1 result as the entry's source.
    if (
      accounting?.debits.some((debit) => {
        const source = sources.get(entryKey(debit));
        return !source || source.validationKind !== "page-1-count" || source.sourceId !== debit.debitId;
      })
    )
      errors.push("complete-requires-debit-sources");
    if (receipt.roster.some((entry) => !sources.has(entryKey(entry))))
      errors.push("complete-requires-every-roster-source");
    if (acquisition && receipt.sources.some((source) => !countTimeIsCurrent(source, acquisition.readback.readAt)))
      errors.push("complete-source-not-current");
  }
  return [...new Set(errors)];
}

/** Validates a parsed receipt against the admitted run identity. */
export function validateRehearsalCountPreparationReceipt(
  value: unknown,
  expected: RehearsalCountPreparationExpectation,
): { ok: boolean; errors: string[] } {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `schema:${issue.path.join(".") || "receipt"}:${issue.code}`);
    return { ok: false, errors: [...new Set(errors)].slice(0, 50) };
  }
  const errors = consistencyErrors(parsed.data);
  for (const key of ["sha", "runId", "runAttempt"] as const)
    if (expected[key] !== undefined && parsed.data[key] !== expected[key]) errors.push(`identity-mismatch:${key}`);
  return { ok: errors.length === 0, errors };
}

// Name-based markers catch a rotated or re-encoded credential the admitted
// values cannot: the session cookie, auth headers, URLs and browser captures.
const secretMarkers: readonly (readonly [string, RegExp])[] = [
  ["session-cookie", /chase[_-]?sets[_-]?session|set-cookie|\bcookie\b/i],
  ["authorization", /authorization|bearer\s|sessiontoken|session_token/i],
  ["credential", /password|api[_-]?key|team[_-]?id|secret/i],
  ["url", /[a-z][a-z0-9+.-]*:\/\/|www\./i],
  ["browser-capture", /storage-?state|\.har\b|trace\.zip|data:image|screenshot|\.webm\b/i],
];

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, into);
  else if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      strings(entry, into);
    }
  return into;
}

function decodedVariants(text: string): string[] {
  const variants = [text];
  try {
    variants.push(decodeURIComponent(text));
  } catch {
    // Malformed percent-encoding is checked in its raw form only.
  }
  return variants;
}

/** Byte-level upload gate: size, secret markers and admitted values first, then the closed shape. */
export function validateRehearsalCountPreparationReceiptText(
  text: string,
  expected: RehearsalCountPreparationExpectation,
): { ok: boolean; errors: string[]; receipt: RehearsalCountPreparationReceipt | null } {
  if (Buffer.byteLength(text, "utf8") > maxReceiptBytes)
    return { ok: false, errors: ["receipt-too-large"], receipt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["receipt-not-json"], receipt: null };
  }
  const haystacks = [text, ...strings(parsed)].flatMap(decodedVariants);
  const errors: string[] = [];
  for (const [name, marker] of secretMarkers)
    if (haystacks.some((haystack) => marker.test(haystack))) errors.push(`secret-marker:${name}`);
  const values = expected.forbiddenValues.filter((value) => value.length > 0);
  if (
    values.some((value) =>
      haystacks.some(
        (haystack) =>
          haystack.includes(value) ||
          haystack.includes(JSON.stringify(value).slice(1, -1)) ||
          haystack.includes(encodeURIComponent(value)),
      ),
    )
  )
    errors.push("forbidden-value");
  const result = validateRehearsalCountPreparationReceipt(parsed, expected);
  errors.push(...result.errors);
  return {
    ok: errors.length === 0,
    errors,
    receipt: errors.length === 0 ? (parsed as RehearsalCountPreparationReceipt) : null,
  };
}

/**
 * The runbook handoff of a validated receipt. A no-spend quote or a complete
 * acquisition may continue only to the rehearsal's own independent reservation,
 * preview and confirm checks, never as batch-ready authority; a quote with misses waits
 * for the host's approval; every other outcome stops.
 */
export function rehearsalCountPreparationContinuation(
  receipt: Pick<RehearsalCountPreparationReceipt, "outcome">,
): "reservation" | "approval" | "stop" {
  if (receipt.outcome === "not-required" || receipt.outcome === "complete") return "reservation";
  return receipt.outcome === "quoted" ? "approval" : "stop";
}
