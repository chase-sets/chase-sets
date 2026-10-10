// CI image mirrors: the upstream images required CI pulls are pinned
// in ci-image-sources.json by sha256 and copied byte-for-byte to public GHCR,
// so no required job pulls anonymously from Docker Hub. The publisher job runs
// this file with packages: write, so it imports node builtins only and never
// executes installed dependencies.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const imageSourcesPath = fileURLToPath(new URL("./ci-image-sources.json", import.meta.url));
export const mirrorRepositoryPrefix = "ghcr.io/chase-sets/ci-mirror-";

const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/;
const platformPattern = /^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?$/;
const indexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const manifestAccept = [
  ...indexMediaTypes,
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const anonymousProbeHubCanary = "docker.io/library/hello-world:latest";
const probeForbiddenCredentials = ["GHCR_PUBLISH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "DOCKER_AUTH_CONFIG"];

// The Hub block is host-local: these names resolve to unroutable sinks in this
// runner's /etc/hosts. It is not a firewall for a remote daemon or for a
// container with its own resolver; those fail the dial-evidence check instead.
export const dockerHubHosts = [
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
  "registry.hub.docker.com",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  "hub.docker.com",
];
const dockerHubSinks = ["0.0.0.0", "::"];
const acceptedSinkAddresses = new Set([...dockerHubSinks, "::ffff:0.0.0.0"]);
// timeout(1) exit statuses; the node runner maps its own timeout and a missing
// executable onto the same codes so every caller classifies them alike.
const timedOutStatuses = new Set([124, 137]);
const missingToolStatus = 127;
const hubCanaryTimeoutMs = 90_000;
const dockerDaemonUnavailable =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect/i;
const hubAnswered =
  /toomanyrequests|rate limit|unauthorized|authentication required|denied|manifest unknown|not found|unexpected (?:http )?status|status code|\b(?:401|403|404|429|500|502|503|504)\b|x509|tls handshake|certificate/i;
const blockedDial =
  /dial tcp (?:0\.0\.0\.0|\[::\]|\[::ffff:0\.0\.0\.0\]):443: connect: (?:connection refused|network is unreachable|cannot assign requested address)/;

export function isSha256Digest(value) {
  return typeof value === "string" && sha256DigestPattern.test(value);
}

export function validateImageSources(map) {
  if (map?.version !== 1 || !Array.isArray(map.sources) || map.sources.length === 0) {
    throw new Error("ci-image-sources.json must be version 1 with a non-empty sources list.");
  }

  const ids = new Set();
  for (const entry of map.sources) {
    const id = entry?.id;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
      throw new Error(`Image source id ${JSON.stringify(id)} must be lowercase letters, digits or dashes.`);
    }
    if (ids.has(id)) {
      throw new Error(`Image source id '${id}' is duplicated.`);
    }
    ids.add(id);
    if (typeof entry.source !== "string" || !/^docker\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(entry.source)) {
      throw new Error(`${id}: source must be a fixed docker.io/<namespace>/<name> repository.`);
    }
    if (typeof entry.tag !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(entry.tag)) {
      throw new Error(`${id}: tag must be a Docker tag.`);
    }
    if (entry.mirror !== `${mirrorRepositoryPrefix}${id}`) {
      throw new Error(`${id}: mirror must be ${mirrorRepositoryPrefix}${id}.`);
    }
    if (!isSha256Digest(entry.digest)) {
      throw new Error(`${id}: digest must be a lowercase sha256 digest (received ${JSON.stringify(entry.digest)}).`);
    }
    const platforms = entry.platforms;
    if (
      !Array.isArray(platforms) ||
      platforms.length === 0 ||
      !platforms.every((platform) => typeof platform === "string" && platformPattern.test(platform)) ||
      platforms.join("\n") !== [...new Set(platforms)].sort().join("\n")
    ) {
      throw new Error(`${id}: platforms must be a non-empty, sorted, unique os/arch[/variant] list.`);
    }
  }

  return map.sources;
}

export function loadImageSources(text = readFileSync(imageSourcesPath, "utf8")) {
  return validateImageSources(JSON.parse(text));
}

// The source is always addressed by its pinned digest; the tag is reported but
// never copied, so a moved upstream tag cannot change the mirrored bytes.
export function sourceReference(entry) {
  return `${entry.source}@${entry.digest}`;
}

export function sourceTagReference(entry) {
  return `${entry.source}:${entry.tag}`;
}

export function mirrorReference(entry) {
  return `${entry.mirror}:${entry.tag}@${entry.digest}`;
}

function platformName(platform) {
  return [platform?.os, platform?.architecture, platform?.variant].filter(Boolean).join("/");
}

export function manifestIdentity(raw) {
  const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  let document;
  try {
    document = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new Error(`Manifest ${digest} is not JSON.`);
  }

  const children = Array.isArray(document?.manifests)
    ? document.manifests.map((child) => ({
        digest: child?.digest,
        platform: platformName(child?.platform),
        attestation: child?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest",
      }))
    : [];
  const platforms = children
    .filter((child) => !child.attestation)
    .map((child) => child.platform)
    .sort();

  return { digest, mediaType: document?.mediaType ?? null, platforms, children };
}

export function verifyPinnedIdentity(entry, raw, role) {
  const identity = manifestIdentity(raw);
  if (identity.digest !== entry.digest) {
    throw new Error(
      `${entry.id}: ${role} manifest is ${identity.digest}, not the pinned ${entry.digest}; refusing moved or substituted bytes.`,
    );
  }
  if (!indexMediaTypes.has(identity.mediaType)) {
    throw new Error(`${entry.id}: ${role} manifest must be a multi-platform index (received ${identity.mediaType}).`);
  }
  const missing = entry.platforms.filter((platform) => !identity.platforms.includes(platform));
  const unexpected = identity.platforms.filter((platform) => !entry.platforms.includes(platform));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${entry.id}: ${role} platforms differ from the pin (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }
  const malformed = identity.children.filter((child) => !isSha256Digest(child.digest));
  if (malformed.length > 0) {
    throw new Error(`${entry.id}: ${role} index lists ${malformed.length} child manifest(s) without a sha256 digest.`);
  }

  return identity;
}

export function splitImageReference(reference) {
  const match = /^(?<registry>[^/]+)\/(?<repository>[^:@]+)(?::(?<tag>[^@]+))?(?:@(?<digest>.+))?$/.exec(reference);
  if (!match?.groups) {
    throw new Error(`Cannot parse image reference '${reference}'.`);
  }
  return match.groups;
}

function registryApi(registry) {
  if (registry === "docker.io") {
    return {
      base: "https://registry-1.docker.io",
      tokenUrl: (repository) =>
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    };
  }
  if (registry === "ghcr.io") {
    return {
      base: "https://ghcr.io",
      tokenUrl: (repository) => `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
    };
  }
  throw new Error(`Unsupported registry '${registry}'.`);
}

// Minimal Registry v2 manifest client. basicAuth maps a registry host to a
// base64 user:token pair; registries without one are read anonymously.
export function createRegistryClient({ fetchImpl = globalThis.fetch, basicAuth = {} } = {}) {
  const tokens = new Map();

  async function bearer(registry, repository) {
    const key = `${registry}/${repository}`;
    if (!tokens.has(key)) {
      const headers = basicAuth[registry] ? { Authorization: `Basic ${basicAuth[registry]}` } : {};
      const response = await fetchImpl(registryApi(registry).tokenUrl(repository), { headers });
      if (!response.ok) {
        throw new Error(`Registry token request for ${key} failed with HTTP ${response.status}.`);
      }
      const body = await response.json();
      tokens.set(key, body.token ?? body.access_token);
    }
    return tokens.get(key);
  }

  async function manifest(method, reference) {
    const { registry, repository, tag, digest } = splitImageReference(reference);
    const response = await fetchImpl(`${registryApi(registry).base}/v2/${repository}/manifests/${digest ?? tag}`, {
      method,
      headers: { Accept: manifestAccept, Authorization: `Bearer ${await bearer(registry, repository)}` },
    });
    const raw = method === "GET" && response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    return { status: response.status, digest: response.headers.get("docker-content-digest"), raw };
  }

  return { head: (reference) => manifest("HEAD", reference), get: (reference) => manifest("GET", reference) };
}

function requireManifest(response, reference) {
  if (response.status === 200 && response.raw) {
    return response.raw;
  }
  const hint = response.status === 429 ? " (registry rate limit; rerun in a later window, never a tag fallback)" : "";
  throw new Error(`GET ${reference} returned HTTP ${response.status}${hint}.`);
}

export function assertTrustedPublisherContext(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error(
      `Refusing to publish CI image mirrors from event '${env.GITHUB_EVENT_NAME ?? ""}'; only a manual workflow_dispatch may publish.`,
    );
  }
  const defaultBranch = env.CI_IMAGE_MIRROR_DEFAULT_BRANCH;
  if (!defaultBranch || env.GITHUB_REF !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `Refusing to publish CI image mirrors from untrusted ref '${env.GITHUB_REF ?? ""}'; only the default branch (${defaultBranch || "unknown"}) may publish.`,
    );
  }
}

export function publisherCredentials(env) {
  const user = env.GHCR_PUBLISH_USER;
  const token = env.GHCR_PUBLISH_TOKEN;
  if (!user || !token) {
    throw new Error(
      "GHCR_PUBLISH_USER and GHCR_PUBLISH_TOKEN are required: the publish step must thread the job-local GITHUB_TOKEN with packages: write. Refusing to publish without them.",
    );
  }
  return { user, token };
}

function run(command, args, { input, env, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const errorStatus = { ETIMEDOUT: 124, ENOENT: missingToolStatus }[result.error?.code] ?? -1;
  return {
    status: result.error ? errorStatus : (result.status ?? 124),
    stdout: result.stdout ?? "",
    stderr: result.stderr || String(result.error ?? ""),
  };
}

function tail(text) {
  return text.trim().split(/\r?\n/).slice(-5).join(" | ");
}

// skopeo copies every child manifest and blob and refuses any digest change.
// runCommand is the process boundary; tests replace only that, not the adapter.
export function skopeoCopy({ from, to, credentials, runCommand = run }) {
  const authDir = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "ci-image-mirror-auth-"));
  const authfile = path.join(authDir, "auth.json");
  try {
    const login = runCommand(
      "skopeo",
      ["login", "--authfile", authfile, "--username", credentials.user, "--password-stdin", "ghcr.io"],
      { input: credentials.token },
    );
    if (login.status !== 0) {
      throw new Error(`skopeo login ghcr.io failed: ${tail(login.stderr)}`);
    }
    const copy = runCommand("skopeo", [
      "copy",
      "--all",
      "--preserve-digests",
      "--src-no-creds",
      "--dest-authfile",
      authfile,
      `docker://${from}`,
      `docker://${to}`,
    ]);
    if (copy.status !== 0) {
      throw new Error(`skopeo copy ${from} -> ${to} failed: ${tail(copy.stderr)}`);
    }
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
}

export async function publishMirrors({
  sources,
  env = process.env,
  createClient = createRegistryClient,
  copyImage = skopeoCopy,
  now = () => new Date().toISOString(),
}) {
  assertTrustedPublisherContext(env);
  const credentials = publisherCredentials(env);
  const upstream = createClient();
  const ghcrClient = () =>
    createClient({
      basicAuth: { "ghcr.io": Buffer.from(`${credentials.user}:${credentials.token}`).toString("base64") },
    });
  const startedAt = now();
  const rows = [];

  for (const entry of sources) {
    // HEAD is informational and not counted against Docker Hub pull limits.
    const tag = await upstream.head(sourceTagReference(entry)).catch(() => ({ digest: null }));
    const sourceIdentity = verifyPinnedIdentity(
      entry,
      requireManifest(await upstream.get(sourceReference(entry)), sourceReference(entry)),
      "source",
    );

    const mirrorDigestReference = `${entry.mirror}@${entry.digest}`;
    const mirrorTagReference = `${entry.mirror}:${entry.tag}`;
    const existingTag = await ghcrClient()
      .head(mirrorTagReference)
      .catch(() => ({ status: 0, digest: null }));
    const copied = existingTag.status !== 200 || existingTag.digest !== entry.digest;
    if (copied) {
      copyImage({ from: sourceReference(entry), to: mirrorTagReference, credentials });
    }

    // A token minted before the copy may predate the package; verify with a fresh one.
    const ghcr = ghcrClient();
    const mirrorIdentity = verifyPinnedIdentity(
      entry,
      requireManifest(await ghcr.get(mirrorDigestReference), mirrorDigestReference),
      "mirror",
    );
    for (const child of mirrorIdentity.children) {
      const childResponse = await ghcr.head(`${entry.mirror}@${child.digest}`);
      if (childResponse.status !== 200) {
        throw new Error(
          `${entry.id}: mirror is missing child manifest ${child.digest} (${child.platform || "unknown"}); HTTP ${childResponse.status}.`,
        );
      }
    }
    const mirrorTag = await ghcr.head(mirrorTagReference);
    if (mirrorTag.digest !== entry.digest) {
      throw new Error(`${entry.id}: ${mirrorTagReference} resolves to ${mirrorTag.digest}, not ${entry.digest}.`);
    }

    rows.push({
      id: entry.id,
      source: sourceReference(entry),
      sourceDigest: sourceIdentity.digest,
      sourceTag: sourceTagReference(entry),
      sourceTagDigest: tag.digest ?? null,
      sourceTagMoved: tag.digest ? tag.digest !== entry.digest : null,
      mirror: mirrorReference(entry),
      mirrorDigest: mirrorIdentity.digest,
      copied,
      children: mirrorIdentity.children.map(({ digest, platform, attestation }) => ({ digest, platform, attestation })),
    });
  }

  return { kind: "publish", startedAt, finishedAt: now(), sources: sources.length, rows };
}

export function dockerHubHostsLines() {
  return dockerHubHosts.flatMap((host) => dockerHubSinks.map((sink) => `${sink} ${host}`));
}

function resolveWithGetent(host) {
  const result = run("getent", ["ahosts", host], { timeoutMs: 10_000 });
  const addresses = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  return { status: result.status, addresses: [...new Set(addresses)] };
}

// Before the canary can prove anything, the daemon must answer and every Hub
// name must resolve only to the block sinks on this runner.
export function dockerHubBlockPreflight({ docker, resolveHost }) {
  const version = docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
  if (version.status === missingToolStatus) {
    throw new Error("The docker CLI is unavailable; cannot prove Docker Hub is blocked.");
  }
  if (version.status !== 0 || !version.stdout.trim()) {
    throw new Error(
      `The Docker daemon is unavailable (exit ${version.status}: ${tail(version.stderr) || "no server version"}); cannot prove Docker Hub is blocked.`,
    );
  }
  for (const host of dockerHubHosts) {
    const resolved = resolveHost(host);
    if (resolved.status === missingToolStatus) {
      throw new Error(`getent is unavailable; cannot verify that ${host} resolves only to the block sinks.`);
    }
    const unexpected = resolved.addresses.filter((address) => !acceptedSinkAddresses.has(address));
    if (resolved.status !== 0 || resolved.addresses.length === 0 || unexpected.length > 0) {
      throw new Error(
        `${host} resolves to ${JSON.stringify(resolved.addresses)} (exit ${resolved.status}), not only ${dockerHubSinks.join(" and ")}; the Docker Hub host block is not in effect.`,
      );
    }
  }
  return { daemonVersion: version.stdout.trim() };
}

// Only a failed dial to a block sink proves the block. A registry answer (rate
// limit, auth, missing manifest), a missing daemon or tool, a timeout and any
// unrecognized failure all fail closed rather than certify Hub as unreachable.
export function classifyDockerHubCanaryPull({ status, output }) {
  const diagnosis = tail(output) || "no output";
  if (status === 0) {
    throw new Error(
      `Docker Hub is reachable (${anonymousProbeHubCanary} pulled); the job requires Hub to be unreachable.`,
    );
  }
  if (timedOutStatuses.has(status)) {
    throw new Error(
      `The ${anonymousProbeHubCanary} canary pull timed out (exit ${status}) without a diagnosis; a timeout does not prove the block.`,
    );
  }
  if (status === missingToolStatus) {
    throw new Error("The docker CLI is unavailable; cannot prove Docker Hub is blocked.");
  }
  if (dockerDaemonUnavailable.test(output)) {
    throw new Error(`The Docker daemon is unavailable (${diagnosis}); cannot prove Docker Hub is blocked.`);
  }
  if (hubAnswered.test(output)) {
    throw new Error(
      `Docker Hub answered the ${anonymousProbeHubCanary} canary pull (${diagnosis}); a registry response is not a network block.`,
    );
  }
  const evidence = blockedDial.exec(output)?.[0];
  if (!evidence) {
    throw new Error(
      `The ${anonymousProbeHubCanary} canary pull failed without dialing a block sink (exit ${status}: ${diagnosis}); refusing to certify Docker Hub as unreachable.`,
    );
  }
  return { canary: anonymousProbeHubCanary, evidence };
}

export function probeAnonymousMirrors({
  sources,
  env = process.env,
  docker,
  resolveHost = resolveWithGetent,
  now = () => new Date().toISOString(),
}) {
  const present = probeForbiddenCredentials.filter((name) => env[name]);
  if (present.length > 0) {
    throw new Error(`The anonymous probe must run without registry credentials; found ${present.join(", ")}.`);
  }

  const startedAt = now();
  dockerHubBlockPreflight({ docker, resolveHost });
  const canaryPull = docker(["pull", anonymousProbeHubCanary], { timeoutMs: hubCanaryTimeoutMs });
  const hubBlock = classifyDockerHubCanaryPull({
    status: canaryPull.status,
    output: `${canaryPull.stdout}\n${canaryPull.stderr}`,
  });

  const rows = [];
  for (const entry of sources) {
    // Pull the exact form consumers use; inspect by the canonical digest form.
    const reference = mirrorReference(entry);
    const canonical = `${entry.mirror}@${entry.digest}`;
    if (docker(["image", "inspect", canonical]).status === 0) {
      throw new Error(`${entry.id}: ${reference} is already present locally; the probe must start cold.`);
    }
    const pulledAt = now();
    const pull = docker(["pull", reference]);
    if (pull.status !== 0) {
      throw new Error(
        `${entry.id}: anonymous pull of ${reference} failed (private, missing or deleted mirror): ${tail(pull.stderr)}`,
      );
    }
    const inspect = docker(["image", "inspect", "--format", "{{json .RepoDigests}}", canonical]);
    const repoDigests = inspect.status === 0 ? JSON.parse(inspect.stdout.trim() || "[]") : [];
    if (!repoDigests.includes(canonical)) {
      throw new Error(`${entry.id}: pulled image records ${JSON.stringify(repoDigests)}, not ${canonical}.`);
    }
    rows.push({ id: entry.id, reference, pulledAt, repoDigests });
  }

  return {
    kind: "anonymous-probe",
    startedAt,
    finishedAt: now(),
    hubCanary: anonymousProbeHubCanary,
    hubBlockEvidence: hubBlock.evidence,
    sources: sources.length,
    rows,
  };
}

export const publisherWorkflowPath = ".github/workflows/ci-image-mirrors.yml";
const publisherJobId = "publish";
// Job-level admission: a dispatch from any ref but the default branch skips the
// token-bearing job before its checkout or any branch code runs.
export const publisherAdmission =
  "github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
export const trustedCheckoutRef = "${{ format('refs/heads/{0}', github.event.repository.default_branch) }}";

function grantsPackagesWrite(permissions) {
  return permissions === "write-all" || permissions?.packages === "write";
}

export function workflowTriggers(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

// AC4 boundary over parsed workflow documents ({ path, document }): only the
// manual default-branch publisher job may hold packages: write, it threads
// exactly the job-local GITHUB_TOKEN into one step, and no workflow inherits
// repository-default token permissions.
export function publisherBoundaryViolations(workflows) {
  const violations = [];
  for (const { path: file, document } of workflows) {
    if (document?.permissions === undefined) {
      violations.push(`${file}: declare top-level permissions; repository-default token permissions are unbounded.`);
    }
    for (const [jobId, job] of Object.entries(document?.jobs ?? {})) {
      const isPublisher = file === publisherWorkflowPath && jobId === publisherJobId;
      const grants = grantsPackagesWrite(job?.permissions ?? document?.permissions);
      if (grants && !isPublisher) {
        violations.push(
          `${file}: job '${jobId}' must not hold packages: write; only the CI image mirror publisher may.`,
        );
      }
      if (isPublisher && !grantsPackagesWrite(job?.permissions)) {
        violations.push(`${file}: job '${jobId}' must declare packages: write at job level.`);
      }
    }
  }

  const publisher = workflows.find((workflow) => workflow.path === publisherWorkflowPath)?.document;
  if (!publisher) {
    return [...violations, `${publisherWorkflowPath} is missing.`];
  }
  if (workflowTriggers(publisher.on).join(",") !== "workflow_dispatch") {
    violations.push(`${publisherWorkflowPath}: the publisher must trigger only on workflow_dispatch.`);
  }
  if (publisher.jobs?.[publisherJobId]?.if !== publisherAdmission) {
    violations.push(
      `${publisherWorkflowPath}: job '${publisherJobId}' must be admitted at job level by if: ${publisherAdmission}`,
    );
  }
  for (const [jobId, job] of Object.entries(publisher.jobs ?? {})) {
    const steps = job?.steps ?? [];
    const checkouts = steps.filter((step) => step?.uses?.startsWith("actions/checkout@"));
    const trusted = (step) => step.with?.ref === trustedCheckoutRef && step.with?.["persist-credentials"] === false;
    if (steps[0] !== checkouts[0] || checkouts.length === 0 || !checkouts.every(trusted)) {
      violations.push(
        `${publisherWorkflowPath}: job '${jobId}' must first check out ref ${trustedCheckoutRef} with persist-credentials: false, and check out nothing else.`,
      );
    }
    if (jobId !== publisherJobId && ![job?.needs].flat().includes(publisherJobId)) {
      violations.push(
        `${publisherWorkflowPath}: job '${jobId}' must need '${publisherJobId}' so its admission gates it.`,
      );
    }
  }
  if (publisher.on?.workflow_dispatch?.inputs) {
    violations.push(`${publisherWorkflowPath}: the publisher must not accept inputs; sources and digests are fixed.`);
  }
  if (typeof publisher.permissions !== "object" || Object.keys(publisher.permissions ?? {}).length > 0) {
    violations.push(`${publisherWorkflowPath}: top-level permissions must be {}.`);
  }
  if (JSON.stringify(publisher).includes("secrets.")) {
    violations.push(`${publisherWorkflowPath}: the publisher must not read repository secrets (no PAT).`);
  }
  const tokenSteps = Object.values(publisher.jobs ?? {}).flatMap((job) =>
    (job?.steps ?? []).filter((step) => JSON.stringify(step?.env ?? {}).includes("github.token")),
  );
  const threaded = publisher.jobs?.[publisherJobId]?.steps?.find(
    (step) => step?.env?.GHCR_PUBLISH_TOKEN === "${{ github.token }}",
  );
  if (!threaded || tokenSteps.length !== 1 || tokenSteps[0] !== threaded) {
    violations.push(
      `${publisherWorkflowPath}: exactly one publish step must thread GHCR_PUBLISH_TOKEN: \${{ github.token }}.`,
    );
  }
  return violations;
}

function writeReceipt(receipt, receiptPath) {
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const lines =
    receipt.kind === "publish"
      ? [
          "## CI image mirror publication",
          "",
          "| Source | Source digest | Tag now | Mirror digest | Copied | Manifests |",
          "|---|---|---|---|---|---|",
          ...receipt.rows.map(
            (row) =>
              `| \`${row.sourceTag}\` | \`${row.sourceDigest}\` | ${row.sourceTagMoved === null ? "unknown" : row.sourceTagMoved ? `moved to \`${row.sourceTagDigest}\`` : "unchanged"} | \`${row.mirrorDigest}\` | ${row.copied} | ${row.children.length} |`,
          ),
        ]
      : [
          "## Anonymous cold mirror probe",
          "",
          `Docker Hub canary \`${receipt.hubCanary}\` was blocked: \`${receipt.hubBlockEvidence}\`.`,
          "",
          "| Mirror | Pulled at |",
          "|---|---|",
          ...receipt.rows.map((row) => `| \`${row.reference}\` | ${row.pulledAt} |`),
        ];
  appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

const usage = [
  "Usage: node scripts/ci-image-sources.mjs <publish|probe> --receipt <path>",
  "       node scripts/ci-image-sources.mjs docker-hub-hosts",
  "       node scripts/ci-image-sources.mjs hub-block-preflight",
  "       node scripts/ci-image-sources.mjs hub-block-canary --status <exit status>  (canary pull output on stdin)",
].join("\n");

// The block-docker-hub action's steps: hosts lines, preflight, and the
// classification of its own bounded canary pull.
function hubBlockCommand(command, rest) {
  if (command === "docker-hub-hosts") {
    console.log(dockerHubHostsLines().join("\n"));
  } else if (command === "hub-block-preflight") {
    const { daemonVersion } = dockerHubBlockPreflight({
      docker: (args, { timeoutMs } = {}) => run("docker", args, { timeoutMs }),
      resolveHost: resolveWithGetent,
    });
    console.log(
      `Docker daemon ${daemonVersion} answered; ${dockerHubHosts.length} Docker Hub names resolve only to block sinks.`,
    );
  } else {
    const status = rest[rest.indexOf("--status") + 1];
    if (!rest.includes("--status") || !/^\d+$/.test(status ?? "")) {
      throw new Error(usage);
    }
    const { evidence } = classifyDockerHubCanaryPull({ status: Number(status), output: readFileSync(0, "utf8") });
    console.log(`Docker Hub block verified: ${evidence}`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (["docker-hub-hosts", "hub-block-preflight", "hub-block-canary"].includes(command)) {
    hubBlockCommand(command, rest);
    return;
  }
  const receiptIndex = rest.indexOf("--receipt");
  const receiptPath = receiptIndex >= 0 ? rest[receiptIndex + 1] : undefined;
  if (!["publish", "probe"].includes(command) || !receiptPath) {
    throw new Error(usage);
  }

  const sources = loadImageSources();
  let receipt;
  if (command === "publish") {
    receipt = await publishMirrors({ sources });
  } else {
    const dockerConfig = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "ci-image-mirror-docker-"));
    const docker = (args, { timeoutMs = 600_000 } = {}) =>
      run("docker", args, { env: { ...process.env, DOCKER_CONFIG: dockerConfig }, timeoutMs });
    receipt = probeAnonymousMirrors({ sources, docker });
  }
  writeReceipt(receipt, receiptPath);
  console.log(`${receipt.kind}: ${receipt.rows.length}/${sources.length} pinned images verified.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error title=CI image mirrors::${error.message}`);
    process.exit(1);
  });
}
