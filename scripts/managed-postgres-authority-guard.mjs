#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { AUTHORITY_ROOT, validateManagedPostgresAuthoritySources } from "./managed-postgres-authority-sources.mjs";

const MANIFEST_PATH = "scripts/managed-postgres-authority-manifest.json";
const SCHEMA_PATH = "scripts/managed-postgres-authority-manifest.schema.json";
const CANONICAL_BOUNDARY_ACTION = "./.github/actions/export-managed-postgres-authority";
const ROOT_AUTHORITY_SECRETS = new Set(["DIGITALOCEAN_ACCESS_TOKEN", "SPACES_ACCESS_ID", "SPACES_SECRET_KEY"]);
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);
const ACTION_MANIFEST_NAMES = new Set(["action.yml", "action.yaml"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".pnpm"]);
const MAX_OUTSTANDING_READDIRS = 4;
const SECRET_REFERENCE = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const REMOTE_PINNED_USES = /^[^/@\s]+\/[^@\s]+(?:\/[^@\s]+)*@[0-9a-f]{40}$/i;
const TLS_DOWNGRADE =
  /(?:rejectUnauthorized\s*:\s*false|sslmode\s*(?:=|["']?\s*[,):]\s*["']?)require\b|PGSSLMODE\s*[:=]\s*["']?require\b|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0\b)/i;
const CONNECTION_URL = /\bpostgres(?:ql)?:\/\//i;
const CONNECTION_URL_TEXT = /\bpostgres(?:ql)?:\/\/[^\s"'`;]*/gi;
const DISCRETE_CONNECTION_ASSIGNMENT = /\bPG(?:HOST|PORT|USER|PASSWORD|DATABASE|SSLMODE)\b\s*(?::|=)\s*(?![=])/i;
// Compose Postgres answers only as `postgres` and as the exact preview alias in docker-compose.pr-smoke.yml.
const COMPOSE_PREVIEW_POSTGRES_HOST = "chase-sets-platform-chase-sets-platform-preview-postgres";
const LOCAL_POSTGRES_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "postgres", COMPOSE_PREVIEW_POSTGRES_HOST]);
const POD_INTERNAL_EXECUTION = /\bkubectl\b[^\n]*(?:\bexec\b|\bcp\b)|\bexecFile\b[^\n]*["']kubectl["']/i;
const KUBERNETES_RUNTIME_SECRET_EXPORT =
  /kind\s*:\s*["']Secret["'][\s\S]*Buffer\.from\s*\([^)]*["']utf8["'][^)]*\)\.toString\s*\(\s*["']base64["']\s*\)[\s\S]*(?:kubectl|applyManifest)/i;
const CA_CLEANUP = /\brm\b[^\n]*(?:PGSSLROOTCERT|MANAGED_POSTGRES_CA_PATH|digitalocean-managed-postgres-ca\.pem)/i;
const RUNTIME_FILE_REFERENCE = new RegExp(
  String.raw`(?:^|\n|&&|;)\s*(?:node|bash|sh|pwsh|powershell|python(?:3)?)\b[^\n;&|]*?\s+((?:\.{0,2}/)?[a-zA-Z0-9_@.-]+(?:/[a-zA-Z0-9_@.-]+)+\.(?:mjs|cjs|js|ts|tsx|sh|bash|ps1|py))(?=$|[\s"'\x60),;])`,
  "gm",
);
const DIRECT_FILE_REFERENCE = new RegExp(
  String.raw`(?:^|\n|&&|;)\s*((?:\.{1,2}/)[a-zA-Z0-9_@.-]+(?:/[a-zA-Z0-9_@.-]+)*\.(?:mjs|cjs|js|ts|tsx|sh|bash|ps1|py))(?=$|[\s"'\x60),;])`,
  "gm",
);
const LOCAL_MODULE_REFERENCE = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["']((?:\.{1,2}/)[a-zA-Z0-9_@./-]+\.(?:mjs|cjs|js|ts|tsx|sh|bash|ps1|py))["']`,
  "gm",
);
const PACKAGE_RUN_REFERENCE = /\b(?:pnpm|npm|yarn)\s+(?:--silent\s+)?run\s+([a-zA-Z0-9:_-]+)/g;
const FILTERED_PACKAGE_RUN_REFERENCE = /\bpnpm\s+--filter\s+(?:["']([^"']+)["']|([^\s]+))\s+run\s+([a-zA-Z0-9:_-]+)/g;

export async function scanManagedPostgresAuthority(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const violations = [];
  const yamlPaths = await enumerateYamlIngressFiles(repositoryRoot);
  const parsedFiles = [];

  for (const path of yamlPaths) {
    const file = repositoryPath(repositoryRoot, path);
    let source;
    try {
      source = await readFile(path, "utf8");
      const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
      if (document.errors.length > 0) {
        violations.push(violation("yaml-parse-failed", { file }));
        continue;
      }
      const value = document.toJS({ maxAliasCount: 100 });
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        violations.push(violation("yaml-parse-failed", { file }));
        continue;
      }
      parsedFiles.push({
        absolutePath: path,
        file,
        kind: isWorkflowPath(file) ? "workflow" : "action",
        value,
      });
    } catch {
      violations.push(violation("yaml-parse-failed", { file }));
    }
  }

  const discovery = discoverIngressAndSteps(parsedFiles, violations);
  await validateUsesTargets(repositoryRoot, discovery.usesSites, parsedFiles, violations);

  const { manifest, schemaValid } = await loadAndValidateManifest(repositoryRoot, violations);
  const sourceResult = await validateManagedPostgresAuthoritySources(repositoryRoot);
  if (!sourceResult.valid) {
    violations.push(violation("authority-source-invalid", { file: AUTHORITY_ROOT }));
  }
  const reconciliation = reconcileIngress(discovery.ingresses, schemaValid ? manifest.grants : [], violations);
  const boundary = enforceBoundaryInvariants({
    discovery,
    manifest: schemaValid ? manifest : { grants: [], dockerConsumers: [] },
    violations,
  });
  const layerB = await scanLayerB(repositoryRoot, parsedFiles, violations);
  const uniqueViolations = deduplicateAndSortViolations(violations);
  const totalYamlFileCount = yamlPaths.length;
  const scannedYamlFileCount = parsedFiles.length;

  return {
    schemaVersion: 1,
    workflowFileCount: parsedFiles.filter(({ kind }) => kind === "workflow").length,
    actionManifestFileCount: parsedFiles.filter(({ kind }) => kind === "action").length,
    totalYamlFileCount,
    scannedYamlFileCount,
    yamlCoverage: `${scannedYamlFileCount}/${totalYamlFileCount}`,
    totalIngressCount: discovery.ingresses.length,
    manifestedIngressCount: reconciliation.matchedCount,
    manifestGrantCount: schemaValid ? manifest.grants.length : 0,
    ingressCoverage: `${reconciliation.matchedCount}/${discovery.ingresses.length}`,
    boundaryConsumerCount: boundary.consumers.length,
    boundaryConsumers: boundary.consumers,
    scannedExecutableSurfaceCount: layerB.scannedSurfaceCount,
    violations: uniqueViolations,
  };
}

async function enumerateYamlIngressFiles(repositoryRoot) {
  const workflowsRoot = resolve(repositoryRoot, ".github/workflows");
  const repositoryTree = await readDirectoryTree(repositoryRoot, workflowsRoot);
  // Root traversal cannot reach a missing, linked or differently cased workflows root.
  const workflowsTree = repositoryTree.workflowsNode ?? (await readDirectoryTree(workflowsRoot, workflowsRoot)).root;
  const workflowFiles = collectSelectedFiles(workflowsTree, "workflow", []).sort(comparePaths);
  const actionFiles = collectSelectedFiles(repositoryTree.root, "action", []).sort(comparePaths);
  return [...new Set([...workflowFiles, ...actionFiles])].sort(comparePaths);
}

async function readDirectoryTree(directory, workflowsRoot) {
  const root = directoryNode(directory, directory === workflowsRoot);
  let workflowsNode = null;
  const waiting = [root];
  const reading = new Set();
  let failure = null;
  while (waiting.length > 0 || reading.size > 0) {
    while (failure === null && waiting.length > 0 && reading.size < MAX_OUTSTANDING_READDIRS) {
      const read = readDirectoryEntries(waiting.shift(), workflowsRoot)
        .then(
          (children) => {
            for (const child of children) {
              if (child.path === workflowsRoot) workflowsNode = child;
              waiting.push(child);
            }
          },
          (error) => {
            failure ??= { error };
          },
        )
        .finally(() => reading.delete(read));
      reading.add(read);
    }
    // After a failure, settle every outstanding read before rejecting.
    if (reading.size === 0) break;
    await Promise.race(reading);
  }
  if (failure) throw failure.error;
  return { root, workflowsNode };
}

async function readDirectoryEntries(node, workflowsRoot) {
  const children = [];
  const entries = await readdirIfPresent(node.path);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const path = resolve(node.path, entry.name);
      const child = directoryNode(path, node.inWorkflows || path === workflowsRoot);
      node.entries.push({ directory: child });
      children.push(child);
    } else if (entry.isFile()) {
      const workflow = node.inWorkflows && YAML_EXTENSIONS.has(extname(entry.name));
      const action = ACTION_MANIFEST_NAMES.has(entry.name.toLowerCase());
      if (workflow || action) node.entries.push({ path: resolve(node.path, entry.name), workflow, action });
    }
  }
  return children;
}

function directoryNode(path, inWorkflows) {
  return { path, inWorkflows, entries: [] };
}

function collectSelectedFiles(node, selection, files) {
  for (const entry of node.entries) {
    if (entry.directory) collectSelectedFiles(entry.directory, selection, files);
    else if (entry[selection]) files.push(entry.path);
  }
  return files;
}

function discoverIngressAndSteps(parsedFiles, violations) {
  const ingresses = [];
  const steps = [];
  const usesSites = [];

  for (const parsed of parsedFiles) {
    if (parsed.kind === "workflow") {
      collectSecretReferences(parsed.value, {
        file: parsed.file,
        jobId: "workflow",
        stepAnchor: "workflow",
        scope: "workflow",
        ingresses,
        excludeKeys: new Set(["jobs"]),
      });
      for (const [jobId, job] of Object.entries(parsed.value.jobs ?? {})) {
        if (!job || typeof job !== "object" || Array.isArray(job)) {
          continue;
        }
        const jobUses = typeof job.uses === "string" ? job.uses : null;
        if (job.secrets === "inherit") {
          violations.push(violation("secrets-inherit-forbidden", { file: parsed.file, jobId, stepAnchor: "job" }));
        } else if (job.secrets && typeof job.secrets === "object") {
          collectSecretReferences(job.secrets, {
            file: parsed.file,
            jobId,
            stepAnchor: jobUses ? `uses:${jobUses}` : "job",
            scope: "job-call",
            ingresses,
          });
        }
        collectSecretReferences(job, {
          file: parsed.file,
          jobId,
          stepAnchor: "job",
          scope: "job",
          ingresses,
          excludeKeys: new Set(["steps", "secrets"]),
        });
        if (jobUses) {
          usesSites.push({ file: parsed.file, jobId, stepAnchor: `uses:${jobUses}`, target: jobUses, kind: "job" });
        }
        collectSteps(parsed.file, jobId, job.steps, ingresses, steps, usesSites);
      }
      continue;
    }

    collectSecretReferences(parsed.value, {
      file: parsed.file,
      jobId: "action",
      stepAnchor: "action",
      scope: "action",
      ingresses,
      excludeKeys: new Set(["runs"]),
    });
    collectSecretReferences(parsed.value.runs, {
      file: parsed.file,
      jobId: "action",
      stepAnchor: "action",
      scope: "action",
      ingresses,
      excludeKeys: new Set(["steps"]),
    });
    collectSteps(parsed.file, "action", parsed.value.runs?.steps, ingresses, steps, usesSites);
  }
  return { ingresses, steps, usesSites };
}

function collectSteps(file, jobId, candidateSteps, ingresses, steps, usesSites) {
  if (!Array.isArray(candidateSteps)) {
    return;
  }
  const usesCounts = new Map();
  for (const [index, step] of candidateSteps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      continue;
    }
    const target = typeof step.uses === "string" ? step.uses : null;
    let stepAnchor;
    if (target) {
      const occurrence = (usesCounts.get(target) ?? 0) + 1;
      usesCounts.set(target, occurrence);
      stepAnchor = `uses:${target}${occurrence > 1 ? `#${occurrence}` : ""}`;
    } else if (typeof step.name === "string" && step.name.trim()) {
      stepAnchor = `name:${step.name.trim()}#${index + 1}`;
    } else {
      stepAnchor = `step:${index + 1}`;
    }
    const record = { file, jobId, stepAnchor, step, target, index: index + 1 };
    steps.push(record);
    if (target) {
      usesSites.push({ file, jobId, stepAnchor, target, kind: "step" });
    }
    collectSecretReferences(step, {
      file,
      jobId,
      stepAnchor,
      scope: "step",
      ingresses,
    });
  }
}

function collectSecretReferences(value, context) {
  if (typeof value === "string") {
    SECRET_REFERENCE.lastIndex = 0;
    for (const match of value.matchAll(SECRET_REFERENCE)) {
      context.ingresses.push({
        file: context.file,
        jobId: context.jobId,
        stepAnchor: context.stepAnchor,
        secretName: match[1],
        scope: context.scope,
      });
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretReferences(item, context);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (context.excludeKeys?.has(key)) {
      continue;
    }
    collectSecretReferences(child, context);
  }
}

async function validateUsesTargets(repositoryRoot, usesSites, parsedFiles, violations) {
  const parsedByPath = new Map(parsedFiles.map((file) => [file.file, file]));
  for (const site of usesSites) {
    const { target } = site;
    if (target.startsWith("docker://")) {
      continue;
    }
    if (target.startsWith("./")) {
      const targetPath = resolve(repositoryRoot, target.slice(2));
      if (!isWithinRepository(repositoryRoot, targetPath)) {
        violations.push(violation("uses-kind-unknown", site));
        continue;
      }
      const details = await statIfPresent(targetPath);
      if (!details) {
        violations.push(violation("referenced-executable-missing", site));
        continue;
      }
      if (details.isDirectory()) {
        const actionPath = await firstExistingFile([
          resolve(targetPath, "action.yml"),
          resolve(targetPath, "action.yaml"),
        ]);
        if (!actionPath) {
          violations.push(violation("referenced-executable-missing", site));
        }
        continue;
      }
      const referencedPath = repositoryPath(repositoryRoot, targetPath);
      const reusable = parsedByPath.get(referencedPath);
      if (!YAML_EXTENSIONS.has(extname(targetPath)) || !reusable || !hasWorkflowCall(reusable.value)) {
        violations.push(violation("uses-kind-unknown", site));
      }
      continue;
    }
    if (!REMOTE_PINNED_USES.test(target)) {
      violations.push(violation("uses-kind-unknown", site));
    }
  }
}

async function loadAndValidateManifest(repositoryRoot, violations) {
  const manifestFile = resolve(repositoryRoot, MANIFEST_PATH);
  const schemaFile = resolve(repositoryRoot, SCHEMA_PATH);
  let manifest;
  let schema;
  try {
    [manifest, schema] = await Promise.all([
      readFile(manifestFile, "utf8").then(JSON.parse),
      readFile(schemaFile, "utf8").then(JSON.parse),
    ]);
  } catch {
    violations.push(violation("manifest-schema-invalid", { file: MANIFEST_PATH }));
    return { manifest: { grants: [], dockerConsumers: [] }, schemaValid: false };
  }
  const errors = validateManifestAgainstSchema(manifest, schema);
  if (errors.length > 0) {
    violations.push(violation("manifest-schema-invalid", { file: MANIFEST_PATH }));
    return { manifest: { grants: [], dockerConsumers: [] }, schemaValid: false };
  }
  return {
    manifest: { ...manifest, dockerConsumers: manifest.dockerConsumers ?? [] },
    schemaValid: true,
  };
}

function validateManifestAgainstSchema(manifest, schema) {
  const errors = [];
  const purposeValues = schema?.properties?.grants?.items?.properties?.purpose?.enum;
  const grantKeys = ["file", "jobId", "purpose", "secretName", "stepAnchor"];
  const dockerKeys = ["file", "jobId", "pathMapping", "stepAnchor"];
  if (schema?.properties?.schemaVersion?.const !== 1 || !Array.isArray(purposeValues)) {
    errors.push("schema");
    return errors;
  }
  if (!plainObject(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.grants)) {
    errors.push("root");
    return errors;
  }
  if (!onlyKeys(manifest, ["schemaVersion", "grants", "dockerConsumers"])) {
    errors.push("root-properties");
  }
  for (const grant of manifest.grants) {
    if (
      !plainObject(grant) ||
      !onlyKeys(grant, grantKeys) ||
      !grantKeys.every((key) => typeof grant[key] === "string" && grant[key].length > 0) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(grant.secretName ?? "") ||
      !purposeValues.includes(grant.purpose)
    ) {
      errors.push("grant");
    }
  }
  if (manifest.dockerConsumers !== undefined && !Array.isArray(manifest.dockerConsumers)) {
    errors.push("dockerConsumers");
  }
  for (const consumer of manifest.dockerConsumers ?? []) {
    if (
      !plainObject(consumer) ||
      !onlyKeys(consumer, dockerKeys) ||
      !dockerKeys.every((key) => typeof consumer[key] === "string" && consumer[key].length > 0)
    ) {
      errors.push("dockerConsumer");
    }
  }
  return errors;
}

function reconcileIngress(ingresses, grants, violations) {
  const remainingGrants = multiset(grants, grantKey);
  let matchedCount = 0;
  for (const ingress of ingresses) {
    if (takeOne(remainingGrants, grantKey(ingress))) {
      matchedCount += 1;
    } else {
      violations.push(violation("unmanifested-secret-ingress", ingress));
    }
  }
  for (const entries of remainingGrants.values()) {
    for (const entry of entries) {
      violations.push(violation("manifest-entry-unmatched", entry));
    }
  }
  return { matchedCount };
}

function enforceBoundaryInvariants({ discovery, manifest, violations }) {
  const stepByKey = new Map(discovery.steps.map((step) => [stepKey(step), step]));
  const boundaryGrants = manifest.grants.filter(({ purpose }) => purpose === "managed-postgres-boundary");
  const targets = new Set();
  const consumers = new Map();

  for (const grant of boundaryGrants) {
    const step = stepByKey.get(stepKey(grant));
    if (step?.target) {
      targets.add(step.target);
      const key = `${step.file}\u0000${step.jobId}\u0000${step.stepAnchor}`;
      consumers.set(key, publicAnchor(step));
    }
  }
  if (targets.size !== 1 || !targets.has(CANONICAL_BOUNDARY_ACTION)) {
    violations.push(violation("boundary-producer-duplicate", { file: MANIFEST_PATH }));
  }

  for (const ingress of discovery.ingresses) {
    if (ROOT_AUTHORITY_SECRETS.has(ingress.secretName) && !["step", "job-call"].includes(ingress.scope)) {
      violations.push(violation("secret-scope-too-wide", ingress));
    }
  }

  const boundaryJobs = new Map();
  for (const consumer of consumers.values()) {
    boundaryJobs.set(`${consumer.file}\u0000${consumer.jobId}`, consumer);
  }
  for (const consumer of boundaryJobs.values()) {
    const jobSteps = discovery.steps.filter(({ file, jobId }) => file === consumer.file && jobId === consumer.jobId);
    const boundaryActionSteps = jobSteps.filter(({ target }) => target === CANONICAL_BOUNDARY_ACTION);
    const isTrustOnlyJob =
      boundaryActionSteps.length > 0 &&
      boundaryActionSteps.every(({ step }) => step.with?.mode === "trust-only-kubernetes-secret");
    const hasCleanup = jobSteps.some(({ step }) => {
      const condition = typeof step.if === "string" ? step.if : "";
      const command = typeof step.run === "string" ? step.run : "";
      return /\balways\s*\(\s*\)/.test(condition) && CA_CLEANUP.test(command);
    });
    if (!hasCleanup && !isTrustOnlyJob) {
      violations.push(violation("missing-ca-cleanup", consumer));
    }

    for (const step of jobSteps.filter(({ target }) => target?.startsWith("docker://"))) {
      const mapped = manifest.dockerConsumers.some(
        (entry) => entry.file === step.file && entry.jobId === step.jobId && entry.stepAnchor === step.stepAnchor,
      );
      if (!mapped) {
        violations.push(violation("docker-consumer-unsupported", step));
      }
    }
  }
  return { consumers: [...consumers.values()].sort(compareAnchors) };
}

async function scanLayerB(repositoryRoot, parsedFiles, violations) {
  const scan = {
    repositoryRoot,
    violations,
    packageIndex: await loadPackageIndex(repositoryRoot),
    queue: [],
    queued: new Set(),
    expanded: new Set(),
    fileFacts: new Map(),
    sourceFacts: new Map(),
    resolutions: new Map(),
  };

  for (const parsed of parsedFiles) {
    if (parsed.kind === "workflow") {
      for (const [jobId, job] of Object.entries(parsed.value.jobs ?? {})) {
        if (!Array.isArray(job?.steps)) continue;
        for (const [index, step] of job.steps.entries()) {
          if (typeof step?.run === "string") {
            enqueueSurface(scan, {
              id: `${parsed.file}\u0000${jobId}\u0000${index + 1}`,
              file: parsed.file,
              jobId,
              stepAnchor: stepAnchorForIndex(job.steps, index),
              source: step.run,
              baseDirectory: repositoryRoot,
              allowCanonicalProducer: false,
            });
          }
        }
      }
    } else {
      if (typeof parsed.value.runs?.main === "string") {
        const mainPath = resolve(dirname(parsed.absolutePath), parsed.value.runs.main);
        await enqueueFileSurface(scan, mainPath, publicAnchorForAction(parsed.file), false);
      }
      for (const [index, step] of (parsed.value.runs?.steps ?? []).entries()) {
        if (typeof step?.run === "string") {
          enqueueSurface(scan, {
            id: `${parsed.file}\u0000action\u0000${index + 1}`,
            file: parsed.file,
            jobId: "action",
            stepAnchor: stepAnchorForIndex(parsed.value.runs.steps, index),
            source: step.run,
            baseDirectory: dirname(parsed.absolutePath),
            allowCanonicalProducer: parsed.file === ".github/actions/export-managed-postgres-authority/action.yml",
          });
        }
      }
    }
  }

  // Each surface is queued once, so the first context that reaches it anchors its content findings.
  for (let next = 0; next < scan.queue.length; next += 1) {
    const surface = scan.queue[next];
    const facts = await surfaceFacts(scan, surface);
    if (!surface.allowCanonicalProducer) {
      for (const code of facts.tripwires) {
        violations.push(violation(code, surface));
      }
    }
    for (const path of facts.executables) {
      if (!path) {
        violations.push(violation("referenced-executable-missing", surface));
        continue;
      }
      await enqueueFileSurface(
        scan,
        path,
        surface,
        surface.allowCanonicalProducer &&
          repositoryPath(repositoryRoot, path) === "scripts/terraform-state-database-urls.mjs",
      );
    }
    await enqueuePackageScripts(scan, facts, surface);
  }
  return { scannedSurfaceCount: scan.queued.size };
}

function enqueueSurface(scan, surface) {
  if (scan.queued.has(surface.id)) return;
  scan.queued.add(surface.id);
  scan.queue.push(surface);
}

function surfaceFacts(scan, surface) {
  if (surface.facts) return surface.facts;
  if (!scan.sourceFacts.has(surface.id)) {
    scan.sourceFacts.set(surface.id, analyzeSource(scan, surface.source, surface.baseDirectory));
  }
  return scan.sourceFacts.get(surface.id);
}

// Reads and analyzes each file once per invocation and keeps only the derived facts, never its contents.
// Null means the path is outside the repository, missing or unreadable.
function fileFacts(scan, path) {
  if (!scan.fileFacts.has(path)) {
    scan.fileFacts.set(path, readFileFacts(scan, path));
  }
  return scan.fileFacts.get(path);
}

async function readFileFacts(scan, path) {
  if (!isWithinRepository(scan.repositoryRoot, path) || !(await firstExistingFile([path]))) {
    return null;
  }
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const baseDirectory = dirname(path);
  const imports = [];
  for (const reference of matches(source, LOCAL_MODULE_REFERENCE, 1)) {
    imports.push(await resolveReference(scan, baseDirectory, reference));
  }
  return {
    file: repositoryPath(scan.repositoryRoot, path),
    imports,
    ...(await analyzeSource(scan, source, baseDirectory)),
  };
}

async function analyzeSource(scan, source, baseDirectory) {
  const executables = [];
  for (const reference of [
    ...matches(source, RUNTIME_FILE_REFERENCE, 1),
    ...matches(source, DIRECT_FILE_REFERENCE, 1),
  ]) {
    executables.push(await resolveReference(scan, baseDirectory, reference));
  }
  FILTERED_PACKAGE_RUN_REFERENCE.lastIndex = 0;
  PACKAGE_RUN_REFERENCE.lastIndex = 0;
  return {
    tripwires: contentTripwires(source),
    executables,
    filteredPackageRuns: [...source.matchAll(FILTERED_PACKAGE_RUN_REFERENCE)].map((match) => ({
      packageName: match[1] ?? match[2],
      scriptName: match[3],
    })),
    packageRuns: [...source.matchAll(PACKAGE_RUN_REFERENCE)].map((match) => match[1]),
  };
}

function contentTripwires(source) {
  if (POD_INTERNAL_EXECUTION.test(source) || KUBERNETES_RUNTIME_SECRET_EXPORT.test(source)) {
    return [];
  }
  const codes = [];
  const outsideLocalUrls = source.replace(CONNECTION_URL_TEXT, (url) => (isLocalPostgresUrl(url) ? " " : url));
  if (CONNECTION_URL.test(outsideLocalUrls) || DISCRETE_CONNECTION_ASSIGNMENT.test(source)) {
    codes.push("connection-material");
  }
  if (TLS_DOWNGRADE.test(outsideLocalUrls)) {
    codes.push("tls-downgrade");
  }
  return codes;
}

function resolveReference(scan, baseDirectory, reference) {
  const key = `${baseDirectory}\u0000${reference}`;
  if (!scan.resolutions.has(key)) {
    scan.resolutions.set(key, resolveExecutableReference(scan.repositoryRoot, baseDirectory, reference));
  }
  return scan.resolutions.get(key);
}

// Queues path and its local imports in one context (job, step anchor and producer flag), visiting each
// file once per expansion so import cycles terminate. A completed expansion is recorded for every file
// it visited: repeating any of them in the same context would only re-queue queued surfaces and re-emit
// identical findings. Findings anchored to parent.file are not reusable, so those expansions repeat.
async function enqueueFileSurface(scan, path, parent, allowCanonicalProducer) {
  const expansion = { visited: new Set(), reusable: true };
  await expandFileSurface(scan, path, parent, allowCanonicalProducer, expansion);
  if (expansion.reusable) {
    for (const visitedPath of expansion.visited) {
      scan.expanded.add(expansionKey(visitedPath, parent, allowCanonicalProducer));
    }
  }
}

async function expandFileSurface(scan, path, parent, allowCanonicalProducer, expansion) {
  if (expansion.visited.has(path) || scan.expanded.has(expansionKey(path, parent, allowCanonicalProducer))) {
    return;
  }
  expansion.visited.add(path);
  const facts = await fileFacts(scan, path);
  if (!facts) {
    scan.violations.push(violation("referenced-executable-missing", parent));
    expansion.reusable = false;
    return;
  }
  enqueueSurface(scan, {
    id: `file:${facts.file}`,
    file: facts.file,
    jobId: parent.jobId,
    stepAnchor: parent.stepAnchor,
    facts,
    allowCanonicalProducer,
  });
  for (const importedPath of facts.imports) {
    if (!importedPath) {
      scan.violations.push(violation("referenced-executable-missing", { ...parent, file: facts.file }));
      continue;
    }
    await expandFileSurface(scan, importedPath, parent, allowCanonicalProducer, expansion);
  }
}

function expansionKey(path, parent, allowCanonicalProducer) {
  return JSON.stringify([path, parent.jobId, parent.stepAnchor, allowCanonicalProducer]);
}

async function enqueuePackageScripts(scan, facts, surface) {
  for (const { packageName, scriptName } of facts.filteredPackageRuns) {
    const packageRecord = scan.packageIndex.byName.get(packageName);
    if (packageRecord) {
      await enqueuePackageScript(scan, packageRecord, scriptName, surface);
    }
  }
  for (const scriptName of facts.packageRuns) {
    await enqueuePackageScript(scan, scan.packageIndex.root, scriptName, surface);
  }
}

async function enqueuePackageScript(scan, packageRecord, scriptName, parent) {
  const source = packageRecord?.scripts?.[scriptName];
  if (typeof source !== "string") {
    return;
  }
  const surface = {
    id: `${packageRecord.file}#scripts.${scriptName}`,
    file: packageRecord.file,
    jobId: parent.jobId,
    stepAnchor: parent.stepAnchor,
    source,
    baseDirectory: packageRecord.directory,
    allowCanonicalProducer: false,
  };
  enqueueSurface(scan, surface);
  for (const path of (await surfaceFacts(scan, surface)).executables) {
    if (!path) {
      scan.violations.push(violation("referenced-executable-missing", surface));
      continue;
    }
    await enqueueFileSurface(scan, path, surface, false);
  }
}

async function loadPackageIndex(repositoryRoot) {
  const root = await readPackageRecord(repositoryRoot, resolve(repositoryRoot, "package.json"));
  const records = [root];
  for (const pattern of root.workspaces) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const parent = resolve(repositoryRoot, pattern.slice(0, -2));
      for (const entry of await readdirIfPresent(parent)) {
        if (!entry.isDirectory()) continue;
        const packagePath = resolve(parent, entry.name, "package.json");
        if (await firstExistingFile([packagePath])) {
          records.push(await readPackageRecord(repositoryRoot, packagePath));
        }
      }
    } else if (!pattern.includes("*")) {
      const packagePath = resolve(repositoryRoot, pattern, "package.json");
      if (await firstExistingFile([packagePath])) {
        records.push(await readPackageRecord(repositoryRoot, packagePath));
      }
    }
  }
  return {
    root,
    byName: new Map(records.filter(({ name }) => name).map((record) => [record.name, record])),
  };
}

async function readPackageRecord(repositoryRoot, packagePath) {
  let value = {};
  try {
    value = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    // A missing fixture package is a valid empty package index.
  }
  return {
    directory: dirname(packagePath),
    file: repositoryPath(repositoryRoot, packagePath),
    name: value.name ?? null,
    scripts: value.scripts ?? {},
    workspaces: value.workspaces ?? [],
  };
}

async function resolveExecutableReference(repositoryRoot, baseDirectory, reference) {
  const rootRelative = reference.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
  const candidates =
    reference.startsWith("./") || reference.startsWith("../")
      ? [resolve(baseDirectory, reference), resolve(repositoryRoot, reference), resolve(repositoryRoot, rootRelative)]
      : [resolve(repositoryRoot, reference), resolve(baseDirectory, reference)];
  const path = await firstExistingFile(candidates);
  return path && isWithinRepository(repositoryRoot, path) ? path : null;
}

function grantKey(value) {
  return `${value.file}\u0000${value.jobId}\u0000${value.stepAnchor}\u0000${value.secretName}`;
}

function stepKey(value) {
  return `${value.file}\u0000${value.jobId}\u0000${value.stepAnchor}`;
}

function multiset(values, keySelector) {
  const result = new Map();
  for (const value of values) {
    const key = keySelector(value);
    const entries = result.get(key) ?? [];
    entries.push(value);
    result.set(key, entries);
  }
  return result;
}

function takeOne(values, key) {
  const entries = values.get(key);
  if (!entries?.length) return false;
  entries.shift();
  if (entries.length === 0) values.delete(key);
  return true;
}

function violation(code, anchor = {}) {
  return {
    code,
    ...(anchor.file ? { file: anchor.file } : {}),
    ...(anchor.jobId ? { jobId: anchor.jobId } : {}),
    ...(anchor.stepAnchor ? { stepAnchor: anchor.stepAnchor } : {}),
  };
}

function deduplicateAndSortViolations(violations) {
  return [
    ...new Map(
      violations.map((entry) => [
        `${entry.code}\u0000${entry.file ?? ""}\u0000${entry.jobId ?? ""}\u0000${entry.stepAnchor ?? ""}`,
        entry,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      (left.jobId ?? "").localeCompare(right.jobId ?? "") ||
      (left.stepAnchor ?? "").localeCompare(right.stepAnchor ?? ""),
  );
}

function publicAnchor(value) {
  return { file: value.file, jobId: value.jobId, stepAnchor: value.stepAnchor };
}

function publicAnchorForAction(file) {
  return { file, jobId: "action", stepAnchor: "action" };
}

function compareAnchors(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.jobId.localeCompare(right.jobId) ||
    left.stepAnchor.localeCompare(right.stepAnchor)
  );
}

function compareGrants(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.jobId.localeCompare(right.jobId) ||
    left.stepAnchor.localeCompare(right.stepAnchor) ||
    left.secretName.localeCompare(right.secretName) ||
    left.purpose.localeCompare(right.purpose)
  );
}

function stepAnchorForIndex(steps, index) {
  const step = steps[index];
  if (typeof step?.uses === "string") {
    const prior = steps.slice(0, index).filter((candidate) => candidate?.uses === step.uses).length;
    return `uses:${step.uses}${prior > 0 ? `#${prior + 1}` : ""}`;
  }
  if (typeof step?.name === "string" && step.name.trim()) {
    return `name:${step.name.trim()}#${index + 1}`;
  }
  return `step:${index + 1}`;
}

function hasWorkflowCall(value) {
  const trigger = value?.on;
  return plainObject(trigger) && Object.hasOwn(trigger, "workflow_call");
}

function isWorkflowPath(path) {
  return path.startsWith(".github/workflows/") && YAML_EXTENSIONS.has(extname(path));
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function matches(source, pattern, group) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].map((match) => match[group]);
}

// Each URL is classified on its own: it is local only when its single authority host is exactly a loopback or
// Compose Postgres name and no query parameter can redirect it. Only a local URL's own text, including its TLS
// mode, is exempt from the tripwires.
function isLocalPostgresUrl(url) {
  const [, authority, query = ""] = /^[^:]*:\/\/([^/?#]*)[^?#]*(?:\?([^#]*))?/.exec(url);
  const host = /^(?:[^@]*@)?(\[[^\]]*\]|[^:[\]]*)(?::[a-zA-Z0-9_${}.-]+)?$/.exec(authority)?.[1];
  return LOCAL_POSTGRES_HOSTS.has(host?.toLowerCase()) && !/(?:^|&)(?:host|hostaddr)=|%/i.test(query);
}

async function readdirIfPresent(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function statIfPresent(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function firstExistingFile(paths) {
  for (const path of paths) {
    const details = await statIfPresent(path);
    if (details?.isFile()) return path;
  }
  return null;
}

function isWithinRepository(repositoryRoot, path) {
  const value = relative(repositoryRoot, path);
  return value !== ".." && !value.startsWith(`..${sep}`);
}

function repositoryPath(repositoryRoot, path) {
  const value = relative(repositoryRoot, path);
  if (value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error("Path escapes repository.");
  }
  return value.split(sep).join("/");
}

function comparePaths(left, right) {
  return left.localeCompare(right);
}

function readCliOptions(argv) {
  const rootIndex = argv.indexOf("--repository-root");
  const repositoryRoot = rootIndex >= 0 ? argv[rootIndex + 1] : undefined;
  return {
    repositoryRoot,
  };
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  if (process.argv.includes("--generate-manifest")) {
    process.stderr.write("--generate-manifest has been retired; use scripts/managed-postgres-authority-sources.mjs\n");
    process.exitCode = 1;
    return;
  }
  const report = await scanManagedPostgresAuthority({ repositoryRoot });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acquireHeavySlot("script-battery");
  main().catch(() => {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        totalYamlFileCount: 0,
        scannedYamlFileCount: 0,
        yamlCoverage: "0/0",
        totalIngressCount: 0,
        manifestedIngressCount: 0,
        ingressCoverage: "0/0",
        violations: [{ code: "authority-scan-failed" }],
      })}\n`,
    );
    process.exitCode = 1;
  });
}
