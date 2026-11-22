import { createHash } from "node:crypto";
import { reservationIdentity } from "@chase-sets/event-core/owner-stream-reservation";
import { z } from "zod";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { scheduleWindowMatches } from "./evaluate";

const id = z.string().min(1).max(512);
const revision = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const exactUtc = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, "Expected a canonical UTC instant.");

export const evaluationBindingSchema = z.strictObject({
  requestId: digest,
  commandFingerprint: digest,
  consumer: z.strictObject({ storeId: id, incarnation: id }),
  tenantId: id,
  accountId: id,
  principal: z.strictObject({ userId: id, membershipId: id, sessionId: id }),
  listingId: id,
  catalogItemId: id,
  productId: id,
  listingVersion: revision,
  target: z.strictObject({ kind: z.literal("channel-connection"), connectionId: id }),
  priceAmount: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
  priceCurrencyCode: z.string().regex(/^[A-Z]{3}$/),
  decision: z.strictObject({
    kind: z.literal("pricing-evaluation"),
    evaluationId: id,
    evaluationRevision: id,
    standingAuthorizationId: id,
    standingAuthorizationRevision: id,
    basePriceRevision: revision,
  }),
});
export type EvaluationBinding = z.infer<typeof evaluationBindingSchema>;

export const evaluationDigest = (value: unknown): string =>
  createHash("sha256").update(reservationIdentity(value)).digest("hex");

export function assertEvaluationBinding(value: unknown, expected: EvaluationBinding): EvaluationBinding {
  const actual = evaluationBindingSchema.parse(value);
  if (evaluationDigest(actual) !== evaluationDigest(evaluationBindingSchema.parse(expected)))
    throw new Error("Evaluated Decision belongs to another command.");
  return actual;
}

export function evaluationDeadline(
  input: Readonly<{
    challengeTime: string;
    validityBounds: readonly string[];
    listingCreatedAt: string | null;
    rules: readonly RepricingRule[];
  }>,
): string {
  const start = Date.parse(exactUtc.parse(input.challengeTime));
  const minute = (Math.floor(start / 60_000) + 1) * 60_000;
  let end = start + 60_000;
  for (const bound of input.validityBounds) end = Math.min(end, Date.parse(exactUtc.parse(bound)));
  for (const rule of input.rules) {
    for (const condition of rule.conditions) {
      if (
        condition.type === "schedule-window" &&
        scheduleWindowMatches(condition, new Date(minute - 1)) !== scheduleWindowMatches(condition, new Date(minute))
      ) {
        end = Math.min(end, minute);
      }
      if (condition.type === "listing-age-at-least" && input.listingCreatedAt !== null) {
        const boundary = Date.parse(exactUtc.parse(input.listingCreatedAt)) + condition.days * 86_400_000;
        if (start < boundary) end = Math.min(end, boundary);
      }
    }
  }
  if (end <= start) throw new Error("Evaluation authority has already expired.");
  return new Date(end).toISOString();
}

const competitorSchema = z.strictObject({
  listingId: id,
  sellerAccountId: id,
  listingVersion: revision,
  amount: z.string().regex(/^[0-9]+(?:\.[0-9]{1,2})?$/),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  pricingMode: z.enum(["hard", "derived"]),
});
export type CapturedCompetitor = z.infer<typeof competitorSchema>;
const partSchema = z.strictObject({
  part: z.number().int().nonnegative(),
  count: z.number().int().positive().max(128),
  hash: digest,
  asks: z.array(competitorSchema).min(1).max(128),
});
const competitorCaptureSchema = z.strictObject({
  generation: id,
  root: digest,
  count: z.number().int().nonnegative(),
  parts: z.array(partSchema),
});

export function sealCompetitorCapture(generation: string, asks: readonly CapturedCompetitor[]) {
  const parts: z.infer<typeof partSchema>[] = [];
  for (let i = 0; i < asks.length; i += 128) {
    const chunk = asks.slice(i, i + 128);
    parts.push({ part: parts.length, count: chunk.length, hash: evaluationDigest(chunk), asks: chunk });
  }
  return readCompetitorCapture({
    generation,
    root: evaluationDigest({ generation, parts: parts.map(({ part, count, hash }) => ({ part, count, hash })) }),
    count: asks.length,
    parts,
  });
}

export function readCompetitorCapture(value: unknown) {
  const capture = competitorCaptureSchema.parse(value);
  const ids = new Set<string>();
  let count = 0;
  for (const [i, part] of capture.parts.entries()) {
    if (part.part !== i || part.count !== part.asks.length || part.hash !== evaluationDigest(part.asks))
      throw new Error("Malformed competitor evidence part.");
    count += part.count;
    for (const ask of part.asks) {
      if (ids.has(ask.listingId)) throw new Error("Duplicate competitor Listing.");
      ids.add(ask.listingId);
    }
  }
  const manifest = capture.parts.map(({ part, count, hash }) => ({ part, count, hash }));
  if (count !== capture.count || capture.root !== evaluationDigest({ generation: capture.generation, parts: manifest }))
    throw new Error("Incomplete competitor capture.");
  return capture;
}
