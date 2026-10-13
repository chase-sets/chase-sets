import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { admissionResources, captureServingSet, proofDigest } from "./agent-grant-revocation-release.mjs";

describe("revocation-caller-partition workflow caller", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/platform-production.yml", import.meta.url), "utf8"),
  );
  it("requires explicit activation after support verification rather than startup or every deploy", () => {
    expect(workflow.on.workflow_dispatch.inputs.activate_agent_grant_revocation).toMatchObject({
      type: "boolean",
      default: false,
    });
    const steps = workflow.jobs["deploy-production"].steps;
    const activation = steps.find((step) => step.name === "Verify production Kubernetes deployment transition");
    expect(activation.env.ACTIVATE_AGENT_GRANT_REVOCATION).toContain("inputs.activate_agent_grant_revocation == true");
    expect(activation.run.indexOf("agent-grant-revocation-release.mjs activate")).toBeGreaterThan(
      activation.run.indexOf("verify-deployment-transition"),
    );
    expect(activation.run).toContain('if [ "$ACTIVATE_AGENT_GRANT_REVOCATION" = "true" ]; then');
    expect(steps.find((step) => step.name === "Upload production Kubernetes deployment transition").with.path).toBe(
      "artifacts/release-health/production-kubernetes-deployment-transition.json",
    );
    const upload = steps.find((step) => step.name === "Upload Agent Grant revocation activation");
    expect(upload.with.path).toBe("artifacts/release-health/agent-grant-revocation-activation.json");
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.if).toContain("inputs.activate_agent_grant_revocation == true");
  });
  it("checks the durable compatibility floor before both automatic rollback paths", () => {
    for (const name of ["Abort production Argo Rollouts", "Roll back production Kubernetes release"]) {
      const step = workflow.jobs["deploy-production"].steps.find((value) => value.name === name);
      expect(step.run.indexOf("agent-grant-revocation-release.mjs check-rollback")).toBeGreaterThanOrEqual(0);
      expect(step.run.indexOf("agent-grant-revocation-release.mjs check-rollback")).toBeLessThan(
        step.run.indexOf("pnpm run platform:kubernetes-deployment"),
      );
    }
  });
});

describe("revocation-floor serving membership and admission", () => {
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const options = {
    namespace: "synthetic",
    releaseCommit: "a".repeat(40),
    imageDigest,
    evidenceId: "synthetic-run",
    fenceId: "synthetic-fence",
    now: new Date("2026-10-13T00:00:00.000Z"),
  };
  const pods = () => ({
    metadata: {},
    items: ["platform-api", "platform-worker"].map((role) => ({
      metadata: { name: role, namespace: "synthetic", uid: `synthetic-${role}` },
      spec: { containers: [{ name: role, image: `registry.example/platform@${imageDigest}` }] },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: role, ready: true, state: { running: {} }, imageID: `registry.example/platform@${imageDigest}` },
        ],
      },
    })),
  });
  const support = new Map(["platform-api", "platform-worker"].map((role) => [`synthetic-${role}`, 1]));
  it("captures every actual member, never a selected ready-pod prefix or desired Deployment", () => {
    expect(captureServingSet({ ...options, pods: pods(), support })).toMatchObject({
      expectedReplicas: ["platform-api", "platform-worker"],
      replicas: [
        expect.objectContaining({ uid: "synthetic-platform-api" }),
        expect.objectContaining({ uid: "synthetic-platform-worker" }),
      ],
    });
  });
  it("binds receipts independently of JSONB key order while retaining member array order", () => {
    const proof = captureServingSet({ ...options, pods: pods(), support });
    const reordered = JSON.parse(JSON.stringify(proof), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    );
    expect(proofDigest(reordered)).toBe(proofDigest(proof));
    expect(proofDigest({ ...proof, replicas: [...proof.replicas].reverse() })).not.toBe(proofDigest(proof));
  });
  it.each(["continued", "old-replica", "missing-worker", "not-ready", "changed-digest", "unknown-support"])(
    "refuses %s without manufacturing completeness",
    (poison) => {
      const changed = pods();
      const supported = new Map(support);
      if (poison === "continued") changed.metadata.continue = "more";
      if (poison === "missing-worker") changed.items.pop();
      if (poison === "old-replica")
        changed.items.push({
          ...changed.items[0],
          metadata: { ...changed.items[0].metadata, name: "old-api", uid: "old-api" },
        });
      if (poison === "not-ready") changed.items[1].status.containerStatuses[0].ready = false;
      if (poison === "changed-digest")
        changed.items[1].status.containerStatuses[0].imageID = "registry.example/old@sha256:old";
      if (poison === "unknown-support") supported.delete("synthetic-platform-worker");
      expect(() => captureServingSet({ ...options, pods: changed, support: supported })).toThrow();
    },
  );
  it("fences membership changes during append and enforces immutable images on later replacement/rollback", () => {
    const input = { namespace: "synthetic", minimumCommit: "a".repeat(40), imageDigests: [imageDigest] };
    const [frozen, binding] = admissionResources({ ...input, frozen: true });
    expect(frozen.spec.validations[0].expression).toBe("false");
    expect(frozen.spec.matchConstraints.resourceRules[0].operations).toEqual(["CREATE", "UPDATE", "DELETE"]);
    expect(frozen.spec.failurePolicy).toBe("Fail");
    expect(binding.spec.validationActions).toEqual(["Deny"]);
    expect(binding.spec.matchResources.namespaceSelector.matchLabels).toEqual({
      "kubernetes.io/metadata.name": "synthetic",
    });
    const [permanent] = admissionResources({ ...input, frozen: false });
    expect(permanent.spec.validations[0].expression).toContain(imageDigest);
    expect(permanent.spec.validations[0].expression).toContain("c.image.endsWith('@' + d)");
    expect(permanent.metadata.annotations["chase-sets.com/revocation-minimum-commit"]).toBe(input.minimumCommit);
  });
});
