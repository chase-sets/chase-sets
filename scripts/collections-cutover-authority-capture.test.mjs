// Every identity below is SYNTHETIC. Provider commands and the database are injected doubles; any attempt to
// spawn a real CLI aborts the test (windows-posix-cli-shim-resolves-real-provider-binary).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  admitPooledStatement,
  admitRequest,
  admitStatement,
  CaptureRefusal,
  captureProviderAuthority,
  commandFailure,
  execFileRunner,
  githubReadRunner,
  HELM_HISTORY_MAX,
  jobPacket,
  KUBERNETES_LISTS,
  MAX_PAGES,
  MAX_RUN_PAGES,
  POOLED_READ_SQL,
  READ_ONLY_PROBE_SQL,
  RECOVERY_COMMIT,
  runCapture,
  SESSION_ROW_CAP,
  SESSION_ROWS_SQL,
  SESSION_TOTAL_SQL,
  workflowFiles,
} from "./collections-cutover-authority-capture.mjs";
import { applyProviderCapture, PROVIDER_CAPTURE_FIELDS } from "./collections-cutover-authority-packet.mjs";
import { checkWorkflowProviderCredentials } from "./workflow-provider-credentials.mjs";

const FLOOR = "a".repeat(40);
const RELEASE = "b".repeat(40);
const PRIOR = "c".repeat(40);
const SUB_FLOOR = "d".repeat(40);
const HEAD = "e".repeat(40);
const CONTAINS_FLOOR = new Set([FLOOR, PRIOR, RELEASE, HEAD]);
const MERGED_AT = "2020-01-01T00:00:00.000Z";
const digest = (digit) => `sha256:${String(digit).repeat(64)}`;
const REGISTRY = "registry.example.invalid/synthetic/chase-sets-platform";
const NAMESPACE = "chase-sets-platform";

const TOKEN = `dop_v1_${"f0".repeat(32)}`;
const PASSWORD = "canary-password-7f3a";
const PASSWORD_URL = `postgresql://canary-user:${PASSWORD}@db.canary.invalid:25060/collections?sslmode=require`;
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIcanaryPEMbody\n-----END PRIVATE KEY-----";
const CANARIES = [TOKEN, PASSWORD, "canary-user", "db.canary.invalid", "BEGIN PRIVATE KEY", "MIIcanaryPEMbody"];
// Raw session and pool identities: only their domain-separated digests may leave the capture.
const POOL_USER = "synthetic_collections_role";
const POOL_HOST = "pool.canary.invalid";
const CLIENT_ADDRESS = "198.51.100.7";
const RAW_IDENTITIES = [POOL_USER, POOL_HOST, CLIENT_ADDRESS, "synthetic-platform", "synthetic-worker"];
const CA_PATH = "/synthetic/runner-temp/digitalocean-managed-postgres-ca.pem";
const REPOSITORY = "synthetic-owner/synthetic-repo";
const CAPTURE_RUN = { id: "9000000001", attempt: "1" };
const SELF_PID = 4100;
const POOLER_PID = 4242;
const RUNNER_PID = 4300;
const POOLER_START = new Date("2030-01-02T00:00:00.000Z");
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const roleDigest = (role) => sha256Hex(`collections-session-role/v1\u0000${role}`);
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
      resources: [
        { instances: [{ attributes: { uri: PASSWORD_URL, ca_certificate: PEM, token: TOKEN } }] },
        {
          type: "digitalocean_database_user",
          name: "contexts",
          instances: [{ index_key: "collections", attributes: { name: POOL_USER, password: PASSWORD } }],
        },
        {
          type: "digitalocean_database_connection_pool",
          name: "contexts",
          instances: [
            {
              index_key: "collections",
              attributes: {
                name: "collections-runtime",
                mode: "transaction",
                size: 1,
                db_name: "collections",
                host: POOL_HOST,
                port: 25061,
                user: POOL_USER,
                password: PASSWORD,
                uri: PASSWORD_URL,
              },
            },
          ],
        },
      ],
    },
    db: {
      readOnly: "on",
      self: SELF_PID,
      // The pool's idle server backend and a same-role direct runner with a blank application of its own.
      sessions: [
        {
          pid: POOLER_PID,
          backend_start: POOLER_START,
          state: "idle",
          backend_type: "client backend",
          role: POOL_USER,
          application: "",
          client_address: CLIENT_ADDRESS,
          query: `SELECT '${PASSWORD_URL}'`,
        },
        {
          pid: RUNNER_PID,
          backend_start: new Date("2030-01-02T01:00:00.000Z"),
          state: "active",
          backend_type: "client backend",
          role: POOL_USER,
          application: "synthetic-worker",
          client_address: "198.51.100.8",
          query: `SELECT '${TOKEN}'`,
        },
      ],
    },
    pooled: { pid: POOLER_PID, backendStart: POOLER_START, readOnly: "on" },
    workflows: { ...SYNTHETIC_WORKFLOWS },
    github: {
      runs: {
        "synthetic-digest.yml": {
          items: [
            { id: 5001, run_attempt: 1, status: "completed", event: "schedule", head_sha: PRIOR },
            {
              id: 5002,
              run_attempt: 1,
              status: "in_progress",
              event: "workflow_dispatch",
              head_sha: RELEASE,
              display_title: TOKEN,
              head_commit: { message: PASSWORD_URL },
            },
          ],
        },
        "synthetic-deploy.yml": {
          items: [{ id: 6001, run_attempt: 1, status: "completed", event: "workflow_dispatch", head_sha: RELEASE }],
        },
      },
      jobs: {
        "5002/1": [
          { id: 7001, name: "Build Synthetic Digest", status: "in_progress", steps: [{ name: PASSWORD_URL }] },
          { id: 7002, name: "Refuse Unconfirmed Synthetic Digest", status: "completed" },
        ],
      },
    },
  };
}

// Synthetic workflows at capture head: a dispatch-selectable pooled holder (default staging), a staging deploy that
// exports pooled Secret URLs, a catalog-only pooled consumer and a direct-mode Collections consumer.
const SYNTHETIC_WORKFLOWS = Object.freeze({
  ".github/workflows/synthetic-catalog.yml": `name: Synthetic Catalog
on:
  schedule:
    - cron: "0 1 * * 1"
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/export-managed-postgres-authority
        with:
          environment: staging
          contexts: catalog
          connection-mode: pooled
`,
  ".github/workflows/synthetic-deploy.yml": `name: Synthetic Deploy
on:
  workflow_dispatch: {}
jobs:
  deploy-staging:
    name: Deploy Synthetic Staging
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Export staging Kubernetes database URLs
        env:
          DEPLOYMENT_ENVIRONMENT: staging
          SYNTHETIC_URL: ${PASSWORD_URL}
        run: |
          node ./scripts/platform-kubernetes-secret.mjs \\
            --export-database-urls "$state_path" \\
            --database-environment staging \\
            --query-connection-mode pooled
  deploy-production:
    runs-on: ubuntu-latest
    steps:
      - run: node ./scripts/platform-kubernetes-secret.mjs --export-database-urls "$state_path" --database-environment production --query-connection-mode direct
`,
  ".github/workflows/synthetic-digest.yml": `name: Synthetic Digest
on:
  schedule:
    - cron: "0 0 * * 1"
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        default: staging
        options: [staging, production]
jobs:
  refuse-unconfirmed:
    name: Refuse Unconfirmed Synthetic Digest
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  digest:
    name: Build Synthetic Digest
    runs-on: ubuntu-latest
    environment: \${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'staging' }}
    env:
      TARGET_ENVIRONMENT: \${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'staging' }}
    steps:
      - uses: actions/checkout@v6
      - name: Export database URLs and TLS trust
        uses: ./.github/actions/export-managed-postgres-authority
        with:
          environment: \${{ env.TARGET_ENVIRONMENT }}
          connection-mode: pooled
`,
  ".github/workflows/synthetic-direct.yml": `name: Synthetic Direct
on:
  workflow_dispatch: {}
jobs:
  redact:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/export-managed-postgres-authority
        with:
          environment: staging
          contexts: collections
          connection-mode: direct
`,
});

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
      if (sql === SESSION_TOTAL_SQL) {
        const total = state.db.totals ? state.db.totals.shift() : state.db.sessions.length;
        return { rows: [{ self_pid: state.db.self, total }] };
      }
      if (sql === SESSION_ROWS_SQL) return { rows: state.db.rows ?? state.db.sessions };
      throw new Error("unexpected-statement");
    },
  };
}

function fakePooled(state, record) {
  return async (url) => {
    record.pooledUrls.push(url);
    if (state.pooled.fail) throw new Error("synthetic-pooled-connect-failure");
    return {
      query: async (sql) => {
        record.pooledStatements.push(sql);
        if (sql === POOLED_READ_SQL[1]) {
          return {
            rows: [
              { pid: state.pooled.pid, read_only: state.pooled.readOnly, backend_start: state.pooled.backendStart },
            ],
          };
        }
        if (sql === POOLED_READ_SQL[0] || sql === POOLED_READ_SQL[2]) return { rows: [] };
        throw new Error("unexpected-pooled-statement");
      },
      end: async () => {
        record.pooledEnds += 1;
      },
    };
  };
}

function fakeRequest(state, record) {
  return async (url) => {
    record.requests.push(url);
    const runs = /\/actions\/workflows\/([^/]+)\/runs\?per_page=100&created=%3E%3D[0-9-]+&page=([0-9]+)$/.exec(url);
    if (runs) {
      const list = state.github.runs[runs[1]] ?? { items: [] };
      if (list.fail) return { ok: false, reason: list.fail };
      const page = Number(runs[2]);
      const items = (list.pages ? list.pages[page - 1] : list.items.slice((page - 1) * 100, page * 100)) ?? [];
      const total = list.total ?? (list.pages ? list.pages.flat().length : list.items.length);
      return { ok: true, stdout: JSON.stringify({ total_count: total, workflow_runs: items }) };
    }
    const jobs = /\/actions\/runs\/([0-9]+)\/attempts\/([0-9]+)\/jobs\?per_page=100$/.exec(url);
    if (jobs) {
      const entry = state.github.jobs[`${jobs[1]}/${jobs[2]}`] ?? [];
      if (entry.fail) return { ok: false, reason: entry.fail };
      const list = Array.isArray(entry) ? entry : entry.items;
      // GitHub binds every job record to its run, attempt and head; a fixture's own fields override that binding.
      const run = Object.values(state.github.runs)
        .flatMap((runs) => runs.items ?? runs.pages?.flat() ?? [])
        .find((candidate) => candidate.id === Number(jobs[1]));
      const records = list.map((job) => {
        const status = job.status ?? "in_progress";
        return {
          run_id: Number(jobs[1]),
          run_attempt: Number(jobs[2]),
          head_sha: run?.head_sha,
          status,
          conclusion: status === "completed" ? "success" : null,
          ...job,
        };
      });
      return { ok: true, stdout: JSON.stringify({ total_count: entry.total ?? records.length, jobs: records }) };
    }
    throw new Error("unexpected-request");
  };
}

function dependencies(state, record) {
  record.pooledStatements ??= [];
  record.pooledUrls ??= [];
  record.pooledEnds ??= 0;
  record.requests ??= [];
  return {
    run: fakeRun(state, record.calls),
    database: fakeDatabase(state, record.statements),
    openPooled: fakePooled(state, record),
    request: fakeRequest(state, record),
    readWorkflows: () => Object.entries(state.workflows).map(([path, text]) => ({ path, text })),
    redact: async (session, options) => {
      record.redactOptions.push(options);
      return redactLegacyAnonymousOwners(session, options);
    },
    countSql: legacyAnonymousOwnerCountSql,
    observationSql: anonymousOwnerObservationSql,
    containsFloor: (floor, revision) => floor === FLOOR && CONTAINS_FLOOR.has(revision),
  };
}

const CAPTURE_ENV = Object.freeze({
  DATABASE_URL_COLLECTIONS: PASSWORD_URL,
  PGSSLROOTCERT: CA_PATH,
  GITHUB_SHA: HEAD,
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_RUN_ID: CAPTURE_RUN.id,
  GITHUB_RUN_ATTEMPT: CAPTURE_RUN.attempt,
  GITHUB_STEP_SUMMARY: "summary.md",
});

// The real job entrypoint over injected doubles: the artifact, every emitted line and the recorded reads.
async function throughEntrypoint(state = world(), env = {}) {
  const record = { calls: [], statements: [], redactOptions: [] };
  const files = new Map();
  const logs = [];
  const exitCode = await runCapture({
    argv: ["--target", "staging", "--out", "artifacts/capture.json"],
    env: { ...CAPTURE_ENV, ...env },
    dependencies: { ...dependencies(state, record), deriveFloor: () => FLOOR, floorCommittedAt: () => MERGED_AT },
    io: {
      mkdir: async () => undefined,
      writeFile: async (path, text) => files.set(path, text),
      appendFile: async (path, text) => files.set(path, `${files.get(path) ?? ""}${text}`),
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
    },
  });
  const artifact = files.get("artifacts/capture.json");
  return {
    exitCode,
    record,
    artifact,
    capture: JSON.parse(artifact),
    emitted: [...files.values(), ...logs].join("\n"),
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

async function capture(state = world(), overrides = {}, options = {}) {
  const record = { calls: [], statements: [], redactOptions: [] };
  const result = await captureProviderAuthority(
    {
      target: "staging",
      floor: FLOOR,
      databaseUrl: PASSWORD_URL,
      head: HEAD,
      caPath: CA_PATH,
      repository: REPOSITORY,
      run: CAPTURE_RUN,
      now: () => new Date("2030-01-03T00:00:00.000Z"),
      ...options,
    },
    { ...dependencies(state, record), ...overrides },
  );
  return { result, record, fields: result.fields };
}

const sessionItem = (fields, pid) => fields["writers.session"].items.find((item) => item.pid === pid);
const holderIds = (fields) => fields["writers.session"].holders.items.map((item) => item.id);
const exclusionIds = (fields) =>
  fields["writers.session"].holders.exclusions.map((item) => `${item.id} ${item.reason}`);

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

  it("records pods' imageID digests, state serial and lineage, and one digested item per backend", async () => {
    const { fields } = await capture();
    expect(fields.imageDigests.value).toEqual([digest(1)]);
    expect(fields.terraformStateSerial.value).toBe(42);
    expect(fields.terraformStateLineage.value).toBe("0f0f0f0f-0000-4000-8000-000000000001");
    expect(fields["writers.session"].items.map((item) => item.id)).toEqual([
      `backend:${POOLER_PID}`,
      `backend:${RUNNER_PID}`,
    ]);
    expect(sessionItem(fields, RUNNER_PID)).toMatchObject({
      pid: RUNNER_PID,
      state: "active",
      backendType: "client backend",
      backendStart: "2030-01-02T01:00:00.000Z",
      roleDigest: roleDigest(POOL_USER),
      clientAddressDigest: sha256Hex("collections-session-client-address/v1\u0000198.51.100.8"),
    });
    for (const raw of RAW_IDENTITIES) expect(JSON.stringify(fields)).not.toContain(raw);
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
      pid: 4400,
      backend_start: null,
      state: null,
      role: "synthetic_other_role",
      application: null,
      backend_type: null,
      client_address: null,
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
    expect(record.statements).toEqual([READ_ONLY_PROBE_SQL, SESSION_TOTAL_SQL, SESSION_ROWS_SQL, SESSION_TOTAL_SQL]);
  });

  it("runs the redaction dryRun: true path and a plain EXPLAIN of its exported count in the read-only session", async () => {
    const { fields, record } = await capture();
    expect(record.redactOptions).toEqual([{ dryRun: true }]);
    expect(anonymousOwnerObservationSql).toContain(legacyAnonymousOwnerCountSql);
    expect(record.statements).toEqual([
      READ_ONLY_PROBE_SQL,
      ...anonymousOwnerObservationSql,
      `EXPLAIN (FORMAT JSON) ${legacyAnonymousOwnerCountSql}`,
      SESSION_TOTAL_SQL,
      SESSION_ROWS_SQL,
      SESSION_TOTAL_SQL,
      READ_ONLY_PROBE_SQL,
    ]);
    expect(record.pooledStatements).toEqual([...POOLED_READ_SQL]);
    expect(record.pooledEnds).toBe(1);
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
    const {
      exitCode,
      capture: written,
      emitted,
      record,
    } = await throughEntrypoint(world(), {
      DIGITALOCEAN_ACCESS_TOKEN: TOKEN,
      AWS_SECRET_ACCESS_KEY: TOKEN,
      MANAGED_POSTGRES_CA: PEM,
    });
    expect(exitCode).toBe(0);
    expect(written.codes).toEqual([]);
    // The pooled URL was built in memory from the pulled state and used, yet never emitted.
    expect(record.pooledUrls).toHaveLength(1);
    expect(record.pooledUrls[0]).toContain(PASSWORD);
    for (const canary of [...CANARIES, ...RAW_IDENTITIES, CA_PATH]) expect(emitted).not.toContain(canary);
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
    state.db.sessions[0].backend_start = null;
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

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY_WORKFLOW = ".github/workflows/synthetic-deploy.yml";
const DIGEST_WORKFLOW = ".github/workflows/synthetic-digest.yml";
const KUBERNETES_HOLDERS = [
  "deployments:chase-sets-platform/api",
  "deployments:chase-sets-platform/worker",
  "replicasets:chase-sets-platform/api-current",
  "replicasets:chase-sets-platform/api-old",
  "cronjobs:chase-sets-platform/sweeper",
  "pods:ops/debug-shell",
];
const STAGING_HOLDERS = [
  "capture:9000000001/1",
  `workflow:${DEPLOY_WORKFLOW}#deploy-staging/2`,
  `workflow:${DIGEST_WORKFLOW}#digest/2`,
  "run:5002/1",
  ...KUBERNETES_HOLDERS,
];
// capture() runs at 2030-01-03, so the 31-day rerun window opens on 2029-12-03.
const runsUrl = (file, page = 1) =>
  `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${file}/runs?per_page=100&created=%3E%3D2029-12-03&page=${page}`;
const jobsUrl = (id, attempt) =>
  `https://api.github.com/repos/${REPOSITORY}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`;
const poolOf = (state) =>
  state.terraform.resources.find((resource) => resource.type === "digitalocean_database_connection_pool").instances[0]
    .attributes;
const sessionRow = (pid, overrides = {}) => ({
  pid,
  backend_start: new Date("2030-01-02T02:00:00.000Z"),
  state: "idle",
  backend_type: "client backend",
  role: "synthetic_other_role",
  application: "synthetic-other",
  client_address: "198.51.100.9",
  ...overrides,
});
const SESSION_SOURCE = "pg_stat_activity per-backend census reconciled with its independent total";
const POOLED_READ_SOURCE = "BEGIN READ ONLY pg_backend_pid() through the collections-runtime pool";
// The pool's next server backend, ~3603.6 s after the first: the hourly recycle the historical captures showed.
const RECYCLED_START = new Date(POOLER_START.getTime() + 3_603_600);
const AGGREGATE_SESSION_SOURCE = "pg_stat_activity grouped by state, backend type, role and application";

describe("AC1 per-backend session census through the capture entrypoint", () => {
  it("excludes the capture's own backend from every census read and lists one item per other backend", async () => {
    for (const sql of [SESSION_TOTAL_SQL, SESSION_ROWS_SQL]) expect(sql).toContain("pid <> pg_backend_pid()");
    expect(SESSION_ROWS_SQL).toContain(`LIMIT ${SESSION_ROW_CAP + 1}`);
    const { exitCode, capture: written, record } = await throughEntrypoint();
    expect(exitCode).toBe(0);
    const sessions = written.fields["writers.session"];
    expect(sessions).toMatchObject({
      collected: 2,
      authoritativeTotal: 2,
      coverage: { sessions: { status: "complete", listed: 2 } },
      source: SESSION_SOURCE,
    });
    expect(sessions.items.map((item) => item.id)).toEqual([`backend:${POOLER_PID}`, `backend:${RUNNER_PID}`]);
    expect(sessions.items.map((item) => item.pid)).not.toContain(SELF_PID);
    expect(record.statements.filter((sql) => sql === SESSION_TOTAL_SQL)).toHaveLength(2);
  });

  it.each([
    ["lists the capture's own backend", "census-self", (state) => state.db.sessions.push(sessionRow(SELF_PID))],
    [
      "is truncated below its independent total",
      "census-mismatch",
      (state) => {
        state.db.totals = [3, 3];
      },
    ],
    [
      "overflows the row cap",
      "session-cap",
      (state) => {
        state.db.rows = Array.from({ length: SESSION_ROW_CAP + 1 }, (_, index) => sessionRow(5000 + index));
        state.db.totals = [SESSION_ROW_CAP + 1, SESSION_ROW_CAP + 1];
      },
    ],
    [
      "lists one backend twice",
      "census-duplicate",
      (state) => {
        state.db.rows = [...state.db.sessions, state.db.sessions[1]];
        state.db.totals = [3, 3];
      },
    ],
    [
      "moves between its two total reads",
      "census-unstable",
      (state) => {
        state.db.totals = [2, 3];
      },
    ],
  ])("a census that %s is a governed unknown, never a partial set", async (_, reason, mutate) => {
    const state = world();
    mutate(state);
    const { exitCode, capture: written } = await throughEntrypoint(state);
    expect(exitCode).toBe(0);
    const sessions = written.fields["writers.session"];
    expect(isGovernedUnknown(sessions)).toBe(true);
    expect(sessions.missingAuthority).toBe(`${SESSION_SOURCE}: ${reason}`);
    expect(sessions).not.toHaveProperty("items");
    expect(isGovernedUnknown(written.fields["gates.credential-session-fence.observeAuthority"])).toBe(true);
    const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), written);
    expect(applied).toMatchObject({ verdict: "bounded-unknown", errors: [] });
    expect(applied.missing.map((entry) => entry.field)).toEqual([
      "writers.session",
      "gates.credential-session-fence.observeAuthority",
    ]);
  });

  it("digests a null client address as null and keeps every backend listed", async () => {
    const state = world();
    for (const session of state.db.sessions) session.client_address = null;
    const { capture: written } = await throughEntrypoint(state);
    const sessions = written.fields["writers.session"];
    expect(sessions.collected).toBe(2);
    expect(sessions.items.map((item) => item.clientAddressDigest)).toEqual([null, null]);
    // An address was never proof, so its absence changes no classification.
    expect(sessions.items.map((item) => item.classification)).toEqual(["pooler", "unknown"]);
  });

  it("serializes each backend as domain-separated digests and allowlisted metadata only", async () => {
    const state = world();
    state.db.sessions[1].state = TOKEN;
    state.db.sessions[1].backend_type = PASSWORD_URL;
    const { exitCode, capture: written, emitted } = await throughEntrypoint(state);
    expect(exitCode).toBe(0);
    const [pooler, runner] = written.fields["writers.session"].items;
    expect(Object.keys(pooler)).toEqual([
      "id",
      "pid",
      "backendStart",
      "state",
      "backendType",
      "roleDigest",
      "applicationDigest",
      "clientAddressDigest",
      "poolMatch",
      "classification",
      "revisions",
      "containsFloor",
    ]);
    expect(runner).toMatchObject({ state: null, backendType: "unnamed" });
    expect(pooler).toMatchObject({
      backendStart: POOLER_START.toISOString(),
      roleDigest: sha256Hex(`collections-session-role/v1\u0000${POOL_USER}`),
      applicationDigest: sha256Hex("collections-session-application/v1\u0000"),
      clientAddressDigest: sha256Hex(`collections-session-client-address/v1\u0000${CLIENT_ADDRESS}`),
    });
    expect(pooler.roleDigest).not.toBe(sha256Hex(POOL_USER));
    expect(pooler.clientAddressDigest).not.toBe(sha256Hex(CLIENT_ADDRESS));
    for (const raw of [...CANARIES, ...RAW_IDENTITIES, "198.51.100.8", CA_PATH, "SELECT '"]) {
      expect(emitted).not.toContain(raw);
    }
  });
});

describe("pool-match", () => {
  it("classifies the backend the same-run pooled read names, under the pool user's role, as pooler", async () => {
    const { fields, record } = await capture();
    const sessions = fields["writers.session"];
    expect(sessions.pool).toEqual({
      value: {
        context: "collections",
        name: "collections-runtime",
        mode: "transaction",
        size: 1,
        hostDigest: sha256Hex(`collections-pool-host/v1\u0000${POOL_HOST}`),
        userDigest: roleDigest(POOL_USER),
      },
      source: "terraform state pull digitalocean_database_connection_pool.contexts[collections]",
    });
    expect(sessions.pooledRead).toEqual({
      value: { pid: POOLER_PID, backendStart: POOLER_START.toISOString() },
      source: POOLED_READ_SOURCE,
    });
    expect(sessionItem(fields, POOLER_PID)).toMatchObject({
      poolMatch: { pid: true, backendStart: true, role: true },
      classification: "pooler",
      applicationDigest: sha256Hex("collections-session-application/v1\u0000"),
    });
    // The pooled URL is built in memory from the pulled state's collections-runtime pool and sees only the closed read.
    expect(record.pooledUrls).toEqual([
      expect.stringMatching(
        /^postgresql:\/\/synthetic_collections_role:canary-password-7f3a@pool\.canary\.invalid:25061\/collections-runtime\?sslmode=verify-full&/,
      ),
    ]);
    expect(record.pooledStatements).toEqual([...POOLED_READ_SQL]);
    expect(POOLED_READ_SQL[0]).toBe("BEGIN READ ONLY");
    expect(record.pooledEnds).toBe(1);
  });

  it("leaves a same-role direct runner unknown", async () => {
    const { fields } = await capture();
    expect(sessionItem(fields, RUNNER_PID)).toMatchObject({
      roleDigest: roleDigest(POOL_USER),
      poolMatch: { pid: false, backendStart: false, role: true },
      classification: "unknown",
      revisions: [],
      containsFloor: null,
    });
  });

  it.each([
    [
      "a blank application under the pool role with no pooled read",
      () => {},
      { openPooled: undefined },
      { pid: null, backendStart: null, role: true },
    ],
    [
      "a pool other than collections-runtime",
      (state) => {
        poolOf(state).name = "collections-other";
      },
      {},
      { pid: null, backendStart: null, role: null },
    ],
    [
      "a session-mode pool",
      (state) => {
        poolOf(state).mode = "session";
      },
      {},
      { pid: null, backendStart: null, role: null },
    ],
    [
      "a pool user other than the backend's role",
      (state) => {
        poolOf(state).user = "synthetic_other_role";
      },
      {},
      { pid: true, backendStart: true, role: false },
    ],
    [
      "a pooled read naming another PID",
      (state) => {
        state.pooled.pid = 4999;
      },
      {},
      { pid: false, backendStart: true, role: true },
    ],
    [
      "a recycled PID whose listed backend started at another time",
      (state) => {
        state.pooled.backendStart = RECYCLED_START;
      },
      {},
      { pid: true, backendStart: false, role: true },
    ],
    [
      "a failed pooled connection",
      (state) => {
        state.pooled.fail = true;
      },
      {},
      { pid: null, backendStart: null, role: true },
    ],
  ])("refuses pooler for %s", async (_, mutate, overrides, poolMatch) => {
    const state = world();
    mutate(state);
    const { result, fields } = await capture(state, overrides);
    const sessions = fields["writers.session"];
    expect(sessionItem(fields, POOLER_PID)).toMatchObject({
      poolMatch,
      classification: "unknown",
      revisions: [],
      containsFloor: null,
    });
    expect(sessions.items.every((item) => item.classification === "unknown")).toBe(true);
    // The census stays complete: an unattributed backend is listed as unknown, never dropped.
    expect(sessions).toMatchObject({ collected: 2, authoritativeTotal: 2 });
    expect(applyProviderCapture(jobPacket(FLOOR, MERGED_AT), result)).toMatchObject({
      verdict: "complete",
      errors: [],
    });
  });

  it("refuses host-only inference: a pool endpoint equal to the backend's address proves nothing", async () => {
    const state = world();
    poolOf(state).host = CLIENT_ADDRESS;
    const { fields, record } = await capture(state, {}, { caPath: undefined });
    const sessions = fields["writers.session"];
    expect(record.pooledUrls).toEqual([]);
    expect(isGovernedUnknown(sessions.pooledRead)).toBe(true);
    expect(sessions.pooledRead.missingAuthority).toBe(`${POOLED_READ_SOURCE}: ca-missing`);
    expect(sessions.pooledRead.hostAction).toContain("export PGSSLROOTCERT");
    const pooler = sessionItem(fields, POOLER_PID);
    expect(pooler).toMatchObject({
      classification: "unknown",
      poolMatch: { pid: null, backendStart: null, role: true },
    });
    expect(sessions.pool.value.hostDigest).not.toBe(pooler.clientAddressDigest);
  });

  it("refuses the capture when the pooled transaction is writable", async () => {
    const state = world();
    state.pooled.readOnly = "off";
    await expect(capture(state)).rejects.toThrow(new CaptureRefusal("database-session-writable"));
  });

  it("keeps the pool identity to its allowlist and never persists the pulled state", async () => {
    const { result } = await capture();
    expect(Object.keys(result.fields["writers.session"].pool.value)).toEqual([
      "context",
      "name",
      "mode",
      "size",
      "hostDigest",
      "userDigest",
    ]);
    const text = JSON.stringify(result);
    for (const raw of [POOL_HOST, POOL_USER, PASSWORD, PASSWORD_URL, CA_PATH, "db_name", "verify-full"]) {
      expect(text).not.toContain(raw);
    }
  });

  it.each([
    "BEGIN",
    "BEGIN READ WRITE",
    "COMMIT",
    "SET TRANSACTION READ WRITE",
    "SELECT pg_terminate_backend(4242)",
    SESSION_ROWS_SQL,
  ])("admits only the closed pooled read, refusing %s", (sql) => {
    for (const admitted of POOLED_READ_SQL) expect(() => admitPooledStatement(admitted)).not.toThrow();
    expect(() => admitPooledStatement(sql)).toThrow(new CaptureRefusal("statement-refused"));
  });
});

describe("holder-census", () => {
  it("reconciles every staging holder against independent totals, with explicit exclusions", async () => {
    const { fields, record } = await capture();
    const holders = fields["writers.session"].holders;
    expect(holderIds(fields)).toEqual(STAGING_HOLDERS);
    expect(holders).toMatchObject({ collected: 10, authoritativeTotal: 10 });
    expect(holders.items).toHaveLength(holders.collected);
    expect(exclusionIds(fields)).toEqual([
      "workflow:.github/workflows/synthetic-catalog.yml#refresh/1 contexts-exclude-collections",
      "jobs:chase-sets-platform/bootstrap direct-bootstrap-credential",
    ]);
    expect(holders.coverage).toEqual({
      workflows: { status: "complete", listed: 4, pooledSteps: 3 },
      runs: {
        [DEPLOY_WORKFLOW]: { status: "complete", listed: 1, executing: 0 },
        [DIGEST_WORKFLOW]: { status: "complete", listed: 2, executing: 1 },
      },
      kubernetes: { status: "complete", listed: 7 },
    });
    const credentialSource = "DATABASE_URL_COLLECTIONS";
    const byId = Object.fromEntries(holders.items.map((item) => [item.id, item]));
    expect(byId["capture:9000000001/1"]).toEqual({
      id: "capture:9000000001/1",
      source: "capture",
      workflow: ".github/workflows/collections-cutover-authority-capture.yml",
      credentialSource,
      revisions: [HEAD],
      containsFloor: true,
    });
    expect(byId[`workflow:${DEPLOY_WORKFLOW}#deploy-staging/2`]).toEqual({
      id: `workflow:${DEPLOY_WORKFLOW}#deploy-staging/2`,
      workflow: DEPLOY_WORKFLOW,
      job: "deploy-staging",
      step: 2,
      acquisition: "platform-kubernetes-secret",
      contexts: "all",
      target: "staging",
      source: "workflow-step",
      mode: "pooled",
      credentialSource,
      revisions: [HEAD],
      containsFloor: true,
    });
    expect(byId[`workflow:${DIGEST_WORKFLOW}#digest/2`]).toMatchObject({
      acquisition: "export-managed-postgres-authority",
      contexts: "all",
      target: "selectable",
    });
    expect(byId["run:5002/1"]).toEqual({
      id: "run:5002/1",
      workflow: DIGEST_WORKFLOW,
      runId: 5002,
      attempt: 1,
      event: "workflow_dispatch",
      status: "in_progress",
      target: "selectable",
      source: "workflow-run",
      jobIds: [7001],
      credentialSource,
      revisions: [RELEASE],
      containsFloor: true,
    });
    expect(byId["replicasets:chase-sets-platform/api-old"]).toEqual({
      id: "replicasets:chase-sets-platform/api-old",
      source: "kubernetes",
      kind: "rollback",
      credentialSource,
      references: ["secretKeyRef:chase-sets-platform/DATABASE_URL_COLLECTIONS"],
      revisions: [SUB_FLOOR],
      containsFloor: false,
    });
    // The pooler inherits every holder's revision and the census's floor ancestry.
    expect(sessionItem(fields, POOLER_PID)).toMatchObject({
      classification: "pooler",
      revisions: [RELEASE, SUB_FLOOR, HEAD],
      containsFloor: false,
    });
    expect(record.requests).toEqual([
      runsUrl("synthetic-deploy.yml"),
      runsUrl("synthetic-digest.yml"),
      jobsUrl(5002, 1),
    ]);
    for (const url of record.requests) expect(() => admitRequest(url, REPOSITORY)).not.toThrow();
  });

  it("maps a scheduled run to the default staging target and a manually dispatched run to either target", async () => {
    const state = world();
    state.github.runs["synthetic-digest.yml"].items.push({
      id: 5003,
      run_attempt: 1,
      status: "queued",
      event: "schedule",
      head_sha: RELEASE,
    });
    state.github.jobs["5003/1"] = [{ id: 7003, name: "Build Synthetic Digest" }];
    const staging = await capture(state);
    expect(holderIds(staging.fields)).toEqual(expect.arrayContaining(["run:5002/1", "run:5003/1"]));
    expect(staging.fields["writers.session"].holders.items.find((item) => item.id === "run:5003/1")).toMatchObject({
      event: "schedule",
      target: "staging",
      jobIds: [7003],
    });
    const production = await capture(state, {}, { target: "production" });
    expect(holderIds(production.fields)).toEqual([
      "capture:9000000001/1",
      `workflow:${DIGEST_WORKFLOW}#digest/2`,
      "run:5002/1",
      ...KUBERNETES_HOLDERS,
    ]);
    expect(exclusionIds(production.fields)).toEqual([
      "workflow:.github/workflows/synthetic-catalog.yml#refresh/1 contexts-exclude-collections",
      `workflow:${DEPLOY_WORKFLOW}#deploy-staging/2 target-mismatch`,
      "run:5003/1 target-mismatch",
      "jobs:chase-sets-platform/bootstrap direct-bootstrap-credential",
    ]);
    expect(production.record.requests).toEqual([runsUrl("synthetic-digest.yml"), jobsUrl(5002, 1)]);
  });

  it("binds a stale rerun to the head and attempt it executes, never to current main", async () => {
    const state = world();
    state.kube.replicasets.pages = [state.kube.replicasets.pages[0]];
    const fresh = await capture(state);
    expect(sessionItem(fresh.fields, POOLER_PID)).toMatchObject({ classification: "pooler", containsFloor: true });
    state.github.runs["synthetic-digest.yml"].items.push({
      id: 5004,
      run_attempt: 2,
      status: "in_progress",
      event: "schedule",
      head_sha: SUB_FLOOR,
    });
    state.github.jobs["5004/1"] = [{ id: 7008, name: "Build Synthetic Digest" }];
    state.github.jobs["5004/2"] = [{ id: 7009, name: "Build Synthetic Digest" }];
    const { fields, record } = await capture(state);
    const rerun = fields["writers.session"].holders.items.find((item) => item.id === "run:5004/2");
    expect(rerun).toMatchObject({ attempt: 2, jobIds: [7009], revisions: [SUB_FLOOR], containsFloor: false });
    expect(record.requests).toContain(jobsUrl(5004, 2));
    expect(record.requests).not.toContain(jobsUrl(5004, 1));
    expect(sessionItem(fields, POOLER_PID)).toMatchObject({
      classification: "pooler",
      revisions: [RELEASE, SUB_FLOOR, HEAD],
      containsFloor: false,
    });
  });

  it("binds an executing run whose owning job already succeeded to that job and its head", async () => {
    const state = world();
    Object.assign(state.github.jobs["5002/1"][0], { status: "completed", conclusion: "success" });
    const { fields } = await capture(state);
    expect(fields["writers.session"].holders.items.find((item) => item.id === "run:5002/1")).toMatchObject({
      jobIds: [7001],
      revisions: [RELEASE],
      containsFloor: true,
    });
    expect(sessionItem(fields, POOLER_PID)).toMatchObject({ classification: "pooler" });
  });

  it("lists a newly found pooled holder and an unresolved-context holder instead of omitting them", async () => {
    const state = world();
    state.workflows[".github/workflows/synthetic-new.yml"] = `name: Synthetic New
on:
  workflow_dispatch: {}
jobs:
  export:
    runs-on: ubuntu-latest
    env:
      TERRAFORM_STATE_DATABASE_URL_CONNECTION_MODE: pooled
    steps:
      - run: node scripts/terraform-state-database-urls.mjs --contexts collections --environment staging
  widen:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/export-managed-postgres-authority
        with:
          environment: staging
          contexts: \${{ inputs.contexts }}
          connection-mode: pooled
`;
    const { fields, record } = await capture(state);
    const found = fields["writers.session"].holders.items.filter((item) =>
      item.workflow?.endsWith("synthetic-new.yml"),
    );
    expect(found).toEqual([
      expect.objectContaining({
        id: "workflow:.github/workflows/synthetic-new.yml#export/1",
        acquisition: "terraform-state-database-urls",
        contexts: "collections",
        target: "staging",
      }),
      expect.objectContaining({
        id: "workflow:.github/workflows/synthetic-new.yml#widen/1",
        acquisition: "export-managed-postgres-authority",
        contexts: "unresolved",
      }),
    ]);
    expect(record.requests).toContain(runsUrl("synthetic-new.yml"));
    expect(fields["writers.session"].holders.coverage.runs).toHaveProperty([".github/workflows/synthetic-new.yml"]);
  });

  it.each([
    [
      "a run page missing one run",
      "census-mismatch",
      (state) => {
        state.github.runs["synthetic-digest.yml"].total = 3;
      },
      {},
    ],
    [
      "a run census past the page bound",
      "run-page-bound",
      (state) => {
        state.github.runs["synthetic-digest.yml"].total = 100 * MAX_RUN_PAGES + 1;
      },
      {},
    ],
    [
      "an unregistered holder workflow",
      "workflow-unregistered",
      (state) => {
        state.github.runs["synthetic-deploy.yml"] = { fail: "not-found" };
      },
      {},
    ],
    [
      "a rate-limited run list",
      "rate-limited",
      (state) => {
        state.github.runs["synthetic-digest.yml"] = { fail: "rate-limited" };
      },
      {},
    ],
    [
      "a reusable workflow holding the pooled credential",
      "reusable-holder",
      (state) => {
        state.workflows[DIGEST_WORKFLOW] = state.workflows[DIGEST_WORKFLOW].replace(
          "  workflow_dispatch:\n",
          "  workflow_call: {}\n  workflow_dispatch:\n",
        );
      },
      {},
    ],
    [
      "an unparsed workflow",
      "workflow-unparsed",
      (state) => {
        state.workflows[".github/workflows/synthetic-broken.yml"] = "jobs: [unclosed";
      },
      {},
    ],
    ["a capture outside GitHub Actions", "repository", () => {}, { repository: undefined }],
    [
      "an executing run without a head commit",
      "run-head-malformed",
      (state) => {
        delete state.github.runs["synthetic-digest.yml"].items[1].head_sha;
      },
      {},
    ],
    [
      "a settled run whose head is not a commit",
      "run-head-malformed",
      (state) => {
        state.github.runs["synthetic-digest.yml"].items[0].head_sha = "not-a-commit";
      },
      {},
    ],
    [
      "an attempt job list naming another run",
      "run:5002/1: job-identity",
      (state) => {
        state.github.jobs["5002/1"][0].run_id = 5001;
      },
      {},
    ],
    [
      "an attempt job list naming another attempt",
      "run:5002/1: job-identity",
      (state) => {
        state.github.jobs["5002/1"][0].run_attempt = 2;
      },
      {},
    ],
    [
      "an attempt job executing another head",
      "run:5002/1: job-identity",
      (state) => {
        state.github.jobs["5002/1"][0].head_sha = PRIOR;
      },
      {},
    ],
    [
      "an attempt job without an id",
      "run:5002/1: job-identity",
      (state) => {
        delete state.github.jobs["5002/1"][0].id;
      },
      {},
    ],
    [
      "a completed job without a conclusion",
      "run:5002/1: job-identity",
      (state) => {
        state.github.jobs["5002/1"][1].conclusion = null;
      },
      {},
    ],
    [
      "a truncated attempt job list",
      "run:5002/1: census-mismatch",
      (state) => {
        state.github.jobs["5002/1"] = { total: 3, items: state.github.jobs["5002/1"] };
      },
      {},
    ],
    [
      "an attempt job list past one page",
      "run:5002/1: jobs-page-bound",
      (state) => {
        state.github.jobs["5002/1"] = { total: 101, items: state.github.jobs["5002/1"] };
      },
      {},
    ],
    [
      "a forbidden attempt job list",
      "run:5002/1: github-forbidden",
      (state) => {
        state.github.jobs["5002/1"] = { fail: "github-forbidden" };
      },
      {},
    ],
    [
      "one job id listed twice",
      "run:5002/1: census-duplicate",
      (state) => {
        state.github.jobs["5002/1"].push({ id: 7002, name: "Synthetic Other", status: "queued" });
      },
      {},
    ],
    [
      "a templated owning-job name",
      "run:5002/1: job-name-unresolved",
      (state) => {
        state.workflows[DIGEST_WORKFLOW] = state.workflows[DIGEST_WORKFLOW].replace(
          "name: Build Synthetic Digest",
          `name: Build \${{ inputs.environment }}`,
        );
        state.github.jobs["5002/1"][0].name = "Build staging";
      },
      {},
    ],
    [
      "an executing run without its owning job",
      "run:5002/1: owning-job-missing",
      (state) => {
        state.github.jobs["5002/1"][0].name = "Build linux";
      },
      {},
    ],
    [
      "an owning job listed twice",
      "run:5002/1: owning-job-ambiguous",
      (state) => {
        state.github.jobs["5002/1"].push({ id: 7012, name: "Build Synthetic Digest", status: "queued" });
      },
      {},
    ],
    [
      "a skipped owning job",
      "run:5002/1: owning-job-skipped",
      (state) => {
        Object.assign(state.github.jobs["5002/1"][0], { status: "completed", conclusion: "skipped" });
      },
      {},
    ],
    [
      "a red owning job",
      "run:5002/1: owning-job-red",
      (state) => {
        Object.assign(state.github.jobs["5002/1"][0], { status: "completed", conclusion: "failure" });
      },
      {},
    ],
  ])("%s leaves the holder census unknown and every backend unattributed", async (_, reason, mutate, options) => {
    const state = world();
    mutate(state);
    const { result, fields } = await capture(state, {}, options);
    const holders = fields["writers.session"].holders;
    expect(isGovernedUnknown(holders)).toBe(true);
    expect(holders.missingAuthority).toContain(reason);
    expect(sessionItem(fields, POOLER_PID)).toMatchObject({
      poolMatch: { pid: true, backendStart: true, role: true },
      classification: "unknown",
      revisions: [],
      containsFloor: null,
    });
    expect(applyProviderCapture(jobPacket(FLOOR, MERGED_AT), result).errors).toEqual([]);
  });

  it("keeps holder evidence secret-free and limited to allowlisted run metadata", async () => {
    const state = world();
    state.github.runs["synthetic-digest.yml"].items.push({
      id: 5005,
      run_attempt: 1,
      status: "waiting",
      event: `push ${TOKEN}`,
      head_sha: RELEASE,
      name: PASSWORD_URL,
      actor: { login: POOL_USER },
    });
    state.github.jobs["5005/1"] = [{ id: 7011, name: "Build Synthetic Digest", runner_name: TOKEN }];
    const { exitCode, capture: written, emitted } = await throughEntrypoint(state, { GITHUB_RUN_ID: "" });
    expect(exitCode).toBe(0);
    const holders = written.fields["writers.session"].holders;
    expect(holders.items[0]).toMatchObject({ id: "capture:unbound", revisions: [HEAD] });
    const run = holders.items.find((item) => item.id === "run:5005/1");
    expect(Object.keys(run).sort()).toEqual(
      [
        "attempt",
        "containsFloor",
        "credentialSource",
        "event",
        "id",
        "jobIds",
        "revisions",
        "runId",
        "source",
        "status",
        "target",
        "workflow",
      ].sort(),
    );
    expect(run).toMatchObject({ event: "unnamed", jobIds: [7011] });
    for (const raw of [...CANARIES, ...RAW_IDENTITIES, CA_PATH]) expect(emitted).not.toContain(raw);
  });

  // One staging capture over every real workflow at head, shared by the assertions below; the production mapping of
  // a fixed-staging step is the synthetic test above.
  describe("over the real workflows at capture head", () => {
    let real;
    beforeAll(async () => {
      const state = world();
      state.workflows = Object.fromEntries(workflowFiles(REPO_ROOT).map(({ path, text }) => [path, text]));
      real = await capture(state);
    });

    it("finds the slow-query digest, growth evidence and staging deploy holders with their targets", () => {
      const steps = real.fields["writers.session"].holders.items.filter((item) => item.source === "workflow-step");
      expect(steps.map((item) => item.id)).toEqual([
        expect.stringMatching(
          /^workflow:\.github\/workflows\/platform-postgres-growth-evidence\.yml#growth-evidence\/\d+$/,
        ),
        expect.stringMatching(
          /^workflow:\.github\/workflows\/platform-postgres-slow-query-digest\.yml#slow-query-digest\/\d+$/,
        ),
        expect.stringMatching(/^workflow:\.github\/workflows\/platform-production\.yml#deploy-staging\/\d+$/),
      ]);
      expect(steps.map((item) => [item.workflow, item.target, item.contexts, item.mode])).toEqual([
        [".github/workflows/platform-postgres-growth-evidence.yml", "selectable", "all", "pooled"],
        [".github/workflows/platform-postgres-slow-query-digest.yml", "selectable", "all", "pooled"],
        [".github/workflows/platform-production.yml", "staging", "all", "pooled"],
      ]);
      expect(sessionItem(real.fields, POOLER_PID).classification).toBe("pooler");
    });

    it("lists the catalog-only pooled consumers as explicit exclusions", () => {
      expect(exclusionIds(real.fields).filter((id) => id.startsWith("workflow:"))).toEqual([
        expect.stringMatching(
          /^workflow:\.github\/workflows\/catalog-integration-staging-reset\.yml#[a-z0-9-]+\/\d+ contexts-exclude-collections$/,
        ),
        expect.stringMatching(
          /^workflow:\.github\/workflows\/catalog-provider-refresh-watch\.yml#[a-z0-9-]+\/\d+ contexts-exclude-collections$/,
        ),
      ]);
    });
  });

  it("reads GitHub with unauthenticated GETs and closed failure reasons", async () => {
    const calls = [];
    const respond = (status, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      text: async () => `{"echo":"${TOKEN}"}`,
    });
    const outcomes = [
      [respond(200), { ok: true, stdout: `{"echo":"${TOKEN}"}` }],
      [respond(429), { ok: false, reason: "rate-limited" }],
      [respond(403, { "x-ratelimit-remaining": "0" }), { ok: false, reason: "rate-limited" }],
      [respond(403), { ok: false, reason: "github-forbidden" }],
      [respond(404), { ok: false, reason: "not-found" }],
      [respond(500), { ok: false, reason: "failed" }],
      [Object.assign(new Error(TOKEN), { name: "TimeoutError" }), { ok: false, reason: "timeout" }],
      [new Error(PASSWORD_URL), { ok: false, reason: "failed" }],
    ];
    for (const [response, expected] of outcomes) {
      const read = githubReadRunner(async (url, init) => {
        calls.push([url, init]);
        if (response instanceof Error) throw response;
        return response;
      });
      expect(await read(runsUrl("synthetic-digest.yml"))).toEqual(expected);
    }
    for (const [, init] of calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(Object.keys(init.headers).map((key) => key.toLowerCase())).not.toContain("authorization");
    }
  });

  it.each([
    "https://api.github.com/repos/synthetic-owner/synthetic-repo/actions/runs/5002/cancel",
    "https://api.github.com/repos/synthetic-owner/synthetic-repo/actions/runs/5002/force-cancel",
    "https://api.github.com/repos/synthetic-owner/synthetic-repo/actions/runs/5002/rerun",
    "https://api.github.com/repos/synthetic-owner/synthetic-repo/actions/workflows/synthetic-digest.yml/disable",
    "https://api.github.com/repos/synthetic-owner/synthetic-repo/actions/secrets",
    "https://api.github.com/repos/other-owner/other-repo/actions/runs/5002/attempts/1/jobs?per_page=100",
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/synthetic-digest.yml/runs?per_page=100&created=%3E%3D2029-12-03&page=${MAX_RUN_PAGES + 1}`,
    "https://api.example.invalid/repos/synthetic-owner/synthetic-repo/actions/runs/5002/attempts/1/jobs?per_page=100",
  ])("refuses the off-allowlist GitHub request %s", (url) => {
    expect(() => admitRequest(url, REPOSITORY)).toThrow(new CaptureRefusal("request-refused"));
  });
});

describe("capture-consumers", () => {
  it("traces the census query through the artifact and its session evidence into the packet consumer", async () => {
    const { exitCode, capture: written, record } = await throughEntrypoint();
    expect(exitCode).toBe(0);
    expect(record.statements.filter((sql) => sql === SESSION_ROWS_SQL)).toHaveLength(1);
    expect(record.pooledStatements).toEqual([...POOLED_READ_SQL]);
    const sessions = written.fields["writers.session"];
    expect(Object.keys(sessions)).toEqual([
      "collected",
      "authoritativeTotal",
      "items",
      "coverage",
      "source",
      "pool",
      "pooledRead",
      "holders",
    ]);
    expect(sessions.items.map((item) => [item.id, item.classification])).toEqual([
      [`backend:${POOLER_PID}`, "pooler"],
      [`backend:${RUNNER_PID}`, "unknown"],
    ]);
    expect(sessions.holders.items[0]).toMatchObject({ id: "capture:9000000001/1", revisions: [HEAD] });
    const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), written);
    expect(applied).toMatchObject({ verdict: "complete", errors: [], missing: [] });
    expect(applied.packet.writerAuthority.targets.staging.writers.session).toEqual(sessions);
  });

  it("without the Collections database no session, pooled read or holder evidence is claimed", async () => {
    const { exitCode, capture: written, record } = await throughEntrypoint(world(), { DATABASE_URL_COLLECTIONS: "" });
    expect(exitCode).toBe(0);
    const sessions = written.fields["writers.session"];
    expect(isGovernedUnknown(sessions)).toBe(true);
    expect(sessions.missingAuthority).toBe(`${SESSION_SOURCE}: connection-failed`);
    expect(record.pooledUrls).toEqual([]);
    expect(record.requests).toEqual([]);
    const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), written);
    expect(applied).toMatchObject({ verdict: "bounded-unknown", errors: [] });
    expect(applied.missing.map((entry) => entry.field)).toContain("writers.session");
  });

  it.each([
    ["PGSSLROOTCERT", { PGSSLROOTCERT: "" }, "pooledRead", "ca-missing"],
    ["GITHUB_REPOSITORY", { GITHUB_REPOSITORY: "" }, "holders", "repository"],
  ])("without %s the pooler stays unknown and the consumer keeps the governed gap", async (_, env, key, reason) => {
    const { exitCode, capture: written } = await throughEntrypoint(world(), env);
    expect(exitCode).toBe(0);
    const sessions = written.fields["writers.session"];
    expect(isGovernedUnknown(sessions[key])).toBe(true);
    expect(sessions[key].missingAuthority).toContain(reason);
    expect(sessions.items.every((item) => item.classification === "unknown")).toBe(true);
    const applied = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), written);
    expect(applied.errors).toEqual([]);
    expect(applied.packet.writerAuthority.targets.staging.writers.session[key]).toEqual(sessions[key]);
  });

  it("refuses a forged pooler and folds an aggregate-only capture as a governed unknown", async () => {
    const { capture: written } = await throughEntrypoint();
    const forged = structuredClone(written);
    forged.fields["writers.session"].items[1].classification = "pooler";
    expect(applyProviderCapture(jobPacket(FLOOR, MERGED_AT), forged)).toMatchObject({
      verdict: "invalid",
      errors: ["staging|writers.session|pooler-unproven"],
    });
    const aggregate = structuredClone(written);
    aggregate.fields["writers.session"] = {
      collected: 1,
      authoritativeTotal: 1,
      items: [
        {
          id: "session:1",
          state: "idle",
          backendType: "client backend",
          roleDigest: roleDigest(POOL_USER),
          applicationDigest: sha256Hex("collections-session-application/v1\u0000"),
          sessions: 1,
          oldestBackendStart: POOLER_START.toISOString(),
        },
      ],
      coverage: { sessions: { status: "complete", listed: 1 } },
      source: AGGREGATE_SESSION_SOURCE,
    };
    const folded = applyProviderCapture(jobPacket(FLOOR, MERGED_AT), aggregate);
    expect(folded).toMatchObject({ verdict: "bounded-unknown", errors: [] });
    expect(folded.missing).toEqual([
      expect.objectContaining({ field: "writers.session", reason: "session-evidence-aggregate" }),
    ]);
    expect(folded.packet.writerAuthority.targets.staging.writers.session).toMatchObject({ status: "unknown" });
  });

  it("keeps the 22 capture fields, the envelope and every other writer category unchanged", async () => {
    const { capture: written } = await throughEntrypoint();
    expect(Object.keys(written)).toEqual(["schemaVersion", "target", "capturedAt", "head", "codes", "fields"]);
    expect(PROVIDER_CAPTURE_FIELDS).toHaveLength(22);
    expect(Object.keys(written.fields)).toEqual([...PROVIDER_CAPTURE_FIELDS]);
    for (const kind of ["serving", "suspended", "dormant", "rollback", "job", "cronjob"]) {
      expect(Object.keys(written.fields[`writers.${kind}`]), kind).toEqual([
        "collected",
        "authoritativeTotal",
        "items",
        "coverage",
        "source",
      ]);
    }
  });
});

describe("no-termination", () => {
  it("corroborates an hourly recycle across two offline captures with a stable pool identity", async () => {
    const first = await capture();
    const recycled = world();
    recycled.db.sessions[0] = { ...recycled.db.sessions[0], pid: 4243, backend_start: RECYCLED_START };
    recycled.pooled = { pid: 4243, backendStart: RECYCLED_START, readOnly: "on" };
    const second = await capture(recycled);
    const [before, after] = [first, second].map(({ fields }) => fields["writers.session"]);
    expect(after.pool).toEqual(before.pool);
    const seconds =
      (Date.parse(after.pooledRead.value.backendStart) - Date.parse(before.pooledRead.value.backendStart)) / 1000;
    expect(seconds).toBeCloseTo(3603.6, 1);
    // Each capture classifies only the backend its own same-run read names; neither inherits the other's.
    expect(sessionItem(first.fields, POOLER_PID).classification).toBe("pooler");
    expect(sessionItem(second.fields, 4243).classification).toBe("pooler");
    expect(sessionItem(second.fields, POOLER_PID)).toBeUndefined();
    // A historical aggregate capture stays unclassified however its backend starts line up.
    const historical = structuredClone(first.result);
    historical.fields["writers.session"] = {
      collected: 1,
      authoritativeTotal: 1,
      items: [{ id: "session:1", sessions: 1, oldestBackendStart: POOLER_START.toISOString() }],
      coverage: { sessions: { status: "complete", listed: 1 } },
      source: AGGREGATE_SESSION_SOURCE,
    };
    expect(applyProviderCapture(jobPacket(FLOOR, MERGED_AT), historical).missing).toEqual([
      expect.objectContaining({ field: "writers.session", reason: "session-evidence-aggregate" }),
    ]);
  });

  it.each([
    [
      "role-only",
      (state) => {
        state.pooled.fail = true;
      },
    ],
    [
      "disappearance",
      (state) => {
        // The pooled read's backend is gone from the census taken after it; the same-role runner remains.
        state.db.sessions = state.db.sessions.filter((session) => session.pid !== POOLER_PID);
      },
    ],
    [
      "recycle-only",
      (state) => {
        // A same-role backend that started one recycle after the old pooler, with no same-run read naming it.
        state.db.sessions[0] = { ...state.db.sessions[0], pid: 4243, backend_start: RECYCLED_START };
      },
    ],
  ])("refuses %s attribution and leaves every backend unknown", async (_, mutate) => {
    const state = world();
    mutate(state);
    const { fields } = await capture(state);
    const sessions = fields["writers.session"];
    expect(sessions.items.length).toBeGreaterThan(0);
    expect(sessions.items.every((item) => item.roleDigest === roleDigest(POOL_USER))).toBe(true);
    expect(sessions.items.every((item) => item.classification === "unknown" && item.revisions.length === 0)).toBe(true);
  });

  it("has no termination, cancellation, signal or disablement path by source guard", () => {
    const termination =
      /pg_terminate_backend|pg_cancel_backend|process\.kill\s*\(|\.kill\s*\(|\bSIG(?:TERM|KILL|INT|HUP)\b|ALTER\s+(?:ROLE|USER)|NOLOGIN|REVOKE\s|DROP\s+(?:ROLE|USER)|\bdoctl\b|connection[-_]pool[\s\S]{0,40}delete|method:\s*"(?:POST|PUT|PATCH|DELETE)"/i;
    for (const file of ["collections-cutover-authority-capture.mjs", "collections-cutover-authority-packet.mjs"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(termination.exec(source)?.[0] ?? null, file).toBeNull();
    }
    expect(workflowSource).not.toMatch(
      /pg_terminate_backend|pg_cancel_backend|doctl\s+databases|kubectl\s+(?:delete|scale|patch)/,
    );
    for (const sql of [
      "SELECT pg_terminate_backend(4242)",
      "SELECT pg_cancel_backend(4242)",
      "ALTER ROLE synthetic_collections_role NOLOGIN",
      "REVOKE CONNECT ON DATABASE collections FROM synthetic_collections_role",
    ]) {
      expect(() => admitStatement(sql, legacyAnonymousOwnerCountSql, anonymousOwnerObservationSql)).toThrow(
        "statement-refused",
      );
      expect(() => admitPooledStatement(sql)).toThrow("statement-refused");
    }
    expect(() => admitCommand("doctl", ["databases", "pool", "delete", "cluster", "collections-runtime"])).toThrow(
      "command-refused",
    );
  });
});
