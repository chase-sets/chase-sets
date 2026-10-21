// Every identity below is SYNTHETIC. Provider commands and the database are injected doubles; any attempt to
// spawn a real CLI aborts the test (windows-posix-cli-shim-resolves-real-provider-binary).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  const spawning = Object.fromEntries(
    ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"].map((name) => [
      name,
      () => {
        throw new Error(`real-cli-reached:${name}`);
      },
    ]),
  );
  return { ...original, ...spawning, default: { ...original, ...spawning } };
});

import {
  anonymousOwnerObservationSql,
  legacyAnonymousOwnerCountSql,
  redactLegacyAnonymousOwners,
} from "../bounded-contexts/collections/features/saved-lists/api/anonymous-owner-redaction.ts";
import { anonymousOwnerActivationReadSql } from "../bounded-contexts/collections/support/runtime-support/anonymous-owner-activation.ts";
import {
  admitCommand,
  admitStatement,
  CaptureRefusal,
  captureProviderAuthority,
  commandFailure,
  execFileRunner,
  HELM_HISTORY_MAX,
  jobPacket,
  KUBERNETES_LISTS,
  MAX_PAGES,
  READ_ONLY_PROBE_SQL,
  RECOVERY_COMMIT,
  runCapture,
  SESSION_ACTIVITY_SQL,
} from "./collections-cutover-authority-capture.mjs";
import { applyProviderCapture, PROVIDER_CAPTURE_FIELDS } from "./collections-cutover-authority-packet.mjs";
import { checkWorkflowProviderCredentials } from "./workflow-provider-credentials.mjs";

const FLOOR = "a".repeat(40);
const RELEASE = "b".repeat(40);
const PRIOR = "c".repeat(40);
const SUB_FLOOR = "d".repeat(40);
const HEAD = "e".repeat(40);
const CONTAINS_FLOOR = new Set([FLOOR, PRIOR, RELEASE]);
const MERGED_AT = "2020-01-01T00:00:00.000Z";
const digest = (digit) => `sha256:${String(digit).repeat(64)}`;
const REGISTRY = "registry.example.invalid/synthetic/chase-sets-platform";
const NAMESPACE = "chase-sets-platform";

const TOKEN = `dop_v1_${"f0".repeat(32)}`;
const PASSWORD = "canary-password-7f3a";
const PASSWORD_URL = `postgresql://canary-user:${PASSWORD}@db.canary.invalid:25060/collections?sslmode=require`;
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIcanaryPEMbody\n-----END PRIVATE KEY-----";
const CANARIES = [TOKEN, PASSWORD, "canary-user", "db.canary.invalid", "BEGIN PRIVATE KEY", "MIIcanaryPEMbody"];
const lastApplied = {
  "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({ PASSWORD_URL, TOKEN, PEM }),
};

const secretKeyEnv = (key = "DATABASE_URL_COLLECTIONS") => ({
  name: key,
  valueFrom: { secretKeyRef: { name: "chase-sets-platform", key } },
});
const container = (overrides = {}) => ({
  name: "app",
  image: `${REGISTRY}@${digest(1)}`,
  env: [secretKeyEnv(), { name: "CANARY_TOKEN", value: TOKEN }],
  ...overrides,
});
const podTemplate = (overrides) => ({ spec: { containers: [container(overrides)] } });
const owner = (kind, name) => [{ kind, name, controller: true }];
const meta = (name, extra = {}) => ({ namespace: NAMESPACE, name, annotations: lastApplied, ...extra });

function world() {
  return {
    kube: {
      rollouts: { fail: "not-found" },
      deployments: {
        items: [
          { metadata: meta("api"), spec: { replicas: 2, template: podTemplate() } },
          {
            metadata: meta("worker"),
            spec: {
              replicas: 0,
              template: podTemplate({ env: [], envFrom: [{ secretRef: { name: "chase-sets-platform" } }] }),
            },
          },
          {
            metadata: meta("unrelated"),
            spec: { replicas: 1, template: podTemplate({ env: [{ name: "OTHER", value: PASSWORD_URL }] }) },
          },
        ],
      },
      replicasets: {
        pages: [
          [
            {
              metadata: meta("api-current", { ownerReferences: owner("Deployment", "api") }),
              spec: { replicas: 2, template: podTemplate() },
            },
          ],
          [
            {
              metadata: meta("api-old", { ownerReferences: owner("Deployment", "api") }),
              spec: { replicas: 0, template: podTemplate({ image: `${REGISTRY}:${SUB_FLOOR}` }) },
            },
          ],
        ],
      },
      jobs: {
        items: [
          {
            metadata: meta("bootstrap"),
            spec: {
              template: podTemplate({ env: [{ name: "BOOTSTRAP_DATABASE_URL_COLLECTIONS", value: PASSWORD_URL }] }),
            },
            status: { active: 1 },
          },
        ],
      },
      cronjobs: {
        items: [
          {
            metadata: meta("sweeper"),
            spec: { suspend: true, jobTemplate: { spec: { template: podTemplate() } } },
          },
          {
            metadata: meta("report"),
            spec: { suspend: false, jobTemplate: { spec: { template: podTemplate({ env: [] }) } } },
          },
        ],
      },
      pods: {
        items: [
          {
            metadata: meta("api-current-1", { ownerReferences: owner("ReplicaSet", "api-current") }),
            spec: { containers: [container()] },
            status: { phase: "Running", containerStatuses: [{ name: "app", imageID: `${REGISTRY}@${digest(1)}` }] },
          },
          {
            metadata: meta("debug-shell", { namespace: "ops" }),
            spec: {
              containers: [
                container({ name: "shell", env: [], envFrom: [{ secretRef: { name: "chase-sets-platform" } }] }),
              ],
            },
            status: { phase: "Running", containerStatuses: [{ name: "shell", imageID: `${REGISTRY}@${digest(1)}` }] },
          },
        ],
      },
    },
    helm: {
      history: [1, 2, 3].map((revision) => ({
        revision,
        status: revision === 3 ? "deployed" : "superseded",
        chart: "chase-sets-platform-0.1.0",
        app_version: "1.0.0",
        description: "Upgrade complete",
      })),
      values: {
        1: { tag: SUB_FLOOR, digest: digest(3) },
        2: { tag: PRIOR, digest: digest(2) },
        3: { tag: RELEASE, digest: digest(1) },
      },
    },
    terraform: {
      version: 4,
      serial: 42,
      lineage: "0f0f0f0f-0000-4000-8000-000000000001",
      resources: [{ instances: [{ attributes: { uri: PASSWORD_URL, ca_certificate: PEM, token: TOKEN } }] }],
    },
    db: {
      readOnly: "on",
      sessions: [
        {
          state: "active",
          role: "synthetic_collections_role",
          application: "synthetic-platform",
          backend_type: "client backend",
          sessions: 3,
          oldest_backend_start: new Date("2030-01-02T00:00:00.000Z"),
          hidden: 0,
        },
        {
          state: "idle",
          role: "synthetic_collections_role",
          application: "synthetic-worker",
          backend_type: "client backend",
          sessions: 1,
          oldest_backend_start: new Date("2030-01-02T01:00:00.000Z"),
          hidden: 0,
        },
      ],
    },
  };
}

function fakeRun(state, calls) {
  return async (program, args) => {
    calls.push([program, ...args]);
    if (program === "kubectl") {
      const [path, query] = args[2].split("?");
      const resource = Object.keys(KUBERNETES_LISTS).find((key) => KUBERNETES_LISTS[key] === path);
      const list = state.kube[resource];
      if (list.fail) return { ok: false, reason: list.fail };
      const pages = list.pages ?? [list.items];
      const token = new URLSearchParams(query).get("continue");
      const index = token ? Number(token.slice("page-".length)) : 0;
      const metadata = {};
      if (list.endless || index + 1 < pages.length) metadata.continue = `page-${index + 1}`;
      if (index === 0 && !list.endless && pages.length > 1) {
        metadata.remainingItemCount = list.remaining ?? pages.slice(1).flat().length;
      }
      return { ok: true, stdout: JSON.stringify({ kind: "List", metadata, items: pages[index] ?? [] }) };
    }
    if (program === "helm" && args[0] === "history") {
      if (state.helm.fail) return { ok: false, reason: state.helm.fail };
      return { ok: true, stdout: JSON.stringify(state.helm.history) };
    }
    if (program === "helm") {
      const image = state.helm.values[Number(args[6])];
      const values = {
        global: { image: { ...image, registry: "registry.example.invalid" } },
        secrets: { TOKEN, PASSWORD_URL, PEM },
      };
      return { ok: true, stdout: JSON.stringify(values) };
    }
    if (program === "terraform") {
      if (state.terraformFail) return { ok: false, reason: state.terraformFail };
      return { ok: true, stdout: JSON.stringify(state.terraform) };
    }
    throw new Error("unexpected-command");
  };
}

const PLAN = [{ Plan: { "Node Type": "Aggregate", Plans: [{ "Node Type": "Seq Scan" }] } }];

function fakeDatabase(state, statements) {
  return {
    query: async (sql) => {
      statements.push(sql);
      if (sql === READ_ONLY_PROBE_SQL) return { rows: [{ default_transaction_read_only: state.db.readOnly }] };
      if (sql.includes("FROM collections_anonymous_owner_activation")) {
        return { rows: [{ singleton: true, activated_at: null, gate_packet_sha256: null, floor_commit: null }] };
      }
      if (sql.includes("FROM bounded_context_schema_migrations")) {
        return { rows: [{ migration_id: "20261016_collections_anonymous_owner_activation" }] };
      }
      if (sql.includes("FROM pg_trigger")) return { rows: [{ present: true }] };
      if (sql === legacyAnonymousOwnerCountSql) return { rows: [{ remaining: "35" }] };
      if (sql === `EXPLAIN (FORMAT JSON) ${legacyAnonymousOwnerCountSql}`) return { rows: [{ "QUERY PLAN": PLAN }] };
      if (sql === SESSION_ACTIVITY_SQL) return { rows: state.db.sessions };
      throw new Error("unexpected-statement");
    },
  };
}

function dependencies(state, record) {
  return {
    run: fakeRun(state, record.calls),
    database: fakeDatabase(state, record.statements),
    redact: async (session, options) => {
      record.redactOptions.push(options);
      return redactLegacyAnonymousOwners(session, options);
    },
    countSql: legacyAnonymousOwnerCountSql,
    observationSql: anonymousOwnerObservationSql,
    containsFloor: (floor, revision) => floor === FLOOR && CONTAINS_FLOOR.has(revision),
  };
}

// An ownerless pod whose only writer reference is an ephemeral container with its own image.
const ephemeralWriterPod = (ephemeralContainerStatuses) => ({
  metadata: meta("debug-ephemeral", { namespace: "ops" }),
  spec: {
    containers: [container({ env: [], image: `${REGISTRY}@${digest(4)}` })],
    ephemeralContainers: [container({ name: "debugger", image: `${REGISTRY}@${digest(5)}` })],
  },
  status: {
    phase: "Running",
    containerStatuses: [{ name: "app", imageID: `${REGISTRY}@${digest(4)}` }],
    ...(ephemeralContainerStatuses && { ephemeralContainerStatuses }),
  },
});

async function capture(state = world(), overrides = {}) {
  const record = { calls: [], statements: [], redactOptions: [] };
  const result = await captureProviderAuthority(
    {
      target: "staging",
      floor: FLOOR,
      databaseUrl: PASSWORD_URL,
      head: HEAD,
      now: () => new Date("2030-01-03T00:00:00.000Z"),
    },
    { ...dependencies(state, record), ...overrides },
  );
  return { result, record, fields: result.fields };
}

const ids = (set) => set.items.map((item) => item.id);
const isGovernedUnknown = (value) =>
  value?.status === "unknown" &&
  typeof value.missingAuthority === "string" &&
  value.missingAuthority.length > 0 &&
  /re-dispatch the capture for staging$/.test(value.hostAction) &&
  !("collected" in value) &&
  !("value" in value);

describe("AC1 capture field set", () => {
  it("writes exactly the AC1 fields for its target, each concrete and applicable", async () => {
    const { result, fields } = await capture();
    expect(result).toMatchObject({
      schemaVersion: "collections-cutover-provider-capture/v1",
      target: "staging",
      head: HEAD,
      codes: [],
    });
    expect(Object.keys(fields)).toEqual([...PROVIDER_CAPTURE_FIELDS]);
    expect(Object.entries(fields).filter(([, value]) => value.status === "unknown")).toEqual([]);
    const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), result);
    expect(applied).toMatchObject({ verdict: "complete", errors: [], missing: [] });
  });

  it("captures a scaled-to-zero ReplicaSet as a rollback writer on its sub-floor revision", async () => {
    const { fields } = await capture();
    const rollback = fields["writers.rollback"].items.find(
      (item) => item.id === "replicasets:chase-sets-platform/api-old",
    );
    expect(rollback).toMatchObject({ replicas: 0, revisions: [SUB_FLOOR], containsFloor: false });
    expect(ids(fields["writers.serving"])).toContain("replicasets:chase-sets-platform/api-current");
    expect(fields["writers.rollback"].coverage.replicasets).toEqual({ status: "complete", listed: 2 });
  });

  it("captures a suspended CronJob and leaves non-referencing CronJobs out", async () => {
    const { fields } = await capture();
    expect(ids(fields["writers.suspended"])).toEqual(["cronjobs:chase-sets-platform/sweeper"]);
    expect(fields["writers.cronjob"]).toMatchObject({ collected: 0, authoritativeTotal: 0, items: [] });
    expect(fields["writers.cronjob"].coverage.cronjobs).toEqual({ status: "complete", listed: 2 });
    expect(ids(fields["writers.job"])).toEqual(["jobs:chase-sets-platform/bootstrap"]);
  });

  it("captures envFrom Secret writers, including a dormant Deployment and an ownerless pod", async () => {
    const { fields } = await capture();
    expect(fields["writers.dormant"].items).toEqual([
      expect.objectContaining({
        id: "deployments:chase-sets-platform/worker",
        replicas: 0,
        references: ["envFrom:secret/chase-sets-platform"],
      }),
    ]);
    const serving = ids(fields["writers.serving"]);
    expect(serving).toContain("pods:ops/debug-shell");
    expect(serving).not.toContain("pods:chase-sets-platform/api-current-1");
    expect(serving).not.toContain("deployments:chase-sets-platform/unrelated");
  });

  it("binds every Helm revision by image tag and flags the sub-floor revision", async () => {
    const { fields } = await capture();
    expect(fields.releaseCommit).toEqual({ value: RELEASE, source: "global.image.tag of deployed Helm revision 3" });
    expect(fields.deployedCommitAncestry.value).toEqual({
      floor: FLOOR,
      revisions: [
        { revision: 1, status: "superseded", commit: SUB_FLOOR, digest: digest(3), containsFloor: false },
        { revision: 2, status: "superseded", commit: PRIOR, digest: digest(2), containsFloor: true },
        { revision: 3, status: "deployed", commit: RELEASE, digest: digest(1), containsFloor: true },
      ],
    });
    expect(fields["writers.rollback"].items).toContainEqual({
      id: "helm:chase-sets-platform/1",
      status: "superseded",
      revisions: [SUB_FLOOR],
      containsFloor: false,
    });
    const api = fields["writers.serving"].items.find((item) => item.id === "deployments:chase-sets-platform/api");
    expect(api).toMatchObject({ revisions: [RELEASE], containsFloor: true });
  });

  it("records pods' imageID digests, state serial and lineage, and hashed session groups", async () => {
    const { fields } = await capture();
    expect(fields.imageDigests.value).toEqual([digest(1)]);
    expect(fields.terraformStateSerial.value).toBe(42);
    expect(fields.terraformStateLineage.value).toBe("0f0f0f0f-0000-4000-8000-000000000001");
    expect(fields["writers.session"].items).toEqual([
      expect.objectContaining({ state: "active", sessions: 3, oldestBackendStart: "2030-01-02T00:00:00.000Z" }),
      expect.objectContaining({ state: "idle", sessions: 1, oldestBackendStart: "2030-01-02T01:00:00.000Z" }),
    ]);
    expect(fields["writers.session"].items[0].roleDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(fields)).not.toContain("synthetic_collections_role");
    expect(JSON.stringify(fields)).not.toContain("synthetic-platform");
    expect(fields.legacyRawRowCount.value).toBe(35);
  });

  it("records an ephemeral writer container's imageID beside its pod's other containers", async () => {
    const state = world();
    state.kube.pods.items.push(ephemeralWriterPod([{ name: "debugger", imageID: `${REGISTRY}@${digest(5)}` }]));
    const { result, fields } = await capture(state);
    expect(ids(fields["writers.serving"])).toContain("pods:ops/debug-ephemeral");
    expect(fields.imageDigests.value).toEqual([digest(1), digest(4), digest(5)]);
    expect(fields.imageDigests.source).toContain("ephemeralContainerStatuses");
    expect(applyProviderCapture(jobPacket(FLOOR, MERGED_AT), result).verdict).toBe("complete");
  });
});

describe("AC2 no ungoverned zero", () => {
  it("a list whose items disagree with first page plus remainingItemCount is unknown", async () => {
    const state = world();
    state.kube.replicasets.remaining = 5;
    const { fields } = await capture(state);
    for (const name of ["writers.serving", "writers.dormant", "writers.rollback", "gates.rollout.observeAuthority"]) {
      expect(isGovernedUnknown(fields[name]), name).toBe(true);
    }
    expect(fields["writers.rollback"].missingAuthority).toContain(
      "/apis/apps/v1/replicasets (all namespaces): count-mismatch",
    );
  });

  it("a list still carrying a continue token at the page bound is unknown", async () => {
    const state = world();
    state.kube.pods = { pages: [[]], endless: true };
    const { fields, record } = await capture(state);
    expect(record.calls.filter((call) => call[3]?.startsWith("/api/v1/pods"))).toHaveLength(MAX_PAGES);
    for (const name of ["writers.serving", "imageDigests", "gates.traffic.observeAuthority"]) {
      expect(isGovernedUnknown(fields[name]), name).toBe(true);
    }
    expect(fields.imageDigests.missingAuthority).toContain("page-bound");
  });

  it("Helm history at --max is unknown", async () => {
    const state = world();
    state.helm.history = Array.from({ length: HELM_HISTORY_MAX }, (_, index) => ({
      revision: index + 1,
      status: index + 1 === HELM_HISTORY_MAX ? "deployed" : "superseded",
    }));
    const { fields, record } = await capture(state);
    for (const name of [
      "releaseCommit",
      "writers.rollback",
      "deployedCommitAncestry",
      "gates.rollback-floor.observeAuthority",
    ]) {
      expect(isGovernedUnknown(fields[name]), name).toBe(true);
    }
    expect(fields.releaseCommit.hostAction).toContain("raise HELM_HISTORY_MAX");
    expect(record.calls.filter((call) => call[0] === "helm" && call[1] === "get")).toEqual([]);
  });

  it("a forbidden (403) list is unknown", async () => {
    const state = world();
    state.kube.jobs = { fail: "forbidden" };
    const { fields } = await capture(state);
    for (const name of ["writers.job", "writers.suspended", "gates.job.observeAuthority"]) {
      expect(isGovernedUnknown(fields[name]), name).toBe(true);
    }
    expect(fields["writers.job"].missingAuthority).toBe(
      "kubectl get --raw /apis/batch/v1/jobs (all namespaces): forbidden",
    );
    expect(fields["writers.job"].hostAction).toMatch(/^grant the capture kubeconfig read/);
  });

  it("a timed-out read is unknown", async () => {
    const state = world();
    state.terraformFail = "timeout";
    const { fields } = await capture(state);
    expect(isGovernedUnknown(fields.terraformStateSerial)).toBe(true);
    expect(isGovernedUnknown(fields.terraformStateLineage)).toBe(true);
    expect(fields.terraformStateSerial.missingAuthority).toBe("terraform state pull: timeout");
  });

  it("a pending-* Helm revision is unknown", async () => {
    const state = world();
    state.helm.history.push({ revision: 4, status: "pending-upgrade" });
    const { fields } = await capture(state);
    for (const name of [
      "releaseCommit",
      "writers.rollback",
      "deployedCommitAncestry",
      "gates.rollback-floor.observeAuthority",
    ]) {
      expect(isGovernedUnknown(fields[name]), name).toBe(true);
    }
    expect(fields.deployedCommitAncestry.missingAuthority).toContain("pending");
  });

  it("a null backend_start is unknown for sessions and the session fence only", async () => {
    const state = world();
    state.db.sessions.push({
      state: null,
      role: "synthetic_other_role",
      application: "",
      backend_type: null,
      sessions: 2,
      oldest_backend_start: null,
      hidden: 2,
    });
    const { result, fields } = await capture(state);
    expect(isGovernedUnknown(fields["writers.session"])).toBe(true);
    expect(isGovernedUnknown(fields["gates.credential-session-fence.observeAuthority"])).toBe(true);
    expect(fields["writers.session"].hostAction).toContain("pg_read_all_stats");
    const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), result);
    expect(applied.errors).toEqual([]);
    expect(applied.missing.map((entry) => entry.field)).toEqual([
      "writers.session",
      "gates.credential-session-fence.observeAuthority",
    ]);
  });

  it.each([
    ["absent", undefined],
    ["empty", [{ name: "debugger", imageID: "" }]],
  ])(
    "an ephemeral writer container with an %s imageID leaves imageDigests unknown, never partial",
    async (_, statuses) => {
      const state = world();
      state.kube.pods.items.push(ephemeralWriterPod(statuses));
      const { result, fields } = await capture(state);
      expect(isGovernedUnknown(fields.imageDigests)).toBe(true);
      expect(fields.imageDigests.missingAuthority).toContain(
        "kubectl get --raw /api/v1/pods (all namespaces): unresolved-image; total:1; pods:ops/debug-ephemeral slot:ephemeral phase:Running state:absent reason:unnamed",
      );
      const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), result);
      expect(applied.errors).toEqual([]);
      expect(applied.missing.map((entry) => entry.field)).toEqual(["imageDigests"]);
    },
  );

  it.each([
    ["ContainerCreating", "Pending", { waiting: { reason: "ContainerCreating" } }, "waiting"],
    ["ImagePullBackOff", "Pending", { waiting: { reason: "ImagePullBackOff" } }, "waiting"],
    ["failed before start", "Failed", { terminated: { reason: "Error" } }, "terminated"],
  ])("names an unresolved regular writer container in the %s state", async (_, phase, state, expectedState) => {
    const worldState = world();
    worldState.kube.pods.items.push({
      metadata: meta("unresolved-regular", { namespace: "ops" }),
      spec: { containers: [container({ env: [] }), container({ name: "writer", env: [secretKeyEnv()] })] },
      status: { phase, containerStatuses: [{ name: "writer", state }] },
    });
    const { fields } = await capture(worldState);
    expect(fields.imageDigests.missingAuthority).toContain(
      `pods:ops/unresolved-regular slot:regular phase:${phase} state:${expectedState}`,
    );
  });

  it("names an unresolved init writer container", async () => {
    const worldState = world();
    worldState.kube.pods.items.push({
      metadata: meta("unresolved-init", { namespace: "ops" }),
      spec: { initContainers: [container({ name: "prepare", env: [secretKeyEnv()] })], containers: [] },
      status: {
        phase: "Pending",
        initContainerStatuses: [{ name: "prepare", state: { waiting: { reason: "ContainerCreating" } } }],
      },
    });
    const { fields } = await capture(worldState);
    expect(fields.imageDigests.missingAuthority).toContain(
      "pods:ops/unresolved-init slot:init phase:Pending state:waiting reason:ContainerCreating",
    );
  });

  it("caps unresolved attribution at ten entries while retaining the exact total and safe metadata", async () => {
    const worldState = world();
    worldState.kube.pods.items.push(
      ...Array.from({ length: 11 }, (_, index) => ({
        metadata: meta(`unresolved-${index}`, { namespace: "ops" }),
        spec: { containers: [container({ name: `writer-${index}`, env: [secretKeyEnv()] })] },
        status: {
          phase: index === 0 ? "not-a-phase" : "Pending",
          containerStatuses: [
            {
              name: `writer-${index}`,
              state: { waiting: { reason: index === 1 ? `${TOKEN}` : "ImagePullBackOff" } },
            },
          ],
        },
      })),
    );
    const { fields } = await capture(worldState);
    const authority = fields.imageDigests.missingAuthority;
    expect(authority).toContain("total:11");
    expect((authority.match(/ slot:/g) ?? []).length).toBe(10);
    expect(authority).toContain("phase:Unknown state:waiting reason:ImagePullBackOff");
    expect(authority).not.toContain(TOKEN);
    expect(authority).not.toContain("not-a-phase");
  });

  it("an unserved resource type is notServed, not unknown or empty", async () => {
    const { fields } = await capture();
    expect(fields["writers.serving"].coverage.rollouts).toEqual({ status: "notServed" });
    expect(fields["gates.rollout.observeAuthority"].value).toBe("demonstrated");
  });
});

describe("AC3 read-only and secret boundary", () => {
  it("issues only allowlisted provider commands", async () => {
    const { record } = await capture();
    for (const [program, ...args] of record.calls) expect(() => admitCommand(program, args)).not.toThrow();
    const shapes = record.calls.map(([program, ...args]) =>
      program === "kubectl" ? `kubectl ${args[2].split("?")[0]}` : `${program} ${args.slice(0, 2).join(" ")}`,
    );
    expect(shapes).toEqual([
      "kubectl /apis/argoproj.io/v1alpha1/rollouts",
      "kubectl /apis/apps/v1/deployments",
      "kubectl /apis/apps/v1/replicasets",
      "kubectl /apis/apps/v1/replicasets",
      "kubectl /apis/batch/v1/jobs",
      "kubectl /apis/batch/v1/cronjobs",
      "kubectl /api/v1/pods",
      "helm history chase-sets-platform",
      "helm get values",
      "helm get values",
      "helm get values",
      "terraform -chdir=infrastructure/digitalocean/platform state",
    ]);
  });

  it.each([
    ["kubectl", ["delete", "pod", "x", "-n", NAMESPACE]],
    ["kubectl", ["scale", "deployment/api", "--replicas=0", "-n", NAMESPACE]],
    ["kubectl", ["patch", "cronjob", "sweeper", "-p", "{}"]],
    ["kubectl", ["apply", "-f", "manifest.json"]],
    ["kubectl", ["exec", "pod/x", "--", "sh"]],
    ["helm", ["rollback", "chase-sets-platform", "2", "--namespace", NAMESPACE]],
    ["helm", ["upgrade", "chase-sets-platform", "chart", "--namespace", NAMESPACE]],
    ["helm", ["uninstall", "chase-sets-platform", "--namespace", NAMESPACE]],
    ["terraform", ["-chdir=infrastructure/digitalocean/platform", "apply"]],
    ["terraform", ["-chdir=infrastructure/digitalocean/platform", "state", "push", "state.json"]],
    ["terraform", ["-chdir=infrastructure/digitalocean/platform", "state", "rm", "x"]],
    ["doctl", ["kubernetes", "cluster", "delete", "x"]],
  ])("refuses the mutating command %s %j", (program, args) => {
    expect(() => admitCommand(program, args)).toThrow(new CaptureRefusal("command-refused"));
  });

  it.each([
    "/api/v1/secrets?limit=500",
    "/api/v1/namespaces/chase-sets-platform/secrets?limit=500",
    "/api/v1/configmaps?limit=500",
    "/api/v1/namespaces/chase-sets-platform/pods?limit=500",
    "/api/v1/pods?limit=501",
    "/api/v1/pods?limit=500&fieldSelector=x",
  ])("refuses the Secret, ConfigMap or off-allowlist read %s", (path) => {
    expect(() => admitCommand("kubectl", ["get", "--raw", path, "--request-timeout=60s"])).toThrow("command-refused");
  });

  it.each([
    ["kubectl", ["get", "secrets", "-A", "-o", "json"]],
    ["kubectl", ["get", "pods", "-A", "-o", "yaml"]],
    ["helm", ["history", "chase-sets-platform", "--namespace", NAMESPACE, "--output", "yaml", "--max", "256"]],
    [
      "helm",
      [
        "get",
        "values",
        "chase-sets-platform",
        "--namespace",
        NAMESPACE,
        "--revision",
        "3",
        "--all",
        "--output",
        "yaml",
      ],
    ],
    ["helm", ["get", "manifest", "chase-sets-platform", "--namespace", NAMESPACE, "--revision", "3"]],
  ])("refuses %s %j (Secret reads and -o yaml)", (program, args) => {
    expect(() => admitCommand(program, args)).toThrow("command-refused");
  });

  it("refuses a writable session before any read", async () => {
    const state = world();
    state.db.readOnly = "off";
    const record = { calls: [], statements: [], redactOptions: [] };
    await expect(
      captureProviderAuthority(
        { target: "staging", floor: FLOOR, databaseUrl: PASSWORD_URL, head: HEAD },
        dependencies(state, record),
      ),
    ).rejects.toThrow(new CaptureRefusal("database-session-writable"));
    expect(record.statements).toEqual([READ_ONLY_PROBE_SQL]);
    expect(record.redactOptions).toEqual([]);
  });

  it.each([
    "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = NULL",
    "SELECT singleton FROM collections_anonymous_owner_activation WHERE singleton = true FOR SHARE",
    "SELECT intent_id FROM collections_anonymous_saved_list_intents FOR UPDATE SKIP LOCKED",
    `EXPLAIN (ANALYZE, FORMAT JSON) ${legacyAnonymousOwnerCountSql}`,
    "SET default_transaction_read_only = off",
    "SELECT 1; DELETE FROM collections_anonymous_saved_list_intents",
    "BEGIN",
    "EXPLAIN (FORMAT JSON) SELECT 1",
    `${anonymousOwnerActivationReadSql} FOR SHARE`,
  ])("refuses the statement %s", (sql) => {
    expect(() => admitStatement(sql, legacyAnonymousOwnerCountSql, anonymousOwnerObservationSql)).toThrow(
      "statement-refused",
    );
  });

  // Lock-free SELECTs that are not one of the exact observe() statements; the last differs from the count only
  // in its predicate.
  it.each([
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    "SELECT pg_advisory_lock(123456789)",
    "SELECT pg_terminate_backend(123456789)",
    "SELECT * FROM collections_anonymous_saved_list_intents",
    "SELECT count(*)::text AS remaining FROM collections_anonymous_saved_list_intents",
  ])("refuses the off-allowlist SELECT %s before it reaches the database", async (sql) => {
    expect(() => admitStatement(sql, legacyAnonymousOwnerCountSql, anonymousOwnerObservationSql)).toThrow(
      new CaptureRefusal("statement-refused"),
    );
    const record = { calls: [], statements: [], redactOptions: [] };
    const offAllowlistRedact = async (session) => {
      await session.query(sql);
      return { before: 0, codes: [] };
    };
    await expect(
      captureProviderAuthority(
        { target: "staging", floor: FLOOR, databaseUrl: PASSWORD_URL, head: HEAD },
        { ...dependencies(world(), record), redact: offAllowlistRedact },
      ),
    ).rejects.toThrow(new CaptureRefusal("statement-refused"));
    expect(record.statements).not.toContain(sql);
  });

  it("refuses every observe() statement and the count EXPLAIN when no observation allowlist is supplied", async () => {
    const record = { calls: [], statements: [], redactOptions: [] };
    await expect(
      captureProviderAuthority(
        { target: "staging", floor: FLOOR, databaseUrl: PASSWORD_URL, head: HEAD },
        { ...dependencies(world(), record), observationSql: undefined },
      ),
    ).rejects.toThrow(new CaptureRefusal("statement-refused"));
    expect(record.statements).toEqual([READ_ONLY_PROBE_SQL, SESSION_ACTIVITY_SQL]);
  });

  it("runs the redaction dryRun: true path and a plain EXPLAIN of its exported count in the read-only session", async () => {
    const { fields, record } = await capture();
    expect(record.redactOptions).toEqual([{ dryRun: true }]);
    expect(anonymousOwnerObservationSql).toContain(legacyAnonymousOwnerCountSql);
    expect(record.statements).toEqual([
      READ_ONLY_PROBE_SQL,
      ...anonymousOwnerObservationSql,
      `EXPLAIN (FORMAT JSON) ${legacyAnonymousOwnerCountSql}`,
      SESSION_ACTIVITY_SQL,
      READ_ONLY_PROBE_SQL,
    ]);
    expect(record.statements.some((sql) => /\bFOR\s+(SHARE|UPDATE)\b/i.test(sql))).toBe(false);
    expect(fields.legacyCountQueryPlan.value).toEqual({
      statementSha256: createHash("sha256").update(legacyAnonymousOwnerCountSql).digest("hex"),
      plan: PLAN,
    });
  });

  it("refuses the capture when the dry-run path issues a locking read", async () => {
    const state = world();
    const record = { calls: [], statements: [], redactOptions: [] };
    const lockingRedact = async (session) => {
      await session.query(
        "SELECT singleton FROM collections_anonymous_owner_activation WHERE singleton = true FOR SHARE",
      );
      return { before: 0, codes: [] };
    };
    await expect(
      captureProviderAuthority(
        { target: "staging", floor: FLOOR, databaseUrl: PASSWORD_URL, head: HEAD },
        { ...dependencies(state, record), redact: lockingRedact },
      ),
    ).rejects.toThrow(new CaptureRefusal("statement-refused"));
  });

  it("keeps planted tokens, password URLs and PEM out of the capture, summary and logs", async () => {
    const state = world();
    const record = { calls: [], statements: [], redactOptions: [] };
    const files = new Map();
    const logs = [];
    const env = {
      DATABASE_URL_COLLECTIONS: PASSWORD_URL,
      DIGITALOCEAN_ACCESS_TOKEN: TOKEN,
      AWS_SECRET_ACCESS_KEY: TOKEN,
      MANAGED_POSTGRES_CA: PEM,
      GITHUB_SHA: HEAD,
      GITHUB_STEP_SUMMARY: "summary.md",
    };
    const exitCode = await runCapture({
      argv: ["--target", "staging", "--out", "artifacts/capture.json"],
      env,
      dependencies: {
        ...dependencies(state, record),
        deriveFloor: () => FLOOR,
        floorCommittedAt: () => MERGED_AT,
      },
      io: {
        mkdir: async () => undefined,
        writeFile: async (path, text) => files.set(path, text),
        appendFile: async (path, text) => files.set(path, `${files.get(path) ?? ""}${text}`),
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      },
    });
    expect(exitCode).toBe(0);
    const emitted = [...files.values(), ...logs].join("\n");
    expect(JSON.parse(files.get("artifacts/capture.json")).codes).toEqual([]);
    for (const canary of CANARIES) expect(emitted).not.toContain(canary);
  });

  it("the default command runner aborts under test instead of reaching a real CLI", async () => {
    await expect(
      execFileRunner()("kubectl", ["get", "--raw", "/api/v1/pods?limit=500", "--request-timeout=60s"]),
    ).rejects.toThrow("real-cli-reached:execFile");
  });

  it("classifies provider failures into closed reasons without echoing stderr", async () => {
    const outcomes = [
      [{ killed: true }, ""],
      [{ code: 1 }, `Error from server (Forbidden): pods is forbidden ${TOKEN}`],
      [{ code: 1 }, "Error from server (NotFound): the server could not find the requested resource"],
      [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, ""],
      [{ code: 1 }, PASSWORD_URL],
    ];
    expect(outcomes.map(([error, stderr]) => commandFailure(error, stderr))).toEqual([
      "timeout",
      "forbidden",
      "not-found",
      "output-limit",
      "failed",
    ]);
    const run = execFileRunner((program, args, options, callback) => callback({ code: 1 }, "", PASSWORD_URL));
    expect(await run("terraform", ["state", "pull"])).toEqual({ ok: false, reason: "failed" });
  });
});

describe("AC4 job-side apply", () => {
  it("a failed capture still writes one canonical capture with codes, a summary and a failing exit", async () => {
    const files = new Map();
    const logs = [];
    const exitCode = await runCapture({
      argv: ["--target", "staging", "--out", "artifacts/capture.json"],
      env: { GITHUB_SHA: HEAD, GITHUB_STEP_SUMMARY: "summary.md" },
      dependencies: {
        deriveFloor: () => {
          throw new Error("floor-ambiguous");
        },
      },
      io: {
        mkdir: async () => undefined,
        writeFile: async (path, text) => files.set(path, text),
        appendFile: async (path, text) => files.set(path, `${files.get(path) ?? ""}${text}`),
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(files.get("artifacts/capture.json"))).toMatchObject({
      schemaVersion: "collections-cutover-provider-capture/v1",
      target: "staging",
      head: HEAD,
      codes: ["floor-ambiguous"],
      fields: {},
    });
    expect(files.get("summary.md")).toBe(
      "## Collections cutover authority capture\n\n- Verdict: invalid\n- Missing: 22\n",
    );
  });

  it("refuses a recovery-commit floor", async () => {
    await expect(
      captureProviderAuthority(
        { target: "staging", floor: RECOVERY_COMMIT, databaseUrl: PASSWORD_URL, head: HEAD },
        {},
      ),
    ).rejects.toThrow(new CaptureRefusal("floor-is-recovery-commit"));
  });

  it("a governed capture summarizes verdict and missing count only and passes", async () => {
    const state = world();
    state.db.sessions[0].hidden = 1;
    const record = { calls: [], statements: [], redactOptions: [] };
    const files = new Map();
    const exitCode = await runCapture({
      argv: ["--target", "staging", "--out", "artifacts/capture.json"],
      env: { DATABASE_URL_COLLECTIONS: PASSWORD_URL, GITHUB_SHA: HEAD, GITHUB_STEP_SUMMARY: "summary.md" },
      dependencies: { ...dependencies(state, record), deriveFloor: () => FLOOR, floorCommittedAt: () => MERGED_AT },
      io: {
        mkdir: async () => undefined,
        writeFile: async (path, text) => files.set(path, text),
        appendFile: async (path, text) => files.set(path, `${files.get(path) ?? ""}${text}`),
        log: () => undefined,
        error: () => undefined,
      },
    });
    expect(exitCode).toBe(0);
    expect(files.get("summary.md")).toBe(
      "## Collections cutover authority capture\n\n- Verdict: bounded-unknown\n- Missing: 2\n",
    );
  });
});

const workflowPath = ".github/workflows/collections-cutover-authority-capture.yml";
const workflowSource = readFileSync(new URL(`../${workflowPath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function stepCredentialGaps(workflow) {
  const steps = workflow.jobs.capture.steps;
  const required = {
    "Export Collections database authority": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "DIGITALOCEAN_ACCESS_TOKEN",
    ],
    "Configure Kubernetes context": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DIGITALOCEAN_ACCESS_TOKEN"],
    "Capture Collections cutover authority": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  };
  return Object.entries(required).flatMap(([name, keys]) => {
    const env = steps.find((step) => step.name === name)?.env ?? {};
    return keys.filter((key) => !/^\$\{\{ secrets\.[A-Z_]+ \}\}$/.test(env[key] ?? "")).map((key) => `${name}: ${key}`);
  });
}

describe("AC5 workflow contract", () => {
  const workflow = parseYaml(workflowSource);
  const job = workflow.jobs.capture;
  const step = (name) => job.steps.find((candidate) => candidate.name === name);

  it("dispatches one read-only job per target with full history and per-target concurrency", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.target).toMatchObject({
      type: "choice",
      options: ["staging", "production"],
    });
    expect(workflow.on.workflow_dispatch.inputs.approval_reference).toMatchObject({ type: "string", required: false });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "collections-cutover-authority-capture-${{ inputs.target }}",
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow.jobs)).toEqual(["capture"]);
    expect(job.environment).toBe("${{ inputs.target }}");
    expect(job.steps[1]).toMatchObject({ with: { "fetch-depth": 0 } });
  });

  it("stops production before any provider step unless approval_reference is a repository issue URL", () => {
    const admit = job.steps[0];
    expect(admit).toMatchObject({ name: "Admit capture target", id: "admit" });
    expect(admit.run).toContain('issue_prefix="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/issues/"');
    expect(admit.run).toContain('[[ ! "$issue_number" =~ ^[1-9][0-9]*$ ]]');
    expect(admit.run).toContain('echo "Accepted production approval reference: ${CAPTURE_APPROVAL_REFERENCE}"');
    for (const name of ["Export Collections database authority", "Configure Kubernetes context"]) {
      expect(step(name).if, name).toBeUndefined();
    }
    expect(step("Capture Collections cutover authority").if).toBe(
      "${{ !cancelled() && steps.admit.outcome == 'success' }}",
    );
  });

  it("removes the kubeconfig and CA always and retains one canonical capture for 14 days", () => {
    const cleanup = step("Remove managed Postgres CA, kubeconfig and pulled state");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain('rm -f -- "${RUNNER_TEMP}/collections-cutover-authority-capture.kubeconfig"');
    expect(cleanup.run).toContain('rm -f -- "$PGSSLROOTCERT"');
    expect(step("Capture Collections cutover authority").run).toContain(
      "--out artifacts/collections-cutover-authority-capture/capture.json",
    );
    expect(step("Retain capture").with).toMatchObject({
      path: "artifacts/collections-cutover-authority-capture/capture.json",
      "if-no-files-found": "error",
      "retention-days": 14,
    });
  });

  it("threads every credential step-locally and nowhere else", () => {
    expect(stepCredentialGaps(workflow)).toEqual([]);
    expect(workflow.env).toBeUndefined();
    expect(JSON.stringify(job.env)).not.toContain("secrets.");
    const secretSteps = job.steps.filter((candidate) => JSON.stringify(candidate).includes("secrets."));
    expect(secretSteps.map((candidate) => candidate.name)).toEqual([
      "Export Collections database authority",
      "Configure Kubernetes context",
      "Capture Collections cutover authority",
    ]);
    expect(step("Capture Collections cutover authority").env).not.toHaveProperty("DIGITALOCEAN_ACCESS_TOKEN");
    expect(checkWorkflowProviderCredentials(workflowSource, { workflowFile: workflowPath }).violations).toEqual([]);
  });

  it("withheld-credential negative: dropping one step-local key names that step", () => {
    const withheld = parseYaml(workflowSource);
    delete withheld.jobs.capture.steps.find((candidate) => candidate.name === "Capture Collections cutover authority")
      .env.AWS_SECRET_ACCESS_KEY;
    expect(stepCredentialGaps(withheld)).toEqual(["Capture Collections cutover authority: AWS_SECRET_ACCESS_KEY"]);
    const stripped = workflowSource.replace(
      /(- name: Configure Kubernetes context\n(?:.*\n)*?) {10}AWS_ACCESS_KEY_ID: .*\n/,
      "$1",
    );
    expect(stripped).not.toBe(workflowSource);
    expect(checkWorkflowProviderCredentials(stripped, { workflowFile: workflowPath }).violations).toEqual([
      expect.stringContaining(
        "provider-touching step 'Configure Kubernetes context' invokes terraform/doctl but does not declare step env: AWS_ACCESS_KEY_ID",
      ),
    ]);
  });
});
