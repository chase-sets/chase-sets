import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Client } from "pg";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const equals = value.indexOf("=");
  if (equals === -1) {
    args.set(value.slice(2), process.argv[index + 1]);
    index += 1;
  } else {
    args.set(value.slice(2, equals), value.slice(equals + 1));
  }
}

const leg = args.get("leg");
const concurrency = args.get("concurrency");
const workspaceList = args.get("workspace-list") ?? "";
const artifactDir = args.get("artifact-dir") ?? `${process.env.RUNNER_TEMP}/db-profile-probe/${leg}`;
if (!new Set(["api", "other"]).has(leg)) throw new Error(`invalid DB profile leg: ${leg}`);
if (concurrency !== (leg === "api" ? "2" : "3")) throw new Error(`unexpected ${leg} concurrency: ${concurrency}`);
if (workspaceList !== "") throw new Error("affected_workspaces must be empty for this probe");
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");

await mkdir(artifactDir, { recursive: true });
const startedAt = Date.now();
const childLogPath = `${artifactDir}/child-${leg}.log`;
const monitorLogPath = `${artifactDir}/monitor-${leg}.log`;
const samplesPath = `${artifactDir}/demand-samples-${leg}.csv`;
const preSettingsPath = `${artifactDir}/settings-pre-${leg}.txt`;
const postSettingsPath = `${artifactDir}/settings-post-${leg}.txt`;
const partitionPath = `${artifactDir}/partition-ledger.json`;
const sampleLedgerPath = `${artifactDir}/sample-ledger.json`;
const signalPath = `${artifactDir}/signal-grep.txt`;
const workflowReceiptPath = `${artifactDir}/workflow-receipt.json`;

const childLines = [];
const partitions = [];
const pendingWrites = [];
let currentPartition;
const appendLine = async (path, line) => {
  await appendFile(path, `${line}\n`);
};
const timestamp = () => new Date().toISOString();
const recordChild = (line) => {
  const stamped = `${timestamp()} ${line}`;
  childLines.push(stamped);
  pendingWrites.push(appendLine(childLogPath, stamped));
  const running = line.match(/^Running (.+) in (.+)\.\.\.$/);
  if (running) {
    if (currentPartition) currentPartition.endedAt = timestamp();
    currentPartition = {
      leg,
      workspace: running[2],
      script: running[1],
      role: /seed/i.test(running[2]) ? "seed" : leg === "api" ? "api" : "unrelated",
      startedAt: timestamp(),
      endedAt: null,
      complete: false,
    };
    partitions.push(currentPartition);
  }
  if (line.startsWith("RUN_WORKSPACES_SUMMARY ") && currentPartition) {
    currentPartition.endedAt = timestamp();
    currentPartition.complete = true;
    currentPartition.summary = line.slice("RUN_WORKSPACES_SUMMARY ".length);
    currentPartition = undefined;
  }
};

const monitor = new Client({ connectionString: process.env.TEST_DATABASE_URL });
await monitor.connect();
const settings = async (path) => {
  const result = await monitor.query(
    "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections','reserved_connections') ORDER BY name",
  );
  await writeFile(path, result.rows.map(({ name, setting }) => `${name}=${setting}`).join("\n") + "\n");
  return Object.fromEntries(result.rows.map(({ name, setting }) => [name, Number(setting)]));
};
const pre = await settings(preSettingsPath);
const cLeg = pre.max_connections - pre.superuser_reserved_connections - pre.reserved_connections;

const csv = ["timestamp,datname,state,wait_event_type,clients,partition,workspace,role,total_clients"];
const samples = [];
let monitorError;
let sampling = true;
let sampleInFlight = Promise.resolve();
const sample = async () => {
  if (!sampling && samples.length > 0) return;
  try {
    const result = await monitor.query(
      "SELECT datname, state, wait_event_type, count(*)::integer AS clients FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() GROUP BY datname, state, wait_event_type ORDER BY datname, state, wait_event_type",
    );
    const at = timestamp();
    const total = result.rows.reduce((sum, row) => sum + Number(row.clients), 0);
    for (const row of result.rows) {
      const role = row.datname === "postgres" ? "admin" : currentPartition?.role ?? "unattributed";
      const workspace = currentPartition?.workspace ?? "";
      const partition = currentPartition?.script ?? "";
      csv.push(
        [at, row.datname ?? "", row.state ?? "", row.wait_event_type ?? "", row.clients, partition, workspace, role, total]
          .map((value) => JSON.stringify(String(value)))
          .join(","),
      );
    }
    samples.push({ timestamp: at, total, rows: result.rows });
  } catch (error) {
    monitorError = String(error);
  }
};
await sample();
const interval = setInterval(() => {
  sampleInFlight = sampleInFlight.then(() => sample());
}, 500);

// This is the unchanged shipped command from platform-pr.yml:385-386.
const child = spawn(
  "node",
  [
    "./scripts/run-workspaces.mjs",
    "test:db*",
    `--concurrency=${concurrency}`,
    `--workspace-list=${workspaceList}`,
    `--db-workspace-group=${leg}`,
  ],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [child.stdout, child.stderr]) {
  const lines = createInterface({ input: stream });
  lines.on("line", recordChild);
}
const childExit = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
});
await new Promise((resolve) => setTimeout(resolve, 50));
sampling = false;
clearInterval(interval);
await sampleInFlight;
sampling = true;
await sample();
sampling = false;
const post = await settings(postSettingsPath);
await monitor.end();
await writeFile(samplesPath, `${csv.join("\n")}\n`);
await Promise.all(pendingWrites);
await writeFile(
  workflowReceiptPath,
  JSON.stringify(
    {
      leg,
      run_id: process.env.GITHUB_RUN_ID ?? null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      job: process.env.GITHUB_JOB ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      ref: process.env.GITHUB_REF ?? null,
      event_name: process.env.GITHUB_EVENT_NAME ?? null,
      head_ref: process.env.GITHUB_HEAD_REF ?? null,
      base_ref: process.env.GITHUB_BASE_REF ?? null,
    },
    null,
    2,
  ) + "\n",
);

const gaps = samples.slice(1).flatMap((value, index) => {
  const previous = Date.parse(samples[index].timestamp);
  const current = Date.parse(value.timestamp);
  return current - previous > 2000 ? [{ from: samples[index].timestamp, to: value.timestamp, milliseconds: current - previous }] : [];
});
const summary = {
  leg,
  concurrency: Number(concurrency),
  workspaceList,
  command: `node ./scripts/run-workspaces.mjs "test:db*" --concurrency="$DB_WORKSPACE_CONCURRENCY" --workspace-list="${workspaceList}" --db-workspace-group=${leg}`,
  cLeg,
  settingsPre: pre,
  settingsPost: post,
  settingsExpected: { max_connections: 300, superuser_reserved_connections: 3, reserved_connections: 0 },
  settingsMatch:
    pre.max_connections === 300 && pre.superuser_reserved_connections === 3 && pre.reserved_connections === 0 &&
    post.max_connections === 300 && post.superuser_reserved_connections === 3 && post.reserved_connections === 0,
  monitorError: monitorError ?? null,
  sampleCount: samples.length,
  gaps,
  maxSampledTotal: Math.max(0, ...samples.map(({ total }) => total)),
  partitions,
  childExit,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: timestamp(),
};
await writeFile(partitionPath, JSON.stringify({ leg, partitions }, null, 2) + "\n");
await writeFile(sampleLedgerPath, JSON.stringify(summary, null, 2) + "\n");

const runtimeSource = await readFile("infrastructure/bounded-context-runtime/test-support.ts", "utf8");
const seedSource = await readFile("deployables/marketplace-seed-testing/index.ts", "utf8");
const knownContexts = [...new Set([...runtimeSource.matchAll(/contextName(?:s)?[^\n]*?['\"]([a-z0-9-]+)['\"]/gi), ...seedSource.matchAll(/['\"]([a-z0-9-]+)['\"]/g)].map((match) => match[1]))];
await writeFile(
  `${artifactDir}/scope-table.json`,
  JSON.stringify(
    {
      source: ["infrastructure/bounded-context-runtime/test-support.ts", "deployables/platform-api/__tests__/bootstrap-db-test-support.ts", "deployables/marketplace-seed-testing/index.ts"],
      nameFormula: "normalizedScope_normalizedContext_uuid8",
      adminDatname: "postgres",
      knownContexts,
      observedDatnames: [...new Set(samples.flatMap(({ rows }) => rows.map(({ datname }) => datname).filter(Boolean)))],
    },
    null,
    2,
  ) + "\n",
);

const signalPatterns = [
  ["server_53300", /53300/g],
  ["server_too_many_clients", /too many clients/gi],
  ["server_remaining_slots", /remaining connection slots/gi],
  ["client_timeout_exceeded", /timeout exceeded when trying to connect/gi],
  ["client_connection_timeout", /Connection terminated due to connection timeout/gi],
  ["informational_admin_termination", /terminating connection due to administrator command/gi],
];
const signalLines = signalPatterns.map(([name, pattern]) => {
  const matches = childLines.filter((line) => {
    pattern.lastIndex = 0;
    return pattern.test(line);
  });
  return `${name}=${matches.length}\n${matches.join("\n")}`;
});
await writeFile(signalPath, `${signalLines.join("\n")}\n`);
await writeFile(monitorLogPath, JSON.stringify({ leg, samples, monitorError }, null, 2) + "\n");

const manifest = {};
for (const name of [
  childLogPath,
  monitorLogPath,
  samplesPath,
  preSettingsPath,
  postSettingsPath,
  partitionPath,
  sampleLedgerPath,
  signalPath,
  `${artifactDir}/scope-table.json`,
  workflowReceiptPath,
]) {
  const bytes = await readFile(name);
  manifest[name.slice(artifactDir.length + 1)] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
await writeFile(`${artifactDir}/sha256-manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
if (monitorError || childExit.code !== 0) process.exitCode = childExit.code || 1;
