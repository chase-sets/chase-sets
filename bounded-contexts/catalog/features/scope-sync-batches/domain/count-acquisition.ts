import { createHash } from "node:crypto";
import { z } from "zod";

const integer = z.number().int().min(0).max(2147483647);
const instant = z.iso.datetime({ offset: true });
export const countQuerySchema = z
  .object({
    environment: z.string().min(1),
    accountRevision: z.string().min(1),
    providerKey: z.literal("scrydex"),
    productDomain: z.enum(["one-piece", "lorcana"]),
    profileKey: z.string().min(1),
    profileVersion: z.string().min(1),
    unitKey: z.string().min(1),
    kind: z.enum(["cards", "sealed"]),
    languageCode: z.string().min(1),
    parentValue: z.string().min(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ScrydexCountQuery = z.infer<typeof countQuerySchema>;
export const countEvidenceSchema = z
  .object({
    query: countQuerySchema,
    validationKind: z.literal("page-1-count"),
    sourceId: z.string().min(1),
    totalCount: integer,
    pageSize: integer.min(1),
    returnedPage: z.literal(1),
    returnedItemCount: integer,
    observedAt: instant,
    expiresAt: instant,
  })
  .strict()
  .refine((value) => value.returnedItemCount === Math.min(value.totalCount, value.pageSize));
export type ScrydexCountEvidence = z.infer<typeof countEvidenceSchema>;
export const countResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("complete"), evidence: countEvidenceSchema }).strict(),
  z.object({ outcome: z.enum(["failed", "uncertain"]), evidence: z.null() }).strict(),
]);
export type ScrydexCountSource = Readonly<{
  query: ScrydexCountQuery;
  validationKind: "page-1-count" | "complete-cache";
  sourceId: string;
  totalCount: number;
  pageSize: number;
  observedAt: string;
  expiresAt: string;
}>;
export type ScrydexCountReader = { read(query: ScrydexCountQuery): Promise<ScrydexCountEvidence | null> };

export function countQueryKey(query: ScrydexCountQuery): string {
  return countFingerprint(countQuerySchema.parse(query));
}
export function countFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
  return createHash("sha256").update(canonical).digest("hex");
}
export function countSourceIsCurrent(
  value: unknown,
  query: ScrydexCountQuery,
  now: string,
): value is ScrydexCountEvidence {
  const parsed = countEvidenceSchema.safeParse(value);
  return (
    parsed.success && countQueryKey(parsed.data.query) === countQueryKey(query) && countTimeIsCurrent(parsed.data, now)
  );
}
export function countTimeIsCurrent(value: Pick<ScrydexCountSource, "observedAt" | "expiresAt">, now: string): boolean {
  if (
    !instant.safeParse(value.observedAt).success ||
    !instant.safeParse(value.expiresAt).success ||
    !instant.safeParse(now).success
  )
    return false;
  const age = Date.parse(now) - Date.parse(value.observedAt);
  return age >= 0 && age <= 900_000 && Date.parse(value.expiresAt) >= Date.parse(now);
}
export function newestCountSource(
  cache: ScrydexCountSource | null,
  count: ScrydexCountEvidence | null,
): ScrydexCountSource | null {
  return cache && (!count || Date.parse(cache.observedAt) >= Date.parse(count.observedAt)) ? cache : count;
}

export type CountTarget = Readonly<{
  scopeRecordId: string;
  query: ScrydexCountQuery;
  source: ScrydexCountSource | null;
  blocked: boolean;
}>;
export type CountAuthority = Readonly<{ fingerprint: string; headroom: number | null; allowed: boolean }>;
export type CountQuote = Readonly<{
  quoteId: string;
  fingerprint: string;
  membershipFingerprint: string;
  selection: unknown;
  authority: CountAuthority;
  targets: readonly CountTarget[];
  plannedCredits: number;
  cap: number;
  expiresAt: string;
  state: "quoted" | "approved" | "acquiring" | "complete" | "failed" | "uncertain";
}>;
const countSourceSchema = z
  .object({
    query: countQuerySchema,
    validationKind: z.enum(["page-1-count", "complete-cache"]),
    sourceId: z.string().min(1),
    totalCount: integer,
    pageSize: integer.min(1),
    observedAt: instant,
    expiresAt: instant,
    returnedPage: z.literal(1).optional(),
    returnedItemCount: integer.optional(),
  })
  .strict();
export const countQuoteSchema = z
  .object({
    quoteId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    membershipFingerprint: z.string().min(1),
    selection: z.unknown(),
    authority: z
      .object({ fingerprint: z.string().min(1), headroom: integer.nullable(), allowed: z.boolean() })
      .strict(),
    targets: z
      .array(
        z
          .object({
            scopeRecordId: z.string().min(1),
            query: countQuerySchema,
            source: countSourceSchema.nullable(),
            blocked: z.boolean(),
          })
          .strict(),
      )
      .max(10_000),
    plannedCredits: integer.max(10_000),
    cap: integer.max(10_000),
    expiresAt: instant,
    state: z.enum(["quoted", "approved", "acquiring", "complete", "failed", "uncertain"]),
  })
  .strict();
export type CountSpend = Readonly<{
  debitId: string;
  quoteId: string;
  kind: "cards" | "sealed";
  credits: 1;
  outcome: "acquiring" | "complete" | "failed" | "uncertain";
  debitedAt: string;
  observedAt: string | null;
  expiresAt: string | null;
}>;
export const countSpendSchema = z
  .object({
    debitId: z.string().min(1),
    quoteId: z.string().min(1),
    kind: z.enum(["cards", "sealed"]),
    credits: z.literal(1),
    outcome: z.enum(["acquiring", "complete", "failed", "uncertain"]),
    debitedAt: instant,
    observedAt: instant.nullable(),
    expiresAt: instant.nullable(),
  })
  .strict();
/**
 * Whole-quote admission reserves a quote's entire approved P as one allocation
 * before any debit or send. The allocation is capacity, not spend: each claim
 * converts one credit of it to a debit, and terminal end or quote expiry
 * releases only what was never converted.
 */
export type CountAdmission = "whole-quote";
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
export const countAllocationSchemaVersion = "catalog-count-quote-allocation/v1";
export const countAllocationSchema = z
  .object({
    schemaVersion: z.literal(countAllocationSchemaVersion),
    admission: z.literal("whole-quote"),
    plannedCredits: integer.min(1).max(10_000),
    quoteFingerprint: hex64,
    authorityFingerprint: z.string().min(1),
    expiresAt: instant,
  })
  .strict();
export const countAllocationEndSchemaVersion = "catalog-count-quote-allocation-end/v1";
export const countAllocationEndSchema = z
  .object({
    schemaVersion: z.literal(countAllocationEndSchemaVersion),
    executionId: z.uuid(),
    state: z.enum(["complete", "failed", "uncertain"]),
  })
  .strict();
export const countQuoteDebitsMax = 10_000;
/** One retained possible-send debit of a quote; a debit without a result is still `acquiring`. */
export const countQuoteDebitSchema = z
  .object({
    quoteId: z.uuid(),
    scopeRecordId: z.string().min(1),
    kind: z.enum(["cards", "sealed"]),
    queryFingerprint: hex64,
    debitId: z.uuid(),
    credits: z.literal(1),
    debitedAt: instant,
    outcome: z.enum(["acquiring", "complete", "failed", "uncertain"]),
    observedAt: instant.nullable(),
    expiresAt: instant.nullable(),
  })
  .strict();
export type CountQuoteDebit = z.infer<typeof countQuoteDebitSchema>;
export const countPreparationViewSchemaVersion = "catalog-count-quote-preparation-view/v1";
/**
 * The opt-in preparation read of an owned quote: the unchanged retained quote,
 * current net authority from retained usage only (never a provider request),
 * its admission state and every debit it owns. `unknown` debits are never zero spend.
 */
export const countPreparationViewSchema = z
  .object({
    schemaVersion: z.literal(countPreparationViewSchemaVersion),
    quote: countQuoteSchema,
    currentAuthority: z
      .object({
        readAt: instant,
        usageFingerprint: hex64,
        usageObservedAt: instant.nullable(),
        state: z.enum(["allowed", "unknown"]),
        headroom: integer.nullable(),
      })
      .strict(),
    admission: z
      .object({
        state: z.enum(["none", "active", "ended", "expired"]),
        plannedCredits: integer.max(10_000).nullable(),
        admittedAt: instant.nullable(),
        endedAt: instant.nullable(),
      })
      .strict(),
    debits: z
      .object({
        status: z.enum(["complete", "unknown"]),
        reason: z.enum(["overflow", "invalid-row"]).nullable(),
        readAt: instant,
        fingerprint: hex64.nullable(),
        rows: z.array(countQuoteDebitSchema).max(countQuoteDebitsMax),
      })
      .strict(),
  })
  .strict();
export type CountPreparationView = Readonly<
  Omit<z.infer<typeof countPreparationViewSchema>, "quote"> & { quote: CountQuote }
>;
export function projectCountSpend(value: unknown, generatedAt: string): CountSpend[] {
  if (!Array.isArray(value) || !instant.safeParse(generatedAt).success) return [];
  return value.slice(0, 100).flatMap((candidate) => {
    const parsed = countSpendSchema.safeParse(candidate);
    if (
      !parsed.success ||
      Date.parse(parsed.data.debitedAt) > Date.parse(generatedAt) ||
      (parsed.data.observedAt && Date.parse(parsed.data.observedAt) > Date.parse(generatedAt))
    )
      return [];
    return [parsed.data];
  });
}
export class CountAcquisitionRefused extends Error {
  readonly code = "count-acquisition-refused";
  constructor() {
    super("Count acquisition is blocked. Redisplay the quote or review retained usage and uncertain spend.");
  }
}
