import { z } from "zod";
import { countEvidenceSchema, countQuerySchema, countQueryKey, countTimeIsCurrent } from "./count-acquisition";

export const countCapturePacketHash = "b44ca44ca7e079b66c19588c49842c499376d063aae1bd8420af32d080a37dde";
export const countCaptureArtifactPath = "artifacts/catalog-count-lifecycle/receipt.json";
const text = z.string().min(1).max(256);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const integer = z.number().int().min(0).max(2147483647);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const countCaptureUnitKeys = [
  "scrydex:one-piece:set:reference-data",
  "scrydex:one-piece:single-card:source-observation-import",
  "scrydex:one-piece:sealed-product:source-observation-import",
] as const;
export const countCaptureAuthoritySchema = z
  .object({
    dispatchId: id,
    dispatchedAt: instant,
    packetHash: z.literal(countCapturePacketHash),
    runnerSha: sha,
    review: z.object({ head: sha, receiptHash: hash, dispatchId: id }).strict(),
    budget: z
      .object({
        withinAllowance: z.literal(true),
        remainingCredits: integer,
        unreflectedCredits: integer,
        reservedCredits: integer,
        observedAt: instant,
        countCap: z.literal(2),
        usageCap: z.literal(9),
        totalCap: z.literal(11),
      })
      .strict(),
    deployment: z
      .object({
        runId: z.string().regex(/^\d{1,20}$/),
        attempt: integer.min(1).max(1000),
        jobId: z.string().regex(/^\d{1,20}$/),
        jobName: text,
        stepNumber: integer.min(1).max(1000),
        stepName: text,
        conclusion: z.literal("success"),
        startedAt: instant,
        completedAt: instant,
        sha,
        digest,
        logSha: sha,
        logDigest: digest,
      })
      .strict(),
    pods: z
      .object({
        dispatchId: id,
        observedAt: instant,
        adminReplicas: integer.min(1).max(100),
        apiReplicas: integer.min(1).max(100),
        ready: z
          .array(z.object({ component: z.enum(["admin", "api"]), image: text, imageId: text }).strict())
          .min(2)
          .max(200),
      })
      .strict(),
    collection: z
      .object({
        collectedAt: instant,
        complete: z.boolean(),
        overlap: z.boolean(),
        workflowCount: integer.min(1).max(1000),
        runCount: integer.min(1),
        attemptCount: integer.min(1),
        jobCount: integer.min(1),
        pageCount: integer.min(1).max(10000),
      })
      .strict(),
  })
  .strict();
export type CountCaptureAuthority = z.infer<typeof countCaptureAuthoritySchema>;

export function validateCountCaptureAuthority(value: unknown, now: string): value is CountCaptureAuthority {
  const parsed = countCaptureAuthoritySchema.safeParse(value);
  if (!parsed.success || !instant.safeParse(now).success) return false;
  const authority = parsed.data;
  const { deployment, pods, budget, collection } = authority;
  const current = Date.parse(now);
  const fresh = (at: string) => Date.parse(at) <= current && current - Date.parse(at) <= 900_000;
  return (
    authority.runnerSha === authority.review.head &&
    authority.runnerSha === deployment.sha &&
    deployment.logSha === deployment.sha &&
    deployment.logDigest === deployment.digest &&
    Date.parse(deployment.startedAt) < Date.parse(deployment.completedAt) &&
    Date.parse(deployment.completedAt) <= Date.parse(authority.dispatchedAt) &&
    fresh(authority.dispatchedAt) &&
    fresh(budget.observedAt) &&
    fresh(pods.observedAt) &&
    fresh(collection.collectedAt) &&
    pods.dispatchId === authority.dispatchId &&
    Date.parse(pods.observedAt) >= Date.parse(authority.dispatchedAt) &&
    Date.parse(collection.collectedAt) >= Date.parse(pods.observedAt) &&
    pods.ready.filter((pod) => pod.component === "admin").length === pods.adminReplicas &&
    pods.ready.filter((pod) => pod.component === "api").length === pods.apiReplicas &&
    pods.ready.every(
      (pod) => pod.image.endsWith(`@${deployment.digest}`) && pod.imageId.endsWith(`@${deployment.digest}`),
    ) &&
    collection.complete &&
    !collection.overlap &&
    collection.attemptCount >= collection.runCount &&
    budget.remainingCredits - budget.unreflectedCredits - budget.reservedCredits >= budget.totalCap
  );
}

const sourceSchema = z
  .object({
    query: countQuerySchema,
    sourceId: id,
    validationKind: z.enum(["page-1-count", "complete-cache"]),
    totalCount: integer,
    pageSize: integer.min(1),
    observedAt: instant,
    expiresAt: instant,
    returnedPage: z.literal(1).optional(),
    returnedItemCount: integer.optional(),
  })
  .strict();
const consumptionSchema = z
  .object({
    phase: z.enum(["preview", "pre-confirm"]),
    requestId: id,
    kind: z.enum(["cards", "sealed"]),
    query: countQuerySchema,
    source: sourceSchema.nullable(),
    readAt: instant,
    ageMs: integer.max(900000).nullable(),
    estimate: integer.min(1).nullable(),
    planFingerprint: hash,
  })
  .strict();
const sendSchema = z
  .object({
    phase: z.enum(["bootstrap", "acquisition", "preview", "pre-confirm"]),
    requestId: id,
    sequence: integer.min(1).max(11),
    category: z.enum(["usage", "cards", "sealed"]),
    requestFingerprint: hash,
    debitedAt: instant,
    respondedAt: instant.nullable(),
    status: integer.min(100).max(599).nullable(),
    outcome: z.enum(["possible-send", "response", "uncertain"]),
  })
  .strict();
export const countLifecycleReceiptSchema = z
  .object({
    schemaVersion: z.literal("scope-sync-count-lifecycle/v1"),
    runId: id,
    authority: countCaptureAuthoritySchema,
    startedAt: instant,
    frozenAt: instant,
    selection: z
      .object({
        scopeRecordId: id,
        productDomain: z.literal("one-piece"),
        parentValue: z.literal("OP01"),
        languageCode: z.literal("en"),
      })
      .strict(),
    units: z
      .array(
        z
          .object({
            unitKey: z.enum(countCaptureUnitKeys),
            profileKey: id,
            profileVersion: id,
            mappingId: id,
            mappingVersion: instant,
            estimate: integer.nullable(),
            blockers: z.array(id).max(100),
          })
          .strict(),
      )
      .length(3),
    notices: z
      .object({
        initialAt: instant,
        finalAt: instant,
        approvalAt: instant,
        quoteId: z.uuid(),
        quoteFingerprint: hash,
        membershipFingerprint: hash,
        authorityFingerprint: hash,
        plannedCount: integer.max(2),
        serverCap: integer.max(2),
      })
      .strict(),
    usage: z
      .object({
        bootstrap: z.enum(["skipped", "persisted", "refused"]),
        observedAt: instant,
        providerUpdatedAt: z.null(),
        remainingCredits: integer,
        unreflectedCredits: integer,
        reservedCredits: integer,
        lagCategory: z.literal("unobserved"),
        persisted: z.boolean(),
      })
      .strict(),
    acquisitions: z
      .array(
        z
          .object({
            evidence: countEvidenceSchema,
            debitId: id,
            quoteId: z.uuid(),
            debitedAt: instant,
            credits: z.literal(1),
            reused: z.boolean(),
            priorReceiptHash: hash.nullable(),
          })
          .strict(),
      )
      .max(2),
    consumption: z.array(consumptionSchema).max(4),
    sends: z.array(sendSchema).max(11),
    preConfirm: z
      .object({
        comparedFingerprint: hash,
        currentFingerprint: hash,
        eligible: z.boolean(),
        blockers: z.array(id).max(100),
        effectsCapability: z.literal(false),
      })
      .strict(),
    effects: z
      .object({
        baselineAt: instant,
        finalAt: instant,
        batches: integer,
        reservations: integer,
        jobs: integer,
        enqueues: integer,
        imports: integer,
        complete: z.boolean(),
      })
      .strict(),
    freezeCollection: countCaptureAuthoritySchema.shape.collection,
    stopReasons: z.array(id).max(100),
  })
  .strict();
export type CountLifecycleReceipt = z.infer<typeof countLifecycleReceiptSchema>;

export function validateCountLifecycleReceipt(value: unknown, forbiddenValues: readonly string[] = []) {
  const failed = { valid: false, verdict: "FAILED" as const, reasons: ["receipt-invalid"] };
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return failed;
  }
  if (
    new TextEncoder().encode(serialized).length > 128_000 ||
    forbiddenValues.some((marker) => marker && serialized.includes(marker)) ||
    /chase_sets_session|authorization|bearer\s|x-api-key|x-team-id|set-cookie|storageState|data:image/i.test(serialized)
  )
    return failed;
  const parsed = countLifecycleReceiptSchema.safeParse(value);
  if (!parsed.success) return failed;
  const receipt = parsed.data;
  const reasons: string[] = [...receipt.stopReasons];
  if (!validateCountCaptureAuthority(receipt.authority, receipt.startedAt)) reasons.push("authority-unbound");
  const at = (value: string) => Date.parse(value);
  if (
    !(
      at(receipt.startedAt) <= at(receipt.notices.initialAt) &&
      at(receipt.notices.initialAt) <= at(receipt.notices.finalAt) &&
      at(receipt.notices.finalAt) <= at(receipt.notices.approvalAt) &&
      at(receipt.notices.approvalAt) <= at(receipt.frozenAt)
    )
  )
    reasons.push("notice-order");
  if (
    receipt.notices.serverCap !== receipt.notices.plannedCount ||
    new Set(receipt.units.map((unit) => unit.unitKey)).size !== 3
  )
    reasons.push("membership-or-cap");
  if (
    !receipt.freezeCollection.complete ||
    receipt.freezeCollection.overlap ||
    at(receipt.freezeCollection.collectedAt) < at(receipt.frozenAt)
  )
    reasons.push("freeze-unknown-or-drift");
  if (receipt.preConfirm.comparedFingerprint !== receipt.preConfirm.currentFingerprint)
    reasons.push("fingerprint-changed");
  if (
    !receipt.effects.complete ||
    [
      receipt.effects.batches,
      receipt.effects.reservations,
      receipt.effects.jobs,
      receipt.effects.enqueues,
      receipt.effects.imports,
    ].some((value) => value !== 0)
  )
    reasons.push("effects-not-proven-zero");
  const caps = { bootstrap: 1, acquisition: receipt.notices.plannedCount, preview: 4, "pre-confirm": 4 };
  for (const [phase, cap] of Object.entries(caps)) {
    const sends = receipt.sends.filter((send) => send.phase === phase);
    if (sends.length > cap || sends.some((send) => (phase === "acquisition") === (send.category === "usage")))
      reasons.push("phase-cap");
  }
  if (
    receipt.sends.some(
      (send, index) =>
        send.sequence !== index + 1 ||
        send.outcome !== "response" ||
        send.status === null ||
        send.status < 200 ||
        send.status >= 300 ||
        !send.respondedAt,
    )
  )
    reasons.push("send-uncertain");
  if (
    receipt.sends.filter((send) => send.category === "usage").length > 9 ||
    ["cards", "sealed"].some((kind) => receipt.sends.filter((send) => send.category === kind).length > 1)
  )
    reasons.push("category-cap");
  const missing: string[] = [];
  for (const phase of ["preview", "pre-confirm"] as const)
    for (const kind of ["cards", "sealed"] as const) {
      const rows = receipt.consumption.filter((row) => row.phase === phase && row.kind === kind);
      const row = rows[0];
      if (rows.length !== 1 || !row?.source) {
        missing.push(`${phase}-${kind}-source`);
        continue;
      }
      const source = row.source;
      if (
        countQueryKey(row.query) !== countQueryKey(source.query) ||
        row.query.kind !== kind ||
        !countTimeIsCurrent(source, row.readAt) ||
        row.ageMs !== at(row.readAt) - at(source.observedAt) ||
        row.estimate !== Math.max(1, Math.ceil(source.totalCount / source.pageSize)) ||
        row.planFingerprint !== receipt.preConfirm.currentFingerprint
      )
        reasons.push("consumed-source-mismatch");
      if (source.validationKind !== "page-1-count") {
        missing.push(`${phase}-${kind}-page1`);
        continue;
      }
      const acquired = receipt.acquisitions.filter(
        ({ evidence }) =>
          evidence.sourceId === source.sourceId && countQueryKey(evidence.query) === countQueryKey(source.query),
      );
      if (
        acquired.length !== 1 ||
        acquired[0]?.debitId !== source.sourceId ||
        (acquired[0].reused && !acquired[0].priorReceiptHash) ||
        acquired[0].evidence.totalCount !== source.totalCount ||
        acquired[0].evidence.pageSize !== source.pageSize ||
        acquired[0].evidence.observedAt !== source.observedAt ||
        acquired[0].evidence.expiresAt !== source.expiresAt
      )
        missing.push(`${phase}-${kind}-writer-join`);
    }
  return {
    valid: true,
    verdict: reasons.length ? ("FAILED" as const) : missing.length ? ("INCOMPLETE" as const) : ("CONFORMING" as const),
    reasons: [...new Set([...reasons, ...missing])],
  };
}
