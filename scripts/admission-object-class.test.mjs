import { Stats, constants as fsConstants, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { link, lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMISSION_OBJECT_CLASS_VERSION,
  ADMISSION_OBJECT_CLASSIFICATIONS,
  COVERED_OBJECT_CLASS_MATRIX,
  DERIVED_STATS_PREDICATES,
  HANDLED_STATS_PREDICATE_PARTITION,
  OBJECT_CLASSES_OUTSIDE_GUARANTEE,
  STATS_PREDICATE_DERIVATION,
  classifyStatedObject,
} from "./admission-object-class.mjs";

const EXPECTED_PREDICATES = [
  "isBlockDevice",
  "isCharacterDevice",
  "isDirectory",
  "isFIFO",
  "isFile",
  "isSocket",
  "isSymbolicLink",
];
const REFUSING_CLASSIFICATIONS = ADMISSION_OBJECT_CLASSIFICATIONS.filter(
  (classification) => classification !== "admissible",
);
const modulePath = fileURLToPath(new URL("./admission-object-class.mjs", import.meta.url));
const moduleSource = readFileSync(modulePath, "utf8");
const testFilePath = fileURLToPath(import.meta.url);
const runtimeFileStats = lstatSync(testFilePath, { bigint: true });
const runtimeDirectoryStats = lstatSync(path.dirname(testFilePath), { bigint: true });
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "admission-object-class-"));
const realControls = new Map();
const controlFailures = new Map();
let applicationAliasObservation;
let cloudStorageObservation;

function activePredicates(stats) {
  return DERIVED_STATS_PREDICATES.filter((predicateName) => stats[predicateName]());
}

function syntheticStats(active, { nlink = 1n, overrides = {} } = {}) {
  const stats = Object.create(Object.getPrototypeOf(runtimeFileStats));
  for (const predicateName of DERIVED_STATS_PREDICATES) {
    Object.defineProperty(stats, predicateName, {
      configurable: true,
      value: () => active.includes(predicateName),
    });
  }
  Object.defineProperty(stats, "nlink", { configurable: true, value: nlink });
  for (const [name, value] of Object.entries(overrides)) {
    Object.defineProperty(stats, name, { configurable: true, value });
  }
  return stats;
}

function knownFirstMutant(stats, position) {
  if (stats.isSymbolicLink()) return "reparse-point-in-path";
  if (position === "intermediate") {
    return stats.isDirectory() ? "admissible" : "component-not-a-directory";
  }
  return stats.isFile() ? "admissible" : "target-not-a-regular-file";
}

function droppedLinkCountMutant(stats, position) {
  if (stats.isSymbolicLink()) return "reparse-point-in-path";
  if (position === "intermediate") {
    return stats.isDirectory() ? "admissible" : "component-not-a-directory";
  }
  return stats.isFile() ? "admissible" : "target-not-a-regular-file";
}

function intermediateLinkCountMutant(stats, position) {
  if (stats.isSymbolicLink()) return "reparse-point-in-path";
  if (position === "intermediate") {
    return stats.isDirectory() && BigInt(stats.nlink) === 1n ? "admissible" : "component-not-a-directory";
  }
  if (!stats.isFile()) return "target-not-a-regular-file";
  return BigInt(stats.nlink) > 1n ? "target-multiply-linked" : "admissible";
}

function classificationRecordErrors(record) {
  const errors = [];
  const classification = record?.classification;
  const expectedKeys =
    classification === "filesystem-unavailable"
      ? ["classification", "version"]
      : ["activePredicates", "classification", "version"];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join("|") !== expectedKeys.join("|")
  ) {
    errors.push("record-keys");
    return errors;
  }
  if (record.version !== ADMISSION_OBJECT_CLASS_VERSION) errors.push("version");
  if (!ADMISSION_OBJECT_CLASSIFICATIONS.includes(classification)) errors.push("classification");
  if (classification !== "filesystem-unavailable") {
    if (
      !Array.isArray(record.activePredicates) ||
      !Object.isFrozen(record.activePredicates) ||
      record.activePredicates.some((member) => !DERIVED_STATS_PREDICATES.includes(member)) ||
      [...record.activePredicates].sort().join("|") !== record.activePredicates.join("|")
    ) {
      errors.push("active-predicates");
    }
  }
  return errors;
}

function matrixRecordErrors(record) {
  const errors = [];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join("|") !== "classification|evidence|objectClass|platform"
  ) {
    errors.push("matrix-keys");
    return errors;
  }
  if (!ADMISSION_OBJECT_CLASSIFICATIONS.includes(record.classification)) errors.push("classification");
  if (typeof record.objectClass !== "string" || record.objectClass.length === 0) errors.push("object-class");
  if (!["all", "posix", "win32"].includes(record.platform)) errors.push("platform");
  if (typeof record.evidence !== "string" || record.evidence.length === 0) errors.push("evidence");
  return errors;
}

function partitionErrors(partition) {
  const members = partition.flatMap((arm) => arm.predicates);
  const uniqueMembers = new Set(members);
  const derivedMembers = new Set(DERIVED_STATS_PREDICATES);
  const errors = [];
  if (members.length !== uniqueMembers.size) errors.push("duplicate-member");
  if (uniqueMembers.size !== derivedMembers.size) errors.push("aggregate-size");
  if ([...uniqueMembers].some((member) => !derivedMembers.has(member))) errors.push("unknown-member");
  if ([...derivedMembers].some((member) => !uniqueMembers.has(member))) errors.push("missing-member");
  return errors;
}

async function createLinkControl({ objectClass, targetKind, symbolicLinkType, relativeTarget = false }) {
  const controlRoot = path.join(tempRoot, objectClass);
  const target = path.join(controlRoot, "target");
  const entry = path.join(controlRoot, "entry");
  await mkdir(controlRoot, { recursive: true });
  if (targetKind === "directory") await mkdir(target);
  else await writeFile(target, "candidate-vs-mutant");
  const targetArgument = relativeTarget ? path.relative(path.dirname(entry), target) : target;
  await symlink(targetArgument, entry, symbolicLinkType);
  return {
    objectClass,
    entry,
    stats: await lstat(entry, { bigint: true }),
  };
}

async function captureControl(definition) {
  try {
    realControls.set(definition.objectClass, await createLinkControl(definition));
  } catch (error) {
    controlFailures.set(definition.objectClass, error?.code ?? error?.message ?? String(error));
  }
}

function requireControl(objectClass) {
  const control = realControls.get(objectClass);
  if (!control) {
    throw new Error(`class-unavailable:${objectClass}:${controlFailures.get(objectClass) ?? "not-created"}`);
  }
  return control;
}

async function observeApplicationExecutionAliases() {
  if (process.platform !== "win32") return { state: "not-applicable", activeSets: [], classifications: [] };
  const aliasDirectory = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps");
  try {
    const entries = (await readdir(aliasDirectory)).filter((entry) => entry.toLowerCase().endsWith(".exe"));
    const observations = [];
    for (const entry of entries.slice(0, 64)) {
      try {
        const stats = await lstat(path.join(aliasDirectory, entry), { bigint: true });
        const active = activePredicates(stats);
        if (active.length === 1 && active[0] === "isSymbolicLink") {
          observations.push({
            activePredicates: active,
            classification: classifyStatedObject(stats, "final").classification,
          });
        }
      } catch {
        // An unreadable alias is not evidence for or against this object class.
      }
    }
    return {
      state: observations.length > 0 ? "observed" : "not-present-on-host",
      activeSets: observations.map((observation) => observation.activePredicates),
      classifications: observations.map((observation) => observation.classification),
    };
  } catch (error) {
    return {
      state: "not-present-on-host",
      activeSets: [],
      classifications: [],
      reason: error?.code ?? "unavailable",
    };
  }
}

async function firstRegularFileBelow(root, maximumEntries = 300) {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < maximumEntries) {
    const current = pending.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maximumEntries) break;
      const entryPath = path.join(current, entry.name);
      if (entry.isFile()) return entryPath;
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return null;
}

async function observeCloudStorageEntry() {
  if (process.platform !== "win32") return { state: "not-applicable" };
  const roots = [
    ...new Set([process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = await firstRegularFileBelow(root);
    if (!candidate) continue;
    try {
      const stats = await lstat(candidate, { bigint: true });
      return {
        state: "observed",
        activePredicates: activePredicates(stats),
        linkCount: String(stats.nlink),
        classification: classifyStatedObject(stats, "final").classification,
      };
    } catch {
      // Continue to the next cloud-storage root.
    }
  }
  return { state: "not-present-on-host" };
}

beforeAll(async () => {
  const platformDefinitions =
    process.platform === "win32"
      ? [
          {
            objectClass: "windows-directory-junction",
            targetKind: "directory",
            symbolicLinkType: "junction",
          },
          {
            objectClass: "windows-directory-symbolic-link",
            targetKind: "directory",
            symbolicLinkType: "dir",
          },
          {
            objectClass: "windows-file-symbolic-link",
            targetKind: "file",
            symbolicLinkType: "file",
          },
          {
            objectClass: "relative-directory-symbolic-link",
            targetKind: "directory",
            symbolicLinkType: "dir",
            relativeTarget: true,
          },
        ]
      : [
          {
            objectClass: "posix-directory-symbolic-link",
            targetKind: "directory",
            symbolicLinkType: "dir",
          },
          {
            objectClass: "posix-file-symbolic-link",
            targetKind: "file",
            symbolicLinkType: "file",
          },
          {
            objectClass: "relative-directory-symbolic-link",
            targetKind: "directory",
            symbolicLinkType: "dir",
            relativeTarget: true,
          },
        ];
  for (const definition of platformDefinitions) await captureControl(definition);

  const hardLinkRoot = path.join(tempRoot, "hard-link-base");
  const hardLinkTarget = path.join(tempRoot, "hard-link-target");
  const hardLinkEntry = path.join(hardLinkRoot, "entry");
  await mkdir(hardLinkRoot);
  await writeFile(hardLinkTarget, "same-inode");
  await link(hardLinkTarget, hardLinkEntry);
  realControls.set("hard-link", {
    objectClass: "hard-link",
    entry: hardLinkEntry,
    stats: await lstat(hardLinkEntry, { bigint: true }),
  });

  const plainFile = path.join(tempRoot, "plain-file");
  await writeFile(plainFile, "same-content");
  realControls.set("plain-file", {
    objectClass: "plain-file",
    entry: plainFile,
    stats: await lstat(plainFile, { bigint: true }),
  });

  const directory = path.join(tempRoot, "directory-with-child");
  await mkdir(path.join(directory, "child"), { recursive: true });
  realControls.set("directory-with-child", {
    objectClass: "directory-with-child",
    entry: directory,
    stats: await lstat(directory, { bigint: true }),
  });

  applicationAliasObservation = await observeApplicationExecutionAliases();
  cloudStorageObservation = await observeCloudStorageEntry();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("admission-object-class/v1 runtime derivation", () => {
  it("derives the complete predicate surface from a real Stats prototype chain", () => {
    expect(DERIVED_STATS_PREDICATES).toEqual(EXPECTED_PREDICATES);
    expect(Object.isFrozen(DERIVED_STATS_PREDICATES)).toBe(true);
    expect(STATS_PREDICATE_DERIVATION).toEqual({
      runtime: "node",
      runtimeVersion: process.version,
      source: "real-stats-prototype-chain",
      predicates: EXPECTED_PREDICATES,
    });
  });

  it("proves a shallow Stats prototype read is insufficient", () => {
    const shallowPredicates = Object.getOwnPropertyNames(Stats.prototype).filter((name) => name.startsWith("is"));
    expect(shallowPredicates).toEqual([]);
    expect(DERIVED_STATS_PREDICATES).not.toEqual(shallowPredicates);
  });

  it("partitions every derived predicate exactly once with no invented member", () => {
    expect(partitionErrors(HANDLED_STATS_PREDICATE_PARTITION)).toEqual([]);
    expect(HANDLED_STATS_PREDICATE_PARTITION).toEqual([
      { arm: "link-precedence", predicates: ["isSymbolicLink"] },
      { arm: "intermediate-directory", predicates: ["isDirectory"] },
      { arm: "final-regular-file", predicates: ["isFile"] },
      {
        arm: "default-refusal",
        predicates: ["isBlockDevice", "isCharacterDevice", "isFIFO", "isSocket"],
      },
    ]);
  });

  it("keeps partial and empty partition controls red at aggregate completeness", () => {
    const partial = HANDLED_STATS_PREDICATE_PARTITION.slice(0, 3);
    const empty = [];
    expect(partitionErrors(partial)).toContain("missing-member");
    expect(partitionErrors(empty)).toContain("missing-member");
  });

  it("grounds the exactly-one admissible sets in real file and directory observations", () => {
    expect(activePredicates(runtimeFileStats)).toEqual(["isFile"]);
    expect(activePredicates(runtimeDirectoryStats)).toEqual(["isDirectory"]);
  });
});

describe("complete active predicate set partition", () => {
  const cases = [
    {
      name: "single file at final",
      active: ["isFile"],
      position: "final",
      expected: "admissible",
      mutant: "admissible",
    },
    {
      name: "single directory at intermediate",
      active: ["isDirectory"],
      position: "intermediate",
      expected: "admissible",
      mutant: "admissible",
    },
    {
      name: "unknown-only at final",
      active: ["isSocket"],
      position: "final",
      expected: "target-not-a-regular-file",
      mutant: "target-not-a-regular-file",
    },
    {
      name: "additive file plus unnamed predicate at final",
      active: ["isFile", "isSocket"],
      position: "final",
      expected: "target-not-a-regular-file",
      mutant: "admissible",
    },
    {
      name: "additive directory plus unnamed predicate at intermediate",
      active: ["isDirectory", "isSocket"],
      position: "intermediate",
      expected: "component-not-a-directory",
      mutant: "admissible",
    },
    {
      name: "two known predicates at final",
      active: ["isDirectory", "isFile"],
      position: "final",
      expected: "target-not-a-regular-file",
      mutant: "admissible",
    },
    {
      name: "empty set at intermediate",
      active: [],
      position: "intermediate",
      expected: "component-not-a-directory",
      mutant: "component-not-a-directory",
    },
    {
      name: "link plus unnamed predicate preserves link precedence",
      active: ["isSocket", "isSymbolicLink"],
      position: "final",
      expected: "reparse-point-in-path",
      mutant: "reparse-point-in-path",
    },
  ];

  it.each(cases)("$name", ({ active, position, expected, mutant }) => {
    const stats = syntheticStats(active);
    const result = classifyStatedObject(stats, position);
    expect(result).toEqual({
      version: ADMISSION_OBJECT_CLASS_VERSION,
      classification: expected,
      activePredicates: [...active].sort(),
    });
    expect(knownFirstMutant(stats, position)).toBe(mutant);
  });

  it("executes the named known-first bypass mutant and proves only aggregate controls kill it", () => {
    const frozenControls = {
      onlyFile: syntheticStats(["isFile"]),
      onlyUnknown: syntheticStats(["isSocket"]),
      additive: syntheticStats(["isFile", "isSocket"]),
    };
    expect(
      Object.fromEntries(
        Object.entries(frozenControls).map(([name, stats]) => [
          name,
          {
            candidate: classifyStatedObject(stats, "final").classification,
            knownFirstMutant: knownFirstMutant(stats, "final"),
          },
        ]),
      ),
    ).toEqual({
      onlyFile: { candidate: "admissible", knownFirstMutant: "admissible" },
      onlyUnknown: {
        candidate: "target-not-a-regular-file",
        knownFirstMutant: "target-not-a-regular-file",
      },
      additive: { candidate: "target-not-a-regular-file", knownFirstMutant: "admissible" },
    });
  });
});

describe("uninterrogable Stats refusal", () => {
  const cases = [
    {
      name: "absent derived predicate",
      stats: () => syntheticStats(["isFile"], { overrides: { isSocket: undefined } }),
    },
    {
      name: "non-callable derived predicate",
      stats: () => syntheticStats(["isFile"], { overrides: { isFile: true } }),
    },
    {
      name: "throwing derived predicate",
      stats: () =>
        syntheticStats(["isFile"], {
          overrides: {
            isSocket() {
              throw new Error("predicate unavailable");
            },
          },
        }),
    },
    {
      name: "non-boolean predicate result",
      stats: () => syntheticStats(["isFile"], { overrides: { isSocket: () => "false" } }),
    },
    {
      name: "non-numeric final link count",
      stats: () => syntheticStats(["isFile"], { nlink: "1" }),
    },
  ];

  it.each(cases)("returns filesystem-unavailable for a $name", ({ stats }) => {
    expect(() => classifyStatedObject(stats(), "final")).not.toThrow();
    expect(classifyStatedObject(stats(), "final")).toEqual({
      version: ADMISSION_OBJECT_CLASS_VERSION,
      classification: "filesystem-unavailable",
    });
  });

  it("never throws for a hostile input corpus including revoked and throwing proxies", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile get");
        },
      },
    );
    const hostileInputs = [null, undefined, 7, "stats", [], revoked.proxy, throwingProxy];
    for (const input of hostileInputs) {
      expect(() => classifyStatedObject(input, "final")).not.toThrow();
      expect(classifyStatedObject(input, "final").classification).toBe("filesystem-unavailable");
    }
  });

  it("refuses an invalid position instead of treating it as final", () => {
    expect(classifyStatedObject(syntheticStats(["isFile"]), "terminal")).toEqual({
      version: ADMISSION_OBJECT_CLASS_VERSION,
      classification: "filesystem-unavailable",
    });
  });
});

describe("real link-count evidence and one-variable mutants", () => {
  it("refuses a real hard link whose complete active set is only isFile", () => {
    const hardLinkStats = requireControl("hard-link").stats;
    expect(activePredicates(hardLinkStats)).toEqual(["isFile"]);
    expect(hardLinkStats.nlink).toBeGreaterThan(1n);
    expect(classifyStatedObject(hardLinkStats, "final")).toEqual({
      version: ADMISSION_OBJECT_CLASS_VERSION,
      classification: "target-multiply-linked",
      activePredicates: ["isFile"],
    });
    expect(droppedLinkCountMutant(hardLinkStats, "final")).toBe("admissible");
  });

  it("admits an otherwise identical single-linked real regular file", () => {
    const plainFileStats = requireControl("plain-file").stats;
    expect(activePredicates(plainFileStats)).toEqual(["isFile"]);
    expect(plainFileStats.nlink).toBe(1n);
    expect(classifyStatedObject(plainFileStats, "final").classification).toBe("admissible");
  });

  it("keeps the intermediate position independent of link count", () => {
    const highLinkCountDirectory = syntheticStats(["isDirectory"], { nlink: 9n });
    expect(classifyStatedObject(highLinkCountDirectory, "intermediate").classification).toBe("admissible");
    expect(intermediateLinkCountMutant(highLinkCountDirectory, "intermediate")).toBe("component-not-a-directory");
  });

  it("observes and admits a real POSIX directory whose link count exceeds one", () => {
    const directoryStats = requireControl("directory-with-child").stats;
    expect(activePredicates(directoryStats)).toEqual(["isDirectory"]);
    expect(classifyStatedObject(directoryStats, "intermediate").classification).toBe("admissible");
    if (process.platform !== "win32") expect(directoryStats.nlink).toBeGreaterThan(1n);
    else expect(directoryStats.nlink).toBeGreaterThanOrEqual(1n);
  });

  it("compares both bigint and number link counts in bigint", () => {
    const bigintStats = syntheticStats(["isFile"], { nlink: 1n });
    const numberStats = syntheticStats(["isFile"], { nlink: 1 });
    expect(classifyStatedObject(bigintStats, "final").classification).toBe("admissible");
    expect(classifyStatedObject(numberStats, "final").classification).toBe("admissible");
  });
});

describe("executed real object-class matrix", () => {
  it("constructs every expected platform class or fails with an explicit class-unavailable identity", () => {
    const expected =
      process.platform === "win32"
        ? [
            "windows-directory-junction",
            "windows-directory-symbolic-link",
            "windows-file-symbolic-link",
            "relative-directory-symbolic-link",
          ]
        : ["posix-directory-symbolic-link", "posix-file-symbolic-link", "relative-directory-symbolic-link"];
    const unavailable = expected
      .filter((objectClass) => !realControls.has(objectClass))
      .map((objectClass) => `class-unavailable:${objectClass}:${controlFailures.get(objectClass) ?? "unknown"}`);
    expect(unavailable, unavailable.join(",")).toEqual([]);
  });

  it("asserts every helper-created control is a real link and kills the ordinary-directory helper mutant", async () => {
    const platformClasses =
      process.platform === "win32"
        ? [
            "windows-directory-junction",
            "windows-directory-symbolic-link",
            "windows-file-symbolic-link",
            "relative-directory-symbolic-link",
          ]
        : ["posix-directory-symbolic-link", "posix-file-symbolic-link", "relative-directory-symbolic-link"];
    for (const objectClass of platformClasses) {
      expect(requireControl(objectClass).stats.isSymbolicLink()).toBe(true);
    }
    const ordinaryDirectory = path.join(tempRoot, "ordinary-directory-mutant");
    await mkdir(ordinaryDirectory);
    const ordinaryStats = await lstat(ordinaryDirectory, { bigint: true });
    expect(ordinaryStats.isSymbolicLink()).toBe(false);
  });

  it("executes refusal evidence for every constructible link class on the running platform", () => {
    const platformClasses =
      process.platform === "win32"
        ? [
            ["windows-directory-junction", "intermediate"],
            ["windows-directory-symbolic-link", "intermediate"],
            ["windows-file-symbolic-link", "final"],
            ["relative-directory-symbolic-link", "intermediate"],
          ]
        : [
            ["posix-directory-symbolic-link", "intermediate"],
            ["posix-file-symbolic-link", "final"],
            ["relative-directory-symbolic-link", "intermediate"],
          ];
    for (const [objectClass, position] of platformClasses) {
      const result = classifyStatedObject(requireControl(objectClass).stats, position);
      expect(result.classification).toBe("reparse-point-in-path");
      expect(result.activePredicates).toEqual(["isSymbolicLink"]);
    }
  });

  it("records the host-conditional application-execution-alias observation without skipping", () => {
    expect(["not-applicable", "not-present-on-host", "observed"]).toContain(applicationAliasObservation.state);
    if (applicationAliasObservation.state === "observed") {
      expect(applicationAliasObservation.activeSets.length).toBeGreaterThan(0);
      expect(applicationAliasObservation.activeSets.every((active) => active.join("|") === "isSymbolicLink")).toBe(
        true,
      );
      expect(
        applicationAliasObservation.classifications.every(
          (classification) => classification === "reparse-point-in-path",
        ),
      ).toBe(true);
    } else {
      expect(applicationAliasObservation.activeSets).toEqual([]);
      expect(applicationAliasObservation.classifications).toEqual([]);
    }
  });

  it("records a real cloud-storage entry as transparently admitted when present", () => {
    expect(["not-applicable", "not-present-on-host", "observed"]).toContain(cloudStorageObservation.state);
    if (cloudStorageObservation.state === "observed") {
      expect(cloudStorageObservation.activePredicates).toEqual(["isFile"]);
      expect(cloudStorageObservation.linkCount).toBe("1");
      expect(cloudStorageObservation.classification).toBe("admissible");
    }
  });

  it("publishes the complete running-platform capability record", () => {
    const expectedConstructibleClasses =
      process.platform === "win32"
        ? [
            "hard-link",
            "relative-directory-symbolic-link",
            "windows-directory-junction",
            "windows-directory-symbolic-link",
            "windows-file-symbolic-link",
          ]
        : [
            "hard-link",
            "posix-directory-symbolic-link",
            "posix-file-symbolic-link",
            "relative-directory-symbolic-link",
          ];
    const capabilityRecord = {
      platform: process.platform,
      expectedConstructibleClasses,
      constructedClasses: [...realControls.keys()]
        .filter((objectClass) => expectedConstructibleClasses.includes(objectClass))
        .sort(),
      applicationExecutionAlias: applicationAliasObservation,
      cloudStoragePlaceholder: cloudStorageObservation,
    };
    expect(capabilityRecord.constructedClasses).toEqual(expectedConstructibleClasses);
    console.info(`admission-object-class capability ${JSON.stringify(capabilityRecord)}`);
  });
});

describe("closed covered and outside-guarantee authority", () => {
  it("publishes exactly the observed covered matrix and transparently supported cloud entry", () => {
    expect(COVERED_OBJECT_CLASS_MATRIX.map((entry) => entry.objectClass)).toEqual([
      "windows-directory-junction",
      "windows-directory-symbolic-link",
      "windows-file-symbolic-link",
      "relative-directory-symbolic-link",
      "posix-directory-symbolic-link",
      "posix-file-symbolic-link",
      "hard-link",
      "windows-application-execution-alias-reparse-tag",
      "cloud-storage-placeholder",
    ]);
    expect(COVERED_OBJECT_CLASS_MATRIX.find((entry) => entry.objectClass === "cloud-storage-placeholder")).toEqual({
      objectClass: "cloud-storage-placeholder",
      platform: "win32",
      evidence: "executed-real-admission",
      classification: "admissible",
    });
  });

  it("publishes exactly three classes outside the guarantee with concrete evidence gaps", () => {
    expect(OBJECT_CLASSES_OUTSIDE_GUARANTEE.map((entry) => entry.objectClass)).toEqual([
      "windows-volume-mount-point",
      "posix-bind-mount",
      "ntfs-deduplication-reparse-tag",
    ]);
    for (const entry of OBJECT_CLASSES_OUTSIDE_GUARANTEE) {
      expect(Object.keys(entry).sort()).toEqual(["objectClass", "platform", "reason", "status"]);
      expect(entry.status).toBe("outside-guarantee");
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps the covered matrix and outside-guarantee list disjoint", () => {
    const covered = new Set(COVERED_OBJECT_CLASS_MATRIX.map((entry) => entry.objectClass));
    expect(OBJECT_CLASSES_OUTSIDE_GUARANTEE.filter((entry) => covered.has(entry.objectClass))).toEqual([]);
  });

  it("contains no forbidden coverage or redirection claim in the contract text", () => {
    expect(moduleSource).not.toMatch(/fail-closed/i);
    expect(moduleSource).not.toMatch(/mount-redirection/i);
    for (const entry of OBJECT_CLASSES_OUTSIDE_GUARANTEE) {
      expect(moduleSource).toContain(entry.objectClass);
    }
  });

  it("freezes every published aggregate and nested record", () => {
    for (const aggregate of [
      ADMISSION_OBJECT_CLASSIFICATIONS,
      DERIVED_STATS_PREDICATES,
      HANDLED_STATS_PREDICATE_PARTITION,
      COVERED_OBJECT_CLASS_MATRIX,
      OBJECT_CLASSES_OUTSIDE_GUARANTEE,
    ]) {
      expect(Object.isFrozen(aggregate)).toBe(true);
    }
    for (const arm of HANDLED_STATS_PREDICATE_PARTITION) {
      expect(Object.isFrozen(arm)).toBe(true);
      expect(Object.isFrozen(arm.predicates)).toBe(true);
    }
    for (const record of [...COVERED_OBJECT_CLASS_MATRIX, ...OBJECT_CLASSES_OUTSIDE_GUARANTEE]) {
      expect(Object.isFrozen(record)).toBe(true);
    }
  });

  it("closes matrix records recursively and keeps unknown or wrong nested members red", () => {
    expect(COVERED_OBJECT_CLASS_MATRIX.flatMap(matrixRecordErrors)).toEqual([]);
    const valid = COVERED_OBJECT_CLASS_MATRIX[0];
    expect(matrixRecordErrors({ ...valid, unexpected: true })).toContain("matrix-keys");
    expect(matrixRecordErrors({ ...valid, classification: "accepted" })).toContain("classification");
    expect(matrixRecordErrors({ ...valid, platform: "windows" })).toContain("platform");
  });
});

describe("closed classification record", () => {
  function recordsByClassification() {
    return {
      admissible: classifyStatedObject(syntheticStats(["isFile"]), "final"),
      "reparse-point-in-path": classifyStatedObject(syntheticStats(["isSymbolicLink"]), "final"),
      "component-not-a-directory": classifyStatedObject(syntheticStats(["isFile"]), "intermediate"),
      "target-not-a-regular-file": classifyStatedObject(syntheticStats(["isDirectory"]), "final"),
      "target-multiply-linked": classifyStatedObject(syntheticStats(["isFile"], { nlink: 2n }), "final"),
      "filesystem-unavailable": classifyStatedObject(null, "final"),
    };
  }

  it("publishes the exact closed six-member classification vocabulary", () => {
    expect(ADMISSION_OBJECT_CLASSIFICATIONS).toEqual([
      "admissible",
      "reparse-point-in-path",
      "component-not-a-directory",
      "target-not-a-regular-file",
      "target-multiply-linked",
      "filesystem-unavailable",
    ]);
    expect(REFUSING_CLASSIFICATIONS).toHaveLength(5);
  });

  it("returns the exact closed key set for all six classifications", () => {
    const records = recordsByClassification();
    expect(Object.keys(records)).toEqual(ADMISSION_OBJECT_CLASSIFICATIONS);
    for (const [classification, record] of Object.entries(records)) {
      expect(record.classification).toBe(classification);
      expect(classificationRecordErrors(record)).toEqual([]);
      expect(Object.isFrozen(record)).toBe(true);
      if (classification === "filesystem-unavailable") {
        expect(record).not.toHaveProperty("activePredicates");
      } else {
        expect(record).toHaveProperty("activePredicates");
      }
    }
  });

  it("keeps unknown keys, wrong types, and wrong nested members red", () => {
    const valid = recordsByClassification().admissible;
    expect(classificationRecordErrors({ ...valid, unknown: true })).toContain("record-keys");
    expect(classificationRecordErrors({ ...valid, version: 1 })).toContain("version");
    expect(classificationRecordErrors({ ...valid, classification: "accepted" })).toContain("classification");
    expect(classificationRecordErrors({ ...valid, activePredicates: "isFile" })).toContain("active-predicates");
    expect(classificationRecordErrors({ ...valid, activePredicates: Object.freeze(["isFutureClass"]) })).toContain(
      "active-predicates",
    );
  });

  it("leaks no host text or link-count facts in any returned record", () => {
    const serialized = JSON.stringify(recordsByClassification());
    const forbidden = [
      process.platform,
      tempRoot,
      "EPERM",
      "EACCES",
      "ENOENT",
      String(fsConstants.UV_DIRENT_UNKNOWN),
      '"dev"',
      '"ino"',
      '"nlink"',
      '"path"',
    ];
    for (const fragment of forbidden) expect(serialized).not.toContain(fragment);
  });

  it("keeps the classifier pure and the module footprint structurally closed", () => {
    expect(moduleSource.match(/\blstatSync\s*\(/g)).toHaveLength(1);
    expect(moduleSource.match(/export\s+function\s+/g)).toHaveLength(1);
    const classifierSource = moduleSource.slice(moduleSource.indexOf("export function classifyStatedObject"));
    expect(classifierSource).not.toMatch(/\b(?:lstat|stat|realpath|readFile|open)\s*\(/);
    expect(moduleSource).not.toMatch(/#[0-9]{3,}/);
  });
});
