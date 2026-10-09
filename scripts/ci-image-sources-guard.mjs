// Required-CI image guard (#9230). Discovers every image a required job can
// pull or build: workflow services and containers, docker:// actions,
// setup-buildx builders (including the implicit default), shell
// pull/run/build commands, Dockerfiles (FROM, syntax, COPY --from), and
// Compose files launched by workflows or scripts. Any Docker Hub or
// non-sha256 reference is refused. Required workflows are found by trigger
// and reusable-workflow calls, never by file name.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  isSha256Digest,
  loadImageSources,
  mirrorRepositoryPrefix,
  publisherBoundaryViolations,
  workflowTriggers,
} from "./ci-image-sources.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const guardPath = "scripts/ci-image-sources-guard.mjs";
const requiredEvents = new Set(["pull_request", "pull_request_target", "merge_group"]);
const hubRegistries = new Set(["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"]);
const buildxDefaultBuilder = "moby/buildkit:buildx-stable-1";
const launcherScriptPattern = /\.(?:mjs|cjs|js|ts|sh|ps1)$/;
const composeFileLiteral = /["'`]((?:[\w.-]+\/)*(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml)["'`]/g;
const profileEnablement = [
  /--profile["'`]?\s*,?\s*["'`]?([\w-]+)/g,
  /COMPOSE_PROFILES["'`]?\s*[:=]\s*["'`]?([\w,-]+)/g,
];

// Scripts that enable Compose profiles but that no required job launches.
const devOnlyProfileLaunchers = new Map([
  ["scripts/observability-stack.mjs", "local `pnpm run dev:observability` stack; no required job launches it"],
]);
// Pulls that must fail: the Hub-block canary proves Docker Hub is unreachable.
const expectedUnreachableCanaries = new Map([
  [".github/actions/block-docker-hub/action.yml", "docker.io/library/hello-world:latest"],
]);

const runValueFlags = new Set(
  "-e --env --env-file -v --volume -w --workdir -p --publish --name --network --net -u --user --entrypoint --mount --platform --add-host -l --label --label-file -m --memory --cpus --shm-size --restart --health-cmd --health-interval --health-timeout --health-retries --health-start-period --cap-add --cap-drop --device --tmpfs --ulimit --log-driver --log-opt -h --hostname --pid --ipc --security-opt --cidfile --gpus --runtime --stop-signal --stop-timeout --volumes-from --link --dns --cgroupns --pull --userns --group-add".split(
    " ",
  ),
);
const buildValueFlags = new Set(
  "-f --file -t --tag --target --platform --build-arg --cache-from --cache-to --label --secret --ssh -o --output --progress --builder --network --add-host --iidfile --metadata-file --build-context --annotation --attest --sbom --provenance --shm-size --ulimit --allow --call".split(
    " ",
  ),
);
const composeValueFlags = new Set(
  "-f --file -p --project-name --profile --env-file --project-directory --ansi --parallel --progress".split(" "),
);

export function createRepoReader(rootDir = repoRoot, overrides = {}) {
  function read(relativePath) {
    if (Object.hasOwn(overrides, relativePath)) return overrides[relativePath];
    const absolute = path.join(rootDir, relativePath);
    return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : null;
  }

  function list(directory, { recursive = false } = {}) {
    const found = new Set();
    const walk = (relative) => {
      const absolute = path.join(rootDir, relative);
      if (!existsSync(absolute)) return;
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (recursive && entry.name !== "node_modules") walk(child);
        } else {
          found.add(child);
        }
      }
    };
    walk(directory);
    for (const [file, content] of Object.entries(overrides)) {
      const rest = file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : null;
      if (rest === null || (!recursive && rest.includes("/"))) continue;
      if (content === null) found.delete(file);
      else found.add(file);
    }
    return [...found].sort();
  }

  return { read, list };
}

function normalizeRepoPath(value) {
  return path.posix.normalize(String(value).replace(/\\/g, "/")).replace(/^\.\//, "");
}

// Returns why a reference is refused, or null when it is a sha256-pinned
// non-Hub image (and, for mirrors, the digest the source map pins).
export function imageReferenceRefusal(reference, sources) {
  const value = reference.replace(/^docker:\/\//, "");
  const at = value.indexOf("@");
  const name = at >= 0 ? value.slice(0, at) : value;
  const digest = at >= 0 ? value.slice(at + 1) : null;
  const first = name.split("/")[0];
  const hasRegistry = name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (!hasRegistry) return "Docker Hub reference (implicit docker.io)";
  if (hubRegistries.has(first)) return "Docker Hub reference";
  if (!isSha256Digest(digest)) return "not pinned by a sha256 digest";
  const tagMatch = /^(.*?)(?::([^/:]+))?$/.exec(name);
  const repository = tagMatch?.[1] ?? name;
  if (repository.startsWith(mirrorRepositoryPrefix)) {
    const entry = sources.find((source) => source.mirror === repository);
    if (!entry) return "unknown CI mirror; add it to scripts/ci-image-sources.json";
    if (entry.digest !== digest) return `mirror digest differs from scripts/ci-image-sources.json (${entry.digest})`;
    if (tagMatch?.[2] && tagMatch[2] !== entry.tag)
      return `mirror tag differs from scripts/ci-image-sources.json (${entry.tag})`;
  }
  return null;
}

function shellWords(text) {
  const words = [];
  let current = "";
  let started = false;
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else if (";|&)".includes(char) || (char === "#" && !started)) {
      break;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

function logicalLines(script) {
  return String(script)
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/);
}

function shellAssignments(script) {
  const assignments = new Map();
  for (const line of logicalLines(script)) {
    const match = /^\s*(?:export\s+|local\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (match) assignments.set(match[1], shellWords(match[2])[0] ?? "");
  }
  return assignments;
}

function resolveWord(word, scope) {
  const variable = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(word);
  if (variable) {
    const value = scope.get(variable[1]);
    return typeof value === "string" && !value.includes("$") ? value : null;
  }
  return word.includes("$") ? null : word;
}

function parseArgs(args, valueFlags) {
  const positionals = [];
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const [flag, inline] = arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, null];
      if (inline !== null) values.set(flag, [...(values.get(flag) ?? []), inline]);
      else if (valueFlags.has(flag)) values.set(flag, [...(values.get(flag) ?? []), args[++index] ?? ""]);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, values };
}

function dockerInvocations(script) {
  const invocations = [];
  for (const line of logicalLines(script)) {
    for (const match of line.matchAll(/(?:^|[\s;&|(`"'])(docker-compose|docker)(?=\s)/g)) {
      invocations.push(shellWords(line.slice(match.index + match[0].length - match[1].length)));
    }
  }
  return invocations;
}

function createScan(reader, sources) {
  const candidates = [];
  const violations = [];
  const localTags = new Set();
  const envValues = new Map();
  const dockerfiles = new Map();
  const composeFiles = new Map();
  const enabledProfiles = new Set();
  const scannedActions = new Set();

  const addCandidate = (candidate) => candidates.push(candidate);
  const rememberEnv = (env) => {
    for (const [name, value] of Object.entries(env ?? {})) {
      if (typeof value !== "string") continue;
      envValues.set(name, new Set([...(envValues.get(name) ?? []), value]));
    }
  };
  const requireFile = (map, file, launcher) => {
    if (!map.has(file)) map.set(file, new Set());
    map.get(file).add(launcher);
  };

  function scanDockerCommand(words, scope, location, workingDirectory) {
    const [program, ...rest] = words;
    let args = program === "docker-compose" ? ["compose", ...rest] : rest;
    if (args[0] === "container" || args[0] === "image") args = args.slice(1);
    if (args[0] === "buildx" && args[1] === "build") args = args.slice(1);
    const [subcommand, ...commandArgs] = args;
    const relative = (file) => normalizeRepoPath(path.posix.join(workingDirectory, file));

    if (subcommand === "run" || subcommand === "create" || subcommand === "pull") {
      const { positionals } = parseArgs(commandArgs, subcommand === "pull" ? new Set(["--platform"]) : runValueFlags);
      const raw = positionals[0];
      if (raw) addCandidate({ location, kind: `docker ${subcommand}`, raw, reference: resolveWord(raw, scope) });
    } else if (subcommand === "build") {
      const { positionals, values } = parseArgs(commandArgs, buildValueFlags);
      for (const tag of [...(values.get("-t") ?? []), ...(values.get("--tag") ?? [])]) {
        const resolved = resolveWord(tag, scope);
        if (resolved) localTags.add(resolved);
      }
      const file = values.get("-f")?.[0] ?? values.get("--file")?.[0];
      const context = positionals[0] ?? ".";
      const dockerfile = file
        ? resolveWord(file, scope)
        : resolveWord(context, scope) && `${resolveWord(context, scope)}/Dockerfile`;
      if (dockerfile) requireFile(dockerfiles, relative(dockerfile), location);
      else violations.push(`${location}: cannot resolve the Dockerfile for '${words.join(" ")}'.`);
    } else if (subcommand === "compose") {
      const { values } = parseArgs(commandArgs, composeValueFlags);
      const files = [...(values.get("-f") ?? []), ...(values.get("--file") ?? [])];
      for (const profile of values.get("--profile") ?? []) enabledProfiles.add(profile);
      if (files.length === 0) files.push("compose.yaml");
      for (const file of files) {
        const resolved = resolveWord(file, scope);
        if (resolved) requireFile(composeFiles, relative(resolved), location);
        else violations.push(`${location}: cannot resolve Compose file '${file}'.`);
      }
    }
  }

  function scanRun(script, env, location, workingDirectory = ".") {
    const scope = new Map([...Object.entries(env), ...shellAssignments(script)]);
    for (const match of String(script).matchAll(profileEnablement[1])) {
      for (const profile of match[1].split(",")) enabledProfiles.add(profile);
    }
    for (const words of dockerInvocations(script)) scanDockerCommand(words, scope, location, workingDirectory);
  }

  function scanAction(actionDirectory, env, location) {
    const directory = normalizeRepoPath(actionDirectory);
    if (scannedActions.has(directory)) return;
    scannedActions.add(directory);
    const file = [`${directory}/action.yml`, `${directory}/action.yaml`].find(
      (candidate) => reader.read(candidate) !== null,
    );
    if (!file) {
      violations.push(`${location}: local action ${directory} has no action.yml.`);
      return;
    }
    const action = parseYaml(reader.read(file), file, violations);
    if (!action) return;
    if (action.runs?.using === "docker") {
      const image = String(action.runs.image ?? "");
      if (image.startsWith("docker://"))
        addCandidate({ location: file, kind: "docker action", raw: image, reference: image.slice(9) });
      else requireFile(dockerfiles, normalizeRepoPath(path.posix.join(directory, image)), file);
    }
    scanSteps(action.runs?.steps ?? [], env, file);
  }

  function scanSteps(steps, inheritedEnv, owner) {
    steps.forEach((step, index) => {
      const location = `${owner} step '${step?.name ?? step?.uses ?? index + 1}'`;
      rememberEnv(step?.env);
      const env = { ...inheritedEnv, ...(step?.env ?? {}) };
      const uses = typeof step?.uses === "string" ? step.uses.trim() : "";
      if (uses.startsWith("docker://")) {
        addCandidate({ location, kind: "docker action", raw: uses, reference: uses.slice(9) });
      } else if (uses.startsWith("./")) {
        scanAction(uses, env, location);
      } else if (/^docker\/setup-buildx-action@/.test(uses)) {
        const driver = step.with?.driver ?? "docker-container";
        if (driver !== "docker") {
          const image = /(?:^|[\s,])image=([^\s,]+)/.exec(` ${step.with?.["driver-opts"] ?? ""}`)?.[1];
          addCandidate({
            location,
            kind: image ? "buildx builder" : "buildx builder (implicit setup-buildx default)",
            raw: image ?? buildxDefaultBuilder,
            reference: image ?? buildxDefaultBuilder,
          });
        }
      } else if (/^docker\/build-push-action@/.test(uses)) {
        const context = step.with?.context ?? ".";
        requireFile(dockerfiles, normalizeRepoPath(step.with?.file ?? `${context}/Dockerfile`), location);
        for (const tag of String(step.with?.tags ?? "")
          .split(/[\s,]+/)
          .filter(Boolean))
          localTags.add(tag);
      }
      if (typeof step?.run === "string") scanRun(step.run, env, location, step["working-directory"] ?? ".");
    });
  }

  function scanWorkflow(file, document) {
    rememberEnv(document?.env);
    for (const [jobId, job] of Object.entries(document?.jobs ?? {})) {
      const owner = `${file} job '${jobId}'`;
      rememberEnv(job?.env);
      const env = { ...(document?.env ?? {}), ...(job?.env ?? {}) };
      for (const [name, service] of Object.entries(job?.services ?? {})) {
        const raw = typeof service === "string" ? service : service?.image;
        addCandidate({
          location: `${owner} service '${name}'`,
          kind: "job service",
          raw: String(raw),
          reference: resolveWord(String(raw), new Map()),
        });
      }
      if (job?.container) {
        const raw = typeof job.container === "string" ? job.container : job.container.image;
        addCandidate({
          location: `${owner} container`,
          kind: "job container",
          raw: String(raw),
          reference: resolveWord(String(raw), new Map()),
        });
      }
      scanSteps(job?.steps ?? [], env, owner);
    }
  }

  return {
    candidates,
    violations,
    localTags,
    envValues,
    dockerfiles,
    composeFiles,
    enabledProfiles,
    scannedActions,
    scanWorkflow,
    requireFile,
  };
}

function parseYaml(text, file, violations) {
  try {
    return YAML.parse(text);
  } catch (error) {
    violations?.push(`${file}: cannot parse YAML (${error.message}).`);
    return null;
  }
}

function dockerfileCandidates(file, text) {
  const lines = logicalLines(text);
  const candidates = [];
  for (const line of lines) {
    if (!/^\s*#/.test(line)) break;
    const directive = /^\s*#\s*syntax\s*=\s*(\S+)/i.exec(line);
    if (directive)
      candidates.push({
        location: file,
        kind: "Dockerfile syntax frontend",
        raw: directive[1],
        reference: directive[1],
      });
  }
  const stages = new Set();
  const external = (value) => !stages.has(value.toLowerCase()) && !/^\d+$/.test(value) && value !== "scratch";
  for (const line of lines) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      if (external(from[1]))
        candidates.push({
          location: file,
          kind: "Dockerfile FROM",
          raw: from[1],
          reference: resolveWord(from[1], new Map()),
        });
      if (from[2]) stages.add(from[2].toLowerCase());
      continue;
    }
    const sources = [
      ...(/^\s*COPY\b/i.test(line) ? [...line.matchAll(/--from=(\S+)/g)] : []),
      ...(/^\s*RUN\b/i.test(line) ? [...line.matchAll(/--mount=\S*?(?:=|,)from=([^,\s]+)/g)] : []),
    ];
    for (const match of sources) {
      if (external(match[1]))
        candidates.push({
          location: file,
          kind: "Dockerfile --from",
          raw: match[1],
          reference: resolveWord(match[1], new Map()),
        });
    }
  }
  return candidates;
}

function composeImageReferences(raw, envValues) {
  const interpolation = /^\$\{([A-Za-z_]\w*)(?::?([-?])([^}]*))?\}$/.exec(raw);
  if (!interpolation) return [resolveWord(raw, new Map())];
  const values = [...(envValues.get(interpolation[1]) ?? [])];
  if (interpolation[2] === "-") values.push(interpolation[3]);
  return values.length > 0 ? values.map((value) => (value.includes("$") ? null : value)) : [null];
}

export function checkCiImageSources({ reader = createRepoReader(), sources = loadImageSources() } = {}) {
  const parseViolations = [];
  const workflowPaths = reader.list(".github/workflows").filter((file) => /\.ya?ml$/.test(file));
  const workflows = new Map(workflowPaths.map((file) => [file, parseYaml(reader.read(file), file, parseViolations)]));
  const scan = createScan(reader, sources);
  scan.violations.push(...parseViolations);

  const queue = workflowPaths.filter((file) =>
    workflowTriggers(workflows.get(file)?.on).some((event) => requiredEvents.has(event)),
  );
  const required = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (required.has(file)) continue;
    if (!workflows.has(file)) {
      scan.violations.push(`Required reusable workflow ${file} does not exist.`);
      continue;
    }
    required.add(file);
    for (const job of Object.values(workflows.get(file)?.jobs ?? {})) {
      if (typeof job?.uses === "string" && job.uses.startsWith("./")) queue.push(normalizeRepoPath(job.uses));
    }
  }
  for (const file of required) scan.scanWorkflow(file, workflows.get(file));

  const launcherScripts = [
    ...reader
      .list("scripts", { recursive: true })
      .filter(
        (file) =>
          file !== guardPath &&
          launcherScriptPattern.test(file) &&
          !/\.test\.[cm]?[jt]s$/.test(file) &&
          !file.includes("/fixtures/"),
      ),
    "package.json",
  ];
  const disregardedLaunchers = [];
  for (const file of launcherScripts) {
    const text = reader.read(file) ?? "";
    for (const match of text.matchAll(composeFileLiteral))
      scan.requireFile(scan.composeFiles, normalizeRepoPath(match[1]), file);
    const profiles = profileEnablement.flatMap((pattern) =>
      [...text.matchAll(pattern)].flatMap((match) => match[1].split(",")),
    );
    if (profiles.length === 0) continue;
    if (devOnlyProfileLaunchers.has(file)) disregardedLaunchers.push(file);
    else for (const profile of profiles) scan.enabledProfiles.add(profile);
  }

  for (const [file, launchers] of scan.composeFiles) {
    const text = reader.read(file);
    if (text === null) {
      scan.violations.push(`Compose file ${file} (launched by ${[...launchers].join(", ")}) does not exist.`);
      continue;
    }
    const compose = parseYaml(text, file, scan.violations);
    for (const [name, service] of Object.entries(compose?.services ?? {})) {
      const location = `${file} service '${name}'`;
      if (service?.build) {
        const build = typeof service.build === "string" ? { context: service.build } : service.build;
        const context = path.posix.join(path.posix.dirname(file), build.context ?? ".");
        scan.requireFile(
          scan.dockerfiles,
          normalizeRepoPath(path.posix.join(context, build.dockerfile ?? "Dockerfile")),
          location,
        );
        if (service.image) scan.localTags.add(service.image);
        continue;
      }
      const profiles = Array.isArray(service?.profiles) ? service.profiles : [];
      if (profiles.length > 0 && !profiles.some((profile) => scan.enabledProfiles.has(profile))) {
        scan.candidates.push({
          location,
          kind: "Compose service",
          raw: String(service?.image),
          excluded: `profile ${profiles.join(",")} is not enabled by a required launcher`,
        });
        continue;
      }
      for (const reference of composeImageReferences(String(service?.image ?? ""), scan.envValues)) {
        scan.candidates.push({ location, kind: "Compose service", raw: String(service?.image), reference });
      }
    }
  }

  for (const [file, launchers] of scan.dockerfiles) {
    const text = reader.read(file);
    if (text === null)
      scan.violations.push(`Dockerfile ${file} (built by ${[...launchers].join(", ")}) does not exist.`);
    else scan.candidates.push(...dockerfileCandidates(file, text));
  }

  const counts = { pinned: 0, localBuild: 0, excluded: 0, canary: 0, refused: 0 };
  for (const candidate of scan.candidates) {
    const canary = expectedUnreachableCanaries.get(candidate.location.split(" ")[0]);
    let refusal = null;
    if (candidate.excluded) candidate.status = "excluded";
    else if (candidate.reference === null || candidate.reference === undefined)
      refusal = `cannot resolve image '${candidate.raw}'`;
    else if (canary && candidate.reference === canary) candidate.status = "canary";
    else if (scan.localTags.has(candidate.reference)) candidate.status = "localBuild";
    else refusal = imageReferenceRefusal(candidate.reference, sources);
    if (refusal) {
      candidate.status = "refused";
      scan.violations.push(`${candidate.location} (${candidate.kind}): '${candidate.raw}' is refused: ${refusal}.`);
    } else if (!candidate.status) {
      candidate.status = "pinned";
    }
    counts[candidate.status] += 1;
  }

  const boundary = publisherBoundaryViolations(
    workflowPaths.map((file) => ({ path: file, document: workflows.get(file) })),
  );
  const summary = {
    workflows: workflowPaths.length,
    requiredWorkflows: required.size,
    actions: scan.scannedActions.size,
    launcherScripts: launcherScripts.length,
    disregardedLaunchers,
    dockerfiles: scan.dockerfiles.size,
    composeFiles: scan.composeFiles.size,
    candidates: scan.candidates.length,
    ...counts,
  };
  return {
    passed: scan.violations.length + boundary.length === 0,
    violations: [...scan.violations, ...boundary],
    candidates: scan.candidates,
    summary,
  };
}

export function formatSummary(summary) {
  return (
    `ci-image-sources: scanned ${summary.requiredWorkflows}/${summary.workflows} required workflows, ${summary.actions} local actions, ` +
    `${summary.launcherScripts} launcher scripts, ${summary.dockerfiles} Dockerfiles, ${summary.composeFiles} Compose files; ` +
    `${summary.candidates} image candidates: ${summary.pinned} sha256-pinned, ${summary.localBuild} local builds, ` +
    `${summary.excluded} excluded profile services, ${summary.canary} Hub canaries, ${summary.refused} refused.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkCiImageSources();
  console.log(formatSummary(result.summary));
  if (!result.passed) {
    console.error("Required-CI image sources check failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
