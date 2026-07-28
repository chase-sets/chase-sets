import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectOpenSchemaObjectPaths,
  validateAgainstSchema,
} from "./check-structure/identity-creation-path-registry.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const defaultRegistryPath = "scripts/identity-creation-positions.json";
const defaultSchemaPath = "scripts/identity-creation-positions.schema.json";

export const identityCommandAnchors = Object.freeze([
  Object.freeze({
    id: "C1",
    path: "bounded-contexts/identity/features/accounts/domain/domain.ts",
    typeAlias: "CreateAccountCommand",
    command: "CreateAccount",
  }),
  Object.freeze({
    id: "C2",
    path: "bounded-contexts/identity/features/users/domain/domain.ts",
    typeAlias: "CreateUserCommand",
    command: "CreateUser",
  }),
  Object.freeze({
    id: "C3",
    path: "bounded-contexts/identity/features/memberships/domain/domain.ts",
    typeAlias: "GrantMembershipCommand",
    command: "GrantMembership",
  }),
]);

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizeSource(source) {
  return source.replaceAll("\r\n", "\n");
}

function normalizeRepositoryPath(value) {
  return value.replaceAll("\\", "/");
}

function commandPosition(command, terminator = "") {
  return ["type", `: "${command}"`, terminator].join("");
}

function declarationFragment(anchor) {
  return [`export type ${anchor.typeAlias} = Readonly<{`, `  ${commandPosition(anchor.command, ";")}`].join("\n");
}

function countStringOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const found = source.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function countBufferOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const found = source.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function deriveCommandAuthority(repositoryRoot) {
  const derivation = [];
  const violations = [];

  for (const anchor of identityCommandAnchors) {
    let source;
    try {
      source = normalizeSource(readFileSync(path.resolve(repositoryRoot, anchor.path), "utf8"));
    } catch {
      violations.push(
        finding(
          "identity-command-authority-unreadable",
          `${anchor.id} cannot read its domain declaration anchor at ${anchor.path}.`,
          { anchorId: anchor.id, path: anchor.path },
        ),
      );
      continue;
    }

    const fragment = declarationFragment(anchor);
    if (countStringOccurrences(source, fragment) !== 1) {
      violations.push(
        finding(
          "identity-command-authority-diverged",
          `${anchor.id} no longer contains its one pinned domain declaration.`,
          { anchorId: anchor.id, path: anchor.path, command: anchor.command },
        ),
      );
      continue;
    }

    derivation.push({
      anchorId: anchor.id,
      path: anchor.path,
      command: anchor.command,
      declaration: `  ${commandPosition(anchor.command, ";")}`,
    });
  }

  return { derivation, violations };
}

function artifactPath(repositoryRoot, value) {
  return path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

function readJsonArtifact(repositoryRoot, relativePath, artifactName) {
  let source;
  try {
    source = readFileSync(artifactPath(repositoryRoot, relativePath), "utf8");
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return {
      value: null,
      violations: [
        finding(
          `identity-creation-${artifactName}-${missing ? "missing" : "unreadable"}`,
          `${artifactName} ${missing ? "does not exist" : "cannot be read"} at ${relativePath}.`,
          { path: relativePath },
        ),
      ],
    };
  }

  try {
    return { value: JSON.parse(source), violations: [] };
  } catch {
    return {
      value: null,
      violations: [
        finding(
          `identity-creation-${artifactName}-unparseable`,
          `${artifactName} is not valid JSON at ${relativePath}.`,
          { path: relativePath },
        ),
      ],
    };
  }
}

function safeRegistryPath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) return false;
  const normalized = normalizeRepositoryPath(value);
  const segments = normalized.split("/");
  return normalized === value && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function reasonIsGeneric(value) {
  return /^(?:internal|test support)[.!]?$/i.test(value.trim());
}

function collectRegistrySemanticViolations(registry, derivation) {
  const violations = [];
  const commands = new Set(derivation.map(({ command }) => command));
  const groups = new Map();

  for (const [index, position] of registry.positions.entries()) {
    const label = `positions[${index}]`;
    if (!safeRegistryPath(position.path)) {
      violations.push(
        finding(
          "identity-creation-registry-schema-invalid",
          `${label} must use a normalized repository-relative path.`,
          { path: position.path, command: position.command },
        ),
      );
    }
    if (!commands.has(position.command)) {
      violations.push(
        finding(
          "identity-creation-registry-stale",
          `${label} names ${position.command}, which is not in the derived command authority.`,
          { path: position.path, command: position.command },
        ),
      );
    }

    if (!position.reason.trim() || reasonIsGeneric(position.reason)) {
      violations.push(
        finding(
          "identity-creation-registry-reason-generic",
          `${label} needs a concrete reason, not "${position.reason.trim()}".`,
          { path: position.path, command: position.command },
        ),
      );
    }
    if (position.disposition === "exempt-temporary" && !Number.isInteger(position.ownerIssue)) {
      violations.push(
        finding("identity-creation-registry-owner-missing", `${label} is temporary and must name ownerIssue.`, {
          path: position.path,
          command: position.command,
        }),
      );
    }
    if (position.disposition !== "exempt-temporary" && position.ownerIssue !== undefined) {
      violations.push(
        finding(
          "identity-creation-registry-owner-unexpected",
          `${label} is not temporary and cannot name ownerIssue.`,
          { path: position.path, command: position.command },
        ),
      );
    }

    const key = `${position.path}\0${position.command}`;
    const entries = groups.get(key) ?? [];
    entries.push({ index, position });
    groups.set(key, entries);
  }

  for (const entries of groups.values()) {
    if (entries.length === 1) continue;
    const compositions = new Set();
    for (const { index, position } of entries) {
      if (!position.composition) {
        violations.push(
          finding(
            "identity-creation-registry-schema-invalid",
            `positions[${index}] shares a path and command, so composition is required to make the partition reviewable.`,
            { path: position.path, command: position.command },
          ),
        );
        continue;
      }
      if (compositions.has(position.composition)) {
        violations.push(
          finding(
            "identity-creation-registry-schema-invalid",
            `positions[${index}] duplicates composition ${position.composition} for the same path and command.`,
            { path: position.path, command: position.command },
          ),
        );
      }
      compositions.add(position.composition);
    }
  }

  return violations;
}

function loadRegistry(repositoryRoot, registryPath, schemaPath, derivation) {
  const schemaResult = readJsonArtifact(repositoryRoot, schemaPath, "registry-schema");
  if (schemaResult.violations.length > 0) {
    return { registry: null, violations: schemaResult.violations };
  }

  const openSchemaObjects = collectOpenSchemaObjectPaths(schemaResult.value);
  if (openSchemaObjects.length > 0) {
    return {
      registry: null,
      violations: openSchemaObjects.map((pointer) =>
        finding(
          "identity-creation-registry-schema-invalid",
          `Registry schema object ${pointer} is not recursively closed.`,
          { path: schemaPath },
        ),
      ),
    };
  }

  const registryResult = readJsonArtifact(repositoryRoot, registryPath, "registry");
  if (registryResult.violations.length > 0) {
    return { registry: null, violations: registryResult.violations };
  }

  const schemaViolations = validateAgainstSchema(registryResult.value, schemaResult.value);
  if (schemaViolations.length > 0) {
    return {
      registry: null,
      violations: schemaViolations.map((message) =>
        finding("identity-creation-registry-schema-invalid", message, { path: registryPath }),
      ),
    };
  }

  const semanticViolations = collectRegistrySemanticViolations(registryResult.value, derivation);
  return {
    registry: semanticViolations.length === 0 ? registryResult.value : null,
    violations: semanticViolations,
  };
}

function listTrackedFiles(repositoryRoot) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "--cached", "-z"], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 100 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return {
      paths: [],
      violations: [
        finding("identity-creation-corpus-discovery-failed", "git ls-files could not enumerate the repository index."),
      ],
    };
  }

  const paths = output.toString("utf8").split("\0").filter(Boolean).map(normalizeRepositoryPath);
  if (paths.length === 0) {
    return {
      paths,
      violations: [finding("identity-creation-corpus-empty", "git ls-files returned zero tracked files.")],
    };
  }
  return { paths, violations: [] };
}

function sweepCorpus(repositoryRoot, trackedPaths, derivation) {
  const observed = new Map();
  const violations = [];
  let sweptFiles = 0;
  const tokens = derivation.map((entry) => ({
    ...entry,
    bytes: Buffer.from(commandPosition(entry.command), "utf8"),
  }));

  for (const repositoryPath of trackedPaths) {
    let source;
    try {
      source = readFileSync(path.resolve(repositoryRoot, repositoryPath));
      sweptFiles += 1;
    } catch {
      violations.push(
        finding("identity-creation-corpus-unreadable", `Tracked corpus file cannot be read: ${repositoryPath}.`, {
          path: repositoryPath,
        }),
      );
      continue;
    }

    for (const token of tokens) {
      const occurrences = countBufferOccurrences(source, token.bytes);
      if (occurrences > 0) {
        observed.set(`${repositoryPath}\0${token.command}`, {
          path: repositoryPath,
          command: token.command,
          occurrences,
        });
      }
    }
  }

  return { observed, sweptFiles, violations };
}

function reconcileRegistry(registry, observed) {
  const registered = new Map();
  const violations = [];

  for (const position of registry.positions) {
    const key = `${position.path}\0${position.command}`;
    const group = registered.get(key) ?? { occurrences: 0, entries: [] };
    group.occurrences += position.occurrences;
    group.entries.push(position);
    registered.set(key, group);
  }

  const keys = new Set([...observed.keys(), ...registered.keys()]);
  for (const key of [...keys].sort()) {
    const hit = observed.get(key);
    const classification = registered.get(key);
    if (hit && !classification) {
      violations.push(
        finding(
          "identity-creation-position-unclassified",
          `${hit.path} has ${hit.occurrences} unclassified ${hit.command} position(s).`,
          { path: hit.path, command: hit.command, observed: hit.occurrences, registered: 0 },
        ),
      );
      continue;
    }
    if (!hit || hit.occurrences !== classification.occurrences) {
      const [positionPath, command] = key.split("\0");
      violations.push(
        finding(
          "identity-creation-registry-stale",
          `${positionPath} has ${hit?.occurrences ?? 0} ${command} position(s), but the registry pins ${classification.occurrences}.`,
          {
            path: positionPath,
            command,
            observed: hit?.occurrences ?? 0,
            registered: classification.occurrences,
          },
        ),
      );
    }
  }

  return { registered, violations };
}

function createReport({ derivation, registry, trackedFiles = 0, sweptFiles = 0, observed, registered, violations }) {
  const commandViolations = new Map();
  for (const violation of violations) {
    if (!violation.command) continue;
    commandViolations.set(violation.command, (commandViolations.get(violation.command) ?? 0) + 1);
  }

  return {
    schemaVersion: 1,
    derivation,
    trackedFiles,
    sweptFiles,
    tokens: derivation.map(({ anchorId, command }) => ({
      command,
      anchorId,
      hitCount: [...(observed?.values() ?? [])]
        .filter((entry) => entry.command === command)
        .reduce((total, entry) => total + entry.occurrences, 0),
      registeredCount: [...(registered?.entries() ?? [])]
        .filter(([key]) => key.endsWith(`\0${command}`))
        .reduce((total, [, entry]) => total + entry.occurrences, 0),
      violationCount: commandViolations.get(command) ?? 0,
    })),
    positions: registry?.positions ?? [],
    violations,
  };
}

export function runIdentityCreationPositionGuard(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const registryPath = options.registryPath ?? defaultRegistryPath;
  const schemaPath = options.schemaPath ?? defaultSchemaPath;
  const authority = deriveCommandAuthority(repositoryRoot);
  if (authority.violations.length > 0) {
    return createReport({
      derivation: authority.derivation,
      registry: null,
      violations: authority.violations,
    });
  }

  const loaded = loadRegistry(repositoryRoot, registryPath, schemaPath, authority.derivation);
  if (loaded.violations.length > 0) {
    return createReport({
      derivation: authority.derivation,
      registry: null,
      violations: loaded.violations,
    });
  }

  const corpus = listTrackedFiles(repositoryRoot);
  if (corpus.violations.length > 0) {
    return createReport({
      derivation: authority.derivation,
      registry: loaded.registry,
      trackedFiles: corpus.paths.length,
      violations: corpus.violations,
    });
  }

  const sweep = sweepCorpus(repositoryRoot, corpus.paths, authority.derivation);
  const reconciled = reconcileRegistry(loaded.registry, sweep.observed);
  return createReport({
    derivation: authority.derivation,
    registry: loaded.registry,
    trackedFiles: corpus.paths.length,
    sweptFiles: sweep.sweptFiles,
    observed: sweep.observed,
    registered: reconciled.registered,
    violations: [...sweep.violations, ...reconciled.violations],
  });
}

function readCliOptions(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--repository-root" || argument === "--registry-path" || argument === "--schema-path") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--repository-root") options.repositoryRoot = value;
      if (argument === "--registry-path") options.registryPath = value;
      if (argument === "--schema-path") options.schemaPath = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function writeReport(report, compact) {
  process.stdout.write(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
}

function main() {
  let options;
  try {
    options = readCliOptions(process.argv.slice(2));
    const report = runIdentityCreationPositionGuard(options);
    writeReport(report, options.json);
    if (report.violations.length > 0) process.exitCode = 1;
  } catch {
    writeReport(
      createReport({
        derivation: [],
        registry: null,
        violations: [
          finding("identity-creation-guard-internal-error", "The identity creation position guard could not complete."),
        ],
      }),
      options?.json ?? false,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acquireHeavySlot("script-battery");
  main();
}
