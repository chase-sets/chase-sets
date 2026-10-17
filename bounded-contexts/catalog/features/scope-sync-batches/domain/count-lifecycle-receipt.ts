import { z } from "zod";
import { countQueryKey, countTimeIsCurrent } from "./count-acquisition";
import {
  countCaptureFields,
  countCaptureKindUnitKeys,
  countCaptureKinds,
  countCapturePageOneSourceSchema,
  countCaptureQuerySchema,
  countCaptureSourceSchema,
  countCaptureUnitKeys,
  type CountCaptureKind,
} from "./count-capture-plan";
import { decodedReceiptText } from "./preview-probe-receipt";

// The closed, support-safe staging receipt of one combined count-lifecycle capture
// (acceptance keys 9431-ac7 and 9424-ac5), and the host authority envelope it was admitted under.
// The FINAL packet's Required Receipt Fields are the contract; the packet hash is
// an envelope field the verifier binds, so a successor packet needs no product change.
// Validation proves shape and causal consistency only. It never proves that a
// live deployment, pod, review or spend authority was observed; the verifier does.
export const countLifecycleArtifactPath = "artifacts/catalog-count-lifecycle/receipt.json";
// The synthetic CONFORMING control, which fills every bounded section, serializes
// to 18,256 bytes; 128 KB keeps seven times that headroom and bounds the upload.
export const countLifecycleReceiptMaxBytes = 128_000;
export const countCapturePhaseCaps = { bootstrap: 1, acquisition: 2, preview: 4, "pre-confirm": 4 } as const;
const runCap = Object.values(countCapturePhaseCaps).reduce((total, cap) => total + cap, 0);

const { id, instant, count, hash, sha, ageMs } = countCaptureFields;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const githubId = z.string().regex(/^[1-9]\d{0,19}$/);
const attempt = z.number().int().min(1).max(1000);
const stepNumber = z.number().int().min(1).max(1000);
const label = z.string().regex(/^[\x20-\x7e]{1,256}$/);
const imageRef = z.string().regex(/^[\x21-\x7e]{1,512}$/);
const kind = z.enum(countCaptureKinds);
const sendPhase = z.enum(["bootstrap", "acquisition", "preview", "pre-confirm"]);
const plannerPhase = z.enum(["preview", "pre-confirm"]);

export const countCaptureCollectionReasons = [
  "http-failure",
  "malformed-response",
  "inventory-truncated",
  "inventory-changed",
  "inventory-cap",
  "inventory-duplicate",
  "selected-job-missing",
  "selected-job-unexecuted",
  "deploy-log-unbound",
  "deploy-image-mismatch",
  "deployment-capability-unknown",
  "staging-mutation-overlap",
  "authority-invalid",
] as const;

// GitHub cancels a workflow run 35 days after creation, so any run executing after
// the selected step was created at most this long before it. The collector searches
// from this instant and a bound collection must have covered it.
const runLifetimeMs = 35 * 24 * 60 * 60 * 1000;
export const countCaptureSearchFrom = (startedAt: string) =>
  new Date(Math.floor((Date.parse(startedAt) - runLifetimeMs) / 1000) * 1000).toISOString().replace(".000Z", "Z");

// A bound collection read at least one run page, the attempt object and a jobs page
// of every attempt it inventoried, the selected job's log and each definition it
// classified with. Every classified job read at most a caller and a callee
// definition, and the selected job is never one of them.
const boundInventoryIsCoherent = (collection: {
  runCount: number;
  attemptCount: number;
  jobCount: number;
  pageCount: number;
  definitionCount: number;
  nonMutatingJobCount: number;
}) =>
  collection.runCount >= 1 &&
  collection.attemptCount >= 1 &&
  collection.jobCount >= 1 &&
  collection.nonMutatingJobCount < collection.jobCount &&
  collection.definitionCount <= 2 * collection.nonMutatingJobCount &&
  (collection.nonMutatingJobCount === 0 || collection.definitionCount >= 1) &&
  collection.pageCount >=
    Math.ceil(collection.runCount / 100) + 2 * collection.attemptCount + 1 + collection.definitionCount;

// Produced by the deployment collector. Unknown is never upgraded: only a bound
// outcome names the executed deploy step it bound, and only a coherent inventory
// over an ordered search interval can be bound. Unknown partial counts stay legal.
export const countCaptureCollectionSchema = z
  .object({
    collectedAt: instant,
    outcome: z.enum(["bound", "unknown"]),
    reason: z.enum(countCaptureCollectionReasons).nullable(),
    binding: z.object({ runId: githubId, attempt, jobId: githubId, stepNumber, sha, digest }).strict().nullable(),
    createdFrom: instant,
    runCount: count,
    attemptCount: count,
    jobCount: count,
    pageCount: count.max(10_000),
    definitionCount: count,
    nonMutatingJobCount: count,
  })
  .strict()
  .refine(
    (collection) =>
      (collection.outcome === "bound") === (collection.reason === null) &&
      (collection.outcome === "bound") === (collection.binding !== null) &&
      Date.parse(collection.createdFrom) <= Date.parse(collection.collectedAt) &&
      (collection.outcome !== "bound" || boundInventoryIsCoherent(collection)),
  );
export type CountCaptureCollection = z.infer<typeof countCaptureCollectionSchema>;

export const countCaptureAuthoritySchema = z
  .object({
    dispatchId: id,
    dispatchedAt: instant,
    packetHash: hash,
    runnerSha: sha,
    review: z.object({ head: sha, receiptHash: hash, dispatchId: id }).strict(),
    budget: z
      .object({
        withinAllowance: z.literal(true),
        remainingCredits: count,
        unreflectedCredits: count,
        reservedCredits: count,
        observedAt: instant,
        countCap: z.literal(countCapturePhaseCaps.acquisition),
        usageCap: z.literal(runCap - countCapturePhaseCaps.acquisition),
        totalCap: z.literal(runCap),
      })
      .strict(),
    deployment: z
      .object({
        environment: z.literal("staging"),
        runId: githubId,
        attempt,
        jobId: githubId,
        jobName: label,
        stepNumber,
        stepName: label,
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
        observedAt: instant,
        adminReplicas: z.number().int().min(1).max(100),
        apiReplicas: z.number().int().min(1).max(100),
        ready: z
          .array(z.object({ component: z.enum(["admin", "api"]), image: imageRef, imageId: imageRef }).strict())
          .min(2)
          .max(200),
      })
      .strict(),
    collection: countCaptureCollectionSchema,
  })
  .strict();
export type CountCaptureAuthority = z.infer<typeof countCaptureAuthoritySchema>;

const at = (value: string) => Date.parse(value);
const observationIsFresh = (observedAt: string, now: string) =>
  at(observedAt) <= at(now) && at(now) - at(observedAt) <= 900_000;

// A consistent envelope only: runner = review head = deployed SHA, the executed
// step's log binds that SHA@digest, the deploy finished before dispatch, every
// listed ready pod runs that digest, net budget covers the whole run, the
// collector bound the same step after searching the whole run lifetime before it,
// and every observation is at most 900 s old.
export function validateCountCaptureAuthority(
  value: unknown,
  now: string,
): Readonly<{ ok: boolean; reasons: readonly string[] }> {
  const parsed = countCaptureAuthoritySchema.safeParse(value);
  if (!parsed.success || !instant.safeParse(now).success) return { ok: false, reasons: ["authority-invalid"] };
  const { deployment, pods, budget, collection, review, runnerSha, dispatchedAt } = parsed.data;
  const reasons: string[] = [];
  if (runnerSha !== review.head || runnerSha !== deployment.sha) reasons.push("runner-review-deploy-mismatch");
  if (deployment.logSha !== deployment.sha || deployment.logDigest !== deployment.digest)
    reasons.push("deploy-log-mismatch");
  if (!(at(deployment.startedAt) < at(deployment.completedAt) && at(deployment.completedAt) <= at(dispatchedAt)))
    reasons.push("deploy-order");
  const onDigest = (reference: string) => reference.endsWith(`@${deployment.digest}`);
  if (
    pods.ready.filter((pod) => pod.component === "admin").length !== pods.adminReplicas ||
    pods.ready.filter((pod) => pod.component === "api").length !== pods.apiReplicas ||
    !pods.ready.every((pod) => onDigest(pod.image) && onDigest(pod.imageId))
  )
    reasons.push("pod-image-mismatch");
  if (budget.remainingCredits - budget.unreflectedCredits - budget.reservedCredits < budget.totalCap)
    reasons.push("budget-headroom");
  if (
    ![dispatchedAt, budget.observedAt, pods.observedAt, collection.collectedAt].every((t) => observationIsFresh(t, now))
  )
    reasons.push("stale-observation");
  if (at(pods.observedAt) < at(dispatchedAt) || at(collection.collectedAt) < at(pods.observedAt))
    reasons.push("observation-order");
  if (!collectionBindsDeployment(collection, deployment)) reasons.push("collection-unbound");
  return { ok: reasons.length === 0, reasons };
}

function collectionBindsDeployment(
  collection: CountCaptureCollection,
  deployment: CountCaptureAuthority["deployment"],
): boolean {
  const binding = collection.binding;
  return (
    collection.outcome === "bound" &&
    binding !== null &&
    at(collection.createdFrom) <= at(countCaptureSearchFrom(deployment.startedAt)) &&
    binding.runId === deployment.runId &&
    binding.attempt === deployment.attempt &&
    binding.jobId === deployment.jobId &&
    binding.stepNumber === deployment.stepNumber &&
    binding.sha === deployment.sha &&
    binding.digest === deployment.digest
  );
}

const verdict = z.enum(["CONFORMING", "INCOMPLETE", "FAILED"]);
const outcomeSchema = z.object({ verdict, reasons: z.array(id).max(100) }).strict();
const classificationSchema = outcomeSchema
  .extend({ acceptance: z.object({ "9431-ac7": outcomeSchema, "9424-ac5": outcomeSchema }).strict() })
  .strict();
export type CountLifecycleClassification = z.infer<typeof classificationSchema>;

const capturePhases = [
  "admission",
  "baseline",
  "bootstrap",
  "quote",
  "acquisition",
  "preview",
  "pre-confirm",
  "freeze",
] as const;
const phaseWindow = z.object({ phase: z.enum(capturePhases), startedAt: instant, endedAt: instant }).strict();
const effectCounts = z
  .object({ at: instant, batches: count, reservations: count, jobs: count, enqueues: count, imports: count })
  .strict();
const sendSchema = z
  .object({
    sequence: z.number().int().min(1).max(runCap),
    phase: sendPhase,
    requestId: id,
    category: z.enum(["usage", "cards", "sealed", "other"]),
    usage: z
      .object({
        purpose: z.enum(["bootstrap", "readiness", "planImport"]),
        unitKey: z.enum(countCaptureUnitKeys).nullable(),
      })
      .strict()
      .nullable(),
    requestFingerprint: hash,
    debitedAt: instant,
    respondedAt: instant.nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    outcome: z.enum(["response", "uncertain"]),
  })
  .strict();

const receiptFields = {
  attribution: z
    .object({
      dispatchId: id,
      runnerRunId: githubId,
      runnerRunAttempt: attempt,
      runnerSha: sha,
      packetHash: hash,
      reviewReceiptHash: hash,
      phases: z.array(phaseWindow).max(capturePhases.length),
    })
    .strict(),
  authority: countCaptureAuthoritySchema,
  startedAt: instant,
  frozenAt: instant,
  selection: z
    .object({
      scopeRecordId: id,
      accountRevision: id,
      productDomain: z.literal("one-piece"),
      parentValue: z.literal("OP01"),
      languageCode: z.literal("en"),
    })
    .strict(),
  access: z
    .object({
      originHost: z.literal("admin.staging.chasesets.com"),
      role: z.literal("platform-admin"),
      permissions: z.array(z.enum(["catalog.view", "catalog.manage"])).length(2),
      ownerMatch: z.boolean(),
      checkedAt: instant,
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
          setCoordinate: z.literal("OP01"),
          estimate: count.nullable(),
          blockers: z.array(id).max(100),
        })
        .strict(),
    )
    .length(countCaptureUnitKeys.length),
  notices: z
    .object({
      initial: z.object({ at: instant, fingerprint: hash }).strict(),
      final: z.object({ at: instant, fingerprint: hash, readBackAt: instant, readBackFingerprint: hash }).strict(),
      approvalAt: instant,
    })
    .strict(),
  quote: z
    .object({
      quoteId: z.uuid(),
      fingerprint: hash,
      state: z.enum(["quoted", "approved", "acquiring", "complete", "failed", "uncertain"]),
      membershipFingerprint: hash,
      authorityFingerprint: hash,
      expiresAt: instant,
      queries: z.array(countCaptureQuerySchema).length(countCaptureKinds.length),
      missingKinds: z.array(kind).max(countCaptureKinds.length),
      reusedKinds: z.array(kind).max(countCaptureKinds.length),
      plannedCredits: count.max(countCapturePhaseCaps.acquisition),
      cap: count.max(countCapturePhaseCaps.acquisition),
      perKindBound: z.literal(1),
    })
    .strict(),
  usage: z
    .object({
      bootstrap: z.enum(["skipped", "persisted", "refused"]),
      creditState: z.enum(["available", "low", "exhausted", "unknown"]),
      totalCredits: count.nullable(),
      remainingCredits: count.nullable(),
      usedCredits: count.nullable(),
      observedAt: instant,
      ageMs,
      providerUpdatedAt: instant.nullable(),
      lagCategory: z.enum(["within-provider-window", "beyond-provider-window", "documented-window", "unobserved"]),
      unreflectedCredits: count,
      reservedCredits: count,
      additionalUsageCredits: count,
      persisted: z.boolean(),
    })
    .strict(),
  acquisitions: z
    .array(
      z
        .object({
          evidence: countCapturePageOneSourceSchema,
          debitId: id,
          quoteId: z.uuid(),
          kind,
          debitedAt: instant,
          credits: z.literal(1),
          outcome: z.enum(["acquiring", "complete", "failed", "uncertain"]),
          reused: z.boolean(),
          priorReceiptHash: hash.nullable(),
          method: z.literal("GET"),
        })
        .strict(),
    )
    .max(countCaptureKinds.length),
  consumption: z
    .array(
      z
        .object({
          phase: plannerPhase,
          requestId: id,
          kind,
          query: countCaptureQuerySchema,
          source: countCaptureSourceSchema.nullable(),
          readAt: instant,
          ageMs: ageMs.nullable(),
          pages: count.min(1).nullable(),
          estimate: count.min(1).nullable(),
          planFingerprint: hash,
        })
        .strict(),
    )
    .max(4),
  sends: z.array(sendSchema).max(runCap),
  accounting: z
    .object({
      possibleSends: z
        .object({
          bootstrap: count.max(runCap),
          acquisition: count.max(runCap),
          preview: count.max(runCap),
          "pre-confirm": count.max(runCap),
          other: count.max(runCap),
        })
        .strict(),
      total: count.max(runCap),
      debitedCountCredits: count.max(countCapturePhaseCaps.acquisition),
      plannedMaximumCredits: count.max(runCap),
    })
    .strict(),
  preConfirm: z
    .object({
      comparedFingerprint: hash,
      currentFingerprint: hash,
      eligible: z.boolean(),
      refusal: id.nullable(),
      blockers: z.array(id).max(100),
      effectsCapability: z.literal(false),
    })
    .strict(),
  effects: z.object({ baseline: effectCounts, final: effectCounts, complete: z.boolean() }).strict(),
  freezeCollection: countCaptureCollectionSchema,
};

export const countLifecycleStopReasons = [
  "authority-unbound",
  "deployment-unknown",
  "source-unavailable",
  "missing-observation",
  "run-expired",
  "capture-stopped",
  "send-uncertain",
  "unexpected-effects",
  "receipt-leak",
] as const;

export const countLifecycleReceiptSchema = z
  .object({
    schemaVersion: z.literal("scope-sync-count-lifecycle/v1"),
    ...receiptFields,
    stopReasons: z.array(z.enum(countLifecycleStopReasons)).max(countLifecycleStopReasons.length),
    classification: classificationSchema,
  })
  .strict();
export type CountLifecycleReceipt = z.infer<typeof countLifecycleReceiptSchema>;

const failedStopReasons = new Set<string>(["capture-stopped", "send-uncertain", "unexpected-effects", "receipt-leak"]);

// An early refusal cannot honestly supply the lifecycle's required fields.
// Absent evidence stays absent; it never becomes a zero, a quote or a PASS.
export const countLifecycleStopReceiptSchema = z
  .object({
    schemaVersion: z.literal("scope-sync-count-lifecycle-stop/v1"),
    // A runner can stop before admission, so no server attribution exists yet.
    // Once the server has sealed a run it fills every field and retains the
    // phases it observed.
    attribution: receiptFields.attribution
      .extend({
        dispatchId: id.nullable(),
        runnerRunId: githubId.nullable(),
        runnerRunAttempt: attempt.nullable(),
        runnerSha: sha.nullable(),
        packetHash: hash.nullable(),
        reviewReceiptHash: hash.nullable(),
      })
      .strict(),
    stoppedAt: instant,
    phase: z.enum(capturePhases),
    reason: z.enum(countLifecycleStopReasons),
    // Retain the durable send ledger at the stop envelope as well as inside
    // evidence so callers can account for debits without unpacking evidence.
    sends: receiptFields.sends.default([]),
    evidence: z.object(receiptFields).strict().partial(),
    classification: classificationSchema,
  })
  .strict();
export type CountLifecycleStopReceipt = z.infer<typeof countLifecycleStopReceiptSchema>;

type Acceptance = keyof CountLifecycleClassification["acceptance"];
type Finding = Readonly<{ failed: boolean; reason: string; acceptance: readonly Acceptance[] }>;
const both: readonly Acceptance[] = ["9431-ac7", "9424-ac5"];
// 9431-ac7 owns the approved page-1/debit of every acquired kind and the card
// reads; 9424-ac5 owns the sealed writer facts and the sealed reads.
const consumedBy = (kind: CountCaptureKind): readonly Acceptance[] => (kind === "cards" ? ["9431-ac7"] : ["9424-ac5"]);
const acquiredBy = (kind: CountCaptureKind): readonly Acceptance[] => (kind === "cards" ? ["9431-ac7"] : both);

function classify(findings: readonly Finding[]): CountLifecycleClassification {
  const outcome = (scope: readonly Finding[]) => ({
    verdict: scope.some((finding) => finding.failed)
      ? ("FAILED" as const)
      : scope.length
        ? ("INCOMPLETE" as const)
        : ("CONFORMING" as const),
    reasons: [...new Set(scope.map((finding) => finding.reason))],
  });
  return {
    ...outcome(findings),
    acceptance: {
      "9431-ac7": outcome(findings.filter((finding) => finding.acceptance.includes("9431-ac7"))),
      "9424-ac5": outcome(findings.filter((finding) => finding.acceptance.includes("9424-ac5"))),
    },
  };
}
const invalid = (reason: string) => classify([{ failed: true, reason, acceptance: both }]);

// Classifies a full or stop receipt from its evidence alone; any recorded
// classification is ignored here and compared by validateCountLifecycleReceipt.
export function classifyCountLifecycleReceipt(value: unknown): CountLifecycleClassification {
  return classifyEvidence(value).classification;
}

function classifyEvidence(value: unknown): Readonly<{ parsed: boolean; classification: CountLifecycleClassification }> {
  const stop = countLifecycleStopReceiptSchema.safeParse(value);
  if (stop.success) {
    const classification = classifyStop(stop.data);
    return { parsed: classification !== null, classification: classification ?? invalid("receipt-invalid") };
  }
  const parsed = countLifecycleReceiptSchema.safeParse(value);
  return parsed.success
    ? { parsed: true, classification: classify(receiptFindings(parsed.data)) }
    : { parsed: false, classification: invalid("receipt-invalid") };
}

function classifyStop(stop: CountLifecycleStopReceipt): CountLifecycleClassification | null {
  const { evidence, stoppedAt, reason } = stop;
  const findings: Finding[] = [{ failed: failedStopReasons.has(reason), reason, acceptance: both }];
  if (
    (evidence.startedAt && at(evidence.startedAt) > at(stoppedAt)) ||
    (evidence.frozenAt && at(evidence.frozenAt) > at(stoppedAt)) ||
    evidence.sends?.some((send, index) => send.sequence !== index + 1 || at(send.debitedAt) > at(stoppedAt))
  )
    return null;
  if (evidence.effects && !effectsUnchanged(evidence.effects))
    findings.push({ failed: true, reason: "unexpected-effects", acceptance: both });
  if (evidence.sends?.some((send) => !sendSucceeded(send)))
    findings.push({ failed: true, reason: "send-uncertain", acceptance: both });
  // The stop reason itself is always a finding, so a stop is never CONFORMING.
  return classify(findings);
}

type Send = z.infer<typeof sendSchema>;
const sendSucceeded = (send: Send) =>
  send.outcome === "response" &&
  send.status !== null &&
  send.status >= 200 &&
  send.status < 300 &&
  send.respondedAt !== null &&
  at(send.respondedAt) >= at(send.debitedAt);
const effectsUnchanged = (effects: CountLifecycleReceipt["effects"]) =>
  (["batches", "reservations", "jobs", "enqueues", "imports"] as const).every(
    (key) => effects.final[key] === effects.baseline[key],
  ) && at(effects.baseline.at) <= at(effects.final.at);

function receiptFindings(receipt: CountLifecycleReceipt): Finding[] {
  const findings: Finding[] = [];
  const fail = (reason: string, acceptance: readonly Acceptance[] = both) =>
    findings.push({ failed: true, reason, acceptance });
  const miss = (reason: string, acceptance: readonly Acceptance[] = both) =>
    findings.push({ failed: false, reason, acceptance });
  const { attribution, authority, notices, quote, usage, sends, accounting, preConfirm, effects } = receipt;
  const within = (value: string, from: string, to: string) => at(from) <= at(value) && at(value) <= at(to);
  const phase = (name: (typeof capturePhases)[number]) => attribution.phases.find((window) => window.phase === name);
  const inPhase = (name: (typeof capturePhases)[number], value: string) => {
    const window = phase(name);
    return window !== undefined && within(value, window.startedAt, window.endedAt);
  };

  for (const reason of receipt.stopReasons) fail(reason);
  if (!validateCountCaptureAuthority(authority, receipt.startedAt).ok) fail("authority-unbound");
  if (
    attribution.dispatchId !== authority.dispatchId ||
    attribution.runnerSha !== authority.runnerSha ||
    attribution.packetHash !== authority.packetHash ||
    attribution.reviewReceiptHash !== authority.review.receiptHash
  )
    fail("attribution-mismatch");
  if (at(receipt.frozenAt) < at(receipt.startedAt) || at(receipt.frozenAt) - at(receipt.startedAt) > 900_000)
    fail("capture-time");

  const order = attribution.phases.map((window) => capturePhases.indexOf(window.phase));
  if (
    order.some((index, position) => position > 0 && index <= order[position - 1]!) ||
    attribution.phases.some(
      (window, position) =>
        at(window.startedAt) > at(window.endedAt) ||
        !within(window.startedAt, receipt.startedAt, receipt.frozenAt) ||
        !within(window.endedAt, receipt.startedAt, receipt.frozenAt) ||
        (position > 0 && at(window.startedAt) < at(attribution.phases[position - 1]!.endedAt)),
    )
  )
    fail("phase-order");
  const requiredPhases = ["admission", "baseline", "quote", "preview", "pre-confirm", "freeze"] as const;
  for (const name of requiredPhases) if (!phase(name)) miss(`${name}-phase-missing`);

  if (
    !within(notices.initial.at, receipt.startedAt, notices.final.at) ||
    !within(notices.final.readBackAt, notices.final.at, notices.approvalAt) ||
    !within(notices.approvalAt, notices.final.readBackAt, receipt.frozenAt) ||
    notices.final.readBackFingerprint !== notices.final.fingerprint
  )
    fail("notice-order");
  if (
    !receipt.access.ownerMatch ||
    new Set(receipt.access.permissions).size !== 2 ||
    !within(receipt.access.checkedAt, receipt.startedAt, notices.initial.at)
  )
    fail("access-unproven");

  const unitFor = (kind: CountCaptureKind) =>
    receipt.units.find((unit) => unit.unitKey === countCaptureKindUnitKeys[kind]);
  const queryFor = (kind: CountCaptureKind) => quote.queries.find((query) => query.kind === kind);
  const plannedKinds = new Set([...quote.missingKinds, ...quote.reusedKinds]);
  if (
    new Set(receipt.units.map((unit) => unit.unitKey)).size !== countCaptureUnitKeys.length ||
    new Set(quote.queries.map((query) => query.kind)).size !== countCaptureKinds.length ||
    plannedKinds.size !== countCaptureKinds.length ||
    quote.missingKinds.length + quote.reusedKinds.length !== countCaptureKinds.length ||
    quote.cap !== quote.plannedCredits ||
    quote.plannedCredits !== quote.missingKinds.length ||
    countCaptureKinds.some((kind) => {
      const query = queryFor(kind);
      const unit = unitFor(kind);
      return (
        !query ||
        !unit ||
        query.accountRevision !== receipt.selection.accountRevision ||
        query.profileKey !== unit.profileKey ||
        query.profileVersion !== unit.profileVersion
      );
    })
  )
    fail("membership-or-cap");
  if (["failed", "uncertain"].includes(quote.state) || at(quote.expiresAt) < at(notices.approvalAt))
    fail("quote-state");

  // The usage observation precedes approval, so its net headroom must cover every
  // remaining slot: P count credits plus both planner phases' usage caps.
  const remainingRun = quote.plannedCredits + countCapturePhaseCaps.preview + countCapturePhaseCaps["pre-confirm"];
  const plannedMaximum = (usage.bootstrap === "persisted" ? countCapturePhaseCaps.bootstrap : 0) + remainingRun;
  if (
    usage.bootstrap === "refused" ||
    !usage.persisted ||
    usage.remainingCredits === null ||
    usage.remainingCredits - usage.unreflectedCredits - usage.reservedCredits - usage.additionalUsageCredits <
      remainingRun ||
    usage.ageMs !== at(notices.approvalAt) - at(usage.observedAt)
  )
    fail("usage-headroom");
  // Spend needs a known, unexhausted credit state and the producer's own balance
  // invariant: a total and a remaining balance, the remainder never above the total.
  if (usage.creditState === "unknown" || usage.creditState === "exhausted") fail("usage-authority");
  if (usage.totalCredits === null || usage.remainingCredits === null || usage.remainingCredits > usage.totalCredits)
    fail("usage-balance");
  // The planner read's own invariant: a read is eligible exactly when it carries no refusal.
  if (preConfirm.eligible !== (preConfirm.refusal === null)) fail("pre-confirm-eligibility");

  const sendsIn = (name: z.infer<typeof sendPhase>) => sends.filter((send) => send.phase === name);
  const usageSends = (scope: readonly Send[]) => scope.filter((send) => send.category === "usage");
  if (sends.some((send) => send.category === "other")) fail("unexpected-send");
  if (
    sendsIn("bootstrap").length !== (usage.bootstrap === "persisted" ? 1 : 0) ||
    sendsIn("bootstrap").some((send) => send.category !== "usage" || send.usage?.purpose !== "bootstrap")
  )
    fail("bootstrap-mismatch");
  const acquisitionSends = sendsIn("acquisition");
  if (
    acquisitionSends.length > quote.plannedCredits ||
    acquisitionSends.some((send) => send.category !== "cards" && send.category !== "sealed") ||
    countCaptureKinds.some((kind) => acquisitionSends.filter((send) => send.category === kind).length > 1) ||
    sends.filter((send) => send.category === "usage").length > runCap - countCapturePhaseCaps.acquisition
  )
    fail("phase-cap");
  for (const planner of plannerPhase.options) {
    const phaseSends = sendsIn(planner);
    const planning = usageSends(phaseSends);
    const keys = planning.map((send) => `${send.usage?.purpose}:${send.usage?.unitKey ?? ""}`);
    if (
      phaseSends.length > countCapturePhaseCaps[planner] ||
      phaseSends.some((send) => send.category !== "usage" && send.category !== "other") ||
      planning.some(
        (send) =>
          !send.usage ||
          (send.usage.purpose === "readiness"
            ? send.usage.unitKey !== null
            : send.usage.purpose !== "planImport" || send.usage.unitKey === null),
      ) ||
      new Set(keys).size !== keys.length
    )
      fail("usage-subcap");
    if (
      new Set(phaseSends.map((send) => send.requestId)).size !== 1 ||
      countCaptureUnitKeys.some(
        (unitKey) => !planning.some((send) => send.usage?.purpose === "planImport" && send.usage.unitKey === unitKey),
      )
    )
      miss(`${planner}-planning-sends`);
  }
  if (sends.some((send, index) => send.sequence !== index + 1) || sends.some((send) => !sendSucceeded(send)))
    fail("send-uncertain");
  if (
    sends.some(
      (send) =>
        !within(send.debitedAt, notices.initial.at, receipt.frozenAt) ||
        (send.respondedAt !== null && at(send.respondedAt) > at(receipt.frozenAt)) ||
        !inPhase(send.phase, send.debitedAt) ||
        (send.category !== "usage" && at(send.debitedAt) < at(notices.approvalAt)),
    )
  )
    fail("send-time");
  const counted = { ...accounting.possibleSends };
  if (
    sendPhase.options.some(
      (name) => counted[name] !== sends.filter((send) => send.phase === name && send.category !== "other").length,
    ) ||
    counted.other !== sends.filter((send) => send.category === "other").length ||
    accounting.total !== sends.length ||
    accounting.debitedCountCredits !== receipt.acquisitions.filter((acquired) => !acquired.reused).length ||
    accounting.debitedCountCredits !== acquisitionSends.length ||
    accounting.plannedMaximumCredits !== plannedMaximum ||
    plannedMaximum > runCap
  )
    fail("accounting-mismatch");

  if (!effects.complete) miss("effects-unknown");
  else if (!effectsUnchanged(effects)) fail("unexpected-effects");
  if (
    !within(effects.baseline.at, receipt.startedAt, notices.initial.at) ||
    at(effects.final.at) < at(receipt.frozenAt)
  )
    fail("effects-time");
  if (
    !collectionBindsDeployment(receipt.freezeCollection, authority.deployment) ||
    at(receipt.freezeCollection.collectedAt) < at(receipt.frozenAt)
  )
    miss("freeze-unknown-or-drift");
  if (preConfirm.comparedFingerprint !== preConfirm.currentFingerprint) fail("fingerprint-changed");

  for (const kind of countCaptureKinds) {
    const query = queryFor(kind);
    const acquired = receipt.acquisitions.filter((acquisition) => acquisition.kind === kind);
    const acquisition = acquired[0];
    if (
      acquired.length > 1 ||
      (acquisition &&
        (!query ||
          acquisition.evidence.query.kind !== kind ||
          countQueryKey(acquisition.evidence.query) !== countQueryKey(query) ||
          acquisition.debitId !== acquisition.evidence.sourceId ||
          acquisition.quoteId !== quote.quoteId ||
          acquisition.reused !== quote.reusedKinds.includes(kind) ||
          (acquisition.reused ? acquisition.priorReceiptHash === null : acquisition.priorReceiptHash !== null) ||
          acquisition.outcome !== "complete"))
    )
      fail(`${kind}-acquisition-mismatch`, acquiredBy(kind));
    // The count store refuses a claim once the quote expired, so a durable debit
    // after expiry contradicts the approval it claims.
    if (acquisition && !acquisition.reused && at(acquisition.debitedAt) > at(quote.expiresAt))
      fail(`${kind}-debit-after-expiry`, acquiredBy(kind));
    if (quote.missingKinds.includes(kind)) {
      const sent = acquisitionSends.filter((send) => send.category === kind);
      if (!acquisition || acquisition.reused || sent.length !== 1)
        miss(`${kind}-acquisition-missing`, acquiredBy(kind));
      else if (
        sent[0]!.requestFingerprint !== acquisition.evidence.query.requestFingerprint ||
        !within(acquisition.debitedAt, notices.approvalAt, sent[0]!.debitedAt) ||
        at(acquisition.evidence.observedAt) < at(sent[0]!.respondedAt ?? receipt.frozenAt)
      )
        fail(`${kind}-acquisition-send-join`, acquiredBy(kind));
    }

    for (const planner of plannerPhase.options) {
      const rows = receipt.consumption.filter((row) => row.phase === planner && row.kind === kind);
      const row = rows[0];
      if (rows.length !== 1 || !row?.source) {
        miss(`${planner}-${kind}-source`, consumedBy(kind));
        continue;
      }
      const source = row.source;
      const unit = unitFor(kind);
      const pages = Math.max(1, Math.ceil(source.totalCount / source.pageSize));
      if (row.requestId !== sendsIn(planner)[0]?.requestId) fail("consumption-request-mismatch", consumedBy(kind));
      if (
        row.planFingerprint !== (planner === "preview" ? preConfirm.comparedFingerprint : preConfirm.currentFingerprint)
      )
        fail("fingerprint-changed", consumedBy(kind));
      if (
        !query ||
        countQueryKey(row.query) !== countQueryKey(query) ||
        countQueryKey(source.query) !== countQueryKey(query) ||
        !unit ||
        !within(row.readAt, notices.approvalAt, receipt.frozenAt) ||
        !inPhase(planner, row.readAt) ||
        !countTimeIsCurrent(source, row.readAt) ||
        row.ageMs !== at(row.readAt) - at(source.observedAt) ||
        row.pages !== pages ||
        row.estimate !== pages ||
        row.estimate !== unit.estimate
      )
        fail("consumed-source-mismatch", consumedBy(kind));
      if (source.validationKind !== "page-1-count") {
        miss(`${planner}-${kind}-page1`, consumedBy(kind));
        continue;
      }
      // A page-1 claim is satisfied only by the writer's own validated acquisition
      // of THAT source; a matching total from another source is not evidence.
      if (!acquisition || acquisition.evidence.sourceId !== source.sourceId) {
        miss(`${planner}-${kind}-writer-join`, consumedBy(kind));
        continue;
      }
      const writer = acquisition.evidence;
      if (
        countQueryKey(writer.query) !== countQueryKey(source.query) ||
        writer.totalCount !== source.totalCount ||
        writer.pageSize !== source.pageSize ||
        writer.returnedItemCount !== source.returnedItemCount ||
        writer.observedAt !== source.observedAt ||
        writer.expiresAt !== source.expiresAt
      )
        fail(`${kind}-writer-mismatch`, acquiredBy(kind));
    }
  }
  return findings;
}

const genericLeak =
  /chase_sets_session|authorization|bearer\s|basic\s[a-z0-9+/=]{8,}|x-api-key|x-team-id|set-cookie|storagestate|data:image|https?:\/\//i;
const leakingKey = /password|cookie|authorization|secret|token|session|rawpayload|credential/i;

// Value-free leak check over the serialized bytes AND every decoded key/value, so
// JSON escapes (quotes, backslashes, control characters, \u sequences) cannot
// hide a forbidden marker. Callers learn only that something leaked, never what.
export function countCaptureContainsForbidden(serialized: string, forbiddenValues: readonly string[]): boolean {
  try {
    const markers = forbiddenValues
      .flatMap((value) => [value, value.trim()])
      .filter((value) => value.length > 0)
      .flatMap((value) => [
        value,
        JSON.stringify(value).slice(1, -1),
        encodeURIComponent(value),
        Buffer.from(value).toString("base64"),
      ]);
    const unsafe = (text: string) => genericLeak.test(text) || markers.some((marker) => text.includes(marker));
    if (unsafe(serialized)) return true;
    const decoded = decodedReceiptText(JSON.parse(serialized));
    return decoded.texts.some(unsafe) || decoded.keys.some((key) => leakingKey.test(key));
  } catch {
    return true;
  }
}

export type CountLifecycleValidation = Readonly<{
  valid: boolean;
  errors: readonly string[];
  classification: CountLifecycleClassification;
}>;

// Valid only when bounded, leak-free, schema-closed and self-classified exactly as
// its evidence derives. Errors are fixed codes and never echo receipt values.
export function validateCountLifecycleReceipt(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): CountLifecycleValidation {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).length > countLifecycleReceiptMaxBytes)
    return { valid: false, errors: ["receipt-invalid"], classification: invalid("receipt-invalid") };
  if (countCaptureContainsForbidden(serialized, forbiddenValues))
    return { valid: false, errors: ["receipt-leak"], classification: invalid("receipt-leak") };
  const { parsed, classification } = classifyEvidence(value);
  if (!parsed) return { valid: false, errors: ["receipt-invalid"], classification };
  const recorded = (value as { classification?: unknown }).classification;
  if (JSON.stringify(canonicalClassification(recorded)) !== JSON.stringify(canonicalClassification(classification)))
    return { valid: false, errors: ["classification-mismatch"], classification };
  return { valid: true, errors: [], classification };
}

function canonicalClassification(value: unknown) {
  const parsed = classificationSchema.safeParse(value);
  if (!parsed.success) return null;
  const outcome = ({ verdict, reasons }: z.infer<typeof outcomeSchema>) => ({ verdict, reasons });
  return {
    ...outcome(parsed.data),
    acceptance: {
      "9431-ac7": outcome(parsed.data.acceptance["9431-ac7"]),
      "9424-ac5": outcome(parsed.data.acceptance["9424-ac5"]),
    },
  };
}
