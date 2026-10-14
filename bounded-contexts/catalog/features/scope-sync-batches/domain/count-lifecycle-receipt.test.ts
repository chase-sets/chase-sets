import { describe, expect, it } from "vitest";
import {
  classifyCountLifecycleReceipt,
  countCaptureCollectionSchema,
  countCaptureContainsForbidden,
  validateCountCaptureAuthority,
  validateCountLifecycleReceipt,
} from "./count-lifecycle-receipt";
import { countCapturePlanSchema, countCapturePlannerReadSchema } from "./count-capture-plan";
import {
  syntheticCountCaptureAuthority,
  syntheticCountCapturePlannerRead,
  syntheticCountLifecycleReceipt,
  syntheticCountLifecycleStopReceipt,
} from "../tests/count-lifecycle-receipt-fixture";

type Receipt = ReturnType<typeof syntheticCountLifecycleReceipt>;
const row = (receipt: Receipt, phase: string, kind: string) =>
  receipt.consumption.find((candidate) => candidate.phase === phase && candidate.kind === kind)!;

describe("derives receipt verdicts", () => {
  it("classifies the complete synthetic control CONFORMING for both acceptance criteria and records it", () => {
    const receipt = syntheticCountLifecycleReceipt();
    expect(validateCountLifecycleReceipt(receipt)).toEqual({
      valid: true,
      errors: [],
      classification: receipt.classification,
    });
  });

  // [mutation, expected overall verdict, reason it must name, #9431 AC7 verdict, #9424 AC5 verdict]
  it.each<[string, (receipt: Receipt) => void, string, string, string, string]>([
    [
      "nested-unknown",
      (r) => Reflect.set(row(r, "preview", "cards").source.query, "unchecked", true),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "date-only",
      (r) => (row(r, "preview", "cards").readAt = "2026-10-13"),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    ["timezone-free", (r) => (r.frozenAt = "2026-10-13T08:06:00"), "FAILED", "receipt-invalid", "FAILED", "FAILED"],
    [
      "total-out-of-range",
      (r) => (row(r, "preview", "cards").source.totalCount = 2_147_483_648),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "size-out-of-range",
      (r) => (r.acquisitions[0]!.evidence.pageSize = 0),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      // A complete-cache source has no returned-page refine, so only the size bound refuses it.
      "complete-cache-size-out-of-range",
      (r) => {
        const source = row(r, "preview", "sealed").source as Record<string, unknown>;
        Object.assign(source, { validationKind: "complete-cache", sourceId: "synthetic-sealed-cache", pageSize: 0 });
        Reflect.deleteProperty(source, "returnedPage");
        Reflect.deleteProperty(source, "returnedItemCount");
      },
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "unsafe-integer",
      (r) => (r.usage.remainingCredits = Number.MAX_SAFE_INTEGER + 2),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "age-out-of-range",
      (r) => (row(r, "preview", "cards").ageMs = 900_001),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    ["call-bound", (r) => r.sends.push(...r.sends.slice(0, 4)), "FAILED", "receipt-invalid", "FAILED", "FAILED"],
    [
      "array-bound",
      (r) => r.consumption.push(row(r, "preview", "cards")),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "text-bound",
      (r) => (r.selection.scopeRecordId = "s".repeat(129)),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "missing-row",
      (r) => (r.consumption = r.consumption.filter((c) => !(c.phase === "pre-confirm" && c.kind === "sealed"))),
      "INCOMPLETE",
      "pre-confirm-sealed-source",
      "CONFORMING",
      "INCOMPLETE",
    ],
    ["missing-observer", (r) => (r.consumption = []), "INCOMPLETE", "preview-cards-source", "INCOMPLETE", "INCOMPLETE"],
    [
      "relabelled-source",
      (r) => Reflect.set(row(r, "preview", "cards").source, "validationKind", "complete-cache"),
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    [
      "complete-cache-winner",
      (r) => {
        const source = row(r, "preview", "sealed").source as Record<string, unknown>;
        Object.assign(source, { validationKind: "complete-cache", sourceId: "synthetic-sealed-cache" });
        Reflect.deleteProperty(source, "returnedPage");
        Reflect.deleteProperty(source, "returnedItemCount");
      },
      "INCOMPLETE",
      "preview-sealed-page1",
      "CONFORMING",
      "INCOMPLETE",
    ],
    [
      "cache-relabelled-as-page1",
      (r) =>
        (row(r, "pre-confirm", "cards").source = {
          ...row(r, "pre-confirm", "cards").source,
          sourceId: "synthetic-cards-cache",
        }),
      "INCOMPLETE",
      "pre-confirm-cards-writer-join",
      "INCOMPLETE",
      "CONFORMING",
    ],
    [
      "same-total-other-writer-facts",
      (r) => (r.acquisitions[1]!.evidence.observedAt = "2026-10-13T08:03:02.000Z"),
      "FAILED",
      "sealed-writer-mismatch",
      "FAILED",
      "FAILED",
    ],
    [
      "stale-source",
      (r) => (row(r, "pre-confirm", "cards").readAt = "2026-10-13T08:18:30.000Z"),
      "FAILED",
      "consumed-source-mismatch",
      "FAILED",
      "CONFORMING",
    ],
    [
      "future-source",
      (r) => (row(r, "preview", "sealed").readAt = "2026-10-13T08:03:00.000Z"),
      "FAILED",
      "consumed-source-mismatch",
      "CONFORMING",
      "FAILED",
    ],
    [
      "age-mismatch",
      (r) => (row(r, "preview", "cards").ageMs = 1),
      "FAILED",
      "consumed-source-mismatch",
      "FAILED",
      "CONFORMING",
    ],
    [
      "page-formula",
      (r) => (row(r, "preview", "cards").pages = 1),
      "FAILED",
      "consumed-source-mismatch",
      "FAILED",
      "CONFORMING",
    ],
    [
      "request-mismatch",
      (r) => (row(r, "preview", "cards").requestId = "synthetic-other-request"),
      "FAILED",
      "consumption-request-mismatch",
      "FAILED",
      "CONFORMING",
    ],
    [
      "fingerprint-changed",
      (r) => (r.preConfirm.currentFingerprint = "0".repeat(64)),
      "FAILED",
      "fingerprint-changed",
      "FAILED",
      "FAILED",
    ],
    [
      "readiness-for-plan",
      (r) => (r.sends[2]!.usage = { purpose: "readiness", unitKey: null }),
      "INCOMPLETE",
      "preview-planning-sends",
      "INCOMPLETE",
      "INCOMPLETE",
    ],
    ["duplicate-plan", (r) => (r.sends[3]!.usage = r.sends[2]!.usage), "FAILED", "usage-subcap", "FAILED", "FAILED"],
    ["unexpected-category", (r) => (r.sends[4]!.category = "other"), "FAILED", "unexpected-send", "FAILED", "FAILED"],
    [
      "send-before-approval",
      (r) => (r.sends[0]!.debitedAt = r.notices.final.readBackAt),
      "FAILED",
      "send-time",
      "FAILED",
      "FAILED",
    ],
    [
      "send-uncertain",
      (r) => Object.assign(r.sends[5]!, { outcome: "uncertain", status: null, respondedAt: null }),
      "FAILED",
      "send-uncertain",
      "FAILED",
      "FAILED",
    ],
    [
      "accounting-mismatch",
      (r) => (r.accounting.possibleSends.preview = 2),
      "FAILED",
      "accounting-mismatch",
      "FAILED",
      "FAILED",
    ],
    ["reserve", (r) => (r.effects.final.reservations += 1), "FAILED", "unexpected-effects", "FAILED", "FAILED"],
    ["enqueue", (r) => (r.effects.final.enqueues += 1), "FAILED", "unexpected-effects", "FAILED", "FAILED"],
    [
      "effects-unproven",
      (r) => (r.effects.complete = false),
      "INCOMPLETE",
      "effects-unknown",
      "INCOMPLETE",
      "INCOMPLETE",
    ],
    [
      "freeze-unknown",
      (r) => Object.assign(r.freezeCollection, { outcome: "unknown", reason: "inventory-truncated", binding: null }),
      "INCOMPLETE",
      "freeze-unknown-or-drift",
      "INCOMPLETE",
      "INCOMPLETE",
    ],
    [
      "freeze-drift",
      (r) => (r.freezeCollection.binding!.jobId = "201"),
      "INCOMPLETE",
      "freeze-unknown-or-drift",
      "INCOMPLETE",
      "INCOMPLETE",
    ],
    [
      "attribution-mismatch",
      (r) => (r.attribution.packetHash = "0".repeat(64)),
      "FAILED",
      "attribution-mismatch",
      "FAILED",
      "FAILED",
    ],
    [
      "notice-readback",
      (r) => (r.notices.final.readBackFingerprint = "0".repeat(64)),
      "FAILED",
      "notice-order",
      "FAILED",
      "FAILED",
    ],
    [
      "phase-order",
      (r) => (r.attribution.phases[4]!.startedAt = "2026-10-13T08:05:40.000Z"),
      "FAILED",
      "phase-order",
      "FAILED",
      "FAILED",
    ],
    ["usage-headroom", (r) => (r.usage.reservedCredits = 89), "FAILED", "usage-headroom", "FAILED", "FAILED"],
    ["unknown-credit", (r) => (r.usage.creditState = "unknown"), "FAILED", "usage-authority", "FAILED", "FAILED"],
    ["exhausted-credit", (r) => (r.usage.creditState = "exhausted"), "FAILED", "usage-authority", "FAILED", "FAILED"],
    ["missing-total", (r) => (r.usage.totalCredits = null), "FAILED", "usage-balance", "FAILED", "FAILED"],
    ["impossible-balance", (r) => (r.usage.totalCredits = 1), "FAILED", "usage-balance", "FAILED", "FAILED"],
    [
      "expired-debit",
      (r) => (r.quote.expiresAt = "2026-10-13T08:03:00.100Z"),
      "FAILED",
      "cards-debit-after-expiry",
      "FAILED",
      "FAILED",
    ],
    [
      "contradictory-pre-confirm-refusal",
      (r) => (r.preConfirm.refusal = "synthetic-refused"),
      "FAILED",
      "pre-confirm-eligibility",
      "FAILED",
      "FAILED",
    ],
    [
      "contradictory-pre-confirm-eligibility",
      (r) => (r.preConfirm.eligible = false),
      "FAILED",
      "pre-confirm-eligibility",
      "FAILED",
      "FAILED",
    ],
    [
      "empty-future-collection",
      (r) => {
        for (const key of ["runCount", "attemptCount", "jobCount", "pageCount", "definitionCount"] as const)
          r.authority.collection[key] = 0;
        r.authority.collection.nonMutatingJobCount = 0;
        r.authority.collection.createdFrom = "2099-01-01T00:00:00Z";
      },
      "FAILED",
      "receipt-invalid",
      "FAILED",
      "FAILED",
    ],
    ["quote-cap", (r) => (r.quote.cap = 1), "FAILED", "membership-or-cap", "FAILED", "FAILED"],
    [
      "authority-unbound",
      (r) => (r.startedAt = "2026-10-13T08:15:01.000Z"),
      "FAILED",
      "authority-unbound",
      "FAILED",
      "FAILED",
    ],
    ["access-unproven", (r) => (r.access.ownerMatch = false), "FAILED", "access-unproven", "FAILED", "FAILED"],
    ["stop-reason", (r) => r.stopReasons.push("capture-stopped"), "FAILED", "capture-stopped", "FAILED", "FAILED"],
  ])("does not accept the %s evidence", (_mutation, mutate, verdict, reason, ac7, ac5) => {
    const receipt = syntheticCountLifecycleReceipt();
    mutate(receipt);
    const classified = classifyCountLifecycleReceipt(receipt);
    expect(classified).toMatchObject({
      verdict,
      acceptance: { "9431-ac7": { verdict: ac7 }, "9424-ac5": { verdict: ac5 } },
    });
    expect(classified.reasons).toContain(reason);
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(false);
  });

  // Coherent evidence that is not a contradiction stays CONFORMING: a low but
  // sufficient balance, a debit at the quote's last valid instant, and a pre-confirm
  // read that honestly reports a blocked plan.
  it.each<[string, (receipt: Receipt) => void]>([
    ["low-but-sufficient credit", (r) => (r.usage.creditState = "low")],
    ["debit at quote expiry", (r) => (r.quote.expiresAt = r.acquisitions[0]!.debitedAt)],
    [
      "blocked pre-confirm",
      (r) => Object.assign(r.preConfirm, { eligible: false, refusal: "synthetic-blocked", blockers: ["synthetic"] }),
    ],
  ])("keeps a %s CONFORMING", (_case, mutate) => {
    const receipt = syntheticCountLifecycleReceipt();
    mutate(receipt);
    expect(validateCountLifecycleReceipt(receipt)).toMatchObject({
      valid: true,
      classification: { verdict: "CONFORMING" },
    });
  });

  it.each(Object.keys(syntheticCountLifecycleReceipt()))("refuses a receipt that drops required field %s", (key) => {
    const receipt = syntheticCountLifecycleReceipt();
    Reflect.deleteProperty(receipt, key);
    expect(classifyCountLifecycleReceipt(receipt)).toMatchObject({ verdict: "FAILED", reasons: ["receipt-invalid"] });
  });

  it.each(Object.keys(syntheticCountLifecycleReceipt().attribution))("refuses dropped attribution field %s", (key) => {
    const receipt = syntheticCountLifecycleReceipt();
    Reflect.deleteProperty(receipt.attribution, key);
    expect(classifyCountLifecycleReceipt(receipt).verdict).toBe("FAILED");
  });

  it("refuses a receipt that records a better classification than its evidence derives", () => {
    const receipt = syntheticCountLifecycleReceipt();
    receipt.effects.complete = false;
    expect(validateCountLifecycleReceipt(receipt)).toMatchObject({
      valid: false,
      errors: ["classification-mismatch"],
      classification: { verdict: "INCOMPLETE" },
    });
  });

  it("retains an early stop as INCOMPLETE without inventing a run, quote, source, zero calls or deployment", () => {
    const stop = syntheticCountLifecycleStopReceipt();
    expect(validateCountLifecycleReceipt(stop)).toEqual({
      valid: true,
      errors: [],
      classification: stop.classification,
    });
  });

  it("never lets a stop receipt claim CONFORMING or hide retained effects and uncertain sends", () => {
    const stop = syntheticCountLifecycleStopReceipt();
    stop.classification = syntheticCountLifecycleReceipt().classification;
    expect(validateCountLifecycleReceipt(stop).valid).toBe(false);
    const receipt = syntheticCountLifecycleReceipt();
    receipt.effects.final.enqueues += 1;
    receipt.sends[0]!.outcome = "uncertain";
    const retained = {
      ...syntheticCountLifecycleStopReceipt(),
      stoppedAt: receipt.frozenAt,
      evidence: { effects: receipt.effects, sends: receipt.sends },
    };
    expect(classifyCountLifecycleReceipt(retained)).toMatchObject({
      verdict: "FAILED",
      reasons: ["authority-unbound", "unexpected-effects", "send-uncertain"],
    });
  });

  it.each([
    'synthetic-quote-"-secret',
    "synthetic-newline-\n-secret",
    "synthetic-slash-\\-secret",
    "synthetic-ünicode-secret",
  ])("detects a JSON-escaped forbidden marker %j value-free", (marker) => {
    const receipt = syntheticCountLifecycleReceipt();
    Reflect.set(receipt.authority.deployment, "jobName", marker);
    const result = validateCountLifecycleReceipt(receipt, [marker]);
    expect(result).toMatchObject({ valid: false, errors: ["receipt-leak"] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  // The scanner also guards projections the closed schemas never see, so a
  // credential-shaped key leaks even when its value and every other text is innocuous.
  it.each(["sessionCookie", "x_password", "rawPayload", "\\u0074oken"])(
    "flags a credential-shaped key %j even with an innocuous value",
    (key) => {
      const serialized = `{"synthetic":{"${key}":"synthetic-value"}}`;
      expect(countCaptureContainsForbidden(serialized, [])).toBe(true);
      expect(countCaptureContainsForbidden('{"synthetic":{"label":"synthetic-value"}}', [])).toBe(false);
    },
  );
});

describe("rejects unbound deployment", () => {
  const now = "2026-10-13T08:02:00.000Z";
  it("accepts only a consistent runner, review, executed deployment, pod, budget and collection envelope", () => {
    expect(validateCountCaptureAuthority(syntheticCountCaptureAuthority(), now)).toEqual({ ok: true, reasons: [] });
  });

  type Authority = ReturnType<typeof syntheticCountCaptureAuthority>;
  it.each<[string, (authority: Authority) => void, string]>([
    ["missing-budget", (a) => Reflect.deleteProperty(a, "budget"), "authority-invalid"],
    ["skipped-job", (a) => Reflect.set(a.deployment, "conclusion", "skipped"), "authority-invalid"],
    [
      "stale-image",
      (a) => (a.pods.ready[1]!.imageId = `docker-pullable://registry.example.invalid/x@sha256:${"0".repeat(64)}`),
      "pod-image-mismatch",
    ],
    ["missing-replica", (a) => a.pods.ready.pop(), "pod-image-mismatch"],
    [
      "later-deploy",
      (a) => Object.assign(a.collection, { outcome: "unknown", reason: "staging-mutation-overlap", binding: null }),
      "collection-unbound",
    ],
    ["collector-deleted", (a) => Reflect.deleteProperty(a, "collection"), "authority-invalid"],
    ["other-collection-binding", (a) => (a.collection.binding.jobId = "201"), "collection-unbound"],
    ["review-hash", (a) => (a.review.head = "e".repeat(40)), "runner-review-deploy-mismatch"],
    ["runner-not-deployed", (a) => (a.runnerSha = "e".repeat(40)), "runner-review-deploy-mismatch"],
    ["log-digest", (a) => (a.deployment.logDigest = `sha256:${"0".repeat(64)}`), "deploy-log-mismatch"],
    ["deploy-after-dispatch", (a) => (a.deployment.completedAt = "2026-10-13T08:00:01.000Z"), "deploy-order"],
    ["freshness", (a) => (a.budget.observedAt = "2026-10-13T07:46:59.000Z"), "stale-observation"],
    ["future-observation", (a) => (a.collection.collectedAt = "2026-10-13T08:02:01.000Z"), "stale-observation"],
    ["pods-before-dispatch", (a) => (a.pods.observedAt = "2026-10-13T07:59:59.000Z"), "observation-order"],
    ["short-headroom", (a) => (a.budget.remainingCredits = 15), "budget-headroom"],
    ["over-allowance", (a) => Reflect.set(a.budget, "withinAllowance", false), "authority-invalid"],
    ["nested-unknown", (a) => Reflect.set(a.deployment, "unchecked", true), "authority-invalid"],
    ["date-only", (a) => (a.pods.observedAt = "2026-10-13"), "authority-invalid"],
    ["unsafe-number", (a) => (a.budget.remainingCredits = Number.MAX_SAFE_INTEGER), "authority-invalid"],
    [
      "empty-bound-inventory",
      (a) => {
        for (const key of ["runCount", "attemptCount", "jobCount", "pageCount", "definitionCount"] as const)
          a.collection[key] = 0;
        a.collection.nonMutatingJobCount = 0;
      },
      "authority-invalid",
    ],
    ["bound-without-runs", (a) => (a.collection.runCount = 0), "authority-invalid"],
    ["bound-without-attempts", (a) => (a.collection.attemptCount = 0), "authority-invalid"],
    ["bound-without-jobs", (a) => (a.collection.jobCount = 0), "authority-invalid"],
    ["bound-without-enough-reads", (a) => (a.collection.pageCount = 12), "authority-invalid"],
    ["every-job-non-mutating", (a) => (a.collection.nonMutatingJobCount = a.collection.jobCount), "authority-invalid"],
    ["classified-without-definitions", (a) => (a.collection.definitionCount = 0), "authority-invalid"],
    ["definitions-without-classified-jobs", (a) => (a.collection.nonMutatingJobCount = 1), "authority-invalid"],
    ["future-search-window", (a) => (a.collection.createdFrom = "2099-01-01T00:00:00Z"), "authority-invalid"],
    ["truncated-search-window", (a) => (a.collection.createdFrom = "2026-09-09T07:40:00Z"), "collection-unbound"],
  ])("refuses %s authority input before any spend", (_mutant, mutate, reason) => {
    const authority = syntheticCountCaptureAuthority();
    mutate(authority);
    const result = validateCountCaptureAuthority(authority, now);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("keeps an honest zero-inventory unknown collection structurally valid without promoting it", () => {
    const authority = syntheticCountCaptureAuthority();
    const collection = {
      ...authority.collection,
      outcome: "unknown",
      reason: "http-failure",
      binding: null,
      createdFrom: authority.collection.collectedAt,
      runCount: 0,
      attemptCount: 0,
      jobCount: 0,
      pageCount: 1,
      definitionCount: 0,
      nonMutatingJobCount: 0,
    };
    expect(countCaptureCollectionSchema.safeParse(collection).success).toBe(true);
    expect(validateCountCaptureAuthority({ ...authority, collection }, now)).toEqual({
      ok: false,
      reasons: ["collection-unbound"],
    });
  });

  it("refuses an unparseable validation instant", () => {
    expect(validateCountCaptureAuthority(syntheticCountCaptureAuthority(), "2026-10-13")).toEqual({
      ok: false,
      reasons: ["authority-invalid"],
    });
  });
});

describe("validates planner-read projections", () => {
  type PlannerRead = ReturnType<typeof syntheticCountCapturePlannerRead>;
  const units = (read: PlannerRead) => read.plan.scopes[0]!.units;
  const parses = (read: unknown) => countCapturePlannerReadSchema.safeParse(read).success;

  it.each(["preview", "pre-confirm"] as const)("accepts the %s read of both sourced kinds", (phase) => {
    const read = syntheticCountCapturePlannerRead(phase);
    expect(countCapturePlanSchema.safeParse(read.plan).success).toBe(true);
    expect(parses(read)).toBe(true);
  });

  it("accepts an unsourced estimate whose winner read no source", () => {
    const read = syntheticCountCapturePlannerRead();
    units(read)[2]!.estimate.countSourceId = null;
    read.winners[1]!.source = null;
    expect(parses(read)).toBe(true);
  });

  it.each<[string, (read: PlannerRead) => void]>([
    ["missing cards winner", (r) => r.winners.shift()],
    ["missing sealed winner", (r) => r.winners.pop()],
    [
      "cards source ID substituted for the missing sealed winner",
      (r) => {
        r.winners.pop();
        units(r)[2]!.estimate.countSourceId = r.winners[0]!.source!.sourceId as string;
      },
    ],
    [
      "sealed source ID substituted for the missing cards winner",
      (r) => {
        r.winners.shift();
        units(r)[1]!.estimate.countSourceId = r.winners[0]!.source!.sourceId as string;
      },
    ],
    ["sourced unit whose winner read no source", (r) => (r.winners[1]!.source = null)],
    ["winner source the unit does not name", (r) => (units(r)[1]!.estimate.countSourceId = "synthetic-other-source")],
    [
      "profile version drift",
      (r) => {
        units(r)[2]!.profileVersion = "synthetic-2";
        r.plan.scopes[0]!.profileVersions[2]!.profileVersion = "synthetic-2";
      },
    ],
    ["profile key drift", (r) => (r.winners[0]!.query.profileKey = "synthetic-other")],
    ["query differs from its source", (r) => (r.winners[0]!.query.accountRevision = "synthetic-other-revision")],
    ["winner kind differs from its query", (r) => (r.winners[0]!.kind = "sealed")],
    ["nested unknown estimate key", (r) => Reflect.set(units(r)[1]!.estimate, "unchecked", true)],
    ["nested unknown source key", (r) => Reflect.set(r.winners[0]!.source!, "unchecked", true)],
    ["preview carrying a compared fingerprint", (r) => (r.comparedFingerprint = r.planFingerprint)],
    ["eligible read carrying a refusal", (r) => (r.refusal = "synthetic-refused")],
    ["provider unit count drift", (r) => (r.plan.scopes[0]!.providerUnitCount = 2)],
  ])("rejects a %s", (_case, mutate) => {
    const read = syntheticCountCapturePlannerRead();
    mutate(read);
    expect(parses(read)).toBe(false);
  });
});
