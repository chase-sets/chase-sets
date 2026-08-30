import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { canonicalRefinedInventoryProbeBytes, validateRefinedInventoryProbePayload } from "./roadmap-status.mjs";

const API_ORIGIN = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_MAX_BYTES = 8 * 1024 * 1024;
const CHILD_MAX_BYTES = 1024 * 1024;
const ARCHIVE_MAX_BYTES = 1024 * 1024;
const PAYLOAD_MAX_BYTES = 512 * 1024;
const MAX_PAGES = 10;
const MAX_ITEMS = 999;
const POLL_INTERVAL_MS = 5_000;
const OVERALL_TIMEOUT_MS = 20 * 60 * 1_000;
const PAYLOAD_NAME = "roadmap-refined-inventory-authority-probe.json";
const RECEIPT_NAME = "roadmap-refined-inventory-authority-receipt.json";
const RECEIPT_SCHEMA = "roadmap-refined-inventory-authority-receipt/v1";
const JOB_NAME = "probe-authority";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const RECEIPT_KEYS = [
  "schemaVersion",
  "repository",
  "workflow",
  "job",
  "jobId",
  "ref",
  "headSha",
  "nonce",
  "runId",
  "runAttempt",
  "artifactId",
  "artifactName",
  "artifactDigest",
  "payloadPath",
  "payloadSha256",
  "checkedAt",
];

export class RoadmapAuthorityProbeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RoadmapAuthorityProbeError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new RoadmapAuthorityProbeError(code, message);
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).join("\0") === keys.join("\0")
  );
}

function canonicalInstant(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function runBoundedChild(command, args, { cwd = process.cwd(), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const overflow = (stream) => {
      killProcessTree(child);
      finish(new RoadmapAuthorityProbeError("ROADMAP_AUTHORITY_CHILD_OVERSIZED", `${stream} exceeded 1 MiB.`));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CHILD_MAX_BYTES) return overflow("stdout");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > CHILD_MAX_BYTES) return overflow("stderr");
      stderr.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        finish(
          new RoadmapAuthorityProbeError(
            "ROADMAP_AUTHORITY_CHILD_FAILED",
            `${command} exited ${code ?? signal}: ${result.stderr.slice(0, 1_024)}`,
          ),
        );
      } else finish(null, result);
    });
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new RoadmapAuthorityProbeError("ROADMAP_AUTHORITY_CHILD_TIMEOUT", `${command} exceeded 30 seconds.`));
    }, timeoutMs);
  });
}

async function responseBytes(response, maxBytes, code) {
  if (!response.ok) fail(code, `GitHub request failed with ${response.status}.`);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) fail(code);
    return bytes;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      fail(code);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function createBoundedGitHubClient({ token, fetchImpl = globalThis.fetch }) {
  if (!token) fail("ROADMAP_GITHUB_TOKEN_REQUIRED");
  async function request(pathOrUrl, init = {}, maxBytes = REQUEST_MAX_BYTES) {
    const url = new URL(pathOrUrl, API_ORIGIN);
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) fail("ROADMAP_AUTHORITY_URL_UNSAFE");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          accept: init.accept ?? "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(init.body && typeof init.body !== "string" ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        body: init.body && typeof init.body !== "string" ? JSON.stringify(init.body) : init.body,
        signal: controller.signal,
      });
      const bytes = await responseBytes(response, maxBytes, "ROADMAP_AUTHORITY_RESPONSE_INVALID");
      return { response, bytes };
    } catch (error) {
      if (error?.name === "AbortError") fail("ROADMAP_AUTHORITY_REQUEST_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function json(path, init = {}) {
    const { bytes } = await request(path, init);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ROADMAP_AUTHORITY_JSON_INVALID");
    }
  }
  return { request, json };
}

export async function collectCountedPages(client, path, key) {
  const items = [];
  const identities = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await client.json(`${path}${separator}per_page=100&page=${page}`);
    const rows = payload?.[key];
    if (!nonNegative(payload?.total_count) || !Array.isArray(rows) || rows.length > 100) {
      fail("ROADMAP_AUTHORITY_PAGE_INVALID");
    }
    if (payload.total_count >= 1_000) fail("ROADMAP_AUTHORITY_PROVIDER_LIMIT");
    expectedTotal ??= payload.total_count;
    if (payload.total_count !== expectedTotal) fail("ROADMAP_AUTHORITY_TOTAL_CHANGED");
    for (const row of rows) {
      if (!positive(row?.id) || identities.has(row.id)) fail("ROADMAP_AUTHORITY_IDENTITY_INVALID");
      identities.add(row.id);
      items.push(row);
    }
    if (items.length > expectedTotal || items.length > MAX_ITEMS) fail("ROADMAP_AUTHORITY_COUNT_MISMATCH");
    if (items.length === expectedTotal) return { items, pages: page, total: expectedTotal };
    if (rows.length !== 100) fail("ROADMAP_AUTHORITY_COUNT_MISMATCH");
  }
  fail("ROADMAP_AUTHORITY_PAGINATION_BOUNDED");
}

const PR_QUERY = `query($owner:String!,$name:String!,$branch:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$after,states:[OPEN],headRefName:$branch){totalCount pageInfo{hasNextPage endCursor}nodes{number headRefName headRefOid baseRefName isDraft}}}}`;

async function collectOpenPullRequests(client, repository, branch) {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) fail("ROADMAP_AUTHORITY_REPOSITORY_INVALID");
  const rows = [];
  let expectedTotal = null;
  let after = null;
  const cursors = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await client.json("/graphql", {
      method: "POST",
      body: { query: PR_QUERY, variables: { owner, name, branch, after } },
    });
    if (payload.errors?.length) fail("ROADMAP_AUTHORITY_GRAPHQL_INVALID");
    const connection = payload.data?.repository?.pullRequests;
    if (
      !nonNegative(connection?.totalCount) ||
      connection.totalCount >= 1_000 ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    ) {
      fail("ROADMAP_AUTHORITY_PR_PAGE_INVALID");
    }
    expectedTotal ??= connection.totalCount;
    if (connection.totalCount !== expectedTotal) fail("ROADMAP_AUTHORITY_TOTAL_CHANGED");
    rows.push(...connection.nodes);
    if (rows.length > expectedTotal || rows.length > MAX_ITEMS) fail("ROADMAP_AUTHORITY_COUNT_MISMATCH");
    if (!connection.pageInfo.hasNextPage) {
      if (rows.length !== expectedTotal) fail("ROADMAP_AUTHORITY_COUNT_MISMATCH");
      return rows;
    }
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || connection.nodes.length === 0) fail("ROADMAP_AUTHORITY_CURSOR_INVALID");
    cursors.add(cursor);
    after = cursor;
  }
  fail("ROADMAP_AUTHORITY_PAGINATION_BOUNDED");
}

function validateExactCandidate({ localHead, remoteHead, pulls, expectedHead, branch }) {
  const candidates = pulls.filter((pull) => pull.headRefName === branch && pull.baseRefName === "main");
  if (
    localHead !== expectedHead ||
    remoteHead !== expectedHead ||
    candidates.length !== 1 ||
    candidates[0].headRefOid !== expectedHead ||
    candidates[0].isDraft === true ||
    !positive(candidates[0].number)
  ) {
    fail("ROADMAP_AUTHORITY_EXACT_HEAD_MISMATCH");
  }
  return candidates[0];
}

function parseRemoteHead(output, branch) {
  const rows = output.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) fail("ROADMAP_AUTHORITY_REMOTE_HEAD_INVALID");
  const [head, ref, extra] = rows[0].split(/\s+/);
  if (!SHA.test(head) || ref !== `refs/heads/${branch}` || extra) fail("ROADMAP_AUTHORITY_REMOTE_HEAD_INVALID");
  return head;
}

async function readHeadState({ cwd, branch, expectedHead, client, repository, runChild }) {
  const status = await runChild("git", ["status", "--porcelain=v1", "-z"], { cwd });
  if (status.stdout !== "") fail("ROADMAP_AUTHORITY_WORKTREE_DIRTY");
  const localHead = (await runChild("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const remoteHead = parseRemoteHead(
    (await runChild("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd })).stdout,
    branch,
  );
  const pulls = await collectOpenPullRequests(client, repository, branch);
  const pull = validateExactCandidate({ localHead, remoteHead, pulls, expectedHead, branch });
  return { localHead, remoteHead, pull };
}

function workflowRunsPath(repository, workflow, branch) {
  return `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch`;
}

async function collectWorkflowRuns(client, repository, workflow, branch) {
  return collectCountedPages(client, workflowRunsPath(repository, workflow, branch), "workflow_runs");
}

function matchingRun(run, { nonce, expectedHead, branch }) {
  return (
    run?.event === "workflow_dispatch" &&
    run?.head_sha === expectedHead &&
    run?.head_branch === branch &&
    run?.display_title === `Backlog Roadmap Status probe ${nonce}` &&
    positive(run?.id) &&
    positive(run?.run_attempt)
  );
}

async function waitForRun({ client, repository, workflow, branch, nonce, expectedHead, baselineIds, sleep, deadline }) {
  let selected = null;
  while (Date.now() < deadline) {
    const { items } = await collectWorkflowRuns(client, repository, workflow, branch);
    const matches = items.filter(
      (run) => !baselineIds.has(run.id) && matchingRun(run, { nonce, expectedHead, branch }),
    );
    if (matches.length > 1) fail("ROADMAP_AUTHORITY_RUN_AMBIGUOUS");
    selected ??= matches[0] ?? null;
    if (selected) {
      const current = items.find((run) => run.id === selected.id);
      if (!current || current.run_attempt !== selected.run_attempt) fail("ROADMAP_AUTHORITY_RUN_MOVED");
      selected = current;
      if (current.status === "completed") {
        if (current.conclusion !== "success") fail("ROADMAP_AUTHORITY_RUN_FAILED");
        return current;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail("ROADMAP_AUTHORITY_OVERALL_TIMEOUT");
}

async function collectRunJobs(client, repository, run) {
  return collectCountedPages(
    client,
    `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?filter=all`,
    "jobs",
  );
}

async function collectRunArtifacts(client, repository, run) {
  return collectCountedPages(client, `/repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts");
}

function selectJob(jobs, payloadJobId = null) {
  const matches = jobs.filter((job) => job.name === JOB_NAME);
  if (matches.length !== 1 || (payloadJobId !== null && matches[0].id !== payloadJobId)) {
    fail("ROADMAP_AUTHORITY_JOB_AMBIGUOUS");
  }
  return matches[0];
}

function validateTerminalJob(job) {
  if (job.status !== "completed" || job.conclusion !== "success" || !Array.isArray(job.steps)) {
    fail("ROADMAP_AUTHORITY_JOB_FAILED");
  }
  for (const name of [
    "Produce refined inventory authority probe",
    "Validate refined inventory authority probe",
    "Upload refined inventory authority probe",
  ]) {
    const matches = job.steps.filter((step) => step.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      fail("ROADMAP_AUTHORITY_JOB_STEP_INVALID");
    }
  }
}

function selectArtifact(artifacts, run) {
  const name = `roadmap-refined-inventory-authority-${run.id}-${run.run_attempt}`;
  const matches = artifacts.filter((artifact) => artifact.name === name && artifact.expired !== true);
  if (matches.length !== 1) fail("ROADMAP_AUTHORITY_ARTIFACT_AMBIGUOUS");
  const artifact = matches[0];
  if (
    !positive(artifact.id) ||
    !positive(artifact.size_in_bytes) ||
    artifact.size_in_bytes > ARCHIVE_MAX_BYTES ||
    !DIGEST.test(artifact.digest ?? "") ||
    typeof artifact.archive_download_url !== "string"
  ) {
    fail("ROADMAP_AUTHORITY_ARTIFACT_INVALID");
  }
  return artifact;
}

export function readAuthorityArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > ARCHIVE_MAX_BYTES) {
    fail("ROADMAP_AUTHORITY_ARCHIVE_INVALID");
  }
  const entries = [];
  for (let offset = 0; offset + 46 <= bytes.length; ) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x06054b50) break;
    if (signature !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ method, compressedSize, uncompressedSize, name, externalAttributes, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length !== 1) fail("ROADMAP_AUTHORITY_ARCHIVE_LAYOUT_INVALID");
  const entry = entries[0];
  if (
    entry.name !== PAYLOAD_NAME ||
    basename(entry.name) !== entry.name ||
    entry.name.includes("/") ||
    entry.name.includes("\\") ||
    ((entry.externalAttributes >>> 16) & 0o170000) === 0o120000 ||
    entry.uncompressedSize < 2 ||
    entry.uncompressedSize > PAYLOAD_MAX_BYTES ||
    entry.localOffset + 30 > bytes.length ||
    bytes.readUInt32LE(entry.localOffset) !== 0x04034b50
  ) {
    fail("ROADMAP_AUTHORITY_ARCHIVE_LAYOUT_INVALID");
  }
  const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const localName = bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength).toString("utf8");
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (localName !== entry.name || compressed.length !== entry.compressedSize) {
    fail("ROADMAP_AUTHORITY_ARCHIVE_LAYOUT_INVALID");
  }
  let payloadBytes;
  if (entry.method === 0) payloadBytes = compressed;
  else if (entry.method === 8) payloadBytes = inflateRawSync(compressed, { maxOutputLength: PAYLOAD_MAX_BYTES + 1 });
  else fail("ROADMAP_AUTHORITY_ARCHIVE_COMPRESSION_INVALID");
  if (payloadBytes.length !== entry.uncompressedSize || payloadBytes.length > PAYLOAD_MAX_BYTES) {
    fail("ROADMAP_AUTHORITY_ARCHIVE_LAYOUT_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    fail("ROADMAP_AUTHORITY_PAYLOAD_INVALID");
  }
  if (!validateRefinedInventoryProbePayload(payload)) fail("ROADMAP_AUTHORITY_PAYLOAD_INVALID");
  if (!payloadBytes.equals(canonicalRefinedInventoryProbeBytes(payload))) {
    fail("ROADMAP_AUTHORITY_PAYLOAD_NONCANONICAL");
  }
  return { payload, payloadBytes };
}

function validatePayloadBinding(payload, { repository, workflow, run, job, expectedHead, nonce }) {
  if (
    payload.repository !== repository ||
    payload.workflow !== workflow ||
    payload.runId !== run.id ||
    payload.runAttempt !== run.run_attempt ||
    payload.jobId !== job.id ||
    payload.headSha !== expectedHead ||
    payload.nonce !== nonce
  ) {
    fail("ROADMAP_AUTHORITY_PAYLOAD_BINDING_INVALID");
  }
}

async function refetchRun(client, repository, run) {
  const current = await client.json(`/repos/${repository}/actions/runs/${run.id}`);
  if (
    current.id !== run.id ||
    current.run_attempt !== run.run_attempt ||
    current.head_sha !== run.head_sha ||
    current.head_branch !== run.head_branch ||
    current.event !== "workflow_dispatch" ||
    current.status !== "completed" ||
    current.conclusion !== "success"
  ) {
    fail("ROADMAP_AUTHORITY_RUN_MOVED");
  }
  return current;
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function assertBeforeDeadline(deadline) {
  if (Date.now() >= deadline) fail("ROADMAP_AUTHORITY_OVERALL_TIMEOUT");
}

export function validateAuthorityReceipt(receipt) {
  return (
    exactKeys(receipt, RECEIPT_KEYS) &&
    receipt.schemaVersion === RECEIPT_SCHEMA &&
    receipt.repository === "chase-sets/chase-sets" &&
    receipt.workflow === "backlog-roadmap-status.yml" &&
    receipt.job === JOB_NAME &&
    positive(receipt.jobId) &&
    /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(receipt.ref) &&
    SHA.test(receipt.headSha) &&
    NONCE.test(receipt.nonce) &&
    positive(receipt.runId) &&
    positive(receipt.runAttempt) &&
    positive(receipt.artifactId) &&
    receipt.artifactName === `roadmap-refined-inventory-authority-${receipt.runId}-${receipt.runAttempt}` &&
    DIGEST.test(receipt.artifactDigest) &&
    receipt.payloadPath === PAYLOAD_NAME &&
    /^[0-9a-f]{64}$/.test(receipt.payloadSha256) &&
    canonicalInstant(receipt.checkedAt)
  );
}

export async function runAuthorityProbe(options, dependencies = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const repository = options.repository;
  const workflow = options.workflow;
  const branch = options.branch;
  const expectedHead = options.expectedHead;
  const artifactParent = resolve(options.artifactParent ?? "");
  if (
    repository !== "chase-sets/chase-sets" ||
    workflow !== "backlog-roadmap-status.yml" ||
    !/^[A-Za-z0-9._/-]+$/.test(branch ?? "") ||
    !SHA.test(expectedHead ?? "") ||
    !isAbsolute(artifactParent) ||
    relative(cwd, artifactParent) === "" ||
    (!relative(cwd, artifactParent).startsWith("..") && !isAbsolute(relative(cwd, artifactParent)))
  ) {
    fail("ROADMAP_AUTHORITY_OPTIONS_INVALID");
  }
  const runChild = dependencies.runChild ?? runBoundedChild;
  const token = dependencies.token ?? (await runChild("gh", ["auth", "token"], { cwd })).stdout.trim();
  if (!token) fail("ROADMAP_GITHUB_TOKEN_REQUIRED");
  const client = dependencies.client ?? createBoundedGitHubClient({ token, fetchImpl: dependencies.fetchImpl });
  const sleep =
    dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const nonce = dependencies.nonce ?? randomBytes(16).toString("hex");
  if (!NONCE.test(nonce)) fail("ROADMAP_AUTHORITY_NONCE_INVALID");
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;

  await readHeadState({ cwd, branch, expectedHead, client, repository, runChild });
  assertBeforeDeadline(deadline);
  const baseline = await collectWorkflowRuns(client, repository, workflow, branch);
  const baselineIds = new Set(baseline.items.map((run) => run.id));
  if (baselineIds.size !== baseline.items.length) fail("ROADMAP_AUTHORITY_IDENTITY_INVALID");

  if (
    !existsSync(artifactParent) ||
    !lstatSync(artifactParent).isDirectory() ||
    lstatSync(artifactParent).isSymbolicLink()
  ) {
    fail("ROADMAP_AUTHORITY_OUTPUT_INVALID");
  }
  const outputDirectory = mkdtempSync(join(artifactParent, "roadmap-authority-probe-"));
  if (!lstatSync(outputDirectory).isDirectory()) fail("ROADMAP_AUTHORITY_OUTPUT_INVALID");
  await client.request(`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    body: { ref: branch, inputs: { authority_nonce: nonce } },
  });

  const run = await waitForRun({
    client,
    repository,
    workflow,
    branch,
    nonce,
    expectedHead,
    baselineIds,
    sleep,
    deadline,
  });
  assertBeforeDeadline(deadline);
  const firstJobs = await collectRunJobs(client, repository, run);
  const job = selectJob(firstJobs.items);
  validateTerminalJob(job);
  const firstArtifacts = await collectRunArtifacts(client, repository, run);
  const artifact = selectArtifact(firstArtifacts.items, run);
  const { bytes: archiveBytes } = await client.request(artifact.archive_download_url, {}, ARCHIVE_MAX_BYTES);
  const archivePath = join(outputDirectory, `${artifact.id}.zip`);
  writeFileSync(archivePath, archiveBytes, { flag: "wx" });
  const { payload, payloadBytes } = readAuthorityArchive(archiveBytes);
  validatePayloadBinding(payload, { repository, workflow, run, job, expectedHead, nonce });
  const payloadPath = join(outputDirectory, PAYLOAD_NAME);
  writeFileSync(payloadPath, payloadBytes, { flag: "wx" });

  await readHeadState({ cwd, branch, expectedHead, client, repository, runChild });
  assertBeforeDeadline(deadline);
  await refetchRun(client, repository, run);
  const finalJobs = await collectRunJobs(client, repository, run);
  const finalJob = selectJob(finalJobs.items, payload.jobId);
  validateTerminalJob(finalJob);
  const finalArtifacts = await collectRunArtifacts(client, repository, run);
  const finalArtifact = selectArtifact(finalArtifacts.items, run);
  if (
    finalArtifact.id !== artifact.id ||
    finalArtifact.name !== artifact.name ||
    finalArtifact.digest !== artifact.digest ||
    finalArtifact.size_in_bytes !== artifact.size_in_bytes ||
    !readFileSync(archivePath).equals(archiveBytes) ||
    !readFileSync(payloadPath).equals(payloadBytes)
  ) {
    fail("ROADMAP_AUTHORITY_FINAL_RECONCILIATION_FAILED");
  }

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    repository,
    workflow,
    job: JOB_NAME,
    jobId: job.id,
    ref: `refs/heads/${branch}`,
    headSha: expectedHead,
    nonce,
    runId: run.id,
    runAttempt: run.run_attempt,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactDigest: artifact.digest,
    payloadPath: PAYLOAD_NAME,
    payloadSha256: sha256(payloadBytes),
    checkedAt: new Date().toISOString(),
  };
  assertBeforeDeadline(deadline);
  if (!validateAuthorityReceipt(receipt)) fail("ROADMAP_AUTHORITY_RECEIPT_INVALID");
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  const receiptPath = join(outputDirectory, RECEIPT_NAME);
  writeAtomic(receiptPath, receiptBytes);
  return { receipt, receiptPath, outputDirectory };
}

function option(argv, name) {
  const equals = argv.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function cliOptions(argv) {
  return {
    repository: option(argv, "--repository"),
    workflow: option(argv, "--workflow"),
    branch: option(argv, "--branch"),
    expectedHead: option(argv, "--expected-head"),
    artifactParent: option(argv, "--artifact-parent"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await runAuthorityProbe(cliOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result.receipt)}\n${result.receiptPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
