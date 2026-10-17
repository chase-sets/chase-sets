import { mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { admissionResources, captureServingSet, main, proofDigest } from "./agent-grant-revocation-release.mjs";

describe("revocation release CLI decisions", () => {
  const minimumCommit = "a".repeat(40);
  const releaseCommit = "b".repeat(40);
  const minimumDigest = `sha256:${"a".repeat(64)}`;
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const proof = { releaseCommit: minimumCommit, imageDigest: minimumDigest };
  const dormant = { state: "dormant" };
  const activated = { state: "activated", proof };
  let directory;
  let out;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "synthetic-revocation-release-"));
    out = join(directory, "receipt.json");
    vi.stubEnv("GITHUB_RUN_ID", "7422");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(out, { force: true });
    rmdirSync(directory);
  });
  function args(action, commit = releaseCommit) {
    return [
      action,
      "--namespace",
      "synthetic",
      ...(action === "check-rollback"
        ? ["--commit", commit]
        : [
            "--release-commit",
            commit,
            "--image-digest",
            imageDigest,
            ...(action === "activate" ? ["--out", out] : []),
          ]),
    ];
  }
  function fixture({
    absent = false,
    statuses = [activated],
    ancestor = true,
    supported = true,
    protocol = "revalidate",
  } = {}) {
    let floor = absent
      ? null
      : admissionResources({
          namespace: "synthetic",
          minimumCommit,
          imageDigests: [minimumDigest],
          frozen: true,
        })[0];
    const applied = [];
    const deleted = [];
    const writes = [];
    const calls = [];
    let statusIndex = 0;
    const pods = {
      items: ["platform-api", "platform-worker"].map((role) => ({
        metadata: { name: `synthetic-${role}`, namespace: "synthetic", uid: `synthetic-uid-${role}` },
        spec: { containers: [{ name: role, image: `registry.example/synthetic@${imageDigest}` }] },
        status: {
          phase: "Running",
          containerStatuses: [
            {
              name: role,
              ready: true,
              state: { running: {} },
              imageID: `registry.example/synthetic@${imageDigest}`,
            },
          ],
        },
      })),
    };
    const run = vi.fn((file, command, input) => {
      calls.push([file, ...command]);
      if (file === "git" && command[0] === "merge-base") {
        if (!ancestor) throw new Error("synthetic_not_ancestor");
        return "";
      }
      if (file === "git" && command[0] === "show")
        return supported ? "AGENT_GRANT_REVOCATION_SUPPORT_VERSION = 1;" : "synthetic pre-support source";
      if (file !== "kubectl") throw new Error(`Unexpected synthetic command: ${file}`);
      if (command[0] === "get" && command[1] === "validatingadmissionpolicy") return floor ? JSON.stringify(floor) : "";
      if (command[0] === "get" && command[1] === "pods") return JSON.stringify(pods);
      if (command[0] === "exec" && command.at(-1) === "--status") {
        const status = statuses[Math.min(statusIndex++, statuses.length - 1)];
        if (status instanceof Error) throw status;
        return JSON.stringify(status);
      }
      if (command[0] === "exec" && command.at(-1) === "--support") return JSON.stringify({ supportVersion: 1 });
      if (command[0] === "apply") {
        const resource = JSON.parse(input);
        applied.push(resource);
        if (resource.kind === "ValidatingAdmissionPolicy")
          floor = {
            ...resource,
            metadata: {
              ...resource.metadata,
              uid: "synthetic-policy",
              resourceVersion: String(applied.length),
              generation: applied.length,
            },
          };
        return "";
      }
      if (command[0] === "wait") return "";
      if (command[0] === "delete") {
        deleted.push(command[1]);
        return "";
      }
      throw new Error(`Unexpected synthetic kubectl command: ${command.join(" ")}`);
    });
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      const close = (code) => {
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => {
          child.exitCode = code;
          child.emit("close", code);
        });
      };
      child.kill = vi.fn(() => close(1));
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          writes.push(JSON.parse(chunk.toString()));
          queueMicrotask(() => {
            if (protocol === "lost-reply") return close(1);
            if (protocol === "revalidate" && writes.length === 1)
              child.stdout.write(`${JSON.stringify({ state: "revalidate" })}\n`);
            else {
              child.stdout.write(
                `${JSON.stringify({ state: "activated", proofDigest: protocol === "wrong-digest" ? "synthetic-mismatch" : proofDigest(writes[0]) })}\n`,
              );
              close(0);
            }
          });
          callback();
        },
      });
      return child;
    });
    return { run, spawn, applied, deleted, writes, calls };
  }
  const policies = (f) => f.applied.filter((resource) => resource.kind === "ValidatingAdmissionPolicy");
  const expectReleased = (f) =>
    expect(f.deleted).toEqual(["validatingadmissionpolicybinding", "validatingadmissionpolicy"]);

  it.each(["prepare", "check-rollback"])(
    "%s refuses pre-support rollback when admission is absent but Identity is activated",
    async (action) => {
      const f = fixture({ absent: true, ancestor: false });
      await expect(main(args(action), f)).rejects.toThrow("synthetic_not_ancestor");
      expect(f.applied).toEqual([]);
      expect(f.deleted).toEqual([]);
    },
  );
  it("prepare reconstructs the missing floor from durable activation and appends the new digest", async () => {
    const f = fixture({ absent: true });
    await main(args("prepare"), f);
    expect(policies(f)).toHaveLength(1);
    expect(policies(f)[0]).toEqual(
      admissionResources({
        namespace: "synthetic",
        minimumCommit,
        imageDigests: [minimumDigest, imageDigest],
        frozen: false,
      })[0],
    );
    expect(f.calls).toContainEqual(["git", "merge-base", "--is-ancestor", minimumCommit, releaseCommit]);
  });
  it.each(["prepare", "check-rollback"])(
    "%s permits a compatible commit with a missing activated floor",
    async (action) => {
      const f = fixture({ absent: true });
      await main(args(action), f);
      expect(f.calls).toContainEqual(["git", "merge-base", "--is-ancestor", minimumCommit, releaseCommit]);
      expect(f.deleted).toEqual([]);
    },
  );
  it.each(["prepare", "check-rollback"])(
    "%s preserves first support rollout when status is dormant or unavailable",
    async (action) => {
      for (const status of [dormant, new Error("revocation_status_unavailable")]) {
        const f = fixture({ absent: true, statuses: [status] });
        await main(args(action), f);
        expect(f.calls.some((call) => call.at(-1) === "--status")).toBe(true);
        expect(f.applied).toEqual([]);
        expect(f.deleted).toEqual([]);
        expect(f.calls.some(([file]) => file === "git")).toBe(false);
      }
    },
  );
  it.each(["prepare", "check-rollback"])("%s releases a dormant fence", async (action) => {
    const f = fixture({ statuses: [dormant] });
    await main(args(action), f);
    expectReleased(f);
    expect(f.applied).toEqual([]);
  });
  it("prepare adds the descendant digest to the unfrozen floor", async () => {
    const f = fixture();
    await main(args("prepare"), f);
    expect(policies(f)).toEqual([
      admissionResources({
        namespace: "synthetic",
        minimumCommit,
        imageDigests: [minimumDigest, imageDigest],
        frozen: false,
      })[0],
    ]);
  });
  it.each(["prepare", "check-rollback"])(
    "%s refuses incompatible ancestry and missing support before any cluster write",
    async (action) => {
      for (const change of [{ ancestor: false }, { supported: false }]) {
        const f = fixture(change);
        await expect(main(args(action), f)).rejects.toThrow(
          change.ancestor === false ? "synthetic_not_ancestor" : "revocation_rollback_floor",
        );
        expect(f.applied).toEqual([]);
        expect(f.deleted).toEqual([]);
        expect(f.spawn).not.toHaveBeenCalled();
      }
    },
  );
  it("check-rollback allows a floor-compatible commit without writes", async () => {
    const f = fixture();
    await main(args("check-rollback"), f);
    expect(f.calls).toContainEqual(["git", "merge-base", "--is-ancestor", minimumCommit, releaseCommit]);
    expect(f.calls.some((call) => call[0] === "git" && call[1] === "show")).toBe(true);
    expect(f.applied).toEqual([]);
    expect(f.deleted).toEqual([]);
  });
  it.each(["prepare", "check-rollback"])(
    "%s retains an existing fence when activation status is unavailable",
    async (action) => {
      const f = fixture({ statuses: [new Error("revocation_status_unavailable")] });
      await expect(main(args(action), f)).rejects.toThrow("revocation_status_unavailable");
      expect(f.deleted).toEqual([]);
      expect(f.applied).toEqual([]);
    },
  );
  it("activate retains the frozen fence after a lost reply when Identity committed", async () => {
    const f = fixture({ statuses: [dormant, activated], protocol: "lost-reply" });
    await expect(main(args("activate"), f)).rejects.toThrow("revocation_activation_unconfirmed");
    expect(policies(f).map((policy) => policy.spec.validations[0].expression)).toEqual(["false"]);
    expect(f.deleted).toEqual([]);
  });
  it("activate releases the frozen fence after a lost reply only when Identity is dormant", async () => {
    const f = fixture({ statuses: [dormant], protocol: "lost-reply" });
    await expect(main(args("activate"), f)).rejects.toThrow("revocation_activation_unconfirmed");
    expectReleased(f);
  });
  it("activate rejects a mismatched receipt digest without unfreezing", async () => {
    const f = fixture({ statuses: [dormant, activated], protocol: "wrong-digest" });
    await expect(main(args("activate"), f)).rejects.toThrow("revocation_activation_unconfirmed");
    expect(policies(f).map((policy) => policy.spec.validations[0].expression)).toEqual(["false"]);
    expect(f.deleted).toEqual([]);
  });
  it("activate replay unfreezes the same release and records the replay artifact", async () => {
    const replayProof = { releaseCommit, imageDigest };
    const f = fixture({ statuses: [{ state: "activated", proof: replayProof }] });
    await main(args("activate"), f);
    expect(policies(f)).toHaveLength(1);
    expect(policies(f)[0].spec.validations[0].expression).not.toBe("false");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ replay: true, proof: replayProof });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("activate replay refuses a different release", async () => {
    const f = fixture();
    await expect(main(args("activate"), f)).rejects.toThrow("revocation_activation_conflict");
    expect(f.applied).toEqual([]);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("activate responds to revalidate with a fresh capture before accepting the receipt", async () => {
    const f = fixture({ statuses: [dormant] });
    await main(args("activate"), f);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]).toMatchObject({
      expectedReplicas: ["synthetic-platform-api", "synthetic-platform-worker"],
      fenceId: "synthetic-policy:1",
    });
    expect(f.calls.filter((call) => call[0] === "kubectl" && call[1] === "get" && call[2] === "pods")).toHaveLength(4);
    expect(policies(f)).toHaveLength(2);
    expect(policies(f)[0].spec.validations[0].expression).toBe("false");
    expect(policies(f)[1].spec.validations[0].expression).not.toBe("false");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      proof: f.writes[0],
      receipt: { state: "activated", proofDigest: proofDigest(f.writes[0]) },
    });
  });
  it.each(
    [
      [],
      ["unknown"],
      ["prepare", "--namespace"],
      ["prepare", "--namespace", "synthetic"],
      ["check-rollback", "--namespace", "synthetic", "--namespace", "synthetic"],
      ["check-rollback", "--namespace", "synthetic", "--unknown", releaseCommit],
    ].map((input) => ({ input })),
  )("rejects malformed arguments before external commands: $input", async ({ input }) => {
    const f = fixture();
    await expect(main(input, f)).rejects.toThrow("revocation_activation_arguments_invalid");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

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
