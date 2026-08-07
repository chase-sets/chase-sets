import { lstatSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * admission-object-class/v1 defines the object-class authority for one object
 * that a caller has already stated.
 *
 * Complete Active Predicate Set: every derived Stats predicate that returns
 * true for the stated object.
 *
 * Derived Object-Class Partition: the exhaustive assignment of the runtime's
 * derived predicates to the link, directory, file, or default-refusal arms.
 *
 * Admitted Directory Entry: the exact stated entry accepted at its path
 * position, without making any claim about content provenance.
 *
 * Class Outside The Guarantee: a named class for which no executed observation
 * exists and for which this authority makes no classification claim.
 */

export const ADMISSION_OBJECT_CLASS_VERSION = "admission-object-class/v1";

export const ADMISSION_OBJECT_CLASSIFICATIONS = Object.freeze([
  "admissible",
  "reparse-point-in-path",
  "component-not-a-directory",
  "target-not-a-regular-file",
  "target-multiply-linked",
  "filesystem-unavailable",
]);

const realRuntimeStats = lstatSync(fileURLToPath(import.meta.url), { bigint: true });

function deriveStatsPredicates(stats) {
  const names = new Set();
  let prototype = Object.getPrototypeOf(stats);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name.startsWith("is")) names.add(name);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return Object.freeze([...names].sort());
}

export const DERIVED_STATS_PREDICATES = deriveStatsPredicates(realRuntimeStats);

export const STATS_PREDICATE_DERIVATION = Object.freeze({
  runtime: "node",
  runtimeVersion: process.version,
  source: "real-stats-prototype-chain",
  predicates: DERIVED_STATS_PREDICATES,
});

const LINK_PREDICATE = "isSymbolicLink";
const DIRECTORY_PREDICATE = "isDirectory";
const FILE_PREDICATE = "isFile";
const DECIDED_PREDICATES = new Set([LINK_PREDICATE, DIRECTORY_PREDICATE, FILE_PREDICATE]);

function frozenDerivedMembers(predicate) {
  return Object.freeze(DERIVED_STATS_PREDICATES.filter(predicate));
}

export const HANDLED_STATS_PREDICATE_PARTITION = Object.freeze([
  Object.freeze({
    arm: "link-precedence",
    predicates: frozenDerivedMembers((name) => name === LINK_PREDICATE),
  }),
  Object.freeze({
    arm: "intermediate-directory",
    predicates: frozenDerivedMembers((name) => name === DIRECTORY_PREDICATE),
  }),
  Object.freeze({
    arm: "final-regular-file",
    predicates: frozenDerivedMembers((name) => name === FILE_PREDICATE),
  }),
  Object.freeze({
    arm: "default-refusal",
    predicates: frozenDerivedMembers((name) => !DECIDED_PREDICATES.has(name)),
  }),
]);

function freezeMatrix(records) {
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

export const COVERED_OBJECT_CLASS_MATRIX = freezeMatrix([
  {
    objectClass: "windows-directory-junction",
    platform: "win32",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "windows-directory-symbolic-link",
    platform: "win32",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "windows-file-symbolic-link",
    platform: "win32",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "relative-directory-symbolic-link",
    platform: "all",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "posix-directory-symbolic-link",
    platform: "posix",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "posix-file-symbolic-link",
    platform: "posix",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "hard-link",
    platform: "all",
    evidence: "executed-real-refusal",
    classification: "target-multiply-linked",
  },
  {
    objectClass: "windows-application-execution-alias-reparse-tag",
    platform: "win32",
    evidence: "executed-real-refusal",
    classification: "reparse-point-in-path",
  },
  {
    objectClass: "cloud-storage-placeholder",
    platform: "win32",
    evidence: "executed-real-admission",
    classification: "admissible",
  },
]);

export const OBJECT_CLASSES_OUTSIDE_GUARANTEE = freezeMatrix([
  {
    objectClass: "windows-volume-mount-point",
    platform: "win32",
    status: "outside-guarantee",
    reason:
      "mountvol reports every volume mounted at a drive letter or unmounted; no directory mount point exists on this host and creating one requires elevation",
  },
  {
    objectClass: "posix-bind-mount",
    platform: "posix",
    status: "outside-guarantee",
    reason: "not constructible on win32; a bind mount in a hosted ubuntu job requires CAP_SYS_ADMIN",
  },
  {
    objectClass: "ntfs-deduplication-reparse-tag",
    platform: "win32",
    status: "outside-guarantee",
    reason: "Get-DedupStatus is not available on this host",
  },
]);

function filesystemUnavailable() {
  return Object.freeze({
    version: ADMISSION_OBJECT_CLASS_VERSION,
    classification: "filesystem-unavailable",
  });
}

function classified(classification, activePredicates) {
  return Object.freeze({
    version: ADMISSION_OBJECT_CLASS_VERSION,
    classification,
    activePredicates,
  });
}

function interrogateStats(stats) {
  try {
    const active = [];
    for (const predicateName of DERIVED_STATS_PREDICATES) {
      const predicate = Reflect.get(stats, predicateName);
      if (typeof predicate !== "function") return null;
      const result = Reflect.apply(predicate, stats, []);
      if (typeof result !== "boolean") return null;
      if (result) active.push(predicateName);
    }
    return Object.freeze(active.sort());
  } catch {
    return null;
  }
}

function exactActiveSet(activePredicates, predicateName) {
  return activePredicates.length === 1 && activePredicates[0] === predicateName;
}

function readLinkCount(stats) {
  try {
    const linkCount = Reflect.get(stats, "nlink");
    if (typeof linkCount === "bigint") return linkCount;
    if (typeof linkCount === "number" && Number.isSafeInteger(linkCount)) return BigInt(linkCount);
    return null;
  } catch {
    return null;
  }
}

export function classifyStatedObject(stats, position) {
  if (position !== "intermediate" && position !== "final") return filesystemUnavailable();

  const activePredicates = interrogateStats(stats);
  if (activePredicates === null) return filesystemUnavailable();

  if (activePredicates.includes(LINK_PREDICATE)) {
    return classified("reparse-point-in-path", activePredicates);
  }

  if (position === "intermediate") {
    return classified(
      exactActiveSet(activePredicates, DIRECTORY_PREDICATE) ? "admissible" : "component-not-a-directory",
      activePredicates,
    );
  }

  if (!exactActiveSet(activePredicates, FILE_PREDICATE)) {
    return classified("target-not-a-regular-file", activePredicates);
  }

  const linkCount = readLinkCount(stats);
  if (linkCount === null) return filesystemUnavailable();
  if (linkCount > 1n) return classified("target-multiply-linked", activePredicates);
  return classified(linkCount === 1n ? "admissible" : "target-not-a-regular-file", activePredicates);
}
