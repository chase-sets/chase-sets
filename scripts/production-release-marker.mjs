#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertNoActiveHelmOperation,
  assertOciIndexPlatformManifestMembership,
  buildHelmHistoryArgs,
  buildHelmValuesArgs,
  captureKubernetesRollbackTarget,
  readGitHubProductionWriterCensus,
  readHelmOperationCensus,
  selectStableDeployedHelmSource,
} from "./platform-kubernetes-deployment.mjs";

const execute = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const productionJobName = "Deploy Production";
const markerStepName = "Mark production release";
const transitionStepName = "Verify production Kubernetes deployment transition";
const uploadStepName = "Upload production Kubernetes deployment transition";
const requiredSteps = [
  "Verify promoted platform runtime image",
  "Capture production rollback target",
  "Deploy production Kubernetes release",
  "Verify production DOKS live hosts and certificate",
  "Production post-deploy readiness gate",
  "Smoke check",
  "Stage 1 production canary",
  transitionStepName,
  uploadStepName,
];

function requireThat(condition, reason) {
  if (!condition) throw new Error(reason);
}

function instant(value) {
  requireThat(typeof value === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(value), "invalid authority timestamp");
  const time = Date.parse(value);
  requireThat(Number.isFinite(time), "invalid authority timestamp");
  return time;
}

function step(job, name, conclusion) {
  const matches = job.steps?.filter((item) => item.name === name) ?? [];
  requireThat(matches.length === 1, `missing or duplicate authority step: ${name}`);
  const item = matches[0];
  requireThat(item.status === "completed" && item.conclusion === conclusion, `unverified authority step: ${name}`);
  if (conclusion !== "skipped") {
    requireThat(instant(item.started_at) >= instant(job.started_at), `step starts outside job: ${name}`);
    requireThat(instant(item.completed_at) >= instant(item.started_at), `invalid step interval: ${name}`);
    requireThat(instant(item.completed_at) <= instant(job.completed_at), `step ends outside job: ${name}`);
  }
  return item;
}

export function releaseMarkerIdentity(run, commit) {
  requireThat(sha.test(commit), "invalid release commit");
  requireThat(Number.isSafeInteger(run.id) && run.id > 0, "invalid release run identity");
  instant(run.created_at);
  return `release-${run.created_at.replace(/[-:TZ]/g, "")}-${commit.slice(0, 8)}-${run.id}`;
}

export function admitPriorProductionJob(job, identity) {
  requireThat(
    job.name === productionJobName && job.run_id === identity.runId && job.run_attempt === identity.attempt,
    "mismatched production job identity",
  );
  requireThat(
    Number.isSafeInteger(job.id) && job.id > 0 && job.head_sha === identity.workflowHead,
    "mismatched production job source",
  );
  requireThat(
    job.status === "completed" && job.conclusion === "failure",
    "prior production job is not terminal failure",
  );
  requireThat(instant(job.completed_at) >= instant(job.started_at), "invalid production job interval");
  const marker = step(job, markerStepName, "failure");
  for (const name of requiredSteps) {
    const verified = step(job, name, "success");
    requireThat(
      verified.number < marker.number && instant(verified.completed_at) <= instant(marker.started_at),
      `authority step did not precede marker: ${name}`,
    );
  }
  step(job, "Roll back production Kubernetes release", "skipped");
  requireThat(
    job.steps.filter((item) => !["success", "skipped"].includes(item.conclusion)).length === 1,
    "failure is not confined to marker publication",
  );
  return job;
}

export function validateTransitionAuthority(transition, artifact, job, identity) {
  requireThat(
    artifact.expired === false &&
      artifact.workflow_run?.id === identity.runId &&
      artifact.workflow_run?.head_sha === identity.workflowHead,
    "unavailable or mismatched transition artifact",
  );
  const upload = step(job, uploadStepName, "success");
  const created = instant(artifact.created_at);
  // Artifact timestamps have second precision, while transition timestamps include milliseconds.
  requireThat(
    created >= instant(upload.started_at) && created <= instant(upload.completed_at),
    "transition artifact is outside the exact upload step",
  );
  const owner = transition.markerIdentity;
  requireThat(
    owner?.runId === identity.runId &&
      owner.attempt === job.run_attempt &&
      owner.jobId === job.id &&
      owner.commit === identity.commit &&
      owner.digest === identity.digest &&
      owner.tag === identity.tag &&
      sha.test(owner.productionCommit),
    "transition lacks exact retained marker identity",
  );
  requireThat(
    transition.schemaVersion === "platform-kubernetes-deployment-transition/v1" &&
      transition.release === identity.release &&
      transition.namespace === identity.namespace,
    "mismatched retained deployment transition",
  );
  const verification = step(job, transitionStepName, "success");
  // The end timestamp names the whole final second, not its first millisecond.
  requireThat(
    instant(transition.checkedAt) >= instant(verification.started_at) &&
      instant(transition.checkedAt) < instant(verification.completed_at) + 1_000,
    "transition timestamp is outside the exact verification step",
  );
  requireThat(
    Number.isSafeInteger(transition.resultingHeadRevision) &&
      transition.resultingHeadRevision === transition.capturedHeadRevision + 1,
    "invalid retained transition revision",
  );
  stableRecoveryHistory(transition.observedHistory, transition.resultingHeadRevision);
  return transition;
}

function normalizedHistory(history) {
  requireThat(Array.isArray(history) && history.length > 0, "missing Helm history");
  const normalized = history
    .map(({ revision, status, description }) => ({
      revision: Number(revision),
      status,
      description,
    }))
    .sort((a, b) => a.revision - b.revision);
  requireThat(
    normalized.every(
      (entry, i) =>
        Number.isSafeInteger(entry.revision) &&
        entry.revision > 0 &&
        typeof entry.status === "string" &&
        typeof entry.description === "string" &&
        (i === 0 || entry.revision > normalized[i - 1].revision),
    ),
    "malformed Helm history",
  );
  return normalized;
}

export function stableRecoveryHistory(history, revision) {
  const normalized = normalizedHistory(history);
  const { source, historyHead } = selectStableDeployedHelmSource(normalized);
  requireThat(
    source.revision === revision && historyHead.revision === revision,
    "recovery requires the retained transition revision as sole deployed history head",
  );
  requireThat(
    normalized.every((entry) => entry === source || ["superseded", "failed"].includes(entry.status)),
    "recovery refuses conflicting Helm history",
  );
  return normalized;
}

export function assertRegistryIdentity(raw, expectedDigest) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest === expectedDigest) return;
  assertOciIndexPlatformManifestMembership({
    index: JSON.parse(bytes.toString("utf8")),
    indexDigest: digest,
    manifestDigest: expectedDigest,
    platform: "linux/amd64",
  });
}

export function registryManifestBytes(output, digest) {
  requireThat(digestPattern.test(digest), "invalid registry manifest digest");
  const matches = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest;
  if (matches(output)) return output;
  // buildx's display newline is not part of the registry manifest. Never accept unbound transformed bytes.
  if (output.at(-1) === 10 && matches(output.subarray(0, -1))) return output.subarray(0, -1);
  throw new Error("registry manifest bytes do not hash to the authoritative digest");
}

// All effects are supplied at this boundary; tests never inherit provider credentials or execute provider tools.
export async function publishReleaseMarker(identity, io) {
  let production = "unknown";
  let operation = "read-refs";
  try {
    const initial = await io.readRefs();
    production = initial.production;
    requireThat(production === identity.productionCommit || production === identity.commit, "production ref moved");
    const checkRefs = async (refs) => {
      requireThat(refs.production === production || refs.production === identity.commit, "production ref moved");
      if (refs.tag) requireThat(refs.tag.commit === identity.commit && refs.tag.annotated, "conflicting release tag");
      if (initial.tag) requireThat(refs.tag?.object === initial.tag.object, "release tag moved");
      requireThat(await io.isAncestor(refs.production, identity.commit), "production-marker-non-fast-forward");
    };
    await checkRefs(initial);
    operation = "registry-identity";
    let registry = await io.readRegistry();
    if (registry !== null) assertRegistryIdentity(registry, identity.digest);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      operation = "fresh-state";
      await io.assertFresh();
      const refs = await io.readRefs();
      await checkRefs(refs);
      production = refs.production;
      operation = "registry-identity";
      registry = await io.readRegistry();
      if (registry === null) {
        operation = "registry-publication";
        try {
          await io.publishRegistry();
        } catch {
          /* The authoritative read, not the response, decides. */
        }
        registry = await io.readRegistry();
        if (registry === null) continue;
      }
      assertRegistryIdentity(registry, identity.digest);
      operation = "fresh-state";
      await io.assertFresh();
      const beforePush = await io.readRefs();
      await checkRefs(beforePush);
      production = beforePush.production;
      if (beforePush.tag && production === identity.commit) {
        return {
          marker_updated: "true",
          marker_mismatch: "false",
          production_marker_commit: production,
          marker_error: "",
          marker_phase: "complete",
          release_tag: identity.tag,
        };
      }
      operation = "atomic-git-publication";
      try {
        await io.publishGit(beforePush);
      } catch {
        /* A lost response may have committed both refs. */
      }
      operation = "read-after-publication";
      const after = await io.readRefs();
      await checkRefs(after);
      production = after.production;
      if (after.tag && production === identity.commit) {
        operation = "registry-identity";
        assertRegistryIdentity(await io.readRegistry(), identity.digest);
        return {
          marker_updated: "true",
          marker_mismatch: "false",
          production_marker_commit: production,
          marker_error: "",
          marker_phase: "complete",
          release_tag: identity.tag,
        };
      }
      operation = "atomic-git-publication";
    }
    throw new Error("publication result remains unknown after three attempts");
  } catch (error) {
    error.marker = {
      marker_updated: "false",
      marker_mismatch: "true",
      production_marker_commit: production,
      marker_error: error.message,
      marker_phase: "publication",
      marker_operation: operation,
      release_commit: identity.commit,
      release_tag: identity.tag,
    };
    throw error;
  }
}

async function command(program, args, options = {}) {
  return execute(program, args, { maxBuffer: 8 * 1024 * 1024, timeout: 120_000, windowsHide: true, ...options });
}

export async function readCompletePages(api, path, field) {
  const records = [];
  let total;
  for (let page = 1; page <= 10; page += 1) {
    const result = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    requireThat(
      Number.isSafeInteger(result.total_count) && result.total_count >= 0 && Array.isArray(result[field]),
      `malformed ${field} authority page`,
    );
    total ??= result.total_count;
    requireThat(total === result.total_count, `${field} authority changed during pagination`);
    records.push(...result[field]);
    requireThat(new Set(records.map((record) => record.id)).size === records.length, `duplicate ${field} authority`);
    if (records.length === total) return records;
    requireThat(records.length < total && result[field].length > 0, `incomplete ${field} authority`);
  }
  throw new Error(`${field} authority exceeded ten-page bound`);
}

function githubApi(env) {
  requireThat(
    env.GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY),
    "missing GitHub authority credentials",
  );
  return async (path) => {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    requireThat(response.ok, `GitHub authority read failed: HTTP ${response.status}`);
    return response.json();
  };
}

export async function productionJob(api, runId, attempt) {
  const jobs = await readCompletePages(api, `actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
  const matches = jobs.filter((job) => job.name === productionJobName);
  requireThat(matches.length === 1, "missing or duplicate production job");
  return matches[0];
}

export async function readPriorAuthority(api, identity) {
  for (let previous = identity.attempt - 1; previous >= 1; previous -= 1) {
    const job = await productionJob(api, identity.runId, previous);
    requireThat(
      job.run_id === identity.runId && job.run_attempt === previous && job.head_sha === identity.workflowHead,
      "mismatched intervening production job",
    );
    if (job.steps?.some((item) => item.name === markerStepName && item.conclusion === "failure")) {
      return admitPriorProductionJob(job, { ...identity, attempt: previous });
    }
    // An intervening capture refusal is safe; an intervening deployment is not.
    requireThat(job.status === "completed" && job.conclusion === "failure", "unverified intervening attempt");
    step(job, "Capture production rollback target", "failure");
    step(job, "Deploy production Kubernetes release", "skipped");
    step(job, "Roll back production Kubernetes release", "skipped");
  }
  throw new Error("no exact prior marker-failure authority");
}

export async function reconcileReleaseMarker(identity, io) {
  const refs = await io.readRefs();
  if (identity.attempt === 1 || refs.production === identity.commit) return;
  const history = normalizedHistory(await io.readHistory());
  const deployed = history.filter((entry) => entry.status === "deployed");
  // An aligned failed-rollback tail remains ordinary capture's responsibility, including its healing path.
  const values = await io.readValues(deployed.length === 1 ? deployed[0].revision : history.at(-1).revision);
  if (values.global?.image?.tag === refs.production) return;
  requireThat(values.global?.image?.tag === identity.commit, "different deployed release requires host reconciliation");
  const transition = await io.readAuthority();
  requireThat(
    transition.markerIdentity.productionCommit === refs.production,
    "production ref changed since admitted deployment",
  );
  const expectedHistory = stableRecoveryHistory(transition.observedHistory, transition.resultingHeadRevision);
  const assertFresh = async () => {
    await io.assertWriters();
    requireThat(
      JSON.stringify(stableRecoveryHistory(await io.readHistory(), transition.resultingHeadRevision)) ===
        JSON.stringify(expectedHistory),
      "Helm history changed since admitted deployment",
    );
    const captured = await io.capture();
    requireThat(
      JSON.stringify(captured.preDeployHistory) === JSON.stringify(expectedHistory),
      "Helm history moved during identity capture",
    );
    await io.assertWriters();
  };
  await publishReleaseMarker({ ...identity, productionCommit: refs.production }, { ...io, assertFresh });
}

async function readTransitionArtifact(api, env, identity, job) {
  const artifacts = await readCompletePages(api, `actions/runs/${identity.runId}/artifacts`, "artifacts");
  const upload = step(job, uploadStepName, "success");
  const candidates = artifacts.filter(
    (artifact) =>
      artifact.name === "production-kubernetes-deployment-transition" &&
      instant(artifact.created_at) >= instant(upload.started_at) &&
      instant(artifact.created_at) <= instant(upload.completed_at),
  );
  requireThat(candidates.length === 1, "missing or duplicate transition artifact in source upload interval");
  const artifact = await api(`actions/artifacts/${candidates[0].id}`);
  requireThat(
    artifact.id === candidates[0].id && artifact.name === candidates[0].name,
    "mismatched transition artifact metadata",
  );
  requireThat(artifact.expired === false, "transition artifact expired");
  const directory = await mkdtemp(join(tmpdir(), "production-marker-"));
  try {
    const archive = join(directory, "transition.zip");
    // gh handles the authenticated redirect without forwarding the token to arbitrary artifact hosts.
    const { stdout } = await command(
      "gh",
      ["api", `repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
      { encoding: "buffer", env: { ...env, GH_TOKEN: env.GITHUB_TOKEN } },
    );
    await writeFile(archive, stdout);
    const listing = await command("unzip", ["-Z1", archive]);
    requireThat(
      listing.stdout.trim() === "production-kubernetes-deployment-transition.json",
      "unexpected transition archive members",
    );
    const extracted = await command("unzip", ["-p", archive, "production-kubernetes-deployment-transition.json"]);
    return validateTransitionAuthority(JSON.parse(extracted.stdout), artifact, job, identity);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function readOnlySpawn(program, args, options, spawnImpl = spawn) {
  requireThat(
    (program === "helm" && (args[0] === "history" || (args[0] === "get" && args[1] === "values"))) ||
      (program === "kubectl" && args[0] === "get"),
    "marker reconciliation forbids Helm/Kubernetes mutation",
  );
  return spawnImpl(program, args, options);
}

async function readHistory(options) {
  const { stdout } = await command("helm", buildHelmHistoryArgs(options));
  return normalizedHistory(JSON.parse(stdout));
}

export function assertExclusiveMarkerWriter(census, currentRunId) {
  requireThat(
    census.writerRuns.length === 1 &&
      String(census.writerRuns[0].id) === currentRunId &&
      census.writerRuns[0].name === "Platform Deploy" &&
      census.writerRuns[0].status === "in_progress",
    "active or conflicting production writer",
  );
}

async function assertWriters(env, options) {
  assertExclusiveMarkerWriter(await readGitHubProductionWriterCensus({ env }), env.GITHUB_RUN_ID);
  assertNoActiveHelmOperation(await readHelmOperationCensus({ ...options, spawn: readOnlySpawn }));
}

async function gitRefs(identity, runCommand = command) {
  // Fetch failure is unknown, never absence. Fetch into FETCH_HEAD avoids trusting stale tracking refs.
  await runCommand("git", ["fetch", "--no-tags", "origin", "refs/heads/production"]);
  const { stdout } = await runCommand("git", [
    "ls-remote",
    "origin",
    "refs/heads/production",
    `refs/tags/${identity.tag}`,
    `refs/tags/${identity.tag}^{}`,
  ]);
  const refs = new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [object, ref] = line.trim().split(/\s+/);
        requireThat(sha.test(object), "malformed remote ref");
        return [ref, object];
      }),
  );
  const production = refs.get("refs/heads/production");
  requireThat(sha.test(production ?? ""), "production ref unavailable");
  const object = refs.get(`refs/tags/${identity.tag}`);
  if (object) {
    await runCommand("git", ["fetch", "--no-tags", "origin", `refs/tags/${identity.tag}`]);
    requireThat(
      (await runCommand("git", ["rev-parse", "FETCH_HEAD"])).stdout.trim() === object,
      "release tag moved during fetch",
    );
  }
  return {
    production,
    tag: object
      ? {
          object,
          commit: refs.get(`refs/tags/${identity.tag}^{}`),
          annotated: refs.has(`refs/tags/${identity.tag}^{}`),
        }
      : null,
  };
}

export function markerIo(identity, env, assertFresh, runCommand = command) {
  const image = `${identity.image}:${identity.tag}`;
  const registryUnavailable = (error) => {
    const stderr = typeof error.stderr === "string" || Buffer.isBuffer(error.stderr) ? error.stderr.toString() : "";
    const excerpt = stderr
      .split(/[\r\n]/, 1)[0]
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 300);
    return new Error(`registry identity unavailable${excerpt ? `: ${excerpt}` : ""}`);
  };
  return {
    readRefs: () => gitRefs(identity, runCommand),
    isAncestor: async (from, to) => {
      try {
        await runCommand("git", ["merge-base", "--is-ancestor", from, to]);
        return true;
      } catch (error) {
        if (error.code === 1) return false;
        throw error;
      }
    },
    readRegistry: async () => {
      let topDigest;
      try {
        topDigest = (
          await runCommand("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{.Manifest.Digest}}"])
        ).stdout.trim();
      } catch (error) {
        const stderr = typeof error.stderr === "string" ? error.stderr : "";
        const line = stderr.replace(/\r?\n$/, "");
        const missingTag = /^ERROR: /i.test(line) && line.slice(7) === `${image}: not found`;
        if (error.code === 1 && !error.killed && !error.signal && (missingTag || /\bmanifest unknown\b/i.test(stderr)))
          return null;
        throw registryUnavailable(error);
      }
      try {
        requireThat(digestPattern.test(topDigest), "invalid registry tag digest");
        const raw = (
          await runCommand("docker", ["buildx", "imagetools", "inspect", `${identity.image}@${topDigest}`, "--raw"], {
            encoding: "buffer",
          })
        ).stdout;
        return registryManifestBytes(raw, topDigest);
      } catch (error) {
        throw registryUnavailable(error);
      }
    },
    publishRegistry: () =>
      runCommand("docker", ["buildx", "imagetools", "create", "--tag", image, `${identity.image}@${identity.digest}`]),
    assertFresh,
    publishGit: async (refs) => {
      let tagSource = refs.tag?.object;
      if (!tagSource) {
        const localRef = `refs/tags/${identity.tag}`;
        let local;
        try {
          local = (await runCommand("git", ["rev-parse", "--verify", localRef])).stdout.trim();
        } catch (error) {
          requireThat(error.code === 128, "local release tag read failed");
        }
        if (local) {
          requireThat(
            (await runCommand("git", ["cat-file", "-t", local])).stdout.trim() === "tag" &&
              (await runCommand("git", ["rev-parse", `${localRef}^{commit}`])).stdout.trim() === identity.commit,
            "conflicting local release tag",
          );
        } else {
          await runCommand(
            "git",
            [
              "-c",
              "user.name=github-actions[bot]",
              "-c",
              "user.email=41898282+github-actions[bot]@users.noreply.github.com",
              "tag",
              "-a",
              identity.tag,
              identity.commit,
              "-m",
              `Production release ${identity.tag}`,
            ],
            { env: { ...env, GIT_COMMITTER_DATE: identity.createdAt } },
          );
        }
        tagSource = (await runCommand("git", ["rev-parse", localRef])).stdout.trim();
      }
      // The explicit lease is a compare-and-swap guard, never permission for a non-fast-forward update.
      await runCommand("git", ["merge-base", "--is-ancestor", refs.production, identity.commit]);
      await runCommand("git", [
        "push",
        "--atomic",
        `--force-with-lease=refs/heads/production:${refs.production}`,
        `--force-with-lease=refs/tags/${identity.tag}:${refs.tag?.object ?? ""}`,
        "origin",
        `${tagSource}:refs/tags/${identity.tag}`,
        `${identity.commit}:refs/heads/production`,
      ]);
    },
  };
}

async function main(action, env) {
  let identity;
  let knownProduction = "unknown";
  try {
    const api = githubApi(env);
    const runId = Number(env.GITHUB_RUN_ID);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    requireThat(
      Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 10,
      "retry attempt exceeds bounded authority window",
    );
    const run = await api(`actions/runs/${runId}`);
    requireThat(
      run.id === runId &&
        run.path === ".github/workflows/platform-production.yml" &&
        run.event === "workflow_dispatch" &&
        run.run_attempt === attempt &&
        run.status === "in_progress",
      "unverified production workflow source",
    );
    identity = {
      runId,
      attempt,
      workflowHead: run.head_sha,
      commit: env.RELEASE_COMMIT,
      digest: env.RELEASE_IMAGE_DIGEST,
      image: env.RELEASE_IMAGE?.replace(/:[^/:]+$/, ""),
      release: env.CHASE_SETS_HELM_RELEASE,
      namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE,
      tag: releaseMarkerIdentity(run, env.RELEASE_COMMIT),
      createdAt: run.created_at,
    };
    requireThat(
      digestPattern.test(identity.digest) &&
        /^registry\.digitalocean\.com\/[a-z0-9-]+\/chase-sets-platform$/.test(identity.image),
      "invalid release image identity",
    );
    const options = { release: identity.release, namespace: identity.namespace };
    const transitionPath = "artifacts/release-health/production-kubernetes-deployment-transition.json";
    if (action === "retain-identity") {
      const job = await productionJob(api, runId, attempt);
      requireThat(
        job.status === "in_progress" &&
          job.run_attempt === attempt &&
          job.run_id === runId &&
          job.head_sha === run.head_sha,
        "current production job identity unavailable",
      );
      const transition = JSON.parse(await readFile(transitionPath, "utf8"));
      const target = JSON.parse(await readFile("artifacts/release-health/production-rollback-target.json", "utf8"));
      requireThat(sha.test(target.lastKnownGoodCommit), "rollback marker identity unavailable");
      transition.markerIdentity = {
        runId,
        attempt,
        jobId: job.id,
        commit: identity.commit,
        digest: identity.digest,
        tag: identity.tag,
        productionCommit: target.lastKnownGoodCommit,
      };
      await writeFile(transitionPath, `${JSON.stringify(transition, null, 2)}\n`);
      return;
    }
    const refs = await gitRefs(identity);
    knownProduction = refs.production;
    identity.productionCommit = refs.production;
    const assertFresh = () => assertWriters(env, options);
    if (action === "reconcile") {
      await reconcileReleaseMarker(identity, {
        ...markerIo(identity, env, assertFresh),
        readHistory: () => readHistory(options),
        readValues: async (revision) =>
          JSON.parse((await command("helm", buildHelmValuesArgs({ ...options, revision }))).stdout),
        readAuthority: async () => readTransitionArtifact(api, env, identity, await readPriorAuthority(api, identity)),
        assertWriters: assertFresh,
        capture: () =>
          captureKubernetesRollbackTarget({
            ...options,
            registryName: identity.image.split("/")[1],
            repository: "chase-sets-platform",
            tag: identity.commit,
            digest: identity.digest,
            lastKnownGoodCommit: identity.commit,
            releaseTag: identity.tag,
            spawn: readOnlySpawn,
          }),
      });
      return;
    } else {
      requireThat(action === "publish", "unknown production marker action");
      const transition = JSON.parse(await readFile(transitionPath, "utf8"));
      requireThat(
        transition.markerIdentity?.attempt === attempt &&
          transition.markerIdentity?.runId === runId &&
          transition.markerIdentity?.commit === identity.commit &&
          transition.markerIdentity?.digest === identity.digest,
        "current retained marker identity mismatch",
      );
      identity.productionCommit = transition.markerIdentity.productionCommit;
    }
    const result = await publishReleaseMarker(identity, markerIo(identity, env, assertFresh));
    // Recovery repairs refs only. Only the normal, freshly verified producer can claim promotion.
    if (action === "publish") await output(result, env);
  } catch (error) {
    error.marker ??= {
      marker_updated: "false",
      marker_mismatch: "true",
      marker_phase: action,
      marker_operation: "admission",
      release_commit: identity?.commit ?? env.RELEASE_COMMIT ?? "unknown",
      release_tag: identity?.tag ?? "unknown",
      production_marker_commit: knownProduction,
      marker_error: error.message,
    };
    throw error;
  }
}

async function output(fields, env) {
  const lines = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`)
    .join("\n");
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${lines}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(env.GITHUB_STEP_SUMMARY, `## Production release marker\n\n\`\`\`text\n${lines}\n\`\`\`\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.env).catch(async (error) => {
    await output(
      error.marker ?? {
        marker_updated: "false",
        marker_mismatch: "true",
        marker_phase: process.argv[2],
        marker_operation: "admission",
        release_commit: process.env.RELEASE_COMMIT ?? "unknown",
        production_marker_commit: "unknown",
        marker_error: error.message,
      },
      process.env,
    );
    console.error(error.message);
    process.exitCode = 1;
  });
}
