import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  applySandboxEnv,
  buildDockerComposeArgs,
  buildSandboxEnv,
  ensureWorktreeSandboxEnvironment,
  normalizeSandboxWorktreeIdentity,
} from "./lib/sandbox.mjs";
import { stopComposePostgresCleanly } from "./lib/postgres-compose-lifecycle.mjs";

const command = process.argv[2] ?? "doctor";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { sandbox, env: sandboxEnv } = ensureWorktreeSandboxEnvironment({ rootDir });
applySandboxEnv(sandboxEnv);
const composeProjectLabel = "com.docker.compose.project";
const composeProjectConfigFilesLabel = "com.docker.compose.project.config_files";
const composeProjectWorkingDirLabel = "com.docker.compose.project.working_dir";
const composeServiceLabel = "com.docker.compose.service";
const sandboxOwnerLabel = "com.chase-sets.sandbox.owner";
const sandboxIdLabel = "com.chase-sets.sandbox.id";
const sandboxWorktreeLabel = "com.chase-sets.sandbox.worktree";
const sandboxOwner = "local-worktree-v1";
const composeProjectPattern = /^chase-sets-([a-z0-9](?:[a-z0-9-]{0,23}))$/;
const composeStatuses = new Set(["created", "dead", "exited", "paused", "removing", "restarting", "running"]);
const resourceSpecs = {
  volume: {
    kindLabel: "com.docker.compose.volume",
    expectedKinds: new Set([
      "chase-sets-postgres-dev-data",
      "chase-sets-prometheus-dev-data",
      "chase-sets-loki-dev-data",
      "chase-sets-tempo-dev-data",
      "chase-sets-grafana-dev-data",
    ]),
  },
  network: {
    kindLabel: "com.docker.compose.network",
    expectedKinds: new Set(["default"]),
  },
};

function printUsage() {
  console.log("Usage:");
  console.log("  node ./scripts/sandbox.mjs doctor      # print current sandbox details");
  console.log("  node ./scripts/sandbox.mjs env         # print generated sandbox env");
  console.log("  node ./scripts/sandbox.mjs compose     # print Docker Compose project details");
  console.log("  node ./scripts/sandbox.mjs down        # stop current sandbox containers");
  console.log("  node ./scripts/sandbox.mjs clean       # stop current sandbox and remove volumes");
  console.log("  node ./scripts/sandbox.mjs list        # list Docker Compose projects");
  console.log("  node ./scripts/sandbox.mjs gc          # remove sandboxes whose worktree no longer exists");
  console.log("  node ./scripts/sandbox.mjs clean-all   # remove all chase-sets-* Compose projects");
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...sandboxEnv,
      ...options.env,
    },
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }

  return result.stdout ?? "";
}

function printDoctor() {
  console.log("");
  console.log(`Worktree sandbox: ${sandbox.id}`);
  console.log(`  Env file:        ${sandbox.envFilePath}`);
  console.log(`  Compose project: ${sandbox.composeProjectName}`);
  console.log(`  Port base:       ${sandbox.basePort}`);
  console.log("");
  console.log("Services");
  console.log(`  Dev portal:      ${sandbox.urls.portal}`);
  console.log(`  Admin web:       ${sandbox.urls.adminWeb}`);
  console.log(`  Marketplace:     ${sandbox.urls.marketplaceWeb}`);
  console.log(`  Public web:      ${sandbox.urls.publicWeb}`);
  console.log(`  Platform API:    ${sandbox.urls.platformApi}`);
  console.log(`  Platform worker: ${sandbox.urls.platformWorker}`);
  console.log("");
  console.log("Databases");
  console.log(`  Admin URL:       ${sandbox.adminDatabaseUrl}`);
  console.log(`  Control URL:     ${sandbox.controlDatabaseUrl}`);
  console.log(`  Context DBs:     ${sandbox.contextNames.length}`);
  console.log("");
  console.log("Observability");
  console.log(`  Grafana:         ${sandbox.urls.grafana}`);
  console.log(`  Prometheus:      ${sandbox.urls.prometheus}`);
  console.log(`  Loki:            ${sandbox.urls.loki}`);
  console.log(`  Tempo:           ${sandbox.urls.tempo}`);
  console.log(`  OTLP HTTP:       ${sandbox.urls.otelHttp}`);
  console.log(`  OTLP gRPC:       ${sandbox.urls.otelGrpc}`);
  console.log("");
}

function printEnv() {
  const env = buildSandboxEnv(sandbox);
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    console.log(`${key}=${value}`);
  }
}

function printCompose() {
  console.log(`COMPOSE_PROJECT_NAME=${sandbox.composeProjectName}`);
  console.log(`COMPOSE_ENV_FILE=${sandbox.envFilePath}`);
  console.log(`docker ${buildDockerComposeArgs(sandbox).join(" ")}`);
}

function composeDown(removeVolumes = false) {
  const invocation = {
    command: "docker",
    args: buildDockerComposeArgs(sandbox),
  };

  if (removeVolumes) {
    runDocker([...invocation.args, "down", "-v"]);
    return;
  }

  return stopComposePostgresCleanly({
    invocation,
    env: sandboxEnv,
    run: (_command, args, options) => runDocker(args, options),
    observe: (observation) => console.log(observation),
  });
}

function listComposeProjects() {
  runDocker(["compose", "ls"], { stdio: "inherit" });
}

function parseComposeStatus(value, projectName) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`Compose project ${projectName} has a missing or malformed status.`);
  }

  const counts = new Map();
  for (const token of value.split(", ")) {
    const match = /^([a-z]+)\(([1-9]\d*)\)$/.exec(token);
    if (!match || !composeStatuses.has(match[1]) || counts.has(match[1])) {
      throw new Error(`Compose project ${projectName} has a missing or malformed status.`);
    }
    counts.set(match[1], Number.parseInt(match[2], 10));
  }
  return counts;
}

function parseComposeProjects(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Docker Compose project discovery returned malformed JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Docker Compose project discovery did not return an array.");
  }

  const projects = [];
  const names = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Docker Compose project discovery returned a malformed record.");
    }
    const name = entry.Name ?? entry.name;
    if (typeof name !== "string" || !name.startsWith("chase-sets-")) {
      continue;
    }
    if (!composeProjectPattern.test(name) || names.has(name)) {
      throw new Error(`Docker Compose project discovery returned an invalid or duplicate project: ${name}.`);
    }
    names.add(name);
    projects.push({
      name,
      statusCounts: parseComposeStatus(entry.Status ?? entry.status, name),
    });
  }
  return projects;
}

function listComposeProjectRecords() {
  const output = runDocker(["compose", "ls", "--all", "--format", "json"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseComposeProjects(output);
}

function parseUniqueLines(output, description, parseLine) {
  if (typeof output !== "string") {
    throw new Error(`${description} returned malformed output.`);
  }
  const records = [];
  const identities = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      continue;
    }
    if (rawLine.trim() !== rawLine) {
      throw new Error(`${description} returned malformed output.`);
    }
    const record = parseLine(rawLine);
    if (!record || identities.has(record.identity)) {
      throw new Error(`${description} returned malformed or duplicate identities.`);
    }
    identities.add(record.identity);
    records.push(record);
  }
  return records;
}

function parseJsonArray(output, description) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${description} returned malformed JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${description} did not return an array.`);
  }
  return parsed;
}

function readLabels(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} has missing or malformed labels.`);
  }
  const labels = {};
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue !== "string") {
      throw new Error(`${description} has missing or malformed labels.`);
    }
    labels[key] = labelValue;
  }
  return labels;
}

function stableLabels(labels) {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function parseSandboxProjectIdentity(projectName, labels, description) {
  const projectMatch = composeProjectPattern.exec(projectName);
  if (!projectMatch) {
    throw new Error(`${description} has an invalid Compose project name.`);
  }
  if (labels[sandboxOwnerLabel] !== sandboxOwner) {
    return null;
  }
  const sandboxId = labels[sandboxIdLabel];
  const worktree = labels[sandboxWorktreeLabel];
  if (
    sandboxId !== projectMatch[1] ||
    typeof worktree !== "string" ||
    worktree.length === 0 ||
    normalizeSandboxWorktreeIdentity(worktree) !== worktree
  ) {
    throw new Error(`${description} has incomplete or conflicting Chase Sets ownership labels.`);
  }
  return { projectName, sandboxId, worktree };
}

function listProjectContainerIds(projectName) {
  const output = runDocker(
    [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      `label=${composeProjectLabel}=${projectName}`,
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  return parseUniqueLines(output, `Container discovery for ${projectName}`, (line) =>
    /^[0-9a-f]{64}$/i.test(line) ? { identity: line, id: line } : null,
  );
}

function inspectContainers(projectName, ids) {
  const output = runDocker(["container", "inspect", ...ids.map(({ id }) => id)], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const parsed = parseJsonArray(output, `Container inspection for ${projectName}`);
  if (parsed.length !== ids.length) {
    throw new Error(`Container inspection for ${projectName} returned an incomplete result.`);
  }

  const expectedIds = new Set(ids.map(({ id }) => id));
  const containers = [];
  const returnedIds = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Container inspection for ${projectName} returned a malformed record.`);
    }
    const id = entry.Id;
    if (typeof id !== "string" || !expectedIds.has(id) || returnedIds.has(id)) {
      throw new Error(`Container inspection for ${projectName} returned a changed or duplicate identity.`);
    }
    returnedIds.add(id);
    const labels = readLabels(entry.Config?.Labels, `Container ${id}`);
    if (labels[composeProjectLabel] !== projectName) {
      throw new Error(`Container ${id} changed Compose project identity during inspection.`);
    }
    const state = entry.State;
    if (
      !state ||
      typeof state !== "object" ||
      typeof state.Running !== "boolean" ||
      typeof state.Status !== "string" ||
      !composeStatuses.has(state.Status)
    ) {
      throw new Error(`Container ${id} has malformed state.`);
    }
    containers.push({
      id,
      labels,
      running: state.Running,
      status: state.Status,
      labelSignature: stableLabels(labels),
    });
  }
  return containers.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function validateOwnedContainers(projectName, containers) {
  const ownerValues = new Set(
    containers.map(({ labels }) => labels[sandboxOwnerLabel]).filter((value) => value !== undefined),
  );
  if (ownerValues.size === 0) {
    return null;
  }
  if (ownerValues.size > 1) {
    throw new Error(`Compose project ${projectName} has conflicting ownership labels.`);
  }
  if (!ownerValues.has(sandboxOwner)) {
    return null;
  }

  let projectIdentity = null;
  for (const container of containers) {
    const description = `Container ${container.id}`;
    const identity = parseSandboxProjectIdentity(projectName, container.labels, description);
    if (!identity) {
      throw new Error(`${description} conflicts with the project's Chase Sets ownership.`);
    }
    if (projectIdentity && identity.worktree !== projectIdentity.worktree) {
      throw new Error(`Compose project ${projectName} has conflicting worktree ownership.`);
    }
    projectIdentity = identity;
    if (
      typeof container.labels[composeServiceLabel] !== "string" ||
      container.labels[composeServiceLabel].length === 0
    ) {
      throw new Error(`${description} has a missing Compose service identity.`);
    }
    const expectedWorkingDir = identity.worktree;
    const expectedConfigFile = normalizeSandboxWorktreeIdentity(`${identity.worktree}/docker-compose.dev.yml`);
    if (
      normalizeSandboxWorktreeIdentity(container.labels[composeProjectWorkingDirLabel] ?? "") !== expectedWorkingDir ||
      normalizeSandboxWorktreeIdentity(container.labels[composeProjectConfigFilesLabel] ?? "") !== expectedConfigFile
    ) {
      throw new Error(`${description} has incomplete or conflicting Compose ownership labels.`);
    }
  }
  return projectIdentity;
}

function inspectProject(projectName, { allowNoContainers = false } = {}) {
  const ids = listProjectContainerIds(projectName);
  if (ids.length === 0) {
    if (allowNoContainers) {
      return null;
    }
    throw new Error(`Compose project ${projectName} has no inspectable containers.`);
  }
  const containers = inspectContainers(projectName, ids);
  const identity = validateOwnedContainers(projectName, containers);
  if (!identity) {
    return { classification: "foreign", containers };
  }
  return {
    classification: "owned",
    identity,
    containers,
    active: containers.some(({ running, status }) => running || status !== "exited"),
  };
}

function validateComposeStatus(project, snapshot) {
  const actualCounts = new Map();
  for (const { status } of snapshot.containers) {
    actualCounts.set(status, (actualCounts.get(status) ?? 0) + 1);
  }
  if (
    project.statusCounts.size !== actualCounts.size ||
    [...project.statusCounts].some(([status, count]) => actualCounts.get(status) !== count)
  ) {
    throw new Error(`Compose project ${project.name} status changed or conflicts with container inspection.`);
  }
}

function sameContainerAuthority(left, right) {
  return (
    left.classification === "owned" &&
    right.classification === "owned" &&
    left.identity.projectName === right.identity.projectName &&
    left.identity.sandboxId === right.identity.sandboxId &&
    left.identity.worktree === right.identity.worktree &&
    left.containers.length === right.containers.length &&
    left.containers.every(
      (container, index) =>
        container.id === right.containers[index].id &&
        container.labelSignature === right.containers[index].labelSignature,
    )
  );
}

function removeComposeProject(projectName) {
  console.log(`Removing ${projectName}...`);
  runDocker([
    "compose",
    "--env-file",
    sandbox.envFilePath,
    "-f",
    "docker-compose.dev.yml",
    "-p",
    projectName,
    "down",
    "-v",
  ]);
}

function listResourceCandidates(resourceType) {
  const args = [
    resourceType,
    "ls",
    "--filter",
    `label=${composeProjectLabel}`,
    ...(resourceType === "network" ? ["--no-trunc"] : []),
    "--format",
    resourceType === "network" ? "{{.ID}}\t{{.Name}}" : "{{.Name}}",
  ];
  const output = runDocker(args, { encoding: "utf8", stdio: "pipe" });
  return parseUniqueLines(output, `${resourceType} discovery`, (line) => {
    if (resourceType === "volume") {
      return /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(line) ? { identity: line, name: line } : null;
    }
    const parts = line.split("\t");
    return parts.length === 2 && /^[0-9a-f]{64}$/i.test(parts[0]) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(parts[1])
      ? { identity: parts[0], id: parts[0], name: parts[1] }
      : null;
  });
}

function inspectResource(resourceType, candidate) {
  const inspectIdentity = resourceType === "network" ? candidate.id : candidate.name;
  const output = runDocker([resourceType, "inspect", inspectIdentity], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const parsed = parseJsonArray(output, `${resourceType} inspection for ${candidate.name}`);
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object" || Array.isArray(parsed[0])) {
    throw new Error(`${resourceType} inspection for ${candidate.name} returned an incomplete result.`);
  }
  const entry = parsed[0];
  const name = entry.Name;
  const id = resourceType === "network" ? entry.Id : name;
  if (
    name !== candidate.name ||
    (resourceType === "network" && id !== candidate.id) ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    throw new Error(`${resourceType} inspection for ${candidate.name} returned a changed identity.`);
  }

  const labels = readLabels(entry.Labels, `${resourceType} ${candidate.name}`);
  const projectName = labels[composeProjectLabel];
  if (typeof projectName !== "string" || !composeProjectPattern.test(projectName)) {
    return { classification: "foreign", resourceType, name, id, labels };
  }
  const identity = parseSandboxProjectIdentity(projectName, labels, `${resourceType} ${candidate.name}`);
  if (!identity) {
    return { classification: "foreign", resourceType, name, id, labels };
  }

  const spec = resourceSpecs[resourceType];
  const kind = labels[spec.kindLabel];
  const oppositeKindLabel = resourceSpecs[resourceType === "volume" ? "network" : "volume"].kindLabel;
  if (
    typeof kind !== "string" ||
    !spec.expectedKinds.has(kind) ||
    labels[oppositeKindLabel] !== undefined ||
    name !== `${projectName}_${kind}`
  ) {
    throw new Error(`${resourceType} ${candidate.name} has missing or conflicting resource-kind labels.`);
  }
  return {
    classification: "owned",
    resourceType,
    name,
    id,
    labels,
    identity,
    kind,
    authoritySignature: JSON.stringify({
      resourceType,
      name,
      id,
      projectName,
      sandboxId: identity.sandboxId,
      worktree: identity.worktree,
      kind,
      labels: stableLabels(labels),
    }),
  };
}

function discoverResources() {
  const snapshots = [];
  const names = new Set();
  const ids = new Set();
  for (const resourceType of ["volume", "network"]) {
    for (const candidate of listResourceCandidates(resourceType)) {
      if (names.has(candidate.name) || (candidate.id && ids.has(candidate.id))) {
        throw new Error("Docker resource discovery returned duplicate or conflicting identities.");
      }
      names.add(candidate.name);
      if (candidate.id) {
        ids.add(candidate.id);
      }
      snapshots.push(inspectResource(resourceType, candidate));
    }
  }
  return snapshots;
}

function removeDetachedResource(snapshot) {
  const projectSnapshot = inspectProject(snapshot.identity.projectName, { allowNoContainers: true });
  if (projectSnapshot) {
    return false;
  }
  const candidate = { name: snapshot.name, id: snapshot.id };
  const reinspected = inspectResource(snapshot.resourceType, candidate);
  if (reinspected.classification !== "owned" || reinspected.authoritySignature !== snapshot.authoritySignature) {
    throw new Error(`${snapshot.resourceType} ${snapshot.name} changed authority before removal.`);
  }
  console.log(`Removing orphaned ${snapshot.resourceType} ${snapshot.name} (${snapshot.identity.projectName})...`);
  runDocker([snapshot.resourceType, "rm", snapshot.resourceType === "network" ? snapshot.id : snapshot.name]);
  return true;
}

function listRegisteredWorktreeIdentities() {
  const result = spawnSync("git", ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git worktree discovery exited with code ${result.status ?? "unknown"}.`);
  }
  const output = String(result.stdout ?? "");
  if (output.trim().length === 0) {
    throw new Error("git worktree discovery returned no registered worktrees.");
  }

  const identities = new Set();
  for (const block of output.trim().split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const worktreeLines = lines.filter((line) => line.startsWith("worktree "));
    const headLines = lines.filter((line) => line.startsWith("HEAD "));
    const branchLines = lines.filter((line) => line.startsWith("branch "));
    const detachedLines = lines.filter((line) => line === "detached");
    if (
      worktreeLines.length !== 1 ||
      headLines.length !== 1 ||
      !/^HEAD [0-9a-f]{40,64}$/i.test(headLines[0]) ||
      branchLines.length + detachedLines.length !== 1 ||
      (branchLines.length === 1 && !/^branch refs\/\S+$/.test(branchLines[0]))
    ) {
      throw new Error("git worktree discovery returned malformed porcelain output.");
    }
    const allowed = new Set([...worktreeLines, ...headLines, ...branchLines, ...detachedLines]);
    if (
      new Set(lines).size !== lines.length ||
      lines.some((line) => !allowed.has(line) && !/^(locked|prunable)( .+)?$/.test(line))
    ) {
      throw new Error("git worktree discovery returned malformed porcelain output.");
    }
    const worktreePath = worktreeLines[0].slice("worktree ".length);
    if (worktreePath.trim() !== worktreePath || worktreePath.length === 0 || !path.isAbsolute(worktreePath)) {
      throw new Error("git worktree discovery returned an invalid worktree path.");
    }
    const identity = normalizeSandboxWorktreeIdentity(worktreePath);
    if (identities.has(identity)) {
      throw new Error("git worktree discovery returned an ambiguous worktree identity.");
    }
    identities.add(identity);
  }
  return identities;
}

function discoverOwnedProjects() {
  return listComposeProjectRecords().map((project) => {
    const snapshot = inspectProject(project.name);
    if (snapshot.classification === "owned") {
      validateComposeStatus(project, snapshot);
    }
    return { project, snapshot };
  });
}

function cleanAllSandboxes() {
  const discoveredProjects = discoverOwnedProjects();
  const resources = discoverResources();
  const plannedProjectNames = new Set(
    discoveredProjects.filter(({ snapshot }) => snapshot.classification === "owned").map(({ project }) => project.name),
  );
  let removedProjects = 0;
  for (const { project, snapshot } of discoveredProjects) {
    if (snapshot.classification !== "owned") {
      continue;
    }
    const reinspected = inspectProject(project.name);
    if (!sameContainerAuthority(snapshot, reinspected)) {
      throw new Error(`Compose project ${project.name} changed authority before removal.`);
    }
    removeComposeProject(project.name);
    removedProjects += 1;
  }
  let removedResources = 0;
  for (const resource of resources) {
    if (
      resource.classification === "owned" &&
      !plannedProjectNames.has(resource.identity.projectName) &&
      removeDetachedResource(resource)
    ) {
      removedResources += 1;
    }
  }

  if (removedProjects === 0 && removedResources === 0) {
    console.log("No owned Chase Sets Compose projects or resources found.");
  }
}

function gcSandboxes() {
  const registeredWorktrees = listRegisteredWorktreeIdentities();
  const discoveredProjects = discoverOwnedProjects();
  const resources = discoverResources();
  const plannedProjects = discoveredProjects.filter(
    ({ project, snapshot }) =>
      snapshot.classification === "owned" &&
      !registeredWorktrees.has(snapshot.identity.worktree) &&
      [...project.statusCounts.keys()].every((status) => status === "exited") &&
      !snapshot.active,
  );
  const plannedProjectNames = new Set(plannedProjects.map(({ project }) => project.name));
  let removedProjects = 0;
  for (const { project, snapshot } of plannedProjects) {
    const reinspected = inspectProject(project.name);
    if (!sameContainerAuthority(snapshot, reinspected)) {
      throw new Error(`Compose project ${project.name} changed authority before removal.`);
    }
    if (reinspected.active) {
      continue;
    }
    removeComposeProject(project.name);
    removedProjects += 1;
  }

  let removedResources = 0;
  for (const resource of resources) {
    if (
      resource.classification === "owned" &&
      !registeredWorktrees.has(resource.identity.worktree) &&
      !plannedProjectNames.has(resource.identity.projectName) &&
      removeDetachedResource(resource)
    ) {
      removedResources += 1;
    }
  }

  if (removedProjects === 0 && removedResources === 0) {
    console.log("No safely reclaimable orphaned Chase Sets sandboxes or resources found.");
  }
}

try {
  if (command === "doctor") {
    printDoctor();
  } else if (command === "env") {
    printEnv();
  } else if (command === "compose") {
    printCompose();
  } else if (command === "down") {
    await composeDown(false);
  } else if (command === "clean") {
    composeDown(true);
  } else if (command === "list") {
    listComposeProjects();
  } else if (command === "gc") {
    gcSandboxes();
  } else if (command === "clean-all") {
    cleanAllSandboxes();
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
