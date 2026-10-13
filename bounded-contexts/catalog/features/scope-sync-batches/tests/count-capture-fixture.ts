import { countCapturePacketHash, type CountCaptureAuthority } from "../domain/count-lifecycle-receipt";

export function syntheticCountCaptureAuthority(dispatchId = "synthetic-dispatch"): CountCaptureAuthority {
  const sha = "a".repeat(40);
  const digest = `sha256:${"b".repeat(64)}`;
  return {
    dispatchId,
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
      dispatchId,
      observedAt: "2026-10-13T08:01:00.000Z",
      adminReplicas: 1,
      apiReplicas: 1,
      ready: (["admin", "api"] as const).map((component) => ({
        component,
        image: `ghcr.io/chase-sets/chase-sets@${digest}`,
        imageId: `docker-pullable://ghcr.io/chase-sets/chase-sets@${digest}`,
      })),
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
