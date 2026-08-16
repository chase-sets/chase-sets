import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMISSION_CONTAINED_PATH_OUTCOMES } from "./admission-contained-path.mjs";
import { DERIVED_STATS_PREDICATES } from "./admission-object-class.mjs";
import {
  ADMISSION_STREAM_READ_FAILURE_REASONS,
  ADMISSION_STREAM_SOURCE_KINDS,
  ADMISSION_STREAM_SOURCE_VERSION,
  acquireStreamText,
  isAdmissionStreamSource,
  materializeStreamSource,
  normalizeStreamBytes,
} from "./admission-stream-source.mjs";

const MAX_MATERIALIZED_BYTES = 1_048_576;
const modulePath = fileURLToPath(new URL("./admission-stream-source.mjs", import.meta.url));
const moduleSource = readFileSync(modulePath, "utf8");
const successfulSources = Object.freeze([
  { name: "bytes-empty", source: { kind: "bytes", base64: "" } },
  { name: "bytes-plain", source: { kind: "bytes", base64: Buffer.from("plain").toString("base64") } },
  {
    name: "bytes-leading-bom",
    source: { kind: "bytes", base64: Buffer.from([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x6d]).toString("base64") },
  },
  {
    name: "bytes-later-bom",
    source: { kind: "bytes", base64: Buffer.from("a\ufeffb", "utf8").toString("base64") },
  },
  { name: "bytes-tabs", source: { kind: "bytes", base64: Buffer.from("a\tbc\t").toString("base64") } },
  {
    name: "bytes-sgr",
    source: { kind: "bytes", base64: Buffer.from("\u001b[31mred\u001b[0;;m").toString("base64") },
  },
  { name: "bytes-crlf", source: { kind: "bytes", base64: Buffer.from("a\r\nb\n").toString("base64") } },
  { name: "text-plain", source: { kind: "text", text: "plain text" } },
  { name: "text-crlf", source: { kind: "text", text: "first\r\nsecond\n" } },
  { name: "text-tabs", source: { kind: "text", text: "x\ty\t" } },
]);

let tempRoot;
let caseNumber = 0;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "admission-stream-source-"));
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

function sourceBytes(source) {
  return source.kind === "bytes"
    ? Buffer.from(source.base64, "base64")
    : Buffer.from(source.text.replaceAll("\r\n", "\n"), "utf8");
}

function syntheticStats(kind, { device = 7n, index = 11n, linkCount = 1n } = {}) {
  const activePredicate = kind === "directory" ? "isDirectory" : "isFile";
  const stats = { dev: device, ino: index, nlink: linkCount };
  for (const predicateName of DERIVED_STATS_PREDICATES) {
    stats[predicateName] = () => predicateName === activePredicate;
  }
  return stats;
}

async function createDirectoryLink(target, entry) {
  await symlink(target, entry, process.platform === "win32" ? "junction" : "dir");
  expect((await lstat(entry, { bigint: true })).isSymbolicLink()).toBe(true);
}

function expectClosedResult(result, expected) {
  expect(result).toEqual(expected);
  expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());
  expect(Object.isFrozen(result)).toBe(true);
}

describe("closed tagged source grammar and real materialization", () => {
  it("publishes exactly the frozen v1 three-kind vocabulary", () => {
    expect(ADMISSION_STREAM_SOURCE_VERSION).toBe("admission-stream-source/v1");
    expect(ADMISSION_STREAM_SOURCE_KINDS).toEqual(["bytes", "text", "absent"]);
    expect(new Set(ADMISSION_STREAM_SOURCE_KINDS).size).toBe(3);
    expect(Object.isFrozen(ADMISSION_STREAM_SOURCE_KINDS)).toBe(true);
  });

  it("accepts every exact bytes, text, and absent member including the byte boundary", () => {
    for (const { source } of successfulSources) expect(isAdmissionStreamSource(source)).toBe(true);
    expect(isAdmissionStreamSource({ kind: "absent" })).toBe(true);
    expect(
      isAdmissionStreamSource({ kind: "bytes", base64: Buffer.alloc(MAX_MATERIALIZED_BYTES).toString("base64") }),
    ).toBe(true);
    expect(isAdmissionStreamSource({ kind: "text", text: "a".repeat(MAX_MATERIALIZED_BYTES) })).toBe(true);
  });

  it.each([
    ["non-object", null],
    ["array", ["absent"]],
    ["fourth kind", { kind: "decoded" }],
    ["unknown absent key", { kind: "absent", unknown: true }],
    ["missing bytes payload", { kind: "bytes" }],
    ["missing text payload", { kind: "text" }],
    ["duplicate bytes payload", { kind: "bytes", base64: "", text: "" }],
    ["extra absent payload", { kind: "absent", text: "" }],
    ["wrong bytes payload type", { kind: "bytes", base64: 7 }],
    ["wrong text payload type", { kind: "text", text: Buffer.from("text") }],
    ["non-canonical missing padding", { kind: "bytes", base64: "YQ" }],
    ["non-canonical padding bits", { kind: "bytes", base64: "YR==" }],
    ["non-canonical whitespace", { kind: "bytes", base64: "YQ==\n" }],
    ["over-bound bytes", { kind: "bytes", base64: Buffer.alloc(MAX_MATERIALIZED_BYTES + 1).toString("base64") }],
    ["over-bound text", { kind: "text", text: "a".repeat(MAX_MATERIALIZED_BYTES + 1) }],
  ])("refuses the one-variable %s mutant", (_name, source) => {
    expect(isAdmissionStreamSource(source)).toBe(false);
  });

  it("is total for throwing and revoked records", () => {
    const throwing = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        throw new Error("private getter failure");
      },
    });
    const revoked = Proxy.revocable({ kind: "absent" }, {});
    revoked.revoke();
    expect(isAdmissionStreamSource(throwing)).toBe(false);
    expect(isAdmissionStreamSource(revoked.proxy)).toBe(false);
  });

  it("writes exact decoded bytes and the specified text transform in a per-run directory", async () => {
    const root = await caseRoot("materialized-bytes-text");
    const bytesSource = successfulSources.find(({ name }) => name === "bytes-sgr").source;
    const textSource = { kind: "text", text: "first\r\nsecond\rlast" };

    const bytesTarget = await materializeStreamSource(bytesSource, root, "bytes.txt");
    const textTarget = await materializeStreamSource(textSource, root, "text.txt");

    expect(bytesTarget).toBe(path.join(root, "bytes.txt"));
    expect(await readFile(bytesTarget)).toEqual(Buffer.from(bytesSource.base64, "base64"));
    expect(textTarget).toBe(path.join(root, "text.txt"));
    expect(await readFile(textTarget)).toEqual(Buffer.from("first\nsecond\rlast", "utf8"));
  });

  it("removes only a stale absent target and returns its path", async () => {
    const root = await caseRoot("materialized-absent");
    const target = path.join(root, "stream.txt");
    await writeFile(target, "stale");
    await expect(materializeStreamSource({ kind: "absent" }, root, "stream.txt")).resolves.toBe(target);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a valid source before deriving or touching a target", async () => {
    const root = await caseRoot("invalid-materialization");
    await expect(materializeStreamSource({ kind: "fourth" }, root, "stream.txt")).rejects.toThrow(TypeError);
    await expect(readFile(path.join(root, "stream.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("derived read-failure vocabulary", () => {
  it("partitions the exact frozen thirteen-member contained authority into fourteen unique failures", () => {
    expect(Object.isFrozen(ADMISSION_CONTAINED_PATH_OUTCOMES)).toBe(true);
    expect(ADMISSION_CONTAINED_PATH_OUTCOMES).toHaveLength(13);
    expect(new Set(ADMISSION_CONTAINED_PATH_OUTCOMES).size).toBe(13);
    expect(ADMISSION_CONTAINED_PATH_OUTCOMES.filter((outcome) => outcome === "contained")).toEqual(["contained"]);

    const carried = ADMISSION_CONTAINED_PATH_OUTCOMES.filter((outcome) => outcome !== "contained");
    expect(ADMISSION_STREAM_READ_FAILURE_REASONS).toEqual([...carried, "invalid-utf8", "unsupported-control-sequence"]);
    expect(ADMISSION_STREAM_READ_FAILURE_REASONS).toHaveLength(14);
    expect(new Set(ADMISSION_STREAM_READ_FAILURE_REASONS).size).toBe(14);
    expect(ADMISSION_STREAM_READ_FAILURE_REASONS).toContain("options-invalid");
    expect(Object.isFrozen(ADMISSION_STREAM_READ_FAILURE_REASONS)).toBe(true);
  });
});

describe("fatal UTF-8 and the supported control grammar", () => {
  it("removes one leading BOM, preserves a later BOM, and preserves exact tab offsets", () => {
    expectClosedResult(normalizeStreamBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), { state: "ok", text: "a" });
    expectClosedResult(normalizeStreamBytes(Buffer.from("a\ufeffb", "utf8")), { state: "ok", text: "a\ufeffb" });
    const tabs = normalizeStreamBytes(Buffer.from("a\tbc\t"));
    expectClosedResult(tabs, { state: "ok", text: "a\tbc\t" });
    expect([...tabs.text].flatMap((character, index) => (character === "\t" ? [index] : []))).toEqual([1, 4]);
  });

  it("removes only admitted SGR decoration and folds every CRLF pair", () => {
    expectClosedResult(normalizeStreamBytes(Buffer.from("\u001b[mplain\u001b[1;32m green\u001b[0;;m")), {
      state: "ok",
      text: "plain green",
    });
    expectClosedResult(normalizeStreamBytes(Buffer.from("a\r\nb\r\n")), { state: "ok", text: "a\nb\n" });
  });

  it.each([
    ["erase-line", `${String.fromCharCode(0x1b)}[2K`],
    ["cursor movement", `${String.fromCharCode(0x1b)}[1A`],
    ["private parameter", `${String.fromCharCode(0x1b)}[?25l`],
    ["lone escape", String.fromCharCode(0x1b)],
    ["bell", String.fromCharCode(0x07)],
    ["DEL", String.fromCharCode(0x7f)],
    ["C1", String.fromCharCode(0x85)],
    ["lone carriage return", String.fromCharCode(0x0d)],
  ])("refuses the named unsupported %s control", (_name, control) => {
    expectClosedResult(normalizeStreamBytes(Buffer.from(`left${control}right`, "utf8")), {
      state: "read-failure",
      reason: "unsupported-control-sequence",
    });
  });

  it("defaults every remaining C0, DEL, and C1 control to refusal while allowing only LF and tab", () => {
    const unsupportedCodePoints = [
      ...Array.from({ length: 0x20 }, (_unused, codePoint) => codePoint).filter(
        (codePoint) => codePoint !== 0x09 && codePoint !== 0x0a,
      ),
      ...Array.from({ length: 0x21 }, (_unused, offset) => 0x7f + offset),
    ];
    for (const codePoint of unsupportedCodePoints) {
      expect(normalizeStreamBytes(Buffer.from(`x${String.fromCharCode(codePoint)}y`, "utf8"))).toEqual({
        state: "read-failure",
        reason: "unsupported-control-sequence",
      });
    }
    expect(normalizeStreamBytes(Buffer.from("x\t\ny"))).toEqual({ state: "ok", text: "x\t\ny" });
  });

  it("fatally refuses invalid UTF-8 without replacement text", () => {
    const result = normalizeStreamBytes(Buffer.from([0x61, 0xff, 0x62]));
    expectClosedResult(result, { state: "read-failure", reason: "invalid-utf8" });
    expect(JSON.stringify(result)).not.toContain("\ufffd");
  });
});

describe("bound acquisition and carried refusal identity", () => {
  it("expresses absent and invalid UTF-8 through real materialization and two-argument acquisition", async () => {
    const root = await caseRoot("real-hostile-materialization");
    const base = path.join(root, "base");
    await mkdir(base);

    await materializeStreamSource({ kind: "absent" }, base, "absent.txt");
    const absent = await acquireStreamText(base, "absent.txt");
    expectClosedResult(absent, { state: "read-failure", reason: "target-absent" });

    await materializeStreamSource({ kind: "bytes", base64: Buffer.from([0xff]).toString("base64") }, base, "bad.txt");
    const invalid = await acquireStreamText(base, "bad.txt");
    expectClosedResult(invalid, { state: "read-failure", reason: "invalid-utf8" });
    expect(JSON.stringify([absent, invalid])).not.toContain("\ufffd");
  });

  it("carries every shipped refusal unchanged, including all three explicit seam controls", async () => {
    const root = await caseRoot("all-contained-refusals");
    const base = path.join(root, "base");
    const outside = path.join(root, "outside");
    await mkdir(base);
    await mkdir(outside);
    await writeFile(path.join(outside, "file.txt"), "outside");
    await mkdir(path.join(base, "directory"));
    await writeFile(path.join(base, "intermediate.txt"), "intermediate");
    await writeFile(path.join(base, "hard.txt"), "hard");
    await link(path.join(base, "hard.txt"), path.join(base, "hard-copy.txt"));
    await createDirectoryLink(outside, path.join(base, "entry"));

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const syntheticBase = path.resolve(root, "synthetic-base");
    const syntheticCandidate = path.join(syntheticBase, "file.txt");
    let escapeRealpathCalls = 0;
    const cases = [
      { reason: "input-not-a-string", args: [null, "file.txt"] },
      { reason: "path-syntax-invalid", args: [base, "../file.txt"] },
      { reason: "options-invalid", args: [base, "file.txt", revoked.proxy] },
      { reason: "reparse-point-in-path", args: [base, "entry/file.txt"] },
      { reason: "component-not-a-directory", args: [base, "intermediate.txt/file.txt"] },
      { reason: "target-not-a-regular-file", args: [base, "directory"] },
      { reason: "target-multiply-linked", args: [base, "hard.txt"] },
      { reason: "base-unresolvable", args: [path.join(root, "absent-base"), "file.txt"] },
      { reason: "target-absent", args: [base, "absent.txt"] },
      {
        reason: "escapes-base",
        args: [
          syntheticBase,
          "file.txt",
          {
            filesystem: {
              async realpath() {
                escapeRealpathCalls += 1;
                return escapeRealpathCalls === 1 ? syntheticBase : path.join(outside, "file.txt");
              },
              async lstat() {
                return syntheticStats("file");
              },
            },
          },
        ],
      },
      {
        reason: "filesystem-unavailable",
        args: [
          syntheticBase,
          "file.txt",
          {
            filesystem: {
              async realpath() {
                return syntheticBase;
              },
              async lstat() {
                throw Symbol("synthetic-filesystem-unavailable");
              },
            },
          },
        ],
      },
    ];

    const observed = [];
    for (const testCase of cases) {
      const result = await acquireStreamText(...testCase.args);
      expectClosedResult(result, { state: "read-failure", reason: testCase.reason });
      expect(result).not.toHaveProperty("text");
      observed.push(result.reason);
    }

    const identityRoot = await caseRoot("real-ancestor-replacement");
    const identityBase = path.join(identityRoot, "base");
    const ancestor = path.join(identityBase, "ancestor");
    const replacement = path.join(identityRoot, "replacement");
    const admittedArchive = path.join(identityRoot, "admitted-archive");
    await mkdir(ancestor, { recursive: true });
    await mkdir(replacement);
    await writeFile(path.join(ancestor, "stream.txt"), "admitted bytes");
    await writeFile(path.join(replacement, "stream.txt"), "outside replacement bytes");
    let replaced = false;
    const replacementFilesystem = {
      async realpath(value) {
        return realpath(value);
      },
      async lstat(value, options) {
        return lstat(value, options);
      },
      async open(value, flags) {
        expect(value).toBe(path.join(ancestor, "stream.txt"));
        if (!replaced) {
          replaced = true;
          await rename(ancestor, admittedArchive);
          await rename(replacement, ancestor);
        }
        return open(value, flags);
      },
    };
    const changed = await acquireStreamText(identityBase, "ancestor/stream.txt", {
      filesystem: replacementFilesystem,
    });
    expectClosedResult(changed, { state: "read-failure", reason: "target-identity-changed" });
    expect(JSON.stringify(changed)).not.toContain("outside replacement bytes");
    observed.push(changed.reason);

    expect(observed).toEqual(ADMISSION_CONTAINED_PATH_OUTCOMES.filter((outcome) => outcome !== "contained"));
  });

  it("passes the exact three arguments once to the bound-read authority and performs no acquisition read", async () => {
    const baseDirectory = path.resolve(tempRoot, `delegation-${(caseNumber += 1)}`);
    const relativePath = "stream.txt";
    const candidate = path.join(baseDirectory, relativePath);
    const stats = syntheticStats("file");
    const calls = [];
    let realpathCalls = 0;
    const handle = {
      async stat(options) {
        calls.push(["stat", options]);
        return stats;
      },
      async readFile() {
        calls.push(["readFile"]);
        return Buffer.from("delegated");
      },
      async close() {
        calls.push(["close"]);
      },
    };
    const filesystem = {
      async realpath(value) {
        calls.push(["realpath", value]);
        realpathCalls += 1;
        return realpathCalls === 1 ? baseDirectory : candidate;
      },
      async lstat(value, options) {
        calls.push(["lstat", value, options]);
        return stats;
      },
      async open(value, flags) {
        calls.push(["open", value, flags]);
        return handle;
      },
    };
    const targetOptions = { filesystem };
    let optionsReads = 0;
    let optionsHasChecks = 0;
    let options;
    options = new Proxy(targetOptions, {
      has(target, key) {
        optionsHasChecks += 1;
        return Reflect.has(target, key);
      },
      get(target, key, receiver) {
        optionsReads += 1;
        expect(receiver).toBe(options);
        return Reflect.get(target, key, receiver);
      },
    });

    await expect(acquireStreamText(baseDirectory, relativePath, options)).resolves.toEqual({
      state: "ok",
      text: "delegated",
    });
    expect(optionsHasChecks).toBe(1);
    expect(optionsReads).toBe(1);
    expect(calls).toEqual([
      ["realpath", baseDirectory],
      ["lstat", candidate, { bigint: true }],
      ["realpath", candidate],
      ["open", candidate, "r"],
      ["stat", { bigint: true }],
      ["readFile"],
      ["close"],
    ]);

    const acquisitionSource = moduleSource.slice(moduleSource.indexOf("export async function acquireStreamText"));
    expect(acquisitionSource.match(/readContainedFile\(baseDirectory, relativePath, options\)/g)).toHaveLength(1);
    expect(acquisitionSource).not.toMatch(
      /\b(?:open|readFile|realpath|lstat|stat|resolveContainedPath|openContainedFile)\s*\(/,
    );
    expect(moduleSource).not.toContain("normalizeFailureFingerprint");
  });
});

describe("fixed stage precedence and materialized/in-memory agreement", () => {
  it("returns only the bound-read refusal before hypothetical invalid bytes", async () => {
    const root = await caseRoot("precedence-bound-read");
    let filesystemCalls = 0;
    const filesystem = {
      async realpath() {
        filesystemCalls += 1;
        throw new Error("must not reach filesystem");
      },
      async lstat() {
        filesystemCalls += 1;
        throw new Error("must not reach filesystem");
      },
    };
    const result = await acquireStreamText(root, "../invalid.bin", { filesystem });
    expectClosedResult(result, { state: "read-failure", reason: "path-syntax-invalid" });
    expect(filesystemCalls).toBe(0);
  });

  it("returns invalid UTF-8 before the unsupported control its replacement candidate contains", async () => {
    const root = await caseRoot("precedence-invalid-utf8");
    const source = { kind: "bytes", base64: Buffer.from([0xff, 0x07]).toString("base64") };
    await materializeStreamSource(source, root, "stream.bin");
    const result = await acquireStreamText(root, "stream.bin");
    expectClosedResult(result, { state: "read-failure", reason: "invalid-utf8" });
  });

  it("returns unsupported control only after a successful fatal decode", async () => {
    const root = await caseRoot("precedence-control");
    const source = { kind: "bytes", base64: Buffer.from(`valid${String.fromCharCode(0x07)}`).toString("base64") };
    await materializeStreamSource(source, root, "stream.bin");
    const result = await acquireStreamText(root, "stream.bin");
    expectClosedResult(result, { state: "read-failure", reason: "unsupported-control-sequence" });
  });

  it.each(successfulSources)(
    "makes materialized acquisition equal pure in-memory normalization for $name",
    async ({ name, source }) => {
      const root = await caseRoot(`agreement-${name}`);
      const expected = normalizeStreamBytes(sourceBytes(source));
      expect(expected.state).toBe("ok");
      expect(Object.keys(expected).sort()).toEqual(["state", "text"]);
      expect(JSON.stringify(expected)).not.toContain("\ufffd");

      const target = await materializeStreamSource(source, root, "stream.txt");
      expect(await readFile(target)).toEqual(sourceBytes(source));
      const acquired = await acquireStreamText(root, "stream.txt");
      expect(acquired).toEqual(expected);
      expect(Object.keys(acquired).sort()).toEqual(["state", "text"]);
    },
  );
});
