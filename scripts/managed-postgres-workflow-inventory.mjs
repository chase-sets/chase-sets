import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
const EXECUTABLE_EXTENSIONS = "(?:mjs|cjs|js|ts|tsx|sh|bash|ps1|py)";
const LOCAL_MODULE_REFERENCE = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["']((?:\.{1,2}/)[a-zA-Z0-9_@./-]+\.${EXECUTABLE_EXTENSIONS})["']`,
  "gm",
);
const RUNTIME_FILE_REFERENCE = new RegExp(
  String.raw`(?:^|\n|&&|;)\s*(?:node|bash|sh|pwsh|powershell|python(?:3)?)\b[^\n;&|]*?\s+((?:\.{0,2}/)?[a-zA-Z0-9_@.-]+(?:/[a-zA-Z0-9_@.-]+)+\.${EXECUTABLE_EXTENSIONS})(?=$|[\s"'\x60),;])`,
  "gm",
);
const DIRECT_FILE_REFERENCE = new RegExp(
  String.raw`(?:^|\n|&&|;)\s*((?:\.{1,2}/)[a-zA-Z0-9_@.-]+(?:/[a-zA-Z0-9_@.-]+)*\.${EXECUTABLE_EXTENSIONS})(?=$|[\s"'\x60),;])`,
  "gm",
);
const LOCAL_USES_REFERENCE = /\buses\s*:\s*["']?(\.\/[a-zA-Z0-9_@./-]+)/g;
const ACTION_MAIN_REFERENCE = /^\s*main\s*:\s*["']?([^\s"'#]+)["']?\s*$/gm;
const PACKAGE_RUN_REFERENCE = /\b(?:pnpm|npm|yarn)\s+(?:--silent\s+)?run\s+([a-zA-Z0-9:_-]+)/g;
const FILTERED_PACKAGE_RUN_REFERENCE = /\bpnpm\s+--filter\s+(?:["']([^"']+)["']|([^\s]+))\s+run\s+([a-zA-Z0-9:_-]+)/g;

const LIBPQ_COMMAND =
  /(?:^|\n|&&|;|\|)\s*(?:(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*(?:(?:sudo|env)\s+)*(?:[^\s;&|]+\/)?(psql|pg_dump|pg_restore|pg_isready|createdb|dropdb|vacuumdb|reindexdb)\b/gm;
const NODE_PG_IMPORT =
  /(?:from\s+["']pg["']|import\s+(?:\*\s+as\s+)?(?:pg|\{[^}]*\b(?:Client|Pool)\b[^}]*\})\s+from\s+["']pg["']|require\s*\(\s*["']pg["']\s*\))/s;
const NODE_PG_CONNECT =
  /(?:new\s+(?:(?:pg\.)?(?:Client|Pool)|(?:Client|Pool)Ctor)\s*\(|createPgPool\s*\(|\.connect\s*\(\s*\))/s;
const POSTGRES_URL_CONSTRUCTION =
  /(?:postgres(?:ql)?:\/\/[\w$%{}`:@./?&=+-]*|new\s+URL\s*\(\s*["'`]postgres(?:ql)?:\/\/)/i;
const URL_EXPORT_BEHAVIOR =
  /(?:GITHUB_ENV|appendFile(?:Sync)?\s*\(|process\.stdout\.(?:write|writeLine)\s*\(|(?:^|\n)\s*(?:echo|printf)\b[^\n]*(?:DATABASE_URL|postgres(?:ql)?:\/\/))/i;
const MANAGED_POSTGRES_SIGNAL =
  /(?:DIGITALOCEAN_ACCESS_TOKEN|digitalocean_database_cluster|\/v2\/databases\/|25060|MANAGED_POSTGRES_CA_PATH)/i;
const EXPLICIT_LOCAL_POSTGRES =
  /postgres(?:ql)?:\/\/[^\s"'`@]*@?(?:localhost|127\.0\.0\.1|\[?::1\]?|postgres)(?::\d+)?\/[^\s"'`?]+[^\s"'`]*sslmode=disable/i;
const VERIFY_FULL =
  /(?:sslmode(?:=|["']?\s*[,):]\s*["']?)verify-full|set\s*\(\s*["']sslmode["']\s*,\s*["']verify-full["'])/i;
const CA_TRUST_INPUT = /(?:sslrootcert|PGSSLROOTCERT|MANAGED_POSTGRES_CA_PATH|fetchDigitalOceanManagedPostgresCa)/i;
const CA_CREDENTIAL = /(?:DIGITALOCEAN_ACCESS_TOKEN|\/v2\/databases\/[^\s"'`]+\/ca)/i;
const CA_CLEANUP =
  /(?:(?:rm\s+-[^\n]*(?:PGSSLROOTCERT|CA_PATH|\.pem))|(?:removeCa|unlink|rm)\s*\([^\n]*(?:caPath|certificate|PGSSLROOTCERT|MANAGED_POSTGRES_CA_PATH))/i;
const TLS_DOWNGRADE =
  /(?:rejectUnauthorized\s*:\s*false|sslmode\s*(?:=|["']?\s*[,):]\s*["']?)require\b|PGSSLMODE\s*[:=]\s*["']?require\b)/i;
const GLOBAL_TLS_DISABLE = /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0\b/;
const POD_INTERNAL_EXECUTION = /\bkubectl\b[^\n]*(?:\bexec\b|\bcp\b)|\bexecFile\b[^\n]*["']kubectl["']/i;
const KUBERNETES_RUNTIME_SECRET_EXPORT =
  /kind\s*:\s*["']Secret["'][\s\S]*Buffer\.from\s*\([^)]*["']utf8["'][^)]*\)\.toString\s*\(\s*["']base64["']\s*\)[\s\S]*(?:kubectl|applyManifest)/i;

export async function scanManagedPostgresWorkflowInventory(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const workflowDirectory = resolve(
    options.workflowDirectory ?? repositoryRoot,
    options.workflowDirectory ? "" : ".github/workflows",
  );
  const packageIndex = await loadPackageIndex(repositoryRoot);
  const workflowPaths = await listWorkflowFiles(workflowDirectory);
  const candidates = [];
  let totalSurfaceCount = 0;
  let scannedSurfaceCount = 0;
  let candidateSurfaceCount = 0;

  for (const workflowPath of workflowPaths) {
    const workflowName = normalizePath(relative(workflowDirectory, workflowPath));
    const context = {
      repositoryRoot,
      packageIndex,
      workflowName,
      surfaces: new Map(),
    };
    await discoverFileSurface(context, workflowPath, "workflow", repositoryRoot);
    const surfaces = [...context.surfaces.values()].sort(compareSurfaces);
    totalSurfaceCount += surfaces.length;
    scannedSurfaceCount += surfaces.filter(({ scanned }) => scanned).length;
    const databaseSurfaces = surfaces.filter(({ shapes }) => shapes.length > 0);
    candidateSurfaceCount += databaseSurfaces.length;
    if (databaseSurfaces.length === 0) {
      continue;
    }

    const combinedSource = surfaces.map(({ source }) => source).join("\n");
    const workflowSource = surfaces.find(({ kind }) => kind === "workflow")?.source ?? "";
    const shapes = [...new Set(databaseSurfaces.flatMap(({ shapes }) => shapes))].sort();
    const unclassifiedDatabaseSurfaces = databaseSurfaces.filter(({ scopeClassification }) => !scopeClassification);
    candidates.push({
      name: workflowName,
      scheduled: /\n\s*schedule\s*:/.test(workflowSource),
      shapes,
      surfaces: databaseSurfaces.map(toPublicSurface),
      scopeClassification:
        unclassifiedDatabaseSurfaces.length === 0
          ? [...new Set(databaseSurfaces.map(({ scopeClassification }) => scopeClassification))].sort().join(",")
          : null,
      trust: Object.freeze({
        caCredential: CA_CREDENTIAL.test(combinedSource),
        caInput: CA_TRUST_INPUT.test(combinedSource),
        caCleanup: CA_CLEANUP.test(combinedSource),
        verifyFull: VERIFY_FULL.test(combinedSource),
        explicitLocal: EXPLICIT_LOCAL_POSTGRES.test(combinedSource) && !MANAGED_POSTGRES_SIGNAL.test(combinedSource),
      }),
      findings: unclassifiedDatabaseSurfaces.flatMap(({ id, kind, source }) => {
        const findings = [];
        if (TLS_DOWNGRADE.test(source)) findings.push({ surface: id, surfaceKind: kind, kind: "tls-downgrade" });
        if (GLOBAL_TLS_DISABLE.test(source)) {
          findings.push({ surface: id, surfaceKind: kind, kind: "global-tls-verification-disabled" });
        }
        return findings;
      }),
    });
  }

  return {
    scannedWorkflowCount: workflowPaths.length,
    totalSurfaceCount,
    scannedSurfaceCount,
    coverage: `${scannedSurfaceCount}/${totalSurfaceCount}`,
    totalCandidateSurfaceCount: candidateSurfaceCount,
    scannedCandidateSurfaceCount: candidateSurfaceCount,
    candidateCoverage: `${candidateSurfaceCount}/${candidateSurfaceCount}`,
    candidateSurfaceCount,
    candidateCount: candidates.length,
    candidates,
  };
}

export function managedPostgresWorkflowTrustViolations(inventory) {
  const violations = [];
  for (const candidate of inventory.candidates) {
    if (candidate.scopeClassification || candidate.trust.explicitLocal) {
      continue;
    }

    for (const finding of candidate.findings) {
      violations.push({
        workflow: candidate.name,
        reason:
          finding.kind === "global-tls-verification-disabled"
            ? finding.kind
            : `tls-downgrade:${finding.surfaceKind === "inline-run" ? "inline-workflow" : finding.surface}`,
      });
    }
    if (candidate.findings.length > 0) {
      continue;
    }

    if (!candidate.trust.caCredential) {
      violations.push({ workflow: candidate.name, reason: "missing-trust:managed-postgres-ca-credential" });
    }
    if (!candidate.trust.caInput) {
      violations.push({ workflow: candidate.name, reason: "missing-trust:ca-input" });
    }
    if (!candidate.trust.verifyFull) {
      violations.push({ workflow: candidate.name, reason: "missing-trust:verify-full" });
    }
    if (!candidate.trust.caCleanup) {
      violations.push({ workflow: candidate.name, reason: "missing-trust:ca-cleanup" });
    }
  }
  return violations;
}

async function discoverFileSurface(context, absolutePath, kind, baseDirectory) {
  const repositoryPath = repositoryRelativePath(context.repositoryRoot, absolutePath);
  const id = kind === "workflow" ? context.workflowName : repositoryPath;
  if (context.surfaces.has(id)) {
    return;
  }
  const source = await readFile(absolutePath, "utf8");
  const yamlExecutionContainer = ["workflow", "reusable-workflow", "local-action"].includes(kind);
  const shapes = yamlExecutionContainer ? [] : executableDatabaseShapes(source);
  const runBlocks = yamlExecutionContainer ? extractRunBlocks(source) : [];
  context.surfaces.set(id, {
    id,
    kind,
    path: repositoryPath,
    source,
    shapes,
    scanned: true,
    scopeClassification: classifySurfaceScope(source, shapes),
  });
  if (yamlExecutionContainer) {
    for (const [index, inlineSource] of runBlocks.entries()) {
      const inlineId = `${id}#run:${index + 1}`;
      const inlineShapes = executableDatabaseShapes(inlineSource);
      context.surfaces.set(inlineId, {
        id: inlineId,
        kind: "inline-run",
        path: `${repositoryPath}#run:${index + 1}`,
        source: inlineSource,
        shapes: inlineShapes,
        scanned: true,
        scopeClassification: classifySurfaceScope(inlineSource, inlineShapes),
      });
    }
  }

  for (const localReference of matches(source, LOCAL_USES_REFERENCE, 1)) {
    await discoverLocalUses(context, resolve(context.repositoryRoot, localReference.slice(2)));
  }
  if (kind === "local-action") {
    for (const mainReference of matches(source, ACTION_MAIN_REFERENCE, 1)) {
      await discoverFileSurface(context, resolve(baseDirectory, mainReference), "referenced-script", baseDirectory);
    }
  }
  const referenceSources = [source, ...runBlocks];
  const executedReferences = referenceSources.flatMap((referenceSource) => [
    ...matches(referenceSource, RUNTIME_FILE_REFERENCE, 1),
    ...matches(referenceSource, DIRECT_FILE_REFERENCE, 1),
  ]);
  const executableReferences =
    kind === "referenced-script"
      ? [...matches(source, LOCAL_MODULE_REFERENCE, 1), ...executedReferences]
      : executedReferences;
  for (const executableReference of executableReferences) {
    const resolvedReference = await resolveExecutableReference(
      context.repositoryRoot,
      baseDirectory,
      executableReference,
    );
    await discoverFileSurface(context, resolvedReference, "referenced-script", dirname(resolvedReference));
  }
  for (const referenceSource of referenceSources) {
    await discoverPackageScripts(context, referenceSource);
  }
}

async function discoverLocalUses(context, absolutePath) {
  const target = await stat(absolutePath);
  if (target.isDirectory()) {
    const manifest = await firstExisting([resolve(absolutePath, "action.yml"), resolve(absolutePath, "action.yaml")]);
    if (!manifest) {
      throw new Error(
        `Local action has no action.yml/action.yaml: ${repositoryRelativePath(context.repositoryRoot, absolutePath)}`,
      );
    }
    await discoverFileSurface(context, manifest, "local-action", absolutePath);
    return;
  }
  if (WORKFLOW_EXTENSIONS.has(extname(absolutePath))) {
    await discoverFileSurface(context, absolutePath, "reusable-workflow", context.repositoryRoot);
  }
}

async function discoverPackageScripts(context, source) {
  for (const match of source.matchAll(FILTERED_PACKAGE_RUN_REFERENCE)) {
    const packageName = match[1] ?? match[2];
    const scriptName = match[3];
    const packageRecord = context.packageIndex.byName.get(packageName);
    if (packageRecord) {
      await discoverPackageScript(context, packageRecord, scriptName);
    }
  }
  for (const scriptName of matches(source, PACKAGE_RUN_REFERENCE, 1)) {
    await discoverPackageScript(context, context.packageIndex.root, scriptName);
  }
}

async function discoverPackageScript(context, packageRecord, scriptName) {
  const command = packageRecord.scripts[scriptName];
  if (!command) {
    return;
  }
  const id = `${packageRecord.path}#scripts.${scriptName}`;
  if (context.surfaces.has(id)) {
    return;
  }
  const shapes = executableDatabaseShapes(command);
  context.surfaces.set(id, {
    id,
    kind: "package-script",
    path: id,
    source: command,
    shapes,
    scanned: true,
    scopeClassification: classifySurfaceScope(command, shapes),
  });
  const executableReferences = [
    ...matches(command, RUNTIME_FILE_REFERENCE, 1),
    ...matches(command, DIRECT_FILE_REFERENCE, 1),
  ];
  for (const executableReference of executableReferences) {
    const resolvedReference = await resolveExecutableReference(
      context.repositoryRoot,
      packageRecord.directory,
      executableReference,
    );
    await discoverFileSurface(context, resolvedReference, "referenced-script", dirname(resolvedReference));
  }
}

function executableDatabaseShapes(source) {
  const shapes = [];
  LIBPQ_COMMAND.lastIndex = 0;
  const libpqCommands = [...source.matchAll(LIBPQ_COMMAND)].map((match) => match[1]);
  for (const command of [...new Set(libpqCommands)].sort()) {
    if (command !== "pg_restore" || /(?:--dbname(?:=|\s)|\s-d\s|DATABASE_URL|postgres(?:ql)?:\/\/)/i.test(source)) {
      shapes.push(`libpq:${command}`);
    }
  }
  if (NODE_PG_IMPORT.test(source) && NODE_PG_CONNECT.test(source)) {
    shapes.push("node-pg-client");
  }
  if (POSTGRES_URL_CONSTRUCTION.test(source) && URL_EXPORT_BEHAVIOR.test(source)) {
    shapes.push("postgres-url-exporter");
  }
  return shapes;
}

function extractRunBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run\s*:\s*(.*)$/.exec(lines[index]);
    if (!match) {
      continue;
    }
    const indentation = match[1].length;
    const value = match[2].trim();
    if (value !== "|" && value !== ">" && !value.startsWith("|-") && !value.startsWith(">-")) {
      blocks.push(value.replace(/^(["'])([\s\S]*)\1$/, "$2"));
      continue;
    }
    const blockLines = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const contentMatch = /^(\s*)(.*)$/.exec(line);
      if (contentMatch[2] && contentMatch[1].length <= indentation) {
        index -= 1;
        break;
      }
      blockLines.push(line.slice(Math.min(line.length, indentation + 2)));
    }
    blocks.push(blockLines.join("\n"));
  }
  return blocks;
}

async function loadPackageIndex(repositoryRoot) {
  const root = await readPackageRecord(repositoryRoot, resolve(repositoryRoot, "package.json"));
  const records = [root];
  for (const workspacePattern of root.workspaces) {
    if (workspacePattern.endsWith("/*") && !workspacePattern.slice(0, -2).includes("*")) {
      const workspaceParent = resolve(repositoryRoot, workspacePattern.slice(0, -2));
      const entries = await readdir(workspaceParent, { withFileTypes: true });
      for (const entry of entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const packagePath = resolve(workspaceParent, entry.name, "package.json");
        if (await firstExisting([packagePath])) {
          records.push(await readPackageRecord(repositoryRoot, packagePath));
        }
      }
      continue;
    }
    if (!workspacePattern.includes("*")) {
      const packagePath = resolve(repositoryRoot, workspacePattern, "package.json");
      if (await firstExisting([packagePath])) {
        records.push(await readPackageRecord(repositoryRoot, packagePath));
      }
      continue;
    }
    throw new Error(`Unsupported workspace pattern for executable discovery: ${workspacePattern}`);
  }
  return {
    root,
    byName: new Map(records.filter(({ name }) => name).map((record) => [record.name, record])),
  };
}

async function readPackageRecord(repositoryRoot, packagePath) {
  const contents = JSON.parse(await readFile(packagePath, "utf8"));
  return {
    directory: dirname(packagePath),
    name: contents.name ?? null,
    path: repositoryRelativePath(repositoryRoot, packagePath),
    scripts: contents.scripts ?? {},
    workspaces: contents.workspaces ?? [],
  };
}

async function listWorkflowFiles(directory) {
  return (await listFiles(directory, new Set(["node_modules", ".git"])))
    .filter((path) => WORKFLOW_EXTENSIONS.has(extname(path)))
    .sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

async function listFiles(directory, excludedDirectories) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, excludedDirectories)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function resolveExecutableReference(repositoryRoot, baseDirectory, reference) {
  const rootRelativeReference = reference.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
  const candidates =
    reference.startsWith("./") || reference.startsWith("../")
      ? [
          resolve(baseDirectory, reference),
          resolve(repositoryRoot, reference),
          resolve(repositoryRoot, rootRelativeReference),
        ]
      : [resolve(repositoryRoot, reference), resolve(baseDirectory, reference)];
  const path = await firstExisting(candidates);
  if (!path) {
    throw new Error(`Referenced executable does not exist: ${reference}`);
  }
  repositoryRelativePath(repositoryRoot, path);
  return path;
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      const details = await stat(path);
      if (details.isFile()) {
        return path;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

function matches(source, pattern, group) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].map((match) => match[group]);
}

function repositoryRelativePath(repositoryRoot, path) {
  const repositoryPath = relative(repositoryRoot, path);
  if (repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`)) {
    throw new Error(`Executable surface escapes the repository: ${path}`);
  }
  return normalizePath(repositoryPath);
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function compareSurfaces(left, right) {
  return left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind);
}

function toPublicSurface(surface) {
  return Object.freeze({
    id: surface.id,
    kind: surface.kind,
    path: surface.path,
    shapes: surface.shapes,
    scopeClassification: surface.scopeClassification,
  });
}

function isDatabaseClientShape(shape) {
  return shape === "node-pg-client" || shape.startsWith("libpq:");
}

function classifySurfaceScope(source, shapes) {
  if (shapes.some(isDatabaseClientShape) && POD_INTERNAL_EXECUTION.test(source)) {
    return "pod-internal-ca-distribution-follow-up";
  }
  if (shapes.includes("postgres-url-exporter") && KUBERNETES_RUNTIME_SECRET_EXPORT.test(source)) {
    return "runtime-secret-ca-distribution-follow-up";
  }
  return null;
}
