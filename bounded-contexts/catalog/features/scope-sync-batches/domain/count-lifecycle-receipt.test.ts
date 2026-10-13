import { describe, expect, it } from "vitest";
import {
  validateCountCaptureAuthority,
  validateCountLifecycleReceipt,
  countCapturePacketHash,
} from "./count-lifecycle-receipt";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
export function syntheticCaptureAuthority() {
  return {
    dispatchId: "synthetic-dispatch",
    dispatchedAt: "2026-10-13T08:00:00.000Z",
    packetHash: countCapturePacketHash,
    runnerSha: sha,
    review: { head: sha, receiptHash: "c".repeat(64), dispatchId: "synthetic-review" },
    budget: {
      withinAllowance: true,
      remainingCredits: 30,
      unreflectedCredits: 3,
      reservedCredits: 2,
      observedAt: "2026-10-13T08:00:00.000Z",
      countCap: 2,
      usageCap: 9,
      totalCap: 11,
    },
    deployment: {
      runId: "100",
      attempt: 1,
      jobId: "200",
      jobName: "Deploy Staging",
      stepNumber: 35,
      stepName: "Deploy staging Kubernetes release",
      conclusion: "success",
      startedAt: "2026-10-13T07:40:00.000Z",
      completedAt: "2026-10-13T07:45:00.000Z",
      sha,
      digest,
      logSha: sha,
      logDigest: digest,
    },
    pods: {
      dispatchId: "synthetic-dispatch",
      observedAt: "2026-10-13T08:01:00.000Z",
      adminReplicas: 1,
      apiReplicas: 1,
      ready: [
        {
          component: "admin",
          image: `ghcr.io/chase-sets/chase-sets@${digest}`,
          imageId: `docker-pullable://ghcr.io/chase-sets/chase-sets@${digest}`,
        },
        {
          component: "api",
          image: `ghcr.io/chase-sets/chase-sets@${digest}`,
          imageId: `docker-pullable://ghcr.io/chase-sets/chase-sets@${digest}`,
        },
      ],
    },
    collection: {
      collectedAt: "2026-10-13T08:01:30.000Z",
      complete: true,
      overlap: false,
      workflowCount: 9,
      runCount: 10,
      attemptCount: 10,
      jobCount: 15,
      pageCount: 30,
    },
  };
}

describe("rejects unbound deployment", () => {
  const now = "2026-10-13T08:02:00.000Z";
  it("accepts only complete, causally bound job/image/review and whole-run allowance proof", () => {
    expect(validateCountCaptureAuthority(syntheticCaptureAuthority(), now)).toBe(true);
  });
  it.each([
    "missing-budget",
    "skipped-job",
    "stale-image",
    "later-deploy",
    "review-hash",
    "collector-deleted",
    "old-pods",
    "foreign-dispatch",
    "missing-replica",
    "short-total-headroom",
    "nested-unknown",
    "date-only",
    "unsafe-number",
  ])("refuses %s authority input before any spend", (mutant) => {
    const value = structuredClone(syntheticCaptureAuthority());
    if (mutant === "missing-budget") Reflect.deleteProperty(value, "budget");
    if (mutant === "skipped-job") Reflect.set(value.deployment, "conclusion", "skipped");
    if (mutant === "stale-image") value.pods.ready[0]!.imageId = `sha256:${"d".repeat(64)}`;
    if (mutant === "later-deploy") value.collection.overlap = true;
    if (mutant === "review-hash") value.review.head = "e".repeat(40);
    if (mutant === "collector-deleted") Reflect.deleteProperty(value, "collection");
    if (mutant === "old-pods") value.pods.observedAt = "2026-10-13T07:00:00.000Z";
    if (mutant === "foreign-dispatch") value.pods.dispatchId = "synthetic-other";
    if (mutant === "missing-replica") value.pods.ready.pop();
    if (mutant === "short-total-headroom") value.budget.remainingCredits = 7;
    if (mutant === "nested-unknown") Reflect.set(value.deployment, "unchecked", true);
    if (mutant === "date-only") value.pods.observedAt = "2026-10-13";
    if (mutant === "unsafe-number") value.budget.remainingCredits = Number.MAX_SAFE_INTEGER;
    expect(validateCountCaptureAuthority(value, now)).toBe(false);
  });
});

describe("rejects unsafe lifecycle receipt projections", () => {
  it("accepts the completely synthetic, source-joined lifecycle control", () => {
    expect(validateCountLifecycleReceipt(syntheticCountLifecycleReceipt())).toMatchObject({
      valid: true,
      verdict: "CONFORMING",
    });
  });
  it.each([
    "nested-unknown",
    "date-only",
    "out-of-range",
    "same-total-other-source",
    "future-source",
    "stale-source",
    "request-mismatch",
    "missing-observer",
    "readiness-for-plan",
    "duplicate-plan",
    "send-before-approval",
    "reserve",
    "enqueue",
    "failed-commit",
  ])("does not accept the %s evidence mutation", (mode) => {
    const receipt = syntheticCountLifecycleReceipt();
    const source = receipt.consumption[0]!.source!;
    if (mode === "nested-unknown") Reflect.set(source.query, "unchecked", true);
    if (mode === "date-only") receipt.consumption[0]!.readAt = "2026-10-13";
    if (mode === "out-of-range") source.totalCount = 2147483648;
    if (mode === "same-total-other-source") source.sourceId = "synthetic-unrelated-source";
    if (mode === "future-source") source.observedAt = "2026-10-13T09:00:00.000Z";
    if (mode === "stale-source") source.observedAt = "2026-10-13T07:00:00.000Z";
    if (mode === "request-mismatch") receipt.consumption[0]!.requestId = "synthetic-another-request";
    if (mode === "missing-observer") receipt.consumption = [];
    if (mode === "readiness-for-plan") receipt.sends[2]!.usage = { purpose: "readiness" };
    if (mode === "duplicate-plan") receipt.sends[3]!.usage = receipt.sends[2]!.usage;
    if (mode === "send-before-approval") receipt.sends[0]!.debitedAt = receipt.notices.initialAt;
    if (mode === "reserve") receipt.effects.reservations = 1;
    if (mode === "enqueue") receipt.effects.enqueues = 1;
    if (mode === "failed-commit") receipt.sends[0]!.status = null;
    expect(validateCountLifecycleReceipt(receipt).verdict).not.toBe("CONFORMING");
  });
  it("detects a synthetic credential marker even inside otherwise allowed text", () => {
    const receipt = syntheticCountLifecycleReceipt();
    receipt.units[0]!.profileKey = "synthetic-secret-marker";
    expect(validateCountLifecycleReceipt(receipt, ["synthetic-secret-marker"]).valid).toBe(false);
    receipt.units[0]!.profileKey = "chase_sets_session";
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(false);
  });
});
