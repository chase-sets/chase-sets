import { z } from "zod";
import { countEvidenceSchema, countQuerySchema, countQueryKey, countTimeIsCurrent } from "./count-acquisition";
import { countCapturePlanSchema, countCaptureUnitKeys } from "./count-capture-plan";
export { countCaptureUnitKeys } from "./count-capture-plan";

export const countCapturePacketHash = "b44ca44ca7e079b66c19588c49842c499376d063aae1bd8420af32d080a37dde";
export const countCaptureArtifactPath = "artifacts/catalog-count-lifecycle/receipt.json";
const text = z.string().min(1).max(256);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const integer = z.number().int().min(0).max(2147483647);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const receiptQuerySchema = countQuerySchema.extend({
  environment: z.literal("staging"),
  accountRevision: id,
  productDomain: z.literal("one-piece"),
  profileKey: id,
  profileVersion: id,
  unitKey: id,
  languageCode: z.literal("en"),
  parentValue: z.literal("OP01"),
});
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
    collection.attemptCount >= 1 &&
    budget.remainingCredits - budget.unreflectedCredits - budget.reservedCredits >= budget.totalCap
  );
}

const sourceSchema = z
  .object({
    query: receiptQuerySchema,
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
    query: receiptQuerySchema,
    source: sourceSchema.nullable(),
    readAt: instant,
    ageMs: integer.max(900000).nullable(),
    estimate: integer.min(1).nullable(),
    planFingerprint: hash,
  })
  .strict();
export const countCapturePlannerReadSchema = z
  .object({
    phase: z.enum(["preview", "pre-confirm"]),
    requestId: z.uuid(),
    planFingerprint: hash,
    comparedFingerprint: hash.nullable(),
    eligible: z.boolean(),
    refusal: id.nullable(),
    effectsCapability: z.literal(false),
    plan: countCapturePlanSchema,
    winners: z
      .array(z.object({ query: receiptQuerySchema, source: sourceSchema.nullable(), readAt: instant }).strict())
      .max(2),
  })
  .strict();
export type CountCapturePlannerRead = z.infer<typeof countCapturePlannerReadSchema>;
const sendSchema = z
  .object({
    phase: z.enum(["bootstrap", "acquisition", "preview", "pre-confirm"]),
    requestId: id,
    sequence: integer.min(1).max(11),
    category: z.enum(["usage", "cards", "sealed"]),
    usage: z
      .object({
        purpose: z.enum(["bootstrap", "readiness", "planImport"]),
        unitKey: z.enum(countCaptureUnitKeys).optional(),
      })
      .strict()
      .optional(),
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
        lagCategory: z.enum(["unobserved", "documented-window"]),
        persisted: z.boolean(),
      })
      .strict(),
    acquisitions: z
      .array(
        z
          .object({
            evidence: countEvidenceSchema.safeExtend({ query: receiptQuerySchema, sourceId: id }),
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

// Early refusal cannot honestly supply the successful lifecycle's required
// fields. Absent evidence stays absent; it never becomes a zero or a PASS.
export const countLifecycleStopReceiptSchema = z
  .object({
    schemaVersion: z.literal("scope-sync-count-lifecycle-stop/v1"),
    stoppedAt: instant,
    phase: z.enum(["baseline", "bootstrap", "quote", "acquisition", "preview", "pre-confirm", "freeze"]),
    reason: z.enum([
      "authority-unbound",
      "deployment-unknown",
      "source-unavailable",
      "missing-observation",
      "run-expired",
      "capture-stopped",
      "send-uncertain",
      "unexpected-effects",
      "receipt-leak",
    ]),
    evidence: countLifecycleReceiptSchema.omit({ schemaVersion: true, stopReasons: true }).partial(),
  })
  .strict();
export type CountLifecycleStopReceipt = z.infer<typeof countLifecycleStopReceiptSchema>;

export function countCaptureContainsForbidden(serialized: string, forbiddenValues: readonly string[]) {
  try {
    const markers = forbiddenValues
      .filter(Boolean)
      .flatMap((marker) => [
        marker,
        JSON.stringify(marker).slice(1, -1),
        encodeURIComponent(marker),
        Buffer.from(marker).toString("base64"),
      ]);
    const unsafe = (value: string) =>
      markers.some((marker) => value.includes(marker)) ||
      /chase_sets_session|authorization|bearer\s|x-api-key|x-team-id|set-cookie|storageState|data:image|https?:\/\//i.test(
        value,
      );
    if (unsafe(serialized)) return true;
    const pending: unknown[] = [JSON.parse(serialized)];
    let visited = 0;
    while (pending.length) {
      if (++visited > 20_000) return true;
      const value = pending.pop();
      if (typeof value === "string" && unsafe(value)) return true;
      if (value && typeof value === "object")
        for (const [key, entry] of Object.entries(value)) {
          if (unsafe(key)) return true;
          pending.push(entry);
        }
    }
    return false;
  } catch {
    return true;
  }
}

export function validateCountLifecycleReceipt(value: unknown, forbiddenValues: readonly string[] = []) {
  const failed = { valid: false, verdict: "FAILED" as const, reasons: ["receipt-invalid"] };
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return failed;
  } catch {
    return failed;
  }
  if (
    new TextEncoder().encode(serialized).length > 128_000 ||
    countCaptureContainsForbidden(serialized, forbiddenValues)
  )
    return failed;
  const stopped = countLifecycleStopReceiptSchema.safeParse(value);
  if (stopped.success) {
    const { evidence, stoppedAt, reason } = stopped.data;
    if (
      (evidence.startedAt && Date.parse(evidence.startedAt) > Date.parse(stoppedAt)) ||
      (evidence.frozenAt && Date.parse(evidence.frozenAt) > Date.parse(stoppedAt)) ||
      evidence.sends?.some(
        (send, index) =>
          send.sequence !== index + 1 ||
          Date.parse(send.debitedAt) > Date.parse(stoppedAt) ||
          (send.respondedAt !== null &&
            (Date.parse(send.respondedAt) < Date.parse(send.debitedAt) ||
              Date.parse(send.respondedAt) > Date.parse(stoppedAt))),
      )
    )
      return failed;
    const failures: string[] = [];
    if (
      evidence.effects &&
      [
        evidence.effects.batches,
        evidence.effects.reservations,
        evidence.effects.jobs,
        evidence.effects.enqueues,
        evidence.effects.imports,
      ].some((count) => count !== 0)
    )
      failures.push("unexpected-effects");
    if (
      evidence.sends?.some(
        (send) =>
          send.outcome !== "response" ||
          send.status === null ||
          send.status < 200 ||
          send.status >= 300 ||
          send.respondedAt === null,
      )
    )
      failures.push("send-uncertain");
    return {
      valid: true,
      verdict:
        ["capture-stopped", "send-uncertain", "unexpected-effects", "receipt-leak"].includes(reason) ||
        failures.length > 0
          ? ("FAILED" as const)
          : ("INCOMPLETE" as const),
      reasons: [...new Set([reason, ...failures])],
    };
  }
  const parsed = countLifecycleReceiptSchema.safeParse(value);
  if (!parsed.success) return failed;
  const receipt = parsed.data;
  const reasons: string[] = [...receipt.stopReasons];
  const missing: string[] = [];
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
    missing.push("freeze-unknown-or-drift");
  if (receipt.preConfirm.comparedFingerprint !== receipt.preConfirm.currentFingerprint)
    reasons.push("fingerprint-changed");
  if (at(receipt.frozenAt) < at(receipt.startedAt) || at(receipt.frozenAt) - at(receipt.startedAt) > 900_000)
    reasons.push("capture-time");
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
    const usage = sends.filter((send) => send.category === "usage");
    if (
      usage.some(
        (send) =>
          !send.usage ||
          (phase === "bootstrap"
            ? send.usage.purpose !== "bootstrap" || send.usage.unitKey !== undefined
            : send.usage.purpose === "readiness"
              ? send.usage.unitKey !== undefined
              : send.usage.purpose !== "planImport" || !send.usage.unitKey),
      ) ||
      new Set(usage.map((send) => `${send.usage?.purpose}:${send.usage?.unitKey ?? ""}`)).size !== usage.length
    )
      reasons.push("usage-subcap");
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
    receipt.sends.some(
      (send) =>
        at(send.debitedAt) < at(receipt.notices.initialAt) ||
        at(send.debitedAt) > at(receipt.frozenAt) ||
        (send.respondedAt !== null &&
          (at(send.respondedAt) < at(send.debitedAt) || at(send.respondedAt) > at(receipt.frozenAt))) ||
        (send.category !== "usage" && at(send.debitedAt) < at(receipt.notices.approvalAt)),
    )
  )
    reasons.push("send-time");
  if (
    receipt.effects.baselineAt !== receipt.startedAt ||
    at(receipt.effects.finalAt) < at(receipt.frozenAt) ||
    at(receipt.usage.observedAt) > at(receipt.notices.approvalAt) ||
    at(receipt.notices.approvalAt) - at(receipt.usage.observedAt) > 900_000 ||
    receipt.usage.remainingCredits - receipt.usage.unreflectedCredits - receipt.usage.reservedCredits <
      receipt.notices.plannedCount + 8 ||
    !receipt.usage.persisted
  )
    reasons.push("authority-or-effects-time");
  if (
    receipt.sends.filter((send) => send.category === "usage").length > 9 ||
    ["cards", "sealed"].some((kind) => receipt.sends.filter((send) => send.category === kind).length > 1)
  )
    reasons.push("category-cap");
  for (const phase of ["preview", "pre-confirm"] as const) {
    const sends = receipt.sends.filter((send) => send.phase === phase);
    if (
      new Set(sends.map((send) => send.requestId)).size !== 1 ||
      countCaptureUnitKeys.some(
        (unitKey) => !sends.some((send) => send.usage?.purpose === "planImport" && send.usage.unitKey === unitKey),
      )
    )
      missing.push(`${phase}-planning-sends`);
    if (receipt.consumption.some((row) => row.phase === phase && row.requestId !== sends[0]?.requestId))
      reasons.push("consumption-request-mismatch");
  }
  for (const phase of ["preview", "pre-confirm"] as const)
    for (const kind of ["cards", "sealed"] as const) {
      const rows = receipt.consumption.filter((row) => row.phase === phase && row.kind === kind);
      const row = rows[0];
      if (rows.length !== 1 || !row?.source) {
        missing.push(`${phase}-${kind}-source`);
        continue;
      }
      const source = row.source;
      const unit = receipt.units.find((unit) => unit.unitKey === countCaptureUnitKeys[kind === "cards" ? 1 : 2]);
      if (
        countQueryKey(row.query) !== countQueryKey(source.query) ||
        row.query.kind !== kind ||
        !unit ||
        row.query.unitKey !== unit.unitKey ||
        row.query.profileKey !== unit.profileKey ||
        row.query.profileVersion !== unit.profileVersion ||
        row.estimate !== unit.estimate ||
        at(row.readAt) < at(receipt.notices.approvalAt) ||
        at(row.readAt) > at(receipt.frozenAt) ||
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
      else if (!acquired[0].reused) {
        const sends = receipt.sends.filter(
          (send) =>
            send.category === kind &&
            send.phase === "acquisition" &&
            send.requestFingerprint === source.query.requestFingerprint,
        );
        if (
          sends.length !== 1 ||
          acquired[0].quoteId !== receipt.notices.quoteId ||
          at(acquired[0].debitedAt) > at(sends[0]!.debitedAt) ||
          at(acquired[0].debitedAt) < at(receipt.notices.approvalAt) ||
          at(source.observedAt) < at(sends[0]!.respondedAt ?? "")
        )
          reasons.push("acquisition-send-join");
      }
    }
  return {
    valid: true,
    verdict: reasons.length ? ("FAILED" as const) : missing.length ? ("INCOMPLETE" as const) : ("CONFORMING" as const),
    reasons: [...new Set([...reasons, ...missing])],
  };
}
