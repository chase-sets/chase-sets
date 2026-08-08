import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COVERED_OBJECT_CLASS_MATRIX as CLASSIFIER_COVERED_MATRIX,
  DERIVED_STATS_PREDICATES,
  OBJECT_CLASSES_OUTSIDE_GUARANTEE as CLASSIFIER_OUTSIDE_GUARANTEE,
} from "./admission-object-class.mjs";
import {
  ADMISSION_CONTAINED_PATH_OUTCOMES,
  ADMISSION_CONTAINED_PATH_VERSION,
  COVERED_OBJECT_CLASS_MATRIX,
  OBJECT_CLASSES_OUTSIDE_GUARANTEE,
  resolveContainedPath,
} from "./admission-contained-path.mjs";

const EXPECTED_OUTCOMES = Object.freeze([
  "contained",
  "input-not-a-string",
  "path-syntax-invalid",
  "options-invalid",
  "reparse-point-in-path",
  "component-not-a-directory",
  "target-not-a-regular-file",
  "target-multiply-linked",
  "base-unresolvable",
  "target-absent",
  "escapes-base",
  "filesystem-unavailable",
]);
const COMPONENT_OUTCOMES = new Set([
  "reparse-point-in-path",
  "component-not-a-directory",
  "target-not-a-regular-file",
  "target-multiply-linked",
  "target-absent",
]);
const modulePath = fileURLToPath(new URL("./admission-contained-path.mjs", import.meta.url));
const moduleSource = readFileSync(modulePath, "utf8");
let tempRoot;
let caseNumber = 0;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "admission-contained-path-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function caseRoot(label) {
  caseNumber += 1;
  const root = path.join(tempRoot, `${label}-${caseNumber}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function createDirectoryLink(target, entry, { relative = false } = {}) {
  const targetArgument = relative ? path.relative(path.dirname(entry), target) : target;
  const type = process.platform === "win32" && !relative ? "junction" : "dir";
  await symlink(targetArgument, entry, type);
  const stats = await lstat(entry, { bigint: true });
  expect(stats.isSymbolicLink()).toBe(true);
  return stats;
}

async function createContainedFile(label, relativePath = "candidate.txt") {
  const root = await caseRoot(label);
  const base = path.join(root, "base");
  const candidate = path.join(base, ...relativePath.split("/"));
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, label);
  return { root, base, candidate, relativePath };
}

function syntheticStats(kind, { device = 7n, index = 11n, linkCount = 1n, overrides = {} } = {}) {
  const activePredicate = kind === "directory" ? "isDirectory" : "isFile";
  const stats = { dev: device, ino: index, nlink: linkCount };
  for (const predicateName of DERIVED_STATS_PREDICATES) {
    stats[predicateName] = () => predicateName === activePredicate;
  }
  Object.assign(stats, overrides);
  return stats;
}

function passthroughFilesystem(observations = []) {
  return {
    async realpath(value) {
      return realpath(value);
    },
    async lstat(value, options) {
      observations.push({ value, options });
      return lstat(value, options);
    },
  };
}

function twoStageSyntheticFilesystem({ base, candidate, stats, canonicalCandidate = candidate, finalError }) {
  let realpathCalls = 0;
  return {
    async realpath() {
      realpathCalls += 1;
      if (realpathCalls === 1) return base;
      if (finalError !== undefined) throw finalError;
      return canonicalCandidate;
    },
    async lstat() {
      return stats;
    },
  };
}

function expectedKeys(record) {
  if (record.outcome === "contained") return ["canonicalPath", "objectIdentity", "outcome", "version"];
  if (record.outcome === "path-syntax-invalid") return ["outcome", "rule", "version"];
  if (COMPONENT_OUTCOMES.has(record.outcome)) return ["componentIndex", "outcome", "version"];
  if (record.outcome === "filesystem-unavailable" && Object.hasOwn(record, "componentIndex")) {
    return ["componentIndex", "outcome", "version"];
  }
  return ["outcome", "version"];
}

function closedRecordErrors(record, componentCount = 300) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["record-type"];
  if (Object.keys(record).sort().join("|") !== expectedKeys(record).join("|")) errors.push("record-keys");
  if (!Object.isFrozen(record)) errors.push("record-frozen");
  if (record.version !== ADMISSION_CONTAINED_PATH_VERSION) errors.push("version");
  if (!EXPECTED_OUTCOMES.includes(record.outcome)) errors.push("outcome");

  if (Object.hasOwn(record, "componentIndex")) {
    if (
      !Number.isSafeInteger(record.componentIndex) ||
      record.componentIndex < 0 ||
      record.componentIndex >= componentCount
    ) {
      errors.push("component-index");
    }
  }
  if (record.outcome === "path-syntax-invalid" && typeof record.rule !== "string") errors.push("rule");
  if (record.outcome === "contained") {
    if (typeof record.canonicalPath !== "string" || !path.isAbsolute(record.canonicalPath)) {
      errors.push("canonical-path");
    }
    const identity = record.objectIdentity;
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      Object.keys(identity).sort().join("|") !== "device|index"
    ) {
      errors.push("object-identity-keys");
    } else {
      if (!Object.isFrozen(identity)) errors.push("object-identity-frozen");
      if (typeof identity.device !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(identity.device)) {
        errors.push("object-identity-device");
      }
      if (typeof identity.index !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(identity.index)) {
        errors.push("object-identity-index");
      }
    }
  }
  return errors;
}

describe("both-sided canonical containment and real reparse controls", () => {
  it("refuses a lexical-true outside-pointing directory link at its exact component", async () => {
    const root = await caseRoot("outside-link");
    const base = path.join(root, "base");
    const outside = path.join(root, "outside");
    const entry = path.join(base, "entry");
    const candidate = path.join(entry, "secret.txt");
    await mkdir(base);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await createDirectoryLink(outside, entry);

    expect(path.relative(base, candidate).startsWith("..")).toBe(false);
    expect(path.relative(await realpath(base), await realpath(candidate)).startsWith("..")).toBe(true);
    await expect(resolveContainedPath(base, "entry/secret.txt")).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "reparse-point-in-path",
      componentIndex: 0,
    });
  });

  it("admits a regular file when the supplied base is a real directory alias", async () => {
    const root = await caseRoot("base-alias");
    const base = path.join(root, "base");
    const alias = path.join(root, "base-alias");
    const candidate = path.join(base, "regular.txt");
    await mkdir(base);
    await writeFile(candidate, "inside");
    await createDirectoryLink(base, alias);

    const result = await resolveContainedPath(alias, "regular.txt");
    expect(result.outcome).toBe("contained");
    expect(result.canonicalPath).toBe(await realpath(candidate));
    expect(result.objectIdentity.device).toMatch(/^[0-9]+$/);
    expect(result.objectIdentity.index).toMatch(/^[0-9]+$/);
  });

  it.each([
    { name: "absolute", relative: false },
    { name: "relative", relative: true },
  ])(
    "refuses an inside-pointing $name link even though its final canonical path is contained",
    async ({ relative }) => {
      const root = await caseRoot(`inside-${relative ? "relative" : "absolute"}`);
      const base = path.join(root, "base");
      const target = path.join(base, "sub");
      const entry = path.join(base, "entry");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "file.txt"), "inside");
      await createDirectoryLink(target, entry, { relative });

      const canonicalBase = await realpath(base);
      const canonicalCandidate = await realpath(path.join(entry, "file.txt"));
      const relativeCanonical = path.relative(canonicalBase, canonicalCandidate);
      expect(relativeCanonical).not.toBe("..");
      expect(relativeCanonical.startsWith(`..${path.sep}`)).toBe(false);
      await expect(resolveContainedPath(base, "entry/file.txt")).resolves.toEqual({
        version: ADMISSION_CONTAINED_PATH_VERSION,
        outcome: "reparse-point-in-path",
        componentIndex: 0,
      });
    },
  );
});

describe("delegated syntax and object-class identities", () => {
  it("carries all three syntax identities and the syntax rule verbatim before filesystem work", async () => {
    const calls = [];
    const filesystem = {
      lstat() {
        calls.push("lstat");
        throw new Error("must not run");
      },
      realpath() {
        calls.push("realpath");
        throw new Error("must not run");
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    await expect(resolveContainedPath(7, "file.txt", { filesystem })).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "input-not-a-string",
    });
    await expect(resolveContainedPath("missing-base", "../file.txt", { filesystem })).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "path-syntax-invalid",
      rule: "dot-segment",
    });
    await expect(resolveContainedPath("base", "file.txt", revoked.proxy)).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "options-invalid",
    });
    expect(calls).toEqual([]);
  });

  it("carries the four real object-class refusals under their original names", async () => {
    const root = await caseRoot("classification-identities");
    const base = path.join(root, "base");
    const target = path.join(root, "target");
    await mkdir(base);
    await mkdir(target);
    await writeFile(path.join(base, "intermediate.txt"), "file");
    await mkdir(path.join(base, "directory"));
    await writeFile(path.join(base, "linked.txt"), "hard-link");
    await link(path.join(base, "linked.txt"), path.join(base, "linked-copy.txt"));
    await createDirectoryLink(target, path.join(base, "reparse"));

    const cases = [
      ["reparse/child.txt", "reparse-point-in-path", 0],
      ["intermediate.txt/child.txt", "component-not-a-directory", 0],
      ["directory", "target-not-a-regular-file", 0],
      ["linked.txt", "target-multiply-linked", 0],
    ];
    for (const [relativePath, outcome, componentIndex] of cases) {
      await expect(resolveContainedPath(base, relativePath)).resolves.toEqual({
        version: ADMISSION_CONTAINED_PATH_VERSION,
        outcome,
        componentIndex,
      });
    }
  });

  it("carries filesystem-unavailable from an uninterrogable synthetic Stats object", async () => {
    const base = path.resolve(tempRoot, "synthetic-uninterrogable");
    const filesystem = twoStageSyntheticFilesystem({ base, candidate: path.join(base, "file.txt"), stats: {} });
    await expect(resolveContainedPath(base, "file.txt", { filesystem })).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "filesystem-unavailable",
      componentIndex: 0,
    });
  });

  it("contains no duplicated syntax or Stats predicate", () => {
    expect(moduleSource).not.toMatch(/reserved|COM[1-9]|isFile|isDirectory|isSymbolicLink|nlink/);
  });
});

describe("lossless bigint object identity", () => {
  it("passes bigint options to every lstat and states each component exactly once", async () => {
    const { base } = await createContainedFile("bigint-options", "directory/file.txt");
    const observations = [];
    const result = await resolveContainedPath(base, "directory/file.txt", {
      filesystem: passthroughFilesystem(observations),
    });
    expect(result.outcome).toBe("contained");
    expect(observations).toHaveLength(2);
    expect(observations.map(({ options }) => options)).toEqual([{ bigint: true }, { bigint: true }]);
    expect(observations.map(({ value }) => path.relative(base, value))).toEqual([
      "directory",
      path.join("directory", "file.txt"),
    ]);
  });

  it("keeps synthetic adjacent above-safe-integer identities distinct without a Number round trip", async () => {
    const base = path.resolve(tempRoot, "synthetic-bigint");
    const candidate = path.join(base, "file.txt");
    const firstIndex = 18_577_348_464_917_840n;
    const secondIndex = 18_577_348_464_917_841n;
    const resolveIndex = async (index) =>
      resolveContainedPath(base, "file.txt", {
        filesystem: twoStageSyntheticFilesystem({
          base,
          candidate,
          stats: syntheticStats("file", { device: 4_101_606_087n, index }),
        }),
      });

    const first = await resolveIndex(firstIndex);
    const second = await resolveIndex(secondIndex);
    expect(first.objectIdentity.index).toBe(firstIndex.toString(10));
    expect(second.objectIdentity.index).toBe(secondIndex.toString(10));
    expect(first.objectIdentity).not.toEqual(second.objectIdentity);
    expect(String(Number(firstIndex))).toBe(String(Number(secondIndex)));
  });

  it("refuses a synthetic negative bigint identity at the final component", async () => {
    const base = path.resolve(tempRoot, "synthetic-negative-bigint");
    const candidate = path.join(base, "file.txt");
    const filesystem = twoStageSyntheticFilesystem({
      base,
      candidate,
      stats: syntheticStats("file", { index: -1n }),
    });
    await expect(resolveContainedPath(base, "file.txt", { filesystem })).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "filesystem-unavailable",
      componentIndex: 0,
    });
  });

  it("distinguishes two real files and round-trips an admitted identity through a bigint handle stat", async () => {
    const { base, candidate } = await createContainedFile("real-identity", "first.txt");
    await writeFile(path.join(base, "second.txt"), "second");
    const first = await resolveContainedPath(base, "first.txt");
    const second = await resolveContainedPath(base, "second.txt");
    expect(first.objectIdentity).not.toEqual(second.objectIdentity);

    const handle = await open(candidate, "r");
    try {
      const handleStats = await handle.stat({ bigint: true });
      expect(first.objectIdentity).toEqual({
        device: handleStats.dev.toString(10),
        index: handleStats.ino.toString(10),
      });
    } finally {
      await handle.close();
    }
  });
});

describe("total stage mapping, exact component indexes, and precedence", () => {
  it("maps every base realpath failure to base-unresolvable without host details", async () => {
    const absent = path.join(tempRoot, "absent-base");
    await expect(resolveContainedPath("", "file.txt")).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "base-unresolvable",
    });
    await expect(resolveContainedPath(absent, "file.txt")).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "base-unresolvable",
    });

    for (const code of ["EACCES", "EPERM", "ELOOP"]) {
      const filesystem = {
        lstat() {
          throw new Error("must not run");
        },
        realpath() {
          throw Object.assign(new Error(`private ${code} path`), { code });
        },
      };
      const result = await resolveContainedPath(path.resolve(tempRoot, "synthetic-base"), "file.txt", {
        filesystem,
      });
      expect(result).toEqual({ version: ADMISSION_CONTAINED_PATH_VERSION, outcome: "base-unresolvable" });
      expect(JSON.stringify(result)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });

  it("reports absent final and intermediate components at their exact indexes", async () => {
    const root = await caseRoot("absent-components");
    const base = path.join(root, "base");
    await mkdir(path.join(base, "present"), { recursive: true });
    await expect(resolveContainedPath(base, "present/missing.txt")).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "target-absent",
      componentIndex: 1,
    });
    await expect(resolveContainedPath(base, "missing/file.txt")).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "target-absent",
      componentIndex: 0,
    });
  });

  it("classifies a file-shaped intermediate independently of host compound-path errno", async () => {
    const { base } = await createContainedFile("file-intermediate", "file.txt");
    await expect(resolveContainedPath(base, "file.txt/child.txt")).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "component-not-a-directory",
      componentIndex: 0,
    });
  });

  it("maps synthetic S3 errors and non-Error throws to indexed filesystem-unavailable", async () => {
    const base = path.resolve(tempRoot, "synthetic-walk-error");
    for (const thrown of [Object.assign(new Error("private path"), { code: "EACCES" }), Symbol("no-code")]) {
      const filesystem = {
        async realpath() {
          return base;
        },
        async lstat() {
          throw thrown;
        },
      };
      await expect(resolveContainedPath(base, "file.txt", { filesystem })).resolves.toEqual({
        version: ADMISSION_CONTAINED_PATH_VERSION,
        outcome: "filesystem-unavailable",
        componentIndex: 0,
      });
    }
  });

  it("maps a synthetic S5 failure to filesystem-unavailable with no component index", async () => {
    const base = path.resolve(tempRoot, "synthetic-final-error");
    const candidate = path.join(base, "file.txt");
    const filesystem = twoStageSyntheticFilesystem({
      base,
      candidate,
      stats: syntheticStats("file"),
      finalError: Object.assign(new Error("private candidate"), { code: "EACCES" }),
    });
    await expect(resolveContainedPath(base, "file.txt", { filesystem })).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "filesystem-unavailable",
    });
  });

  it("derives the enumerated component-error subset from the runtime errno authority", () => {
    const errnoNames = new Set(Object.keys(os.constants.errno));
    expect(errnoNames.has("ENOENT")).toBe(true);
    expect(errnoNames.has("ENOTDIR")).toBe(true);
    expect([...errnoNames].filter((name) => name.startsWith("UV"))).toEqual([]);
  });

  it("gives link classification precedence over an absent or multiply-linked descendant", async () => {
    const root = await caseRoot("precedence");
    const base = path.join(root, "base");
    const target = path.join(root, "target");
    await mkdir(base);
    await mkdir(target);
    await createDirectoryLink(target, path.join(base, "entry"));
    await writeFile(path.join(target, "hard.txt"), "hard");
    await link(path.join(target, "hard.txt"), path.join(target, "hard-copy.txt"));

    for (const relativePath of ["entry/absent.txt", "entry/hard.txt"]) {
      await expect(resolveContainedPath(base, relativePath)).resolves.toEqual({
        version: ADMISSION_CONTAINED_PATH_VERSION,
        outcome: "reparse-point-in-path",
        componentIndex: 0,
      });
    }
  });
});

describe("closed versioned records and fail-closed authority", () => {
  async function outcomeRecords() {
    const containedTree = await createContainedFile("outcome-contained");
    const root = await caseRoot("outcome-refusals");
    const base = path.join(root, "base");
    const outside = path.join(root, "outside");
    await mkdir(base);
    await mkdir(outside);
    await mkdir(path.join(base, "directory"));
    await writeFile(path.join(base, "intermediate.txt"), "intermediate");
    await writeFile(path.join(base, "hard.txt"), "hard");
    await link(path.join(base, "hard.txt"), path.join(base, "hard-copy.txt"));
    await createDirectoryLink(outside, path.join(base, "entry"));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const syntheticBase = path.resolve(tempRoot, "synthetic-outcomes");
    const syntheticCandidate = path.join(syntheticBase, "file.txt");

    return [
      await resolveContainedPath(containedTree.base, containedTree.relativePath),
      await resolveContainedPath(null, "file.txt"),
      await resolveContainedPath(base, "../file.txt"),
      await resolveContainedPath(base, "file.txt", revoked.proxy),
      await resolveContainedPath(base, "entry/file.txt"),
      await resolveContainedPath(base, "intermediate.txt/file.txt"),
      await resolveContainedPath(base, "directory"),
      await resolveContainedPath(base, "hard.txt"),
      await resolveContainedPath(path.join(root, "absent-base"), "file.txt"),
      await resolveContainedPath(base, "absent.txt"),
      await resolveContainedPath(syntheticBase, "file.txt", {
        filesystem: twoStageSyntheticFilesystem({
          base: syntheticBase,
          candidate: syntheticCandidate,
          canonicalCandidate: path.resolve(tempRoot, "synthetic-outside", "file.txt"),
          stats: syntheticStats("file"),
        }),
      }),
      await resolveContainedPath(syntheticBase, "file.txt", {
        filesystem: {
          async realpath() {
            return syntheticBase;
          },
          async lstat() {
            throw Symbol("no-code");
          },
        },
      }),
      await resolveContainedPath(syntheticBase, "file.txt", {
        filesystem: twoStageSyntheticFilesystem({
          base: syntheticBase,
          candidate: syntheticCandidate,
          stats: syntheticStats("file"),
          finalError: new Error("synthetic final failure"),
        }),
      }),
    ];
  }

  it("publishes the exact frozen twelve-member outcome vocabulary and delegated matrices", () => {
    expect(ADMISSION_CONTAINED_PATH_OUTCOMES).toEqual(EXPECTED_OUTCOMES);
    expect(Object.isFrozen(ADMISSION_CONTAINED_PATH_OUTCOMES)).toBe(true);
    expect(new Set(ADMISSION_CONTAINED_PATH_OUTCOMES).size).toBe(12);
    expect(COVERED_OBJECT_CLASS_MATRIX).toBe(CLASSIFIER_COVERED_MATRIX);
    expect(OBJECT_CLASSES_OUTSIDE_GUARANTEE).toBe(CLASSIFIER_OUTSIDE_GUARANTEE);
  });

  it("returns recursively closed records with the exact component-index presence rule", async () => {
    const records = await outcomeRecords();
    expect(new Set(records.map(({ outcome }) => outcome))).toEqual(new Set(EXPECTED_OUTCOMES));
    for (const record of records) expect(closedRecordErrors(record)).toEqual([]);

    const unavailable = records.filter(({ outcome }) => outcome === "filesystem-unavailable");
    expect(unavailable).toHaveLength(2);
    expect(Object.hasOwn(unavailable[0], "componentIndex")).toBe(true);
    expect(Object.hasOwn(unavailable[1], "componentIndex")).toBe(false);
    for (const record of records.filter(({ outcome }) => outcome !== "filesystem-unavailable")) {
      expect(Object.hasOwn(record, "componentIndex")).toBe(COMPONENT_OUTCOMES.has(record.outcome));
    }
  });

  it("keeps nested unknown, wrong-type, out-of-range, and malformed record controls red", async () => {
    const { base } = await createContainedFile("closed-negative-controls");
    const contained = await resolveContainedPath(base, "candidate.txt");
    const indexed = Object.freeze({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "target-absent",
      componentIndex: 0,
    });
    const controls = [
      { mutant: Object.freeze({ ...contained, unknown: true }), error: "record-keys" },
      { mutant: Object.freeze({ ...contained, outcome: 7 }), error: "outcome" },
      { mutant: Object.freeze({ ...indexed, componentIndex: -1 }), error: "component-index" },
      { mutant: Object.freeze({ ...indexed, componentIndex: 300 }), error: "component-index" },
      { mutant: Object.freeze({ ...indexed, componentIndex: 0.5 }), error: "component-index" },
      {
        mutant: Object.freeze({
          ...contained,
          objectIdentity: Object.freeze({ ...contained.objectIdentity, unknown: "x" }),
        }),
        error: "object-identity-keys",
      },
      {
        mutant: Object.freeze({
          ...contained,
          objectIdentity: Object.freeze({ ...contained.objectIdentity, index: 7 }),
        }),
        error: "object-identity-index",
      },
      {
        mutant: Object.freeze({
          ...contained,
          objectIdentity: Object.freeze({ ...contained.objectIdentity, device: "-1" }),
        }),
        error: "object-identity-device",
      },
      {
        mutant: Object.freeze({
          ...contained,
          objectIdentity: Object.freeze({ ...contained.objectIdentity, index: "01" }),
        }),
        error: "object-identity-index",
      },
    ];
    for (const { mutant, error } of controls) expect(closedRecordErrors(mutant)).toContain(error);
  });

  it("never throws for hostile inputs or non-Error filesystem throws", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    await expect(resolveContainedPath(Symbol("base"), 1n, revoked.proxy)).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "input-not-a-string",
    });

    const base = path.resolve(tempRoot, "hostile-seam");
    const filesystem = {
      async realpath() {
        return base;
      },
      async lstat() {
        throw 17n;
      },
    };
    await expect(resolveContainedPath(base, "file.txt", { filesystem })).resolves.toEqual({
      version: ADMISSION_CONTAINED_PATH_VERSION,
      outcome: "filesystem-unavailable",
      componentIndex: 0,
    });
  });

  it("uses the declared synthetic seam only to exercise defense-in-depth escapes-base", async () => {
    const base = path.resolve(tempRoot, "synthetic-escape-base");
    const candidate = path.join(base, "file.txt");
    const outside = path.resolve(tempRoot, "synthetic-escape-outside", "file.txt");
    const result = await resolveContainedPath(base, "file.txt", {
      filesystem: twoStageSyntheticFilesystem({
        base,
        candidate,
        canonicalCandidate: outside,
        stats: syntheticStats("file"),
      }),
    });
    expect(result).toEqual({ version: ADMISSION_CONTAINED_PATH_VERSION, outcome: "escapes-base" });
    expect(result).not.toHaveProperty("componentIndex");
  });

  it("omitting options selects the real filesystem", async () => {
    const { base, candidate } = await createContainedFile("default-filesystem");
    const result = await resolveContainedPath(base, "candidate.txt");
    expect(result.outcome).toBe("contained");
    expect(result.canonicalPath).toBe(await realpath(candidate));
  });

  it("documents the narrowed threat and honest synthetic branch without claiming outside-class coverage", () => {
    expect(moduleSource).toMatch(/lane-owned, single-writer tree/);
    expect(moduleSource).toMatch(/does not answer a privileged concurrent adversary/);
    expect(moduleSource).toMatch(/No supported real construct at this base/);
    expect(moduleSource).toMatch(/does not[\s\S]*make any coverage claim[\s\S]*outside its guarantee/);
    expect(moduleSource).toMatch(/does not[\s\S]*grant read authority/);
  });

  it("exports one decision function and grants no file-content read authority", () => {
    expect(moduleSource.match(/export\s+async\s+function\s+/g)).toHaveLength(1);
    expect(moduleSource).not.toMatch(/readFile|createReadStream|openAsBlob|fsPromises\.open|fs\.open/);
  });

  it("returns no host error text, errno token, number, or path fragment in refusals", async () => {
    const privatePath = path.resolve(tempRoot, "private-host-fragment");
    const filesystem = {
      async realpath() {
        return privatePath;
      },
      async lstat() {
        const error = new Error(`private failure at ${privatePath}`);
        error.code = "EACCES";
        error.errno = -4092;
        throw error;
      },
    };
    const result = await resolveContainedPath(privatePath, "file.txt", { filesystem });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain("private failure");
    expect(serialized).not.toContain("EACCES");
    expect(serialized).not.toContain("4092");
  });

  it("contains no hash-plus-digits issue reference in production comments", () => {
    const comments = moduleSource.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) ?? [];
    expect(comments.join("\n")).not.toMatch(/#[0-9]{3,}/);
  });

  it("keeps the repository consumer inventory at the credited route-census authority", () => {
    const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
    const output = execFileSync(
      "git",
      ["grep", "-nE", "path\\.relative|realpath", "--", "scripts/route-census/target-authority.mts"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(output).toMatch(/target-authority\.mts:30:.*path\.relative/);
    expect(output).toMatch(/target-authority\.mts:69:.*realpath/);
    expect(output).toMatch(/target-authority\.mts:91:.*realpath/);
    expect(output).toMatch(/target-authority\.mts:97:.*realpath/);
  });
});
