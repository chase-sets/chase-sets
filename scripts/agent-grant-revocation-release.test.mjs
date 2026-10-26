import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  admissionResources,
  captureServingSet,
  failureCategory,
  main,
  proofDigest,
  refusalCode,
  sqlstateClass,
  summarizeRuntimeLog,
} from "./agent-grant-revocation-release.mjs";
import { classifyDeploymentRootCause, DEPLOY_ROOT_CAUSE_CODES } from "./platform-deploy-incident.mjs";

const secretMarker = "synthetic-secret-marker-7f3c";

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
  let statusOut;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "synthetic-revocation-release-"));
    out = join(directory, "receipt.json");
    statusOut = join(directory, "status.json");
    vi.stubEnv("GITHUB_RUN_ID", "7422");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  function args(action, commit = releaseCommit, environment = "production") {
    return [
      action,
      "--namespace",
      "synthetic",
      ...(action === "check-rollback"
        ? ["--commit", commit]
        : [
            "--environment",
            environment,
            "--release-commit",
            commit,
            "--image-digest",
            imageDigest,
            "--status-out",
            statusOut,
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
    forbidden = null,
    logs = "",
    childDiagnostic = null,
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
      if (forbidden && file === "kubectl" && command[0] === forbidden) {
        // Synthetic withheld authority: the raw error carries a secret-bearing marker.
        const error = new Error(`Error from server (Forbidden): token=${secretMarker}`);
        error.stderr = `Error from server (Forbidden): token=${secretMarker}\n`;
        throw error;
      }
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
      if (command[0] === "logs") return logs;
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
            if (protocol === "refused") {
              child.stderr.write(`raw failure ${secretMarker}\nrevocation_dormant_request_unresolved\n`);
              if (childDiagnostic) child.stderr.write(`${JSON.stringify(childDiagnostic)}\n`);
              return close(1);
            }
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
    return { run, spawn, applied, deleted, writes, calls, now: () => new Date("2026-10-20T00:00:00.000Z") };
  }
  const policies = (f) => f.applied.filter((resource) => resource.kind === "ValidatingAdmissionPolicy");
  const expectReleased = (f) =>
    expect(f.deleted).toEqual(["validatingadmissionpolicybinding", "validatingadmissionpolicy"]);
  const status = () => JSON.parse(readFileSync(statusOut, "utf8"));

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
  it("activate surfaces the pod's bounded refusal code without its raw stderr", async () => {
    const f = fixture({ statuses: [dormant], protocol: "refused" });
    await expect(main(args("activate"), f)).rejects.toThrow(/^revocation_dormant_request_unresolved$/);
    expectReleased(f);
    expect(status()).toMatchObject({ result: "refused", refusal: "revocation_dormant_request_unresolved" });
    expect(readFileSync(statusOut, "utf8")).not.toContain(secretMarker);
  });
  it("records a value-free diagnostic beside a refusal status", async () => {
    const typed = Object.assign(new Error("raw database detail"), {
      code: "42501",
      failureCategory: "schema_permission",
    });
    expect(sqlstateClass(typed)).toBe("42");
    expect(failureCategory(typed)).toBe("schema_permission");
    const f = fixture({ statuses: [dormant], protocol: "refused" });
    await expect(main(args("activate"), f)).rejects.toThrow("revocation_dormant_request_unresolved");
    expect(status()).toHaveProperty("diagnostic");
    expect(JSON.stringify(status().diagnostic)).not.toContain(secretMarker);
  });
  it("preserves a known status identity over an unknown child diagnostic", async () => {
    const f = fixture({
      statuses: [dormant],
      protocol: "refused",
      childDiagnostic: {
        schemaVersion: "agent-grant-revocation-diagnostic/v1",
        identity: { state: "unknown" },
        sqlstateClass: "unknown",
        failureCategory: "application",
      },
    });
    await expect(main(args("activate"), f)).rejects.toThrow("revocation_dormant_request_unresolved");
    expect(status().diagnostic).toMatchObject({ identity: { state: "dormant" } });
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
    expect(status()).toMatchObject({ command: "activate", result: "replayed", refusal: null });
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
    // Status, preflight, proof and revalidation reads, then the post-command status and log census.
    expect(f.calls.filter((call) => call[0] === "kubectl" && call[1] === "get" && call[2] === "pods")).toHaveLength(6);
    expect(policies(f)).toHaveLength(2);
    expect(policies(f)[0].spec.validations[0].expression).toBe("false");
    expect(policies(f)[1].spec.validations[0].expression).not.toBe("false");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      proof: f.writes[0],
      receipt: { state: "activated", proofDigest: proofDigest(f.writes[0]) },
    });
  });
  it.each(["staging", "production"])("activate binds the %s proof to its selected environment", async (environment) => {
    const f = fixture({ statuses: [dormant] });
    await main(args("activate", releaseCommit, environment), f);
    expect(f.writes.map((write) => write.environment)).toEqual([environment, environment]);
    expect(status()).toMatchObject({ environment, command: "activate", result: "activated" });
  });
  it("records the post-command floor, Identity summary and bounded log facts without raw lines", async () => {
    const nonterminal = { count: 2, oldestAgeMs: 95_000, oldestSource: "admission" };
    const activation = {
      eventId: "synthetic-event",
      streamVersion: 1,
      recordedAt: "2026-10-19T23:58:00.000Z",
      proofDigest: "c".repeat(64),
    };
    const f = fixture({
      statuses: [{ ...activated, activation, nonterminal }],
      logs: [
        JSON.stringify({
          timestamp: "2026-10-19T23:57:01.000Z",
          level: "info",
          type: "worker.runner.completed",
          runnerName: "auth.agent-grant-revocation-recovery",
        }),
        `postgres://user:${secretMarker}@db.example/identity`,
      ].join("\n"),
    });
    await main(args("prepare"), f);
    const record = status();
    expect(record).toMatchObject({
      schemaVersion: "agent-grant-revocation-status/v1",
      environment: "production",
      command: "prepare",
      result: "prepared",
      refusal: null,
      capturedAt: "2026-10-20T00:00:00.000Z",
      floor: { state: "present", minimumCommit, imageDigests: [minimumDigest, imageDigest], frozen: false },
      identity: { state: "activated", activation, nonterminal },
      logs: { since: "5m", tail: 200, complete: true },
    });
    expect(record.logs.pods).toHaveLength(2);
    expect(record.logs.pods[0]).toMatchObject({
      read: "observed",
      lines: 2,
      unparsed: 1,
      recovery: { completed: 1, failed: 0, firstAt: "2026-10-19T23:57:01.000Z" },
    });
    expect(f.calls).toContainEqual([
      "kubectl",
      "logs",
      "-n",
      "synthetic",
      "synthetic-platform-worker",
      "-c",
      "platform-worker",
      "--since=5m",
      "--tail=200",
    ]);
    expect(JSON.stringify(record)).not.toContain(secretMarker);
  });
  it("records an unreadable section as unknown rather than a pass", async () => {
    const f = fixture({ absent: true, statuses: [new Error("revocation_status_unavailable")] });
    await main(args("prepare"), f);
    expect(status()).toMatchObject({
      result: "prepared",
      floor: { state: "absent" },
      identity: { state: "unknown", code: "revocation_status_unavailable" },
    });
  });
  it.each([
    ["prepare", "exec"],
    ["prepare", "get"],
    ["activate", "exec"],
    ["check-rollback", "exec"],
  ])("%s fails closed with withheld %s authority and never retains the raw error", async (action, verb) => {
    const f = fixture({ statuses: [activated], forbidden: verb });
    const failure = await main(args(action), f).then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(refusalCode(failure)).toBe("revocation_release_refused");
    expect(f.applied).toEqual([]);
    expect(f.deleted).toEqual([]);
    expect(f.spawn).not.toHaveBeenCalled();
    if (action !== "check-rollback") {
      expect(status()).toMatchObject({ result: "refused", refusal: "revocation_release_refused" });
      expect(readFileSync(statusOut, "utf8")).not.toContain(secretMarker);
    }
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
  it("rejects an unknown environment before external commands", async () => {
    const f = fixture();
    await expect(main(args("activate", releaseCommit, "preview"), f)).rejects.toThrow("revocation_environment_invalid");
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("revocation CLI refusal boundary", () => {
  const cli = fileURLToPath(new URL("./agent-grant-revocation-release.mjs", import.meta.url));
  let emptyPath;
  beforeAll(() => {
    emptyPath = mkdtempSync(join(tmpdir(), "synthetic-empty-path-"));
  });
  afterAll(() => rmSync(emptyPath, { recursive: true, force: true }));
  it.each([
    ["an own code", new Error("revocation_membership_changed"), "revocation_membership_changed"],
    [
      "a pod code behind kubectl noise",
      Object.assign(new Error("Command failed: kubectl exec"), {
        stderr: "revocation_support_floor\ncommand terminated with exit code 1\n",
      }),
      "revocation_support_floor",
    ],
    ["a raw connection error", new Error(`postgres://user:${secretMarker}@db`), "revocation_release_refused"],
    ["an unbounded code", new Error(`revocation_${"a".repeat(65)}`), "revocation_release_refused"],
    ["an uppercase code", new Error("revocation_Membership"), "revocation_release_refused"],
    ["a non-error", `revocation_${secretMarker}`, "revocation_release_refused"],
  ])("maps %s to a bounded code", (_name, error, code) => {
    expect(refusalCode(error)).toBe(code);
    expect(code).toMatch(/^revocation_[a-z_]+$/);
  });
  it.each([
    [["prepare", "--namespace", secretMarker], "revocation_activation_arguments_invalid"],
    [
      ["check-rollback", "--namespace", `UPPER-${secretMarker}`, "--commit", "a".repeat(40)],
      "revocation_namespace_invalid",
    ],
    // An empty PATH withholds kubectl entirely; the spawn error never crosses the boundary.
    [["check-rollback", "--namespace", "synthetic", "--commit", "a".repeat(40)], "revocation_release_refused"],
  ])("the entrypoint prints only a bounded code for %j", (input, code) => {
    const result = spawnSync(process.execPath, [cli, ...input], {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath, Path: undefined },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${code}\n`);
    expect(result.stderr).not.toContain(secretMarker);
  });
});

describe("revocation runtime log facts", () => {
  const recovery = (type, timestamp, extra = {}) =>
    JSON.stringify({ timestamp, level: type.endsWith("failed") ? "error" : "info", type, ...extra });
  it("counts recovery cycles and failures and keeps their boundaries", () => {
    const text = [
      recovery("worker.runner.completed", "2026-10-20T00:00:02.000Z", {
        runnerName: "auth.agent-grant-revocation-recovery",
      }),
      recovery("platform-worker.runner.failed", "2026-10-20T00:00:01.000Z", {
        runner: "auth.agent-grant-revocation-recovery",
        error: { message: secretMarker },
      }),
      recovery("worker.runner.completed", "2026-10-20T00:00:03.000Z", { runnerName: "auth.agent-webhook-dispatcher" }),
      JSON.stringify({ level: "error", message: "unrelated" }),
      "not json",
    ].join("\n");
    const summary = summarizeRuntimeLog(text);
    expect(summary).toEqual({
      lines: 5,
      truncated: false,
      unparsed: 1,
      errors: 2,
      revocationErrors: 1,
      recovery: { completed: 1, failed: 1, firstAt: "2026-10-20T00:00:01.000Z", lastAt: "2026-10-20T00:00:02.000Z" },
    });
    expect(JSON.stringify(summary)).not.toContain(secretMarker);
  });
  it("marks a tail-limited read as truncated", () => {
    expect(summarizeRuntimeLog(Array.from({ length: 200 }, () => "{}").join("\n")).truncated).toBe(true);
    expect(summarizeRuntimeLog(Array.from({ length: 199 }, () => "{}").join("\n")).truncated).toBe(false);
  });
});

describe("revocation-floor serving membership and admission", () => {
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const options = {
    environment: "staging",
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
      environment: "staging",
      expectedReplicas: ["platform-api", "platform-worker"],
      replicas: [
        expect.objectContaining({ uid: "synthetic-platform-api" }),
        expect.objectContaining({ uid: "synthetic-platform-worker" }),
      ],
    });
    expect(() => captureServingSet({ ...options, environment: "preview", pods: pods(), support })).toThrow(
      "revocation_environment_invalid",
    );
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

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowFile = ".github/workflows/platform-production.yml";
const productionWorkflow = parse(readFileSync(resolve(root, workflowFile), "utf8"));
const releaseCli = "agent-grant-revocation-release.mjs";
const selections = ["none", "staging", "production"];

/** A GitHub Actions `if` evaluator for the operators these deploy jobs use. */
function evaluateCondition(source, context) {
  const expression = String(source)
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const statusFunction = /\b(success|failure|always|cancelled)\(\)/.test(expression);
  const tokens = expression.match(/'(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*(?:\(\))?/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== expression.replace(/\s/g, ""))
    throw new Error(`Unsupported workflow expression: ${expression}`);
  let index = 0;
  const value = (token) => {
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "success()") return !context.failed;
    if (token === "failure()") return context.failed;
    if (token === "always()") return true;
    if (token === "cancelled()") return false;
    const [scope, name, field, output] = token.split(".");
    if (scope === "env") return context.env[name] ?? "";
    if (scope === "inputs") return context.inputs[name] ?? "";
    // No simulated step continues on error, so its conclusion equals its outcome.
    if (scope === "steps" && (field === "outcome" || field === "conclusion")) return context.steps[name]?.outcome ?? "";
    if (scope === "steps" && field === "outputs") return context.steps[name]?.outputs?.[output] ?? "";
    throw new Error(`Unsupported workflow token: ${token}`);
  };
  const primary = () => {
    const token = tokens[index++];
    if (token === "(") {
      const result = or();
      index += 1;
      return result;
    }
    if (token === "!") return !primary();
    const left = value(token);
    if (tokens[index] === "==" || tokens[index] === "!=") {
      const operator = tokens[index++];
      const right = value(tokens[index++]);
      return operator === "==" ? left === right : left !== right;
    }
    return left;
  };
  const and = () => {
    let result = primary();
    while (tokens[index] === "&&") {
      index += 1;
      const right = primary();
      result = result ? right : result;
    }
    return result;
  };
  const or = () => {
    let result = and();
    while (tokens[index] === "||") {
      index += 1;
      const right = and();
      result = result ? result : right;
    }
    return result;
  };
  const result = or();
  return statusFunction ? result : !context.failed && result;
}

/** Runs one job's step conditions in order; `failAt` names the only steps that fail. */
function simulateJob(job, { inputs, env = {}, failAt = [], outputs = {} }) {
  const steps = {};
  const executed = [];
  let failed = false;
  for (const step of job.steps) {
    const ran = Boolean(evaluateCondition(step.if ?? "success()", { env, inputs, steps, failed }));
    const outcome = !ran ? "skipped" : failAt.includes(step.name) ? "failure" : "success";
    if (ran) executed.push(step);
    if (outcome === "failure") failed = true;
    if (step.id) steps[step.id] = { outcome, outputs: outcome === "success" ? (outputs[step.id] ?? {}) : {} };
  }
  return { executed, steps, failed, names: executed.map((step) => step.name) };
}

function stepEnvValue(step, name, context) {
  return String(evaluateCondition(step.env[name], { ...context, failed: false }));
}

function revocationCallerInventory(files) {
  const inventory = {};
  for (const [file, document] of Object.entries(files)) {
    for (const [jobId, job] of Object.entries(document.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const run = step.run ?? "";
        const add = (kind, count = 1) => {
          if (!count) return;
          const entry = ((inventory[file] ??= {})[jobId] ??= {});
          (entry[kind] ??= []).push(...Array(count).fill(step.name));
        };
        for (const action of ["prepare", "activate", "check-rollback"])
          add(action, run.split(`${releaseCli} ${action}`).length - 1);
        if (/platform:kubernetes-deployment -- (abort)\b/.test(run)) add("abort");
        if (/platform:kubernetes-deployment -- (rollback|recover-stale-pending-upgrade)\b/.test(run)) add("rollback");
        if (/platform:kubernetes-deployment -- deploy\b/.test(run)) add("atomic");
      }
    }
  }
  return inventory;
}

const longLivedRollbackWorkflows = [
  ".github/workflows/platform-staging-rollback-drill.yml",
  ".github/workflows/platform-staging-helm-recovery.yml",
  ".github/workflows/platform-production-stale-helm-recovery.yml",
];
const staging = "Activate Agent Grant revocation in staging";
const production = "Activate Agent Grant revocation in production";
const expectedInventory = {
  [workflowFile]: {
    "deploy-staging": {
      prepare: ["Deploy staging Kubernetes release"],
      atomic: ["Deploy staging Kubernetes release"],
      abort: ["Abort staging Argo Rollouts"],
      activate: [staging, staging],
    },
    "deploy-production": {
      prepare: ["Deploy production Kubernetes release"],
      "check-rollback": [
        "Deploy production Kubernetes release",
        "Abort production Argo Rollouts",
        "Roll back production Kubernetes release",
      ],
      atomic: ["Deploy production Kubernetes release"],
      abort: ["Abort production Argo Rollouts"],
      rollback: ["Roll back production Kubernetes release"],
      activate: [production, production],
    },
  },
  // Operator rollback workflows carry no release CLI call: the admission floor
  // alone admits their pods once an environment is activated (runbook).
  ".github/workflows/platform-staging-rollback-drill.yml": {
    "staging-rollback-drill": {
      rollback: ["Roll back staging DOKS Helm release", "Roll forward staging DOKS Helm release"],
    },
  },
  ".github/workflows/platform-staging-helm-recovery.yml": {
    "staging-helm-recovery": { rollback: ["Roll back staging Helm release"] },
  },
  ".github/workflows/platform-production-stale-helm-recovery.yml": {
    "recover-production-stale-helm-upgrade": { rollback: ["Recover exact stable stale pending-upgrade frontier"] },
  },
};

function clone(value) {
  return structuredClone(value);
}
function stepNamed(document, jobId, name) {
  const step = document.jobs[jobId].steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing ${jobId} step: ${name}`);
  return step;
}

/** Per-job executed activate/prepare counts for every selector on a healthy run. */
function selectorViolations(document) {
  const violations = [];
  for (const selection of selections) {
    for (const [jobId, environment] of [
      ["deploy-staging", "staging"],
      ["deploy-production", "production"],
    ]) {
      const { executed } = simulateJob(document.jobs[jobId], {
        inputs: { agent_grant_revocation_activation: selection },
        env: { ARGO_ROLLOUTS_ENABLED: "true" },
        outputs: { production_marker: { marker_updated: "true" }, rollback_readiness: { result: "success" } },
      });
      const count = (action) =>
        executed.reduce((total, step) => total + ((step.run ?? "").split(`${releaseCli} ${action}`).length - 1), 0);
      const expected = selection === environment ? 2 : 0;
      if (count("activate") !== expected)
        violations.push(`${selection}: ${jobId} ran activate ${count("activate")} times, expected ${expected}`);
      if (count("prepare") !== 1) violations.push(`${selection}: ${jobId} ran prepare ${count("prepare")} times`);
      for (const step of executed.filter((candidate) => (candidate.run ?? "").includes(`${releaseCli} activate`)))
        if (!step.run.includes(`--environment ${environment}`))
          violations.push(`${selection}: ${jobId} activates another environment`);
    }
  }
  return violations;
}

/**
 * Holds the run fixed and changes only the failing cause: an activation refusal
 * must keep the release, marker, handoff and terminal state; a real deploy
 * failure must keep the floor-checked recovery.
 */
function causeViolations(document) {
  const violations = [];
  const base = {
    env: { ARGO_ROLLOUTS_ENABLED: "true" },
    outputs: { production_marker: { marker_updated: "true" }, rollback_readiness: { result: "success" } },
  };
  const scenarios = [
    {
      jobId: "deploy-production",
      cause: "refusal",
      failAt: [production],
      expectRan: ["Mark production release", "Write promoted release handoff", production],
      expectSkipped: ["Abort production Argo Rollouts", "Roll back production Kubernetes release"],
      terminal: "promoted",
      rootCause: "agent-grant-revocation-activation-refused",
    },
    {
      jobId: "deploy-production",
      cause: "deploy",
      failAt: ["Verify production Kubernetes deployment transition"],
      expectRan: ["Abort production Argo Rollouts", "Roll back production Kubernetes release"],
      expectSkipped: ["Mark production release", production],
      terminal: "rolled-back",
    },
    {
      jobId: "deploy-staging",
      cause: "refusal",
      failAt: [staging],
      expectRan: [
        "Verify staging preview wildcard certificate",
        staging,
        "Upload staging Agent Grant revocation status",
      ],
      expectSkipped: ["Abort staging Argo Rollouts"],
      rootCause: "agent-grant-revocation-activation-refused",
    },
    {
      jobId: "deploy-staging",
      cause: "deploy",
      failAt: ["Staging Stripe money smoke"],
      expectRan: ["Abort staging Argo Rollouts", "Upload staging Agent Grant revocation status"],
      expectSkipped: [staging, "Mark staging applied"],
    },
  ];
  for (const scenario of scenarios) {
    const environment = scenario.jobId === "deploy-staging" ? "staging" : "production";
    const job = document.jobs[scenario.jobId];
    const outputs = { ...base.outputs };
    if (scenario.cause === "deploy") outputs.production_rollback = { result: "success" };
    const result = simulateJob(job, {
      ...base,
      outputs,
      inputs: { agent_grant_revocation_activation: environment },
      failAt: scenario.failAt,
    });
    const label = `${scenario.jobId} ${scenario.cause}`;
    for (const name of scenario.expectRan)
      if (!result.names.includes(name)) violations.push(`${label}: ${name} did not run`);
    for (const name of scenario.expectSkipped)
      if (result.names.includes(name)) violations.push(`${label}: ${name} ran`);
    const classify = job.steps.find((step) =>
      /^Classify (staging|production) deployment failure$/.test(step.name ?? ""),
    );
    const phase = stepEnvValue(classify, "DEPLOY_ROOT_CAUSE_PHASE", { env: base.env, inputs: {}, steps: result.steps });
    const rootCause = classifyDeploymentRootCause({ phase, diagnostics: [] }).rootCauseCode;
    if ((rootCause === "agent-grant-revocation-activation-refused") !== (scenario.cause === "refusal"))
      violations.push(`${label}: incident classified ${rootCause}`);
    if (scenario.terminal) {
      const state = job.steps.find((step) => step.name === "Resolve terminal release state");
      const context = { env: base.env, inputs: {}, steps: result.steps };
      // The step's shell branches: rollback success, then marker update, then failure.
      const terminal =
        stepEnvValue(state, "PRODUCTION_ROLLBACK_RESULT", context) === "success"
          ? "rolled-back"
          : stepEnvValue(state, "PRODUCTION_MARKER_UPDATED", context) === "true"
            ? "promoted"
            : "failed";
      if (terminal !== scenario.terminal) violations.push(`${label}: terminal ${terminal}`);
    }
  }
  return violations;
}

const gitBash =
  process.platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
    : "bash";

const nonConsumingJqStub = `jq() { printf 'synthetic\\n'; }`;
const drainingJqStub = `
    jq() {
      if [[ ! -t 0 ]]; then cat >/dev/null; fi
      [[ -z "\${JQ_FAIL:-}" ]] || return 1
      printf 'synthetic\\n'
    }
  `;
const pipeSafetyProducer = "terraform() { dd if=/dev/zero bs=65536 count=64 2>/dev/null; }";
const pipeSafetyPipeline = "terraform output -json marketplace_domains | jq -r '.'";

function runPipeSafetyControl(jqStub) {
  return spawnSync(gitBash, ["-c", `set -o pipefail\n${pipeSafetyProducer}\n${jqStub}\n${pipeSafetyPipeline}`], {
    encoding: "utf8",
  });
}

/** Executes one step's shell with intercepted commands; nothing reaches a cluster or provider. */
function executeStep(step, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-revocation-step-"));
  const stubs = `
    trace() { printf '%s\\n' "$*" >> "$TRACE"; }
    node() { trace node "$@"; [[ -z "\${FAIL_ON:-}" || "$*" != *"$FAIL_ON"* ]] || { echo revocation_membership_changed >&2; return 1; }; }
    pnpm() { trace pnpm "$@"; }
    git() { trace git "$@"; [[ "$1" != rev-parse ]] || printf '%s\\n' "$LATEST_MAIN"; }
    terraform() { printf 'synthetic\\n'; }
    ${drainingJqStub}
  `;
  try {
    const run = step.run.replace(/\$\{\{[^}]*\}\}/g, "synthetic");
    const result = spawnSync(gitBash, ["-c", `${stubs}\n${run}`], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CHASE_SETS_KUBERNETES_NAMESPACE: "synthetic",
        CHASE_SETS_HELM_RELEASE: "synthetic",
        CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT: "1m",
        ARGO_ROLLOUTS_ENABLED: "false",
        PLATFORM_IMAGE_REF: "registry.example/synthetic@sha256:synthetic",
        ADMISSION_RETRY_READINESS_RESULT: "success",
        ADMISSION_RETRY_ROLLBACK_COMMIT: "a".repeat(40),
        RELEASE_COMMIT: "a".repeat(40),
        RELEASE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
        GITHUB_OUTPUT: join(directory, "output"),
        GITHUB_ENV: join(directory, "env"),
        TRACE: join(directory, "trace"),
        ...env,
      },
    });
    if (result.error) throw result.error;
    const read = (name) => (existsSync(join(directory, name)) ? readFileSync(join(directory, name), "utf8") : "");
    return { status: result.status, stderr: result.stderr, trace: read("trace").trim().split("\n"), env: read("env") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Requested activation must fail visibly whenever its deploy is skipped. */
function eligibilityViolations(document) {
  const violations = [];
  const guard = stepNamed(document, "resolve-release", "Require a deploy for Agent Grant revocation activation");
  const coalesce = stepNamed(document, "deploy-staging", "Activate immutable release before staging mutation");
  for (const selection of selections) {
    for (const deploy of ["true", "false"]) {
      const result = executeStep(guard, { AGENT_GRANT_REVOCATION_ACTIVATION: selection, DEPLOYMENT_REQUIRED: deploy });
      const refuse = selection !== "none" && deploy !== "true";
      if ((result.status !== 0) !== refuse || (refuse && result.stderr.trim() !== "revocation_activation_not_deployed"))
        violations.push(`resolve-release ${selection}/${deploy}: exit ${result.status}`);
    }
    const coalesced = executeStep(coalesce, {
      AGENT_GRANT_REVOCATION_ACTIVATION: selection,
      AUTOMATIC_RELEASE: "true",
      LATEST_MAIN: "c".repeat(40),
    });
    const skipped = coalesced.env.includes("SHOULD_DEPLOY=false");
    if (selection === "none" ? !skipped || coalesced.status !== 0 : skipped || coalesced.status === 0)
      violations.push(`coalesced ${selection}: exit ${coalesced.status}, SHOULD_DEPLOY=false ${skipped}`);
  }
  const writers = Object.values(document.jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) => (step.run ?? "").includes("SHOULD_DEPLOY=false")),
  );
  if (writers.length !== 1 || writers[0] !== coalesce)
    violations.push("an unguarded SHOULD_DEPLOY=false writer can skip a requested activation");
  for (const name of [staging, production]) {
    const jobId = name === staging ? "deploy-staging" : "deploy-production";
    const step = stepNamed(document, jobId, name);
    if (step.if !== `inputs.agent_grant_revocation_activation == '${name === staging ? "staging" : "production"}'`)
      violations.push(`${name} is not selected by the input alone`);
  }
  return violations;
}

describe("revocation-caller-partition workflow caller", () => {
  it("proves the jq seam drains piped Terraform output under pipefail", () => {
    expect(runPipeSafetyControl(nonConsumingJqStub).status).toBe(141);
    expect(runPipeSafetyControl(drainingJqStub).status).toBe(0);
  });

  it("inventories every prepare, activate, check-rollback, abort, rollback and atomic caller, and the zero sets", () => {
    const files = Object.fromEntries(
      readdirSync(resolve(root, ".github/workflows"))
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [
          `.github/workflows/${name}`,
          parse(readFileSync(resolve(root, ".github/workflows", name), "utf8")),
        ]),
    );
    const inventory = revocationCallerInventory(files);
    const longLived = Object.fromEntries(
      Object.entries(inventory).filter(([file]) => file === workflowFile || longLivedRollbackWorkflows.includes(file)),
    );
    expect(longLived).toEqual(expectedInventory);
    // Every other caller deploys a disposable namespace and never calls the release CLI.
    for (const [file, jobs] of Object.entries(inventory).filter(([file]) => !(file in longLived)))
      for (const callers of Object.values(jobs)) expect(Object.keys(callers), file).toEqual(["atomic"]);
    expect(
      revocationCallerInventory({
        [workflowFile]: (() => {
          const mutant = clone(productionWorkflow);
          const deploy = stepNamed(mutant, "deploy-staging", "Deploy staging Kubernetes release");
          deploy.run = deploy.run.replace(`${releaseCli} prepare`, "omitted-staging-prepare");
          return mutant;
        })(),
      })[workflowFile],
      "omit-staging-prepare",
    ).not.toEqual(expectedInventory[workflowFile]);
  });

  it("selects only the chosen job's activate, while every deploy still prepares", () => {
    expect(productionWorkflow.on.workflow_dispatch.inputs.agent_grant_revocation_activation).toEqual({
      description: expect.any(String),
      required: false,
      default: "none",
      type: "choice",
      options: selections,
    });
    expect(productionWorkflow.on.workflow_dispatch.inputs).not.toHaveProperty("activate_agent_grant_revocation");
    expect(selectorViolations(productionWorkflow)).toEqual([]);
    const mutant = clone(productionWorkflow);
    stepNamed(mutant, "deploy-production", production).if = "inputs.agent_grant_revocation_activation != 'none'";
    expect(selectorViolations(mutant), "staging-target-activates-production").toContain(
      "staging: deploy-production ran activate 2 times, expected 0",
    );
  });

  it("fails visibly when a requested activation has no deploy", () => {
    expect(eligibilityViolations(productionWorkflow)).toEqual([]);
    const mutant = clone(productionWorkflow);
    const coalesce = stepNamed(mutant, "deploy-staging", "Activate immutable release before staging mutation");
    coalesce.run = coalesce.run.replace(
      'if [ "$AGENT_GRANT_REVOCATION_ACTIVATION" != "none" ]; then',
      "if false; then",
    );
    expect(eligibilityViolations(mutant), "skip-silently").toContain(
      "coalesced staging: exit 0, SHOULD_DEPLOY=false true",
    );
  });

  it("runs activate and its inert replay at one commit and digest, and stops at the first refusal", () => {
    for (const [jobId, name, environment] of [
      ["deploy-staging", staging, "staging"],
      ["deploy-production", production, "production"],
    ]) {
      const step = stepNamed(productionWorkflow, jobId, name);
      const healthy = executeStep(step);
      const activations = healthy.trace.filter((line) => line.includes(`${releaseCli} activate`));
      expect(healthy.status).toBe(0);
      expect(activations).toHaveLength(2);
      for (const line of activations) {
        expect(line).toContain(`--environment ${environment}`);
        expect(line).toContain(`--release-commit ${"a".repeat(40)} --image-digest sha256:${"b".repeat(64)}`);
      }
      expect(activations[0]).toContain(`--out artifacts/agent-grant-revocation/${environment}/activation.json`);
      expect(activations[1]).toContain(`--out artifacts/agent-grant-revocation/${environment}/replay.json`);
      expect(activations[1]).toContain(
        `--status-out artifacts/agent-grant-revocation/${environment}/replay-status.json`,
      );
      expect(step.run).toContain(
        `jq -c "{diagnostic, status: {environment,releaseCommit,imageDigest,identity,refusal}}"`,
      );
      const refused = executeStep(step, { FAIL_ON: "activation.json" });
      expect(refused.status).not.toBe(0);
      expect(refused.trace.filter((line) => line.includes(`${releaseCli} activate`))).toHaveLength(1);
      const notInert = executeStep(step, { JQ_FAIL: "1" });
      expect(notInert.status).not.toBe(0);
      const upload = stepNamed(productionWorkflow, jobId, `Upload ${environment} Agent Grant revocation status`);
      expect(upload).toMatchObject({
        if: `always() && steps.${environment}_kubernetes_deploy.outcome != 'skipped'`,
        with: {
          name: `agent-grant-revocation-status-${environment}`,
          path: `artifacts/agent-grant-revocation/${environment}`,
          "if-no-files-found": "error",
        },
      });
    }
  });

  it("prepares before every Helm upgrade and retains its status", () => {
    for (const [jobId, environment] of [
      ["deploy-staging", "staging"],
      ["deploy-production", "production"],
    ]) {
      const step = stepNamed(productionWorkflow, jobId, `Deploy ${environment} Kubernetes release`);
      const { status, trace } = executeStep(step);
      expect(status).toBe(0);
      const prepare = trace.findIndex((line) => line.includes(`${releaseCli} prepare`));
      const deploy = trace.findIndex((line) => line.includes("platform:kubernetes-deployment -- deploy"));
      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(prepare).toBeLessThan(deploy);
      expect(trace[prepare]).toContain(`--environment ${environment}`);
      expect(trace[prepare]).toContain(
        `--status-out artifacts/agent-grant-revocation/${environment}/prepare-status.json`,
      );
    }
  });

  it("documents the shipped selector, refusal codes, status artifact and recovery in the runbook", () => {
    const runbook = readFileSync(resolve(root, "docs/runbooks/doks-platform-operations.md"), "utf8");
    const section = runbook.slice(runbook.indexOf("### Agent Grant Revocation Activation (#10235)"));
    for (const claim of [
      "`agent_grant_revocation_activation`",
      ...selections.map((selection) => `\`${selection}\``),
      "`revocation_activation_not_deployed`",
      "`agent-grant-revocation-activation-refused`",
      "`agent-grant-revocation-status-<environment>`",
      "`kubectl logs --since=5m --tail=200`",
      "sqlstateClass",
      "failureCategory",
      "value-free diagnostic",
      "`revocation_membership_changed`",
      "(N18)",
      "Passing tests are not evidence of a live activation.",
    ])
      expect(section, claim).toContain(claim);
    expect(DEPLOY_ROOT_CAUSE_CODES).toContain("agent-grant-revocation-activation-refused");
  });

  it("isolates an activation refusal from abort and rollback, and keeps recovery for a real deploy failure", () => {
    expect(causeViolations(productionWorkflow)).toEqual([]);
    const mutant = clone(productionWorkflow);
    const steps = mutant.jobs["deploy-production"].steps;
    const [activation] = steps.splice(
      steps.findIndex((step) => step.name === production),
      1,
    );
    steps.splice(
      steps.findIndex((step) => step.name === "Abort production Argo Rollouts"),
      0,
      activation,
    );
    expect(causeViolations(mutant), "refusal-triggers-rollback").toEqual(
      expect.arrayContaining([
        "deploy-production refusal: Abort production Argo Rollouts ran",
        "deploy-production refusal: Roll back production Kubernetes release ran",
      ]),
    );
  });
});
