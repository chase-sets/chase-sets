import { z } from "zod";
import { countQueryKey, countQuerySchema } from "./count-acquisition";

// Closed vocabulary of the one combined count-lifecycle staging capture:
// one One Piece OP01 English scope and its three Scrydex units. Card and sealed
// units each consume one count source; set reference data consumes none.
export const countCaptureUnitKeys = [
  "scrydex:one-piece:set:reference-data",
  "scrydex:one-piece:single-card:source-observation-import",
  "scrydex:one-piece:sealed-product:source-observation-import",
] as const;
export const countCaptureKinds = ["cards", "sealed"] as const;
export type CountCaptureKind = (typeof countCaptureKinds)[number];
export const countCaptureKindUnitKeys = {
  cards: countCaptureUnitKeys[1],
  sealed: countCaptureUnitKeys[2],
} as const satisfies Record<CountCaptureKind, (typeof countCaptureUnitKeys)[number]>;

// Every receipt value is one of these bounded shapes. There is no free text:
// ids are bounded tokens and instants must carry a timezone.
export const countCaptureFields = {
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  instant: z.iso.datetime({ offset: true }),
  count: z.number().int().min(0).max(2_147_483_647),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  ageMs: z.number().int().min(0).max(900_000),
};
const { id, instant, count, hash } = countCaptureFields;
const kind = z.enum(countCaptureKinds);
const unitKey = z.enum(countCaptureUnitKeys);

export const countCaptureQuerySchema = countQuerySchema
  .extend({
    environment: z.literal("staging"),
    accountRevision: id,
    productDomain: z.literal("one-piece"),
    profileKey: id,
    profileVersion: id,
    unitKey: z.enum([countCaptureKindUnitKeys.cards, countCaptureKindUnitKeys.sealed]),
    languageCode: z.literal("en"),
    parentValue: z.literal("OP01"),
  })
  .strict()
  .refine((query) => query.unitKey === countCaptureKindUnitKeys[query.kind]);
export type CountCaptureQuery = z.infer<typeof countCaptureQuerySchema>;

// A complete-cache winner has no page-1 shape at all, so it cannot be relabelled
// as a page-1 count without inventing returned-page facts the writer join refutes.
const sourceFields = {
  query: countCaptureQuerySchema,
  sourceId: id,
  totalCount: count,
  pageSize: count.min(1),
  observedAt: instant,
  expiresAt: instant,
};
const pageOneSource = z
  .object({
    ...sourceFields,
    validationKind: z.literal("page-1-count"),
    returnedPage: z.literal(1),
    returnedItemCount: count,
  })
  .strict();
const completeCacheSource = z.object({ ...sourceFields, validationKind: z.literal("complete-cache") }).strict();
const sourceIsOrdered = (source: z.infer<typeof pageOneSource> | z.infer<typeof completeCacheSource>) =>
  Date.parse(source.observedAt) <= Date.parse(source.expiresAt) &&
  (source.validationKind !== "page-1-count" ||
    source.returnedItemCount === Math.min(source.totalCount, source.pageSize));
export const countCapturePageOneSourceSchema = pageOneSource.refine(sourceIsOrdered);
export const countCaptureSourceSchema = z
  .discriminatedUnion("validationKind", [pageOneSource, completeCacheSource])
  .refine(sourceIsOrdered);
export type CountCaptureSource = z.infer<typeof countCaptureSourceSchema>;

const unitKeys = z
  .array(unitKey)
  .max(3)
  .refine((keys) => new Set(keys).size === keys.length);
const providerLimits = (maximum: number, minimum = 0) =>
  z.object({ scrydex: count.min(minimum).max(maximum).optional() }).strict();
const profile = z.object({ providerKey: z.literal("scrydex"), unitKey, profileKey: id, profileVersion: id }).strict();
const blocker = z.object({ code: id, scopeRecordId: id.nullable(), providerKey: id.nullable() }).strict();

// Support-safe projection of one resolved batch plan for the capture scope.
// Diagnostic prose, samples and provider payloads are deliberately absent.
export const countCapturePlanSchema = z
  .object({
    selection: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("ids"), scopeRecordIds: z.array(id).max(1) }).strict(),
      z
        .object({
          mode: z.literal("matching-scope"),
          query: z
            .object({
              productDomain: z.literal("one-piece").nullish(),
              scopeKind: z.literal("set").nullish(),
              languageCode: z.literal("en").nullish(),
            })
            .strict(),
        })
        .strict(),
    ]),
    budget: z
      .object({
        maxScopesPerTurn: count.min(1).max(25),
        defaultProviderConcurrency: count.min(1).max(20),
        providerConcurrency: providerLimits(20, 1),
        providerRequestLimits: providerLimits(1_000_000),
        creditedProviderRequestLimits: providerLimits(1_000_000),
        providerFailureThreshold: count.min(1).max(100),
      })
      .strict(),
    resolvedAt: instant,
    status: z.enum(["empty", "blocked", "ready"]),
    blockers: z.array(blocker).max(100),
    scopes: z
      .array(
        z
          .object({
            scopeRecordId: id,
            scopeRecordVersion: instant,
            mappingVersions: z.array(z.object({ mappingId: id, version: instant, reviewStatus: id }).strict()).max(3),
            profileVersions: z.array(profile).max(3),
            scope: z
              .object({
                scopeVersion: z.literal("catalog-sync-scope-v2"),
                productDomain: z.literal("one-piece"),
                productForm: id.nullish(),
                languageCode: z.literal("en").nullish(),
                reference: z.object({ kind: z.literal("set"), scopeRecordId: id }).strict(),
                providerParticipation: z
                  .object({
                    requiredUnitKeys: unitKeys.optional(),
                    selectedUnitKeys: unitKeys.optional(),
                    excludedUnitKeys: unitKeys.optional(),
                  })
                  .strict()
                  .nullish(),
              })
              .strict(),
            providerUnitCount: count.max(3),
            status: z.enum(["ready", "degraded", "blocked"]),
            startAllowed: z.boolean(),
            blockers: z.array(blocker).max(100),
            participationBlockers: z.array(id).max(100),
            units: z
              .array(
                profile
                  .extend({
                    selected: z.boolean(),
                    defaultSelected: z.boolean(),
                    eligibility: z.enum(["eligible", "ineligible"]),
                    requirement: z.enum(["required", "optional"]),
                    role: z.enum([
                      "primary-source-observation",
                      "supplemental-marketplace-reference",
                      "reference-data",
                      "image-evidence",
                    ]),
                    estimate: z
                      .object({
                        countSourceId: id.nullable(),
                        targetCount: count.nullable(),
                        estimatedRequestCount: count.nullable(),
                        requestStrategy: z.enum(["bulk-first", "single-record", "unknown"]).nullable(),
                        estimateState: z.enum(["estimated", "estimate-unavailable", "not-requested", "unavailable"]),
                        usageCheckState: z
                          .enum(["checked", "not-supported", "not-configured", "unavailable", "unknown"])
                          .nullable(),
                      })
                      .strict(),
                    blockers: z.array(id).max(100),
                  })
                  .strict(),
              )
              .max(3),
          })
          .strict(),
      )
      .max(1),
  })
  .strict()
  .refine((plan) =>
    plan.scopes.every((scope) => {
      const selected = scope.units.filter((unit) => unit.selected);
      return (
        scope.scope.reference.scopeRecordId === scope.scopeRecordId &&
        new Set(scope.units.map((unit) => unit.unitKey)).size === scope.units.length &&
        new Set(scope.mappingVersions.map((mapping) => mapping.mappingId)).size === scope.mappingVersions.length &&
        new Set(scope.profileVersions.map((entry) => entry.unitKey)).size === scope.profileVersions.length &&
        scope.providerUnitCount === selected.length &&
        scope.profileVersions.length === selected.length &&
        scope.profileVersions.every((entry) =>
          selected.some(
            (unit) =>
              unit.unitKey === entry.unitKey &&
              unit.profileKey === entry.profileKey &&
              unit.profileVersion === entry.profileVersion,
          ),
        )
      );
    }),
  );
export type CountCapturePlan = z.infer<typeof countCapturePlanSchema>;

// One planner read (an ordinary preview or the pre-confirm planner read) and the
// count-source winners THAT request consumed. Every winner must be the source the
// plan's unit estimate names, and every unit estimate naming a source needs its winner.
export const countCapturePlannerReadSchema = z
  .object({
    phase: z.enum(["preview", "pre-confirm"]),
    requestId: id,
    planFingerprint: hash,
    comparedFingerprint: hash.nullable(),
    eligible: z.boolean(),
    refusal: id.nullable(),
    effectsCapability: z.literal(false),
    plan: countCapturePlanSchema,
    winners: z
      .array(
        z
          .object({
            kind,
            query: countCaptureQuerySchema,
            source: countCaptureSourceSchema.nullable(),
            readAt: instant,
          })
          .strict(),
      )
      .max(2),
  })
  .strict()
  .refine((read) => {
    const units = read.plan.scopes.flatMap((scope) => scope.units);
    const sourced = units.filter(
      (unit) => unit.estimate.countSourceId !== null && unit.unitKey !== countCaptureUnitKeys[0],
    );
    return (
      (read.phase === "preview") === (read.comparedFingerprint === null) &&
      read.eligible === (read.refusal === null) &&
      new Set(read.winners.map((winner) => winner.kind)).size === read.winners.length &&
      read.winners.every((winner) => {
        if (winner.query.kind !== winner.kind) return false;
        if (!winner.source) return true;
        const unit = units.find((candidate) => candidate.unitKey === winner.query.unitKey);
        return (
          countQueryKey(winner.source.query) === countQueryKey(winner.query) &&
          unit?.profileKey === winner.query.profileKey &&
          unit.profileVersion === winner.query.profileVersion &&
          unit.estimate.countSourceId === winner.source.sourceId
        );
      }) &&
      sourced.every((unit) => read.winners.some((winner) => winner.source?.sourceId === unit.estimate.countSourceId))
    );
  });
export type CountCapturePlannerRead = z.infer<typeof countCapturePlannerReadSchema>;
