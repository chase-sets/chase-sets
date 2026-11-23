// Holds `<identifier>.data as` casts in bounded-context production source at a
// committed per-file ceiling. A consumer that casts another context's event
// payload to a local shape is not linked to the producer's published type; the
// typed route is defineProjectorHandlers over a Pick of the published payload
// map. This is a text scan with no type analysis: a file is exempt only when it
// declares handler keys and every key is its own context's, so a cast moved
// into a keyless helper stays counted.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import { listBoundedContextManifests, repoRoot as defaultRepoRoot } from "../lib/repo.mjs";

export const CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH =
  "scripts/check-structure/cross-context-event-payload-casts-baseline.json";

const checkCommand = "node scripts/check-structure/cross-context-event-payload-casts.mjs";
const sourceModulePattern = /\.tsx?$/;
const testModuleSuffixPattern = /\.(?:test|spec|d)\.tsx?$/;
const testOnlyDirectorySegments = Object.freeze([
  "__tests__",
  "e2e",
  "fixtures",
  "tests",
  "fixture",
  "test",
  "test-support",
]);
// Prefixes of event streams that no context registers as its streamPrefix.
const unregisteredStreamPrefixes = Object.freeze(["support.", "experience.", "platform-policy."]);
const eventTypeShape = String.raw`[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+`;
const payloadCastPattern = /(?<![\w$])[A-Za-z_$][\w$]*\.data\s+as\b/g;
// A property name starts its line or follows `{` or `,`, which keeps `case "..."` labels and ternary arms out.
const handlerPropertyKeyPattern = new RegExp(String.raw`(?:^|[{,])[ \t]*(["'])(${eventTypeShape})\1[ \t]*:`, "gm");
const handlerAssignmentKeyPattern = new RegExp(
  String.raw`\bhandlers\[\s*(["'])(${eventTypeShape})\1\s*\]\s*=(?!=)`,
  "g",
);

function normalizeRepoPath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function isScannedProductionModule(file) {
  return (
    /^bounded-contexts\/[^/]+\//.test(file) &&
    sourceModulePattern.test(file) &&
    !testModuleSuffixPattern.test(file) &&
    !file.split("/").some((segment) => testOnlyDirectorySegments.includes(segment))
  );
}

function listTrackedRepoFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--", "bounded-contexts"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(Boolean);
}

function ownStreamPrefixForFile(file, contextManifests) {
  const contextRoot = file.match(/^bounded-contexts\/[^/]+/)?.[0];
  const streamPrefix = contextRoot ? contextManifests.get(contextRoot)?.manifest?.streamPrefix : null;
  return typeof streamPrefix === "string" && streamPrefix.length > 0 ? streamPrefix : null;
}

export function countEventPayloadCasts(content) {
  return [...content.matchAll(payloadCastPattern)].length;
}

export function collectHandlerKeys(content) {
  return [
    ...[...content.matchAll(handlerPropertyKeyPattern)].map((match) => match[2]),
    ...[...content.matchAll(handlerAssignmentKeyPattern)].map((match) => match[2]),
  ];
}

function isExemptFile({ handlerKeys, ownStreamPrefix }) {
  return (
    handlerKeys.length > 0 &&
    handlerKeys.every(
      (key) =>
        (ownStreamPrefix !== null && key.startsWith(ownStreamPrefix)) ||
        unregisteredStreamPrefixes.some((prefix) => key.startsWith(prefix)),
    )
  );
}

/**
 * Scans tracked non-test `.ts`/`.tsx` under `bounded-contexts/<context>/`.
 * `casts` maps every non-exempt file with at least one match to its count, in
 * path order; `exemptFiles` holds exempt files that have matches.
 */
export function collectCrossContextEventPayloadCasts({ repoRoot, contextManifests, listTrackedFiles }) {
  const trackedFiles = (listTrackedFiles ?? listTrackedRepoFiles)(repoRoot).map(normalizeRepoPath);
  const scannedFiles = [...new Set(trackedFiles.filter(isScannedProductionModule))].sort();
  const casts = new Map();
  const exemptFiles = new Set();

  for (const file of scannedFiles) {
    const absolutePath = path.join(repoRoot, ...file.split("/"));
    // A tracked path deleted from the working tree has no module to scan.
    if (!existsSync(absolutePath)) {
      continue;
    }

    const content = readFileSync(absolutePath, "utf8");
    const count = countEventPayloadCasts(content);
    if (count === 0) {
      continue;
    }

    const exempt = isExemptFile({
      handlerKeys: collectHandlerKeys(content),
      ownStreamPrefix: ownStreamPrefixForFile(file, contextManifests),
    });
    if (exempt) {
      exemptFiles.add(file);
    } else {
      casts.set(file, count);
    }
  }

  return { casts, exemptFiles };
}

function readBaseline({ repoRoot, baselinePath, violations }) {
  const absolutePath = path.resolve(repoRoot, baselinePath);
  if (!existsSync(absolutePath)) {
    return { exists: false, entries: new Map() };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    violations.push(`${baselinePath}: baseline is not valid JSON (${error instanceof Error ? error.message : error})`);
    return { exists: true, entries: new Map() };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    violations.push(`${baselinePath}: baseline must be an object that maps file paths to cast counts`);
    return { exists: true, entries: new Map() };
  }

  const entries = new Map();
  for (const [file, count] of Object.entries(parsed)) {
    if (file !== normalizeRepoPath(file)) {
      violations.push(`${baselinePath}: entry '${file}' must be a normalized repository path with forward slashes`);
      continue;
    }
    if (!Number.isInteger(count) || count < 1) {
      violations.push(`${baselinePath}: entry '${file}' must be a positive integer cast count`);
      continue;
    }
    entries.set(file, count);
  }

  return { exists: true, entries };
}

const typedRouteAdvice =
  "Read the payload through defineProjectorHandlers over a Pick of the published payload map instead of casting. " +
  "The ceiling covers every cast in the file, including casts on its own context's events.";

function staleEntryReason({ repoRoot, file, exemptFiles }) {
  if (!existsSync(path.join(repoRoot, ...file.split("/")))) {
    return "the file is gone";
  }
  if (exemptFiles.has(file)) {
    return "the file is exempt because every handler key in it is its own context's";
  }
  return "the file holds no counted cast";
}

export function validateCrossContextEventPayloadCasts(options) {
  const {
    repoRoot,
    contextManifests,
    baselinePath = CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH,
    listTrackedFiles,
  } = options;
  const violations = [];
  const warnings = [];
  const { casts, exemptFiles } = collectCrossContextEventPayloadCasts({ repoRoot, contextManifests, listTrackedFiles });
  const baseline = readBaseline({ repoRoot, baselinePath, violations });

  for (const [file, count] of casts) {
    const allowed = baseline.entries.get(file);
    if (allowed === undefined) {
      violations.push(
        `${file}: ${count} '<identifier>.data as' cast(s) and no entry in ${baselinePath} (allowed 0). ${typedRouteAdvice}`,
      );
    } else if (count > allowed) {
      violations.push(
        `${file}: ${count} '<identifier>.data as' cast(s) but ${baselinePath} allows ${allowed}. ${typedRouteAdvice}`,
      );
    } else if (count < allowed) {
      violations.push(
        `${baselinePath}: stale entry for ${file} allows ${allowed} cast(s) but the file holds ${count}; ` +
          `lower it with \`${checkCommand} --write\`.`,
      );
    }
  }

  for (const [file, allowed] of baseline.entries) {
    if (casts.has(file)) {
      continue;
    }
    violations.push(
      `${baselinePath}: stale entry for ${file} allows ${allowed} cast(s) but ` +
        `${staleEntryReason({ repoRoot, file, exemptFiles })}; remove it with \`${checkCommand} --write\`.`,
    );
  }

  return {
    ok: violations.length === 0,
    casts,
    baselineEntries: baseline.entries,
    violations,
    warnings,
  };
}

function serializeBaseline(entries) {
  const sorted = Object.fromEntries([...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Creates the baseline when the file is absent. Against an existing baseline it
 * only lowers or removes entries; a file that needs a new or higher entry is
 * returned in `refused` and left for the check to fail on.
 */
export function writeCrossContextEventPayloadCastsBaseline(options) {
  const {
    repoRoot,
    contextManifests,
    baselinePath = CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH,
    listTrackedFiles,
  } = options;
  const { casts } = collectCrossContextEventPayloadCasts({ repoRoot, contextManifests, listTrackedFiles });
  const absolutePath = path.resolve(repoRoot, baselinePath);

  if (!existsSync(absolutePath)) {
    writeFileSync(absolutePath, serializeBaseline(casts), "utf8");
    return { created: true, lowered: [], removed: [], refused: [] };
  }

  const shapeViolations = [];
  const baseline = readBaseline({ repoRoot, baselinePath, violations: shapeViolations });
  if (shapeViolations.length > 0) {
    throw new Error(shapeViolations.join("\n"));
  }

  const next = new Map();
  const lowered = [];
  const removed = [];
  const refused = [];

  for (const [file, allowed] of baseline.entries) {
    const count = casts.get(file);
    if (count === undefined) {
      removed.push({ file, from: allowed });
    } else if (count < allowed) {
      next.set(file, count);
      lowered.push({ file, from: allowed, to: count });
    } else {
      next.set(file, allowed);
      if (count > allowed) {
        refused.push({ file, count, allowed });
      }
    }
  }

  for (const [file, count] of casts) {
    if (!baseline.entries.has(file)) {
      refused.push({ file, count, allowed: 0 });
    }
  }

  if (lowered.length > 0 || removed.length > 0) {
    writeFileSync(absolutePath, serializeBaseline(next), "utf8");
  }

  return { created: false, lowered, removed, refused };
}

export function formatCrossContextEventPayloadCastInventory(casts) {
  const total = [...casts.values()].reduce((sum, count) => sum + count, 0);
  const width = Math.max(1, ...[...casts.values()].map((count) => String(count).length));
  return [
    ...[...casts].map(([file, count]) => `${String(count).padStart(width)}  ${file}`),
    `${casts.size} file(s), ${total} cast(s)`,
  ].join("\n");
}

function loadContextManifestsForDirectRun(repoRoot) {
  return new Map(
    listBoundedContextManifests({ repoRoot }).map((context) => [
      `bounded-contexts/${context.dirName}`,
      { manifest: context.manifest },
    ]),
  );
}

function main() {
  const repoRoot = defaultRepoRoot;
  const contextManifests = loadContextManifestsForDirectRun(repoRoot);

  if (process.argv.includes("--write")) {
    const outcome = writeCrossContextEventPayloadCastsBaseline({ repoRoot, contextManifests });
    if (outcome.created) {
      console.log(`Created ${CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH}.`);
    }
    for (const { file, from, to } of outcome.lowered) {
      console.log(`Lowered ${file} from ${from} to ${to}.`);
    }
    for (const { file, from } of outcome.removed) {
      console.log(`Removed ${file} (was ${from}).`);
    }
    for (const { file, count, allowed } of outcome.refused) {
      console.error(
        `Refused to raise ${file} from ${allowed} to ${count}: --write only lowers or removes entries. ${typedRouteAdvice}`,
      );
    }
    if (outcome.refused.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const result = validateCrossContextEventPayloadCasts({ repoRoot, contextManifests });
  console.log(formatCrossContextEventPayloadCastInventory(result.casts));
  for (const violation of result.violations) {
    console.error(violation);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
