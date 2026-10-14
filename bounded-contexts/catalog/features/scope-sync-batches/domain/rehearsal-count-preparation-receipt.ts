import { z } from "zod";
import { countTimeIsCurrent } from "./count-acquisition";

// Governed Scrydex count preparation for a #9224 rehearsal pass (#9591). The
// receipt is the only artifact the staging workflow may upload: a closed,
// count-only record of the quote, the host approval it was bound to, the single
// acquisition and its retained readback. It never carries URLs, payloads,
// account identifiers, cookies or credentials, and it never grants batch,
// preview, confirm or reservation authority.

export const rehearsalCountPreparationReceiptPath = "artifacts/catalog-count-preparation/receipt.json";
export const rehearsalCountPreparationReceiptSchemaVersion = "catalog-rehearsal-count-preparation-receipt/v1";
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

/** The #9224 start journey selects `set` scopes, and Pokemon `expansion` scopes. */
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
    state: z.enum(["reused", "missing", "blocked"]),
  })
  .strict();
const sourceSchema = z
  .object({
    scopeRecordId: token,
    kind,
    sourceId,
    validationKind: z.enum(["page-1-count", "complete-cache"]),
    totalCount: integer,
    pageSize: integer.min(1),
    returnedItemCount: integer.nullable(),
    observedAt: instant,
    expiresAt: instant,
  })
  .strict();
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
    roster: z.array(rosterEntrySchema).max(rehearsalCountPreparationMaxTargets),
    acquisition: z
      .object({
        submittedAt: instant,
        response: z
          .object({ status: z.number().int().min(100).max(599).nullable(), state: quoteState.nullable() })
          .strict(),
        readback: z
          .object({ readAt: instant, status: z.enum(["read", "failed"]), state: quoteState.nullable() })
          .strict(),
      })
      .strict()
      .nullable(),
    sources: z.array(sourceSchema).max(rehearsalCountPreparationMaxTargets),
    debits: z
      .array(z.object({ scopeRecordId: token, kind, debitId: sourceId, outcome: z.literal("complete") }).strict())
      .max(rehearsalCountPreparationMaxTargets),
    outcome: z.enum([
      "quoted",
      "not-required",
      "refused",
      "complete",
      "partial",
      "failed",
      "uncertain",
      "readback-failed",
    ]),
    refusal: z.enum(rehearsalCountPreparationRefusalCodes).nullable(),
    completedAt: instant,
  })
  .strict();
export type RehearsalCountPreparationReceipt = z.infer<typeof receiptSchema>;
export type RehearsalCountPreparationOutcome = RehearsalCountPreparationReceipt["outcome"];

export type RehearsalCountPreparationExpectation = Readonly<{
  sha?: string;
  runId?: string;
  runAttempt?: string;
  forbiddenValues: readonly string[];
}>;

const quoteOutcomes = new Set(["quoted", "not-required", "refused"]);
const acquireOutcomes = new Set(["refused", "complete", "partial", "failed", "uncertain", "readback-failed"]);
const entryKey = (entry: { scopeRecordId: string; kind: string }) => `${entry.scopeRecordId}\u0000${entry.kind}`;

/** Cross-field rules a closed shape cannot express; returns stable error codes, never values. */
function consistencyErrors(receipt: RehearsalCountPreparationReceipt): string[] {
  const errors: string[] = [];
  const expectedSelection = rehearsalCountPreparationSelection(receipt.pass);
  if (JSON.stringify(receipt.selection) !== JSON.stringify(expectedSelection)) errors.push("selection-not-pass");
  if ((receipt.outcome === "refused") !== (receipt.refusal !== null)) errors.push("refusal-code-mismatch");
  if (
    (receipt.mode === "quote" && (receipt.approval !== null || !quoteOutcomes.has(receipt.outcome))) ||
    (receipt.mode === "acquire" && (receipt.approval === null || !acquireOutcomes.has(receipt.outcome)))
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

  const sources = new Map<string, (typeof receipt.sources)[number]>();
  for (const source of receipt.sources) {
    const key = entryKey(source);
    if (!roster.has(key) || sources.has(key)) errors.push("source-not-in-roster");
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
    if (receipt.debits.length > 0) errors.push("debit-not-acquired-source");
  }

  const debitKeys = new Set<string>();
  for (const debit of receipt.debits) {
    const source = sources.get(entryKey(debit));
    if (
      !source ||
      debitKeys.has(entryKey(debit)) ||
      source.validationKind !== "page-1-count" ||
      source.sourceId !== debit.debitId ||
      roster.get(entryKey(debit))?.state !== "missing"
    )
      errors.push("debit-not-acquired-source");
    debitKeys.add(entryKey(debit));
  }
  if (quote && receipt.debits.length > quote.plannedCredits) errors.push("debits-exceed-planned");

  if (receipt.outcome === "complete") {
    const acquisition = receipt.acquisition;
    if (
      !acquisition ||
      acquisition.response.status !== 200 ||
      acquisition.response.state !== "complete" ||
      acquisition.readback.status !== "read" ||
      acquisition.readback.state !== "complete"
    )
      errors.push("complete-requires-complete-acquisition");
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

/** Quoted, not-required and complete are the only outcomes that end a run successfully. */
export function rehearsalCountPreparationSucceeded(receipt: RehearsalCountPreparationReceipt): boolean {
  return receipt.outcome === "quoted" || receipt.outcome === "not-required" || receipt.outcome === "complete";
}
