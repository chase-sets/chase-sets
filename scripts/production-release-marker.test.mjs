import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  admitPriorProductionJob,
  assertRegistryIdentity,
  publishReleaseMarker,
  readCompletePages,
  releaseMarkerIdentity,
  stableRecoveryHistory,
  validateTransitionAuthority,
  registryManifestBytes,
  readPriorAuthority,
  reconcileReleaseMarker,
  readOnlySpawn,
  markerIo,
} from "./production-release-marker.mjs";

// Every mutable control below has unmistakably synthetic identities, never a real hosted job identity.
const commit = "a".repeat(40);
const previousCommit = "b".repeat(40);
const manifest = Buffer.from(
  JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" }),
);
const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
const run = { id: 900000001, created_at: "2030-01-01T00:00:00Z" };
const identity = {
  runId: run.id,
  workflowHead: commit,
  attempt: 1,
  commit,
  digest,
  tag: releaseMarkerIdentity(run, commit),
  productionCommit: previousCommit,
  release: "synthetic",
  namespace: "synthetic",
};
const names = [
  "Verify promoted platform runtime image",
  "Capture production rollback target",
  "Deploy production Kubernetes release",
  "Verify production DOKS live hosts and certificate",
  "Production post-deploy readiness gate",
  "Smoke check",
  "Stage 1 production canary",
  "Verify production Kubernetes deployment transition",
  "Upload production Kubernetes deployment transition",
  "Roll back production Kubernetes release",
  "Mark production release",
];
const timestamp = (seconds) => `2030-01-01T00:00:${String(seconds).padStart(2, "0")}Z`;
function syntheticJob() {
  return {
    id: 900000002,
    run_id: run.id,
    run_attempt: 1,
    head_sha: commit,
    name: "Deploy Production",
    status: "completed",
    conclusion: "failure",
    started_at: timestamp(0),
    completed_at: timestamp(50),
    steps: names.map((name, index) => ({
      name,
      number: index + 1,
      status: "completed",
      conclusion: index === 10 ? "failure" : index === 9 ? "skipped" : "success",
      started_at: timestamp(index * 2),
      completed_at: timestamp(index * 2 + 1),
    })),
  };
}
function syntheticTransition() {
  return {
    schemaVersion: "platform-kubernetes-deployment-transition/v1",
    checkedAt: timestamp(15),
    release: identity.release,
    namespace: identity.namespace,
    capturedHeadRevision: 20,
    resultingHeadRevision: 21,
    observedHistory: [
      { revision: 20, status: "superseded", description: "Upgrade complete" },
      { revision: 21, status: "deployed", description: "Upgrade complete" },
    ],
    markerIdentity: {
      runId: run.id,
      attempt: 1,
      jobId: 900000002,
      commit,
      digest,
      tag: identity.tag,
      productionCommit: previousCommit,
    },
  };
}
function syntheticArtifact() {
  return { id: 900000003, expired: false, created_at: timestamp(16), workflow_run: { id: run.id, head_sha: commit } };
}
function publication() {
  const state = { production: previousCommit, tag: null, registry: null };
  const io = {
    readRefs: vi.fn(async () => structuredClone({ production: state.production, tag: state.tag })),
    isAncestor: vi.fn(async () => true),
    readRegistry: vi.fn(async () => state.registry),
    publishRegistry: vi.fn(async () => {
      state.registry = manifest;
    }),
    assertFresh: vi.fn(async () => {}),
    publishGit: vi.fn(async () => {
      state.tag = { annotated: true, commit, object: "c".repeat(40) };
      state.production = commit;
    }),
  };
  return { state, io };
}

describe("stable release identity and conflicting tag refusal", () => {
  it("retains chronological release-* identity across attempt wall clocks", () => {
    expect(releaseMarkerIdentity({ ...run, run_attempt: 1 }, commit)).toBe(
      releaseMarkerIdentity({ ...run, run_attempt: 4 }, commit),
    );
    expect(identity.tag).toBe("release-20300101000000-aaaaaaaa-900000001");
    expect(releaseMarkerIdentity({ ...run, created_at: "2030-01-02T00:00:00Z" }, commit) > identity.tag).toBe(true);
  });
  it.each([
    { annotated: false, commit },
    { annotated: true, commit: previousCommit },
  ])("refuses conflicting Git identity %j", async (tag) => {
    const { io, state } = publication();
    state.tag = tag;
    await expect(publishReleaseMarker(identity, io)).rejects.toThrow("conflicting release tag");
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("accepts exact digest or cryptographically hashed linux/amd64 membership only", () => {
    expect(() => assertRegistryIdentity(manifest, digest)).not.toThrow();
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    };
    expect(() => assertRegistryIdentity(JSON.stringify(index), digest)).not.toThrow();
    index.manifests[0].platform.architecture = "arm64";
    expect(() => assertRegistryIdentity(JSON.stringify(index), digest)).toThrow("linux/amd64");
    index.manifests[0].platform.architecture = "amd64";
    index.manifests[0].digest = `sha256:${"f".repeat(64)}`;
    expect(() => assertRegistryIdentity(JSON.stringify(index), digest)).toThrow("is not the linux/amd64");
  });
  it("removes a buildx display newline only when the remaining bytes hash to the authoritative digest", () => {
    expect(registryManifestBytes(manifest, digest)).toEqual(manifest);
    expect(registryManifestBytes(Buffer.concat([manifest, Buffer.from("\n")]), digest)).toEqual(manifest);
    expect(() => registryManifestBytes(Buffer.from("{}\n"), digest)).toThrow("do not hash");
  });
});

describe("publication interruption and unknown response", () => {
  it.each(["registry", "tag", "both", "no-effect"])("converges after %s interruption", async (phase) => {
    const { io, state } = publication();
    if (phase === "registry")
      io.publishRegistry.mockImplementationOnce(async () => {
        state.registry = manifest;
        throw new Error("response lost");
      });
    else
      io.publishGit.mockImplementationOnce(async () => {
        if (phase !== "no-effect") state.tag = { annotated: true, commit, object: "c".repeat(40) };
        if (phase === "both") state.production = commit;
        throw new Error("response lost");
      });
    expect(await publishReleaseMarker(identity, io)).toMatchObject({
      marker_updated: "true",
      production_marker_commit: commit,
    });
    expect(io.publishRegistry).toHaveBeenCalledTimes(1);
    expect(io.publishGit.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("accepts interrupted production-only publication after authoritative identity checks", async () => {
    const { io, state } = publication();
    state.production = commit;
    expect(await publishReleaseMarker(identity, io)).toMatchObject({ marker_updated: "true" });
    expect(io.publishGit).toHaveBeenCalledOnce();
  });
  it("bounds retries without claiming PASS for unknown results", async () => {
    const { io } = publication();
    io.publishGit.mockRejectedValue(new Error("unknown"));
    await expect(publishReleaseMarker(identity, io)).rejects.toMatchObject({
      marker: { marker_updated: "false", marker_phase: "publication" },
    });
    expect(io.publishGit).toHaveBeenCalledTimes(3);
  });
  it.each(["fetch", "registry", "ancestry", "freshness"])("refuses %s failure before mutation", async (failure) => {
    const { io } = publication();
    if (failure === "fetch") io.readRefs.mockRejectedValue(new Error("fetch failed"));
    if (failure === "registry") io.readRegistry.mockRejectedValue(new Error("unavailable"));
    if (failure === "ancestry") io.isAncestor.mockResolvedValue(false);
    if (failure === "freshness") io.assertFresh.mockRejectedValue(new Error("writer conflict"));
    await expect(publishReleaseMarker(identity, io)).rejects.toThrow();
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("refuses a changed production ref between checks", async () => {
    const { io } = publication();
    io.readRefs
      .mockResolvedValueOnce({ production: previousCommit, tag: null })
      .mockResolvedValue({ production: "d".repeat(40), tag: null });
    await expect(publishReleaseMarker(identity, io)).rejects.toThrow("production ref moved");
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("does not overwrite a wrong registry tag", async () => {
    const { io, state } = publication();
    state.registry = Buffer.from("{}");
    await expect(publishReleaseMarker(identity, io)).rejects.toThrow();
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
});

describe("same-release retry admission", () => {
  it("admits a failed enclosing job only from exact successful verification steps", () => {
    expect(admitPriorProductionJob(syntheticJob(), identity).id).toBe(900000002);
    expect(
      validateTransitionAuthority(syntheticTransition(), syntheticArtifact(), syntheticJob(), identity)
        .resultingHeadRevision,
    ).toBe(21);
  });
  it("binds millisecond transition time to the verification step's second-precision interval", () => {
    const job = syntheticJob();
    const transition = syntheticTransition();
    const artifact = syntheticArtifact();
    const upload = job.steps.find((item) => item.name === "Upload production Kubernetes deployment transition");
    upload.started_at = timestamp(15);
    upload.completed_at = timestamp(15);
    artifact.created_at = timestamp(15);
    transition.checkedAt = "2030-01-01T00:00:15.635Z";
    expect(validateTransitionAuthority(transition, artifact, job, identity)).toBe(transition);
    transition.checkedAt = timestamp(16);
    expect(() => validateTransitionAuthority(transition, artifact, job, identity)).toThrow("verification step");
  });
  it.each(["missing", "skipped", "duplicate", "failed", "late"])("refuses %s smoke authority", (defect) => {
    const job = syntheticJob();
    const smoke = job.steps.find((item) => item.name === "Smoke check");
    if (defect === "missing") job.steps = job.steps.filter((item) => item !== smoke);
    if (defect === "skipped") smoke.conclusion = "skipped";
    if (defect === "duplicate") job.steps.push({ ...smoke });
    if (defect === "failed") smoke.conclusion = "failure";
    if (defect === "late") smoke.completed_at = timestamp(49);
    expect(() => admitPriorProductionJob(job, identity)).toThrow();
  });
  it.each(["rollback", "attempt", "job-name", "head", "marker-not-begun"])("refuses %s source", (defect) => {
    const job = syntheticJob();
    if (defect === "rollback") job.steps[9].conclusion = "success";
    if (defect === "attempt") job.run_attempt = 2;
    if (defect === "job-name") job.name = "Resolve Release";
    if (defect === "head") job.head_sha = previousCommit;
    if (defect === "marker-not-begun") job.steps[10].conclusion = "skipped";
    expect(() => admitPriorProductionJob(job, identity)).toThrow();
  });
  it.each(["expired", "outside-job", "wrong-run", "wrong-job", "wrong-attempt", "wrong-digest", "missing-identity"])(
    "refuses %s artifact",
    (defect) => {
      const artifact = syntheticArtifact();
      const transition = syntheticTransition();
      if (defect === "expired") artifact.expired = true;
      if (defect === "outside-job") artifact.created_at = timestamp(45);
      if (defect === "wrong-run") artifact.workflow_run.id += 1;
      if (defect === "wrong-job") transition.markerIdentity.jobId += 1;
      if (defect === "wrong-attempt") transition.markerIdentity.attempt += 1;
      if (defect === "wrong-digest") transition.markerIdentity.digest = `sha256:${"f".repeat(64)}`;
      if (defect === "missing-identity") delete transition.markerIdentity;
      expect(() => validateTransitionAuthority(transition, artifact, syntheticJob(), identity)).toThrow();
    },
  );
  it("does not inherit enclosing run success for the captured attempt-2 capture-failure shape", () => {
    const job = syntheticJob();
    job.steps[1].conclusion = "failure";
    for (const item of job.steps.slice(2)) item.conclusion = "skipped";
    expect(() => admitPriorProductionJob(job, identity)).toThrow();
  });
  it("bounds pagination and refuses incomplete, duplicate, or moving authority", async () => {
    expect(await readCompletePages(async () => ({ total_count: 1, jobs: [{ id: 1 }] }), "jobs", "jobs")).toEqual([
      { id: 1 },
    ]);
    await expect(readCompletePages(async () => ({ total_count: 1, jobs: [] }), "jobs", "jobs")).rejects.toThrow(
      "incomplete",
    );
    await expect(
      readCompletePages(async () => ({ total_count: 2, jobs: [{ id: 1 }] }), "jobs", "jobs"),
    ).rejects.toThrow("duplicate");
    let page = 0;
    await expect(
      readCompletePages(async () => ({ total_count: 11, jobs: [{ id: ++page }] }), "jobs", "jobs"),
    ).rejects.toThrow("ten-page");
    expect(page).toBe(10);
  });
});

describe("live identity and concurrent state refusal", () => {
  function recovery() {
    const fixture = publication();
    const transition = syntheticTransition();
    return {
      ...fixture,
      io: {
        ...fixture.io,
        readHistory: vi.fn(async () => structuredClone(transition.observedHistory)),
        readValues: vi.fn(async () => ({ global: { image: { tag: commit } } })),
        readAuthority: vi.fn(async () => transition),
        assertWriters: vi.fn(async () => {}),
        capture: vi.fn(async () => ({ preDeployHistory: structuredClone(transition.observedHistory) })),
      },
    };
  }
  it("repairs the verified same-release mismatch before ordinary capture without claiming promotion", async () => {
    const { io, state } = recovery();
    expect(await reconcileReleaseMarker({ ...identity, attempt: 2 }, io)).toBeUndefined();
    expect(state.production).toBe(commit);
    expect(io.capture).toHaveBeenCalled();
    expect(io.publishGit).toHaveBeenCalledOnce();
  });
  it.each([
    "different-commit",
    "wrong-workload",
    "missing-authority",
    "changed-history",
    "writer",
    "active-hook",
    "changed-ref",
    "zero",
    "failed-tail",
  ])("refuses %s before any recovery publication", async (defect) => {
    const { io, state } = recovery();
    if (defect === "different-commit") io.readValues.mockResolvedValue({ global: { image: { tag: "d".repeat(40) } } });
    if (defect === "wrong-workload") io.capture.mockRejectedValue(new Error("workload identity mismatch"));
    if (defect === "missing-authority") io.readAuthority.mockRejectedValue(new Error("missing artifact"));
    if (defect === "writer" || defect === "active-hook") io.assertWriters.mockRejectedValue(new Error(defect));
    if (defect === "changed-ref")
      io.readAuthority.mockImplementation(async () => {
        state.production = "d".repeat(40);
        return syntheticTransition();
      });
    if (["zero", "failed-tail", "changed-history"].includes(defect))
      io.readHistory.mockResolvedValue([
        { revision: 20, status: "superseded", description: "Upgrade complete" },
        { revision: 21, status: defect === "changed-history" ? "deployed" : "failed", description: "Rollback to 20" },
      ]);
    await expect(reconcileReleaseMarker({ ...identity, attempt: 2 }, io)).rejects.toThrow();
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("leaves an ordinary aligned failed-tail capture and its existing healing behavior untouched", async () => {
    const { io } = recovery();
    io.readHistory.mockResolvedValue([{ revision: 21, status: "failed", description: "Rollback to 20" }]);
    io.readValues.mockResolvedValue({ global: { image: { tag: previousCommit } } });
    await reconcileReleaseMarker({ ...identity, attempt: 2 }, io);
    expect(io.readAuthority).not.toHaveBeenCalled();
    expect(io.capture).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("already reconciled retry performs no recovery or authority read", async () => {
    const { io, state } = recovery();
    state.production = commit;
    await reconcileReleaseMarker({ ...identity, attempt: 2 }, io);
    expect(io.readHistory).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("enforces read-only capture even if Helm changes to a failed rollback tail during the probe", () => {
    const spawn = vi.fn();
    expect(() => readOnlySpawn("helm", ["rollback", "synthetic", "20"], {}, spawn)).toThrow("forbids");
    expect(() => readOnlySpawn("kubectl", ["patch", "deployment", "synthetic"], {}, spawn)).toThrow("forbids");
    expect(spawn).not.toHaveBeenCalled();
    readOnlySpawn("helm", ["history", "synthetic"], {}, spawn);
    expect(spawn).toHaveBeenCalledOnce();
  });
  it.each(["zero", "multiple", "later", "pending", "failed-rollback"])(
    "refuses %s history without a mutation dependency",
    (defect) => {
      const history = syntheticTransition().observedHistory;
      if (defect === "zero") history[1].status = "superseded";
      if (defect === "multiple") history[0].status = "deployed";
      if (defect === "later") history.push({ revision: 22, status: "deployed", description: "Upgrade complete" });
      if (defect === "pending") history[1].status = "pending-upgrade";
      if (defect === "failed-rollback") {
        history[1].status = "superseded";
        history.push({ revision: 22, status: "failed", description: "Rollback to 20" });
      }
      expect(() => stableRecoveryHistory(history, 21)).toThrow();
    },
  );
  it("aligned retry is idempotent", async () => {
    const { io, state } = publication();
    state.registry = manifest;
    state.production = commit;
    state.tag = { annotated: true, commit, object: "c".repeat(40) };
    expect(await publishReleaseMarker(identity, io)).toMatchObject({ marker_updated: "true" });
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
  });
  it("marker failure output identifies phase, operation, release and known marker", async () => {
    const { io } = publication();
    io.publishRegistry.mockRejectedValue(new Error("interrupted"));
    await expect(publishReleaseMarker(identity, io)).rejects.toMatchObject({
      marker: {
        marker_updated: "false",
        marker_mismatch: "true",
        marker_phase: "publication",
        release_commit: commit,
        release_tag: identity.tag,
        production_marker_commit: previousCommit,
        marker_operation: "registry-publication",
      },
    });
  });
});

describe("production authority collector", () => {
  it("selects exact attempt 1 through an intervening attempt-2 capture refusal", async () => {
    const source = syntheticJob();
    const captureFailure = syntheticJob();
    captureFailure.id = 900000004;
    captureFailure.run_attempt = 2;
    captureFailure.steps[1].conclusion = "failure";
    for (const item of captureFailure.steps.slice(2)) item.conclusion = "skipped";
    const api = vi.fn(async (path) => ({
      total_count: 1,
      jobs: [path.includes("attempts/2/") ? captureFailure : source],
    }));
    expect(await readPriorAuthority(api, { ...identity, attempt: 3 })).toBe(source);
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      `actions/runs/${run.id}/attempts/2/jobs?per_page=100&page=1`,
      `actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=1`,
    ]);
  });
  it.each(["missing", "duplicate", "intervening-deploy", "wrong-attempt", "unavailable"])(
    "refuses %s at the live collector boundary",
    async (defect) => {
      const job = syntheticJob();
      if (defect === "wrong-attempt") job.run_attempt = 9;
      if (defect === "intervening-deploy") job.steps.at(-1).conclusion = "skipped";
      const jobs = defect === "missing" ? [] : defect === "duplicate" ? [job, { ...job, id: 900000005 }] : [job];
      const api = async () => {
        if (defect === "unavailable") throw new Error("HTTP 403");
        return { total_count: jobs.length, jobs };
      };
      await expect(readPriorAuthority(api, { ...identity, attempt: 2 })).rejects.toThrow();
    },
  );
});

describe("registry reads through the real command adapter", () => {
  const release = { ...identity, image: "registry.digitalocean.com/synthetic/chase-sets-platform" };
  const ref = `${release.image}:${release.tag}`;
  const failure = (stderr, code = 1) => Object.assign(new Error("synthetic command failure"), { code, stderr });
  const creates = (runCommand) =>
    runCommand.mock.calls.filter(([program, args]) => program === "docker" && args.includes("create"));

  it("readRegistry accepts exact-ref buildx missing tag", async () => {
    const runCommand = vi.fn(async () => {
      throw failure(`ERROR: ${ref}: not found\n`);
    });
    const adapter = markerIo(release, {}, async () => {}, runCommand);
    await expect(adapter.readRegistry()).resolves.toBeNull();
    expect(runCommand).toHaveBeenCalledExactlyOnceWith("docker", [
      "buildx",
      "imagetools",
      "inspect",
      ref,
      "--format",
      "{{.Manifest.Digest}}",
    ]);
    const { io } = publication();
    io.readRegistry.mockImplementationOnce(adapter.readRegistry);
    expect(await publishReleaseMarker(release, io)).toMatchObject({ marker_updated: "true" });
    expect(io.publishRegistry).toHaveBeenCalledOnce();
  });

  it.each([`error: ${ref}: not found\r\n`, "manifest unknown", "ERROR: manifest unknown: manifest unknown\n"])(
    "retains supported tag-absence wording %s",
    async (stderr) => {
      const runCommand = vi.fn(async () => {
        throw failure(stderr);
      });
      await expect(markerIo(release, {}, async () => {}, runCommand).readRegistry()).resolves.toBeNull();
      expect(runCommand).toHaveBeenCalledOnce();
    },
  );

  it("readRegistry refuses digest-pinned raw-read failure", async () => {
    const runCommand = vi.fn(async (_program, args) => {
      if (args.includes("--raw")) throw failure("manifest unknown");
      return { stdout: `${digest}\n` };
    });
    const adapter = markerIo(release, {}, async () => {}, runCommand);
    await expect(adapter.readRegistry()).rejects.toThrow("registry identity unavailable");
    expect(runCommand.mock.calls[1]).toEqual([
      "docker",
      ["buildx", "imagetools", "inspect", `${release.image}@${digest}`, "--raw"],
      { encoding: "buffer" },
    ]);
    const { io } = publication();
    io.readRegistry = adapter.readRegistry;
    await expect(publishReleaseMarker(release, io)).rejects.toThrow("registry identity unavailable");
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
    expect(creates(runCommand)).toHaveLength(0);
  });

  it.each([
    ["401/unauthorized", failure("ERROR: failed to authorize: 401 Unauthorized\n")],
    ["denied", failure("ERROR: denied: requested access to the resource is denied\n")],
    ["rate limit", failure("ERROR: toomanyrequests: rate limit exceeded\n")],
    ["timeout/kill", Object.assign(failure("", null), { killed: true, signal: "SIGTERM" })],
    ["spawn ENOENT", failure(undefined, "ENOENT")],
    ["missing stderr", failure(undefined)],
    ["other ref", failure(`ERROR: ${release.image}:other: not found\n`)],
    ["non-1 missing tag", failure(`ERROR: ${ref}: not found\n`, 2)],
    ["non-1 manifest unknown", failure("manifest unknown", 2)],
    ["different ref case", failure(`ERROR: ${ref.toUpperCase()}: not found\n`)],
    ["extra line", failure(`ERROR: unrelated failure\nERROR: ${ref}: not found\n`)],
    ["extra suffix", failure(`ERROR: ${ref}: not found: unauthorized\n`)],
  ])("refuses %s without creation", async (_label, error) => {
    const runCommand = vi.fn(async () => {
      throw error;
    });
    const adapter = markerIo(release, {}, async () => {}, runCommand);
    await expect(adapter.readRegistry()).rejects.toThrow("registry identity unavailable");
    const { io } = publication();
    io.readRegistry = adapter.readRegistry;
    await expect(publishReleaseMarker(release, io)).rejects.toThrow("registry identity unavailable");
    expect(io.publishRegistry).not.toHaveBeenCalled();
    expect(io.publishGit).not.toHaveBeenCalled();
    expect(creates(runCommand)).toHaveLength(0);
  });

  it.each(["tag", "raw"])(
    "bounds the first stderr line in marker_error for a %s failure without credential reads",
    async (stage) => {
      const envReads = vi.fn(() => {
        throw new Error("environment must not be read");
      });
      const env = new Proxy({}, { get: envReads, ownKeys: envReads });
      const firstLine = `ERROR: denied: ${"x".repeat(320)}`;
      const stderr = `${firstLine}\r\nsynthetic-credential-on-second-line`;
      const error = failure(stage === "raw" ? Buffer.from(stderr) : stderr);
      error.message = "synthetic-credential-in-command-error";
      const runCommand = vi.fn(async (_program, args) => {
        if (stage === "raw" && !args.includes("--raw")) return { stdout: `${digest}\n` };
        throw error;
      });
      const { io } = publication();
      io.readRegistry = markerIo(release, env, async () => {}, runCommand).readRegistry;
      await expect(publishReleaseMarker(release, io)).rejects.toMatchObject({
        marker: { marker_error: `registry identity unavailable: ${firstLine.slice(0, 300)}` },
      });
      expect(envReads).not.toHaveBeenCalled();
      expect(io.publishRegistry).not.toHaveBeenCalled();
      expect(creates(runCommand)).toHaveLength(0);
    },
  );
});

describe("publication interruption through the real command adapter", () => {
  it.each(["registry", "tag", "both", "no-effect"])(
    "reconciles authoritative reads after %s interruption",
    async (fault) => {
      const state = { production: previousCommit, tag: null, registry: null, localTag: null, fetched: previousCommit };
      let interrupted = false;
      const object = "c".repeat(40);
      const runCommand = vi.fn(async (program, args) => {
        if (program === "docker") {
          if (args.includes("create")) {
            state.registry = manifest;
            if (fault === "registry" && !interrupted) {
              interrupted = true;
              throw new Error("synthetic lost registry response");
            }
            return { stdout: "" };
          }
          if (!state.registry)
            throw Object.assign(new Error("synthetic missing"), { code: 1, stderr: `ERROR: ${args[3]}: not found\n` });
          return {
            stdout: args.includes("--raw") ? Buffer.concat([state.registry, Buffer.from("\n")]) : `${digest}\n`,
          };
        }
        expect(program).toBe("git");
        if (args[0] === "fetch") {
          state.fetched = args.at(-1).startsWith("refs/tags/") ? state.tag : state.production;
          return { stdout: "" };
        }
        if (args[0] === "ls-remote")
          return {
            stdout: `${state.production}\trefs/heads/production\n${state.tag ? `${state.tag}\trefs/tags/${identity.tag}\n${commit}\trefs/tags/${identity.tag}^{}\n` : ""}`,
          };
        if (args[0] === "merge-base") return { stdout: "" };
        if (args[0] === "cat-file") return { stdout: "tag\n" };
        if (args[0] === "rev-parse") {
          if (args.at(-1) === "FETCH_HEAD") return { stdout: state.fetched };
          if (args.at(-1).endsWith("^{commit}")) return { stdout: commit };
          if (!state.localTag) throw Object.assign(new Error("synthetic missing local tag"), { code: 128 });
          return { stdout: state.localTag };
        }
        if (args[0] === "-c" && args.includes("tag")) {
          state.localTag = object;
          return { stdout: "" };
        }
        if (args[0] === "push") {
          expect(args).toContain("--atomic");
          expect(args).toContain(`--force-with-lease=refs/heads/production:${state.production}`);
          expect(args).toContain(`--force-with-lease=refs/tags/${identity.tag}:${state.tag ?? ""}`);
          expect(args).not.toContain("--force");
          expect(args.some((arg) => arg.startsWith("+"))).toBe(false);
          if (fault !== "registry" && !interrupted) {
            interrupted = true;
            if (fault !== "no-effect") state.tag = object;
            if (fault === "both") state.production = commit;
            throw new Error("synthetic lost Git response");
          }
          state.tag = object;
          state.production = commit;
          return { stdout: "" };
        }
        throw new Error(`unhandled synthetic command ${program} ${args.join(" ")}`);
      });
      const release = {
        ...identity,
        image: "registry.digitalocean.com/synthetic/chase-sets-platform",
        createdAt: run.created_at,
      };
      const io = markerIo(release, {}, async () => {}, runCommand);
      expect(await publishReleaseMarker(release, io)).toMatchObject({
        marker_updated: "true",
        production_marker_commit: commit,
      });
      expect(state.tag).toBe(object);
      expect(interrupted).toBe(true);
      expect(runCommand.mock.calls[0]).toEqual(["git", ["fetch", "--no-tags", "origin", "refs/heads/production"]]);
      expect(
        runCommand.mock.calls.filter(([program, args]) => program === "docker" && args.includes("create")),
      ).toHaveLength(1);
    },
  );
  it("refuses non-fast-forward publication before the lease-protected push", async () => {
    const runCommand = vi.fn(async () => {
      throw Object.assign(new Error("synthetic non-ancestor"), { code: 1 });
    });
    const io = markerIo(identity, {}, async () => {}, runCommand);
    await expect(io.publishGit({ production: previousCommit, tag: { object: "c".repeat(40) } })).rejects.toThrow(
      "non-ancestor",
    );
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0][1][0]).toBe("merge-base");
  });
});

describe("production workflow marker recovery wiring", () => {
  const workflow = readFileSync(new URL("../.github/workflows/platform-production.yml", import.meta.url), "utf8");
  const production = workflow.slice(workflow.indexOf("  deploy-production:"));
  it("uses the shared marker implementation before capture and for normal publication", () => {
    expect(production).toContain("node ./scripts/production-release-marker.mjs reconcile");
    expect(production.indexOf("production-release-marker.mjs reconcile")).toBeLessThan(
      production.indexOf("platform-kubernetes-deployment.mjs capture-rollback-target"),
    );
    expect(production).toContain("node ./scripts/production-release-marker.mjs publish");
    expect(production).not.toContain("release-$(date -u +%Y%m%d%H%M%S)");
  });
  it("retains missing durable identity before artifact upload and writes the real successful-attempt handoff", () => {
    expect(production.indexOf("production-release-marker.mjs retain-identity")).toBeGreaterThan(
      production.indexOf("verify-deployment-transition"),
    );
    expect(production.indexOf("production-release-marker.mjs retain-identity")).toBeLessThan(
      production.indexOf("- name: Upload production Kubernetes deployment transition"),
    );
    expect(production).toContain("if: steps.production_marker.outputs.marker_updated == 'true'");
    expect(production).toContain('--producer-run-attempt "${{ github.run_attempt }}"');
  });
});
