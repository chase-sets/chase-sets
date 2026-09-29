import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { afterAll, describe, expect, it } from "vitest";
import * as generator from "./generate-guard-import-candidate-emission.mjs";
import { importerSpecifierFixture as fixture } from "./fixtures/guard-import-candidate-emission/importer-specifier-fixture.mjs";
import { deriveGuardCandidateProvenance } from "./guard-candidate-provenance.mjs";
import { listNonTestTypeScriptModules, classifySqlExecutionSurface } from "./sql-execution-surface.mjs";
import { enumerateTrackedRoots } from "./authoritative-stream-read-classification.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const generatorPath = path.join(import.meta.dirname, "generate-guard-import-candidate-emission.mjs");
const fixturePath = path.join(
  import.meta.dirname,
  "fixtures/guard-import-candidate-emission/importer-specifier-fixture.mjs",
);
const artifactPath = path.join(import.meta.dirname, "fixtures/guard-import-candidate-emission/emission-oracle.json");
const artifactBytes = readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes);
const { PINNED_SOURCE, loadPinnedSource, readGitObject, selectDeclaration, executeDeclaration, buildArtifact } =
  generator;
const coordinate = { sourceCommit: PINNED_SOURCE.commit, sourcePath: PINNED_SOURCE.path };
const sameBlobCommit = "22b1151c2bed6083e7cf297d205e236496749c29";
const fixtureDigest = "79247eb90558610e8678508f4e50b5cf1cbed8f9021f64dd139a5afa924bc103";
const declarationDigest = "0baa51a3f502e92ad62ecdcd4d1d225e04592d708d5a3cabec34c557a812a312";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (rows) => JSON.stringify(rows.map((row) => [row.importerPath, row.specifierText]));
const emit = (label, value) => process.stdout.write(`${label} ${JSON.stringify(value)}\n`);
const git = (args, cwd = repoRoot) =>
  execFileSync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const source = loadPinnedSource(coordinate);
const selected = selectDeclaration(source.bytes);
const temporaryRoots = [];
function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "emission-oracle-"));
  expect(path.relative(repoRoot, root).startsWith("..")).toBe(true);
  temporaryRoots.push(root);
  return root;
}
function isolatedGeneratorSource(original) {
  let isolated = original;
  for (const specifier of [
    "@chase-sets/typescript-compiler-api",
    "prettier",
    "./fixtures/guard-import-candidate-emission/importer-specifier-fixture.mjs",
  ]) {
    isolated = isolated.replace(JSON.stringify(specifier), JSON.stringify(import.meta.resolve(specifier)));
  }
  return isolated;
}
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function refusal(run, code, reachedClause) {
  let caught;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, code).toMatchObject({ code, reachedClause });
  emit("REFUSAL", { code: caught.code, reachedClause: caught.reachedClause });
  return caught;
}

function braceMatch(text) {
  const start = text.indexOf("function collectResolvedImportCodes(");
  const open = text.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  for (; end < text.length && depth !== 0; end += 1) {
    if (text[end] === "{") depth += 1;
    if (text[end] === "}") depth -= 1;
  }
  return text.slice(start, end);
}

const nestedCases = [
  [
    "nested only",
    `function outer() {\n${selected.text}\n}`,
    "DECLARATION_NOT_TOP_LEVEL",
    "declaration-parent-source-file",
  ],
  [
    "nested duplicate",
    `${selected.text}\nfunction outer() {\n${selected.text}\n}`,
    "DECLARATION_NOT_UNIQUE",
    "declaration-count-one",
  ],
  [
    "parameter",
    `${selected.text}\nfunction outer(collectResolvedImportCodes) {}`,
    "ALTERNATE_BINDING_PRESENT",
    "whole-tree-alternate-bindings",
  ],
  [
    "class",
    `${selected.text}\nfunction outer() { class collectResolvedImportCodes {} }`,
    "ALTERNATE_BINDING_PRESENT",
    "whole-tree-alternate-bindings",
  ],
  [
    "const",
    `${selected.text}\nfunction outer() { const collectResolvedImportCodes = 1; }`,
    "ALTERNATE_BINDING_PRESENT",
    "whole-tree-alternate-bindings",
  ],
  [
    "function expression",
    `${selected.text}\nconst outer = function collectResolvedImportCodes() {};`,
    "ALTERNATE_BINDING_PRESENT",
    "whole-tree-alternate-bindings",
  ],
];

function measure(value) {
  return {
    rows: value.fixture.length,
    emissions: value.rows.reduce((sum, row) => sum + row.candidates.length, 0),
    partition: [5, 24, 0].map((count) => value.rows.filter((row) => row.candidates.length === count).length),
    uniquePairs: new Set(value.fixture.map((row) => JSON.stringify([row.importerPath, row.specifierText]))).size,
    keysClosed: value.fixture.every(
      (row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["importerPath", "specifierText"]),
    ),
    strings: value.fixture.every((row) =>
      [row.importerPath, row.specifierText].every((item) => typeof item === "string" && item.length > 0),
    ),
    digest: hash(canonical(value.fixture)),
  };
}

function assertArtifactProvenance(value) {
  if (value.sourceCommit !== PINNED_SOURCE.commit)
    throw Object.assign(new Error("artifact commit"), {
      code: "SOURCE_COMMIT_NOT_PINNED",
      reachedClause: "artifact-source-commit",
    });
  expect(value).toMatchObject({
    sourcePath: PINNED_SOURCE.path,
    sourceBlobObjectId: PINNED_SOURCE.blobObjectId,
    sourceByteLength: PINNED_SOURCE.byteLength,
    sourceSha256: PINNED_SOURCE.sha256,
  });
}

describe("immutable Git-object emission authority", () => {
  it("AC1 pinned source bytes and SHA refusal are inseparable", () => {
    expect(Object.isFrozen(PINNED_SOURCE)).toBe(true);
    expect(source.blobObjectId).toBe("0c0e536f46d3f597947e4e2b1b08ce97345460df");
    expect(source.bytes.length).toBe(51413);
    expect(hash(source.bytes)).toBe("43f554b410922f491b4aa0c755f73188f5e32cb3ea2d35a7417b99c697f1524c");
    expect(source.bytes.includes(Buffer.from("\r\n"))).toBe(false);
    const corrupt = Buffer.from(source.bytes);
    corrupt[0] ^= 1;
    refusal(
      () =>
        loadPinnedSource({
          ...coordinate,
          execGit: (args) => (args[0] === "rev-parse" ? Buffer.from(PINNED_SOURCE.blobObjectId) : corrupt),
        }),
      "SOURCE_SHA256_MISMATCH",
      "source-sha256-equality",
    );
    emit("SOURCE", { blob: source.blobObjectId, bytes: source.bytes.length, sha256: hash(source.bytes) });
  });

  it.each([
    ["blob", "SOURCE_BLOB_OBJECT_MISMATCH", "source-blob-object-equality"],
    ["length", "SOURCE_BYTE_LENGTH_MISMATCH", "source-byte-length"],
    ["hash", "SOURCE_SHA256_MISMATCH", "source-sha256-equality"],
    ["absent", "SOURCE_OBJECT_UNREADABLE", "git-object-read"],
    ["git unavailable", "SOURCE_OBJECT_UNREADABLE", "git-object-read"],
  ])("AC1 refusal ladder: %s", (kind, code, clause) => {
    const execGit = (args) => {
      if (kind === "absent") return git(["cat-file", "blob", "0".repeat(40)]);
      if (kind === "git unavailable") throw Object.assign(new Error("git unavailable"), { code: "ENOENT" });
      if (args[0] === "rev-parse") return Buffer.from(kind === "blob" ? "1".repeat(40) : PINNED_SOURCE.blobObjectId);
      if (kind === "blob") throw new Error("blob mismatch must precede cat-file");
      if (kind === "length") return source.bytes.subarray(1);
      const bytes = Buffer.from(source.bytes);
      bytes[0] ^= 1;
      return bytes;
    };
    refusal(() => loadPinnedSource({ ...coordinate, execGit }), code, clause);
  });

  it("AC2 parser selects one unique top-level declaration", () => {
    expect(selected).toMatchObject({
      byteLength: 1253,
      sha256: declarationDigest,
      declarationCount: 1,
      alternateBindingCount: 0,
      parseDiagnosticCount: 0,
    });
    emit("DECLARATION", selected);
  });

  it.each([
    ["duplicate declarations", `${selected.text}\n${selected.text}`, "DECLARATION_NOT_UNIQUE", "declaration-count-one"],
    ["no declaration", "const unrelated = 1;", "DECLARATION_ABSENT", "declaration-count-zero"],
    ["const only", "const collectResolvedImportCodes = () => {};", "DECLARATION_ABSENT", "declaration-count-zero"],
    [
      "parse diagnostics",
      "function collectResolvedImportCodes( {",
      "SOURCE_PARSE_DIAGNOSTICS",
      "source-parse-diagnostics",
    ],
  ])("AC2 ordered parser refusal: %s", (_name, text, code, clause) => {
    refusal(() => selectDeclaration(text), code, clause);
  });

  it.each([
    ['  const spoof = " } ";\n', 94, 1276],
    ["  const spoof = `}`;\n", 93, 1274],
    ["  const spoof = /}/;\n", 93, 1274],
    ["  // }\n", 81, 1260],
  ])("AC3 brace spoof %s", (line, braceBytes, parserBytes) => {
    const newline = selected.text.indexOf("\n") + 1;
    const variant = selected.text.slice(0, newline) + line + selected.text.slice(newline);
    expect(Buffer.byteLength(braceMatch(variant))).toBe(braceBytes);
    expect(selectDeclaration(variant).byteLength).toBe(parserBytes);
    expect(selectDeclaration(variant).text).toBe(variant);
    emit("BRACE_VS_PARSER", { line, braceBytes, parserBytes });
  });

  it("AC3 comment-prefix and duplicate-declaration byte controls", () => {
    const prefixed = `// see function collectResolvedImportCodes(filePath) below\n${selected.text}`;
    expect(Buffer.byteLength(braceMatch(prefixed))).toBe(1305);
    expect(selectDeclaration(prefixed).text).toBe(selected.text);
    emit("BRACE_VS_PARSER", { variant: "comment-prefix", braceBytes: 1305, parserBytes: 1253 });
    const duplicate = `${selected.text}\n${selected.text}`;
    expect(hash(braceMatch(duplicate))).toBe(declarationDigest);
    refusal(() => selectDeclaration(duplicate), "DECLARATION_NOT_UNIQUE", "declaration-count-one");
    emit("BRACE_DUPLICATE_BLIND", { bytes: 1253, sha256: hash(braceMatch(duplicate)) });
  });

  it.each(nestedCases)("AC14 nested/alternate binding %s", (name, text, code, clause) => {
    expect(hash(braceMatch(text))).toBe(declarationDigest);
    refusal(() => selectDeclaration(text), code, clause);
    emit("BRACE_BINDING_BLIND", { name, braceBytes: Buffer.byteLength(braceMatch(text)), code });
  });

  it.each([
    "function outer({ value: collectResolvedImportCodes }) {}",
    "function outer() { try {} catch (collectResolvedImportCodes) {} }",
    "import { value as collectResolvedImportCodes } from 'synthetic';",
    "const outer = class collectResolvedImportCodes {};",
  ])("AC14 other AST binding form %s", (suffix) => {
    refusal(
      () => selectDeclaration(`${selected.text}\n${suffix}`),
      "ALTERNATE_BINDING_PRESENT",
      "whole-tree-alternate-bindings",
    );
  });

  it("AC4 exact free identifiers and real two-parameter bindings", () => {
    expect(selected.freeIdentifiers).toEqual(["matchesAny", "path"]);
    const result = executeDeclaration(
      selected.text,
      fixture[0].importerPath,
      `import value from '${fixture[0].specifierText}'`,
    );
    expect(result.factoryParameterCount).toBe(2);
    expect(result.candidates[0]).toBe(
      path.posix.normalize(path.posix.join(path.posix.dirname(fixture[0].importerPath), fixture[0].specifierText)),
    );
    expect(result.candidates).toEqual(artifact.rows[0].candidates);
    expect(result.reasonCodes.size).toBe(0);
    expect(readFileSync(generatorPath, "utf8")).toContain('new Function("path", "matchesAny",');
    emit("CLOSED_FACTORY", { parameters: result.factoryParameterCount, bindings: ["node:path", "recordingMatcher"] });
  });

  it.each([
    "process.exit(99);",
    "const hidden = () => process; hidden();",
    "{ const process = 1; } process.exit(99);",
    "const object = { process };",
  ])("AC4 refuses unexpected free identifier before execution: %s", (statement) => {
    const text = selected.text.replace("{\n", `{\n  ${statement}\n`);
    refusal(
      () => executeDeclaration(text, fixture[0].importerPath, ""),
      "FREE_IDENTIFIER_UNEXPECTED",
      "free-identifiers-exactly-path-and-matchesAny",
    );
  });

  it("AC5 AC13 one frozen, closed, ordered fixture authority", () => {
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(fixture.every(Object.isFrozen)).toBe(true);
    expect(artifact.fixture).toEqual(fixture);
    expect(measure(artifact)).toEqual({
      rows: 31,
      emissions: 258,
      partition: [18, 7, 6],
      uniquePairs: 31,
      keysClosed: true,
      strings: true,
      digest: fixtureDigest,
    });
    expect(Buffer.byteLength(canonical(fixture))).toBe(1843);
    expect(fixture.filter((row) => row.importerPath === "bounded-contexts/example/source.ts")).toHaveLength(29);
    expect(fixture[16].importerPath).toBe("bounded-contexts\\example\\source.ts");
    expect(fixture[17].importerPath).toBe("packages/example-2/nested/source.ts");
    emit("FIXTURE", { ...measure(artifact), canonicalBytes: Buffer.byteLength(canonical(fixture)) });
  });

  it("AC6 exact emission, raw backslashes and unnormalized package paths", () => {
    expect(artifact.rows).toHaveLength(31);
    for (const [index, row] of artifact.rows.entries()) {
      expect(Object.keys(row).sort()).toEqual(["candidates", "importerPath", "index", "specifierText"]);
      expect(row.index).toBe(index + 1);
      expect(row.importerPath).toBe(fixture[index].importerPath);
      expect(row.specifierText).toBe(fixture[index].specifierText);
      expect(row.candidates.every((candidate) => typeof candidate === "string")).toBe(true);
      expect(new Set(row.candidates).size).toBe(row.candidates.length);
      expect(row.candidates.length).toBe(index < 18 ? 5 : index < 25 ? 24 : 0);
    }
    expect(artifact.rows[12].candidates.every((candidate) => candidate.includes("\\"))).toBe(true);
    const traversal = artifact.rows[20].candidates;
    expect(traversal.every((candidate) => candidate.includes("/../"))).toBe(true);
    expect(traversal[0]).toBe("bounded-contexts/example/a/../b");
    expect(traversal.at(-1)).toBe("packages/example/support/a/../b/index.ts");
    const raw = artifact.rows[21].candidates;
    expect(new Set(raw).size).toBe(24);
    expect(new Set(raw.map((candidate) => path.posix.normalize(candidate))).size).toBe(15);
    emit("scanned = 31 / declared = 31", { candidates: 258, partition: "18/7/6", duplicates: 0 });
    emit("ROW13", artifact.rows[12].candidates);
    emit("ROW21", traversal);
    emit("ROW22", { rawDistinct: 24, normalizedDistinct: 15 });
  });

  it("AC7 closed artifact and candidate-construction versus early return", () => {
    expect(Object.keys(artifact).sort()).toEqual(
      [
        "schemaVersion",
        "sourceCommit",
        "sourcePath",
        "sourceBlobObjectId",
        "sourceByteLength",
        "sourceSha256",
        "declarationSha256",
        "declarationByteLength",
        "recordedChannel",
        "fixture",
        "rows",
      ].sort(),
    );
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.recordedChannel).toBe("candidate-construction");
    expect(artifact.declarationSha256).toBe(declarationDigest);
    expect(artifact.declarationByteLength).toBe(1253);
    const content = fixture
      .slice(0, 2)
      .map((row) => `import value from '${row.specifierText}'`)
      .join(";\n");
    const all = executeDeclaration(selected.text, fixture[0].importerPath, content);
    const early = executeDeclaration(selected.text, fixture[0].importerPath, content, () => true);
    expect(all.candidates).toHaveLength(10);
    expect(early.candidates).toHaveLength(1);
    expect([...early.reasonCodes]).toEqual(["seed_bootstrap_import_reconciliation"]);
    emit("CONSTRUCTION_VS_RETURN", {
      constructedCandidates: 10,
      observedBeforeReturn: 1,
      constructedSpecifiers: 2,
      matchedSpecifiers: 1,
    });
  });

  it("AC8 byte-for-byte CLI regeneration outside repository", () => {
    const output = path.join(temporaryRoot(), "regenerated.json");
    const args = [
      generatorPath,
      "--source-commit",
      coordinate.sourceCommit,
      "--source-path",
      coordinate.sourcePath,
      "--out",
      output,
    ];
    execFileSync(process.execPath, args, { cwd: repoRoot, stdio: "pipe", windowsHide: true });
    const regenerated = readFileSync(output);
    expect(regenerated.equals(artifactBytes)).toBe(true);
    emit("REGENERATED", {
      command: `node ${args.join(" ")}`,
      checkedIn: hash(artifactBytes),
      regenerated: hash(regenerated),
    });
  });

  it("AC1 AC5 AC8 no filesystem source entrypoint or second fixture list", () => {
    expect(Object.keys(generator).sort()).toEqual(
      [
        "PINNED_SOURCE",
        "buildArtifact",
        "executeDeclaration",
        "loadPinnedSource",
        "main",
        "readGitObject",
        "selectDeclaration",
      ].sort(),
    );
    const ownPath = path.join(import.meta.dirname, "generate-guard-import-candidate-emission.test.mjs");
    const noReads = spawnSync("rg", ["-n", "readFileSync", generatorPath], { encoding: "utf8", windowsHide: true });
    expect(noReads.status).toBe(1);
    const noSecondList = spawnSync("rg", ["-n", "-F", fixture[18].specifierText, generatorPath, ownPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(noSecondList.status).toBe(1);
    const imports = spawnSync("rg", ["-n", "importer-specifier-fixture", generatorPath, ownPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(imports.status).toBe(0);
    const workingTreeReads = spawnSync(
      "rg",
      ["-n", ["readFileSync", ".*", PINNED_SOURCE.path.split("/").at(-1)].join(""), ownPath],
      { encoding: "utf8", windowsHide: true },
    );
    expect(workingTreeReads.status).toBe(1);
    expect(
      readFileSync(ownPath, "utf8")
        .split("\n")
        .filter((line) => line.includes("readFileSync(") && line.includes(PINNED_SOURCE.path)),
    ).toEqual([]);
    emit("GREP", {
      generatorReadFileSync: { exit: noReads.status, output: noReads.stdout },
      parallelFixtureLiteral: { exit: noSecondList.status, output: noSecondList.stdout },
      imports: imports.stdout,
      workingTreeReads: workingTreeReads.stdout,
    });
  });

  it("AC12 same-blob commit cannot replace provenance", () => {
    const alternate = readGitObject({ ...coordinate, sourceCommit: sameBlobCommit });
    expect(alternate.blobObjectId).toBe(PINNED_SOURCE.blobObjectId);
    expect(alternate.bytes.equals(source.bytes)).toBe(true);
    emit("SAME_BLOB_OTHER_COMMIT", {
      commit: sameBlobCommit,
      blob: alternate.blobObjectId,
      bytes: alternate.bytes.length,
      sha256: hash(alternate.bytes),
    });
    refusal(
      () =>
        loadPinnedSource({
          ...coordinate,
          sourceCommit: sameBlobCommit,
          execGit: () => {
            throw new Error("must not read");
          },
        }),
      "SOURCE_COMMIT_NOT_PINNED",
      "source-commit-equality",
    );
    assertArtifactProvenance(artifact);
  });

  it.each([
    [sameBlobCommit, PINNED_SOURCE.path, "SOURCE_COMMIT_NOT_PINNED", "source-commit-equality"],
    [PINNED_SOURCE.commit, "scripts/release-deployment-scope.mjs", "SOURCE_PATH_NOT_PINNED", "source-path-equality"],
  ])("AC12 refused coordinate writes no output %s %s", (commit, sourcePath, code, clause) => {
    refusal(
      () =>
        loadPinnedSource({
          sourceCommit: commit,
          sourcePath,
          execGit: () => {
            throw new Error("must not read");
          },
        }),
      code,
      clause,
    );
    const out = path.join(temporaryRoot(), "refused.json");
    const result = spawnSync(
      process.execPath,
      [generatorPath, "--source-commit", commit, "--source-path", sourcePath, "--out", out],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${code}: ${clause}`);
    expect(existsSync(out)).toBe(false);
  });

  it("AC12 immutable object reader ignores a dirty scratch predecessor", () => {
    const root = temporaryRoot();
    git(["init", "--quiet"], root);
    git(["config", "core.autocrlf", "false"], root);
    git(["config", "core.eol", "lf"], root);
    const target = path.join(root, ...PINNED_SOURCE.path.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    const committed = Buffer.concat([source.bytes, Buffer.from("\n// committed scratch variant\n")]);
    const dirty = Buffer.concat([source.bytes, Buffer.from("\n// dirty scratch variant\n")]);
    writeFileSync(target, committed);
    git(["add", "--", PINNED_SOURCE.path], root);
    git(
      [
        "-c",
        "user.name=Oracle fixture",
        "-c",
        "user.email=oracle@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "synthetic immutable source",
      ],
      root,
    );
    const commit = git(["rev-parse", "HEAD"], root).toString("utf8").trim();
    writeFileSync(target, dirty);
    const object = readGitObject({
      sourceCommit: commit,
      sourcePath: PINNED_SOURCE.path,
      execGit: (args) => git(args, root),
    });
    expect(object.bytes.equals(committed)).toBe(true);
    expect(object.bytes.equals(dirty)).toBe(false);
    expect(hash(committed)).not.toBe(hash(source.bytes));
    emit("IMMUTABLE_VS_DIRTY", { committed: hash(object.bytes), dirty: hash(dirty), pinned: hash(source.bytes) });
  });

  it("AC8 missing Git object refuses a full generator run without output", () => {
    const root = temporaryRoot();
    const target = path.join(root, "generator.mjs");
    const output = path.join(root, "absent.json");
    writeFileSync(target, isolatedGeneratorSource(readFileSync(generatorPath, "utf8")));
    const result = spawnSync(
      process.execPath,
      [target, "--source-commit", coordinate.sourceCommit, "--source-path", coordinate.sourcePath, "--out", output],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SOURCE_OBJECT_UNREADABLE: git-object-read");
    expect(existsSync(output)).toBe(false);
    emit("ABSENT_OBJECT_NO_OUTPUT", {
      status: result.status,
      code: "SOURCE_OBJECT_UNREADABLE",
      reachedClause: "git-object-read",
      outputExists: false,
    });
  });

  it("AC9 candidate-string and same-blob provenance mutants redden independent controls", async () => {
    const root = temporaryRoot();
    const target = path.join(root, "emission-oracle.json");
    const mutations = [
      [
        "candidate row 1 index 0",
        (value) => {
          value.rows[0].candidates[0] += "-mutant";
        },
      ],
      [
        "same-blob provenance",
        (value) => {
          value.sourceCommit = sameBlobCommit;
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      writeFileSync(target, artifactBytes);
      try {
        const value = JSON.parse(readFileSync(target, "utf8"));
        mutate(value);
        writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
        if (name.startsWith("candidate")) {
          const regenerated = Buffer.from(
            await format(JSON.stringify(buildArtifact(coordinate)), { parser: "json", tabWidth: 2, printWidth: 120 }),
          );
          expect(regenerated.equals(artifactBytes)).toBe(true);
          expect(() => expect(readFileSync(target).equals(regenerated)).toBe(true)).toThrow();
        } else refusal(() => assertArtifactProvenance(value), "SOURCE_COMMIT_NOT_PINNED", "artifact-source-commit");
        emit("ARTIFACT_MUTANT_RED", name);
      } finally {
        writeFileSync(target, artifactBytes);
      }
      expect(readFileSync(target).equals(artifactBytes)).toBe(true);
      emit("ARTIFACT_RESTORED", hash(readFileSync(target)));
    }
  });

  it.each([
    ["M1", (rows) => rows.pop(), 30, 258, [18, 7, 5], 30, true, true],
    ["M2", (rows) => rows.push({ ...rows[0], specifierText: "./added" }), 32, 263, [19, 7, 6], 32, true, true],
    [
      "M3",
      (rows) => {
        [rows[0], rows[1]] = [rows[1], rows[0]];
      },
      31,
      258,
      [18, 7, 6],
      31,
      true,
      true,
    ],
    ["M4", (rows) => rows.push({ ...rows[1] }), 32, 263, [19, 7, 6], 31, true, true],
    [
      "M5",
      (rows) => {
        rows[0] = { ...rows[1] };
      },
      31,
      258,
      [18, 7, 6],
      30,
      true,
      true,
    ],
    [
      "M6",
      (rows) => {
        rows[4].specifierText = 42;
      },
      31,
      253,
      [17, 7, 7],
      31,
      true,
      false,
    ],
    [
      "M7",
      (rows) => {
        rows[6].unknown = true;
      },
      31,
      258,
      [18, 7, 6],
      31,
      false,
      true,
    ],
  ])("AC13 fixture co-edit mutant %s", (name, mutate, rows, emissions, partition, uniquePairs, keysClosed, strings) => {
    const mutated = structuredClone(fixture);
    mutate(mutated);
    const regenerated = buildArtifact({ ...coordinate, fixture: mutated });
    const actual = measure(regenerated);
    expect(actual).toMatchObject({ rows, emissions, partition, uniquePairs, keysClosed, strings });
    expect(regenerated.fixture).toEqual(mutated);
    const controls = {
      counts: actual.rows === 31 && actual.emissions === 258 && JSON.stringify(actual.partition) === "[18,7,6]",
      pairs: actual.uniquePairs === actual.rows,
      keys: actual.keysClosed,
      strings: actual.strings,
      digest: actual.digest === fixtureDigest,
    };
    expect(Object.values(controls).every(Boolean)).toBe(false);
    if (name === "M3")
      expect(controls).toEqual({ counts: true, pairs: true, keys: true, strings: true, digest: false });
    if (name === "M7")
      expect(controls).toEqual({ counts: true, pairs: true, keys: false, strings: true, digest: true });
    if (name === "M5")
      expect(controls).toEqual({ counts: true, pairs: false, keys: true, strings: true, digest: false });
    if (["M1", "M2", "M4", "M6"].includes(name)) expect(controls.counts).toBe(false);
    emit("FIXTURE_MUTANT", { name, ...actual, controls, candidate: "31 / 258 / 18-7-6 / 31 / 79247eb90558610e" });
    expect(hash(canonical(fixture))).toBe(fixtureDigest);
    emit("FIXTURE_RESTORED", hash(readFileSync(fixturePath)));
  });
});

describe("transient source mutants with restored-byte controls", () => {
  const mutationCases = [
    [
      "AC1 SHA comparison",
      "digest(source.bytes) !== PINNED_SOURCE.sha256",
      "false",
      `
      const bad = Buffer.from(${JSON.stringify(source.bytes.toString("base64"))}, "base64");
      bad[0] ^= 1;
      assert.throws(() => m.loadPinnedSource({ ...coordinate, execGit: (args) => args[0] === "rev-parse" ? Buffer.from(m.PINNED_SOURCE.blobObjectId) : bad }), { code: "SOURCE_SHA256_MISMATCH" });
    `,
    ],
    [
      "AC2 first declaration",
      "declarations.length !== 1",
      "false",
      `
      assert.throws(() => m.selectDeclaration(${JSON.stringify(`${selected.text}\n${selected.text}`)}), { code: "DECLARATION_NOT_UNIQUE" });
    `,
    ],
    [
      "AC14 top-level-only binding scan",
      "if (isBinding(node) && bindingNames(node.name).includes(declarationName))",
      "if (isBinding(node) && (node.parent === source || (ts.isVariableDeclaration(node) && node.parent.parent.parent === source)) && bindingNames(node.name).includes(declarationName))",
      `
      let rejected = 0;
      for (const text of ${JSON.stringify(nestedCases.slice(2).map((row) => row[1]))}) {
        try { m.selectDeclaration(text); } catch (error) { if (error.code === "ALTERNATE_BINDING_PRESENT") rejected += 1; else throw error; }
      }
      assert.equal(rejected, 4, "all four alternate-binding rows must refuse");
    `,
    ],
  ];
  it.each(mutationCases)("%s: green twin, one-variable red, restored green", (name, before, after, assertion) => {
    const original = readFileSync(generatorPath, "utf8");
    expect(original.split(before)).toHaveLength(2);
    // Only import locations change in the isolated harness; no selector or loader behavior changes.
    const isolated = isolatedGeneratorSource(original);
    const target = path.join(temporaryRoot(), "generator.mjs");
    const script = `import assert from 'node:assert/strict';
      import * as m from ${JSON.stringify(pathToFileURL(target).href)};
      const coordinate = ${JSON.stringify(coordinate)};
      assert.equal(m.selectDeclaration(${JSON.stringify(selected.text)}).sha256, ${JSON.stringify(declarationDigest)});
      assert.throws(() => m.selectDeclaration('const unrelated = 1;'), { code: 'DECLARATION_ABSENT' });
      assert.throws(() => m.selectDeclaration(${JSON.stringify(`${selected.text}\nconst collectResolvedImportCodes = 1;`)}), { code: 'ALTERNATE_BINDING_PRESENT' });
      ${assertion}`;
    const runner = path.join(path.dirname(target), "assertions.mjs");
    writeFileSync(runner, script);
    const run = () =>
      spawnSync(process.execPath, [runner], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    writeFileSync(target, isolated);
    try {
      const green = run();
      expect(green.status, green.stderr).toBe(0);
      writeFileSync(target, isolated.replace(before, after));
      const red = run();
      expect(red.status).toBe(1);
      expect(red.stderr).toContain("AssertionError");
      emit("SOURCE_MUTANT_RED", {
        name,
        status: red.status,
        assertion: red.stderr
          .split("\n")
          .filter((line) => line.includes("AssertionError") || line.includes("actual:") || line.includes("expected:")),
      });
    } finally {
      writeFileSync(target, isolated);
    }
    const restored = run();
    expect(restored.status, restored.stderr).toBe(0);
    expect(hash(readFileSync(target))).toBe(hash(isolated));
    expect(hash(readFileSync(generatorPath))).toBe(hash(original));
    emit("SOURCE_RESTORED", {
      name,
      isolatedSha256: hash(readFileSync(target)),
      generatorSha256: hash(readFileSync(generatorPath)),
      restoredExit: restored.status,
    });
  });
});

function neutralityError(code, clause) {
  throw Object.assign(new Error(code), { code, reachedClause: clause });
}
function treeMembers(read, aliases = new Map()) {
  let bytes;
  try {
    bytes = read();
  } catch {
    neutralityError("NEUTRALITY_TREE_UNREADABLE", "tree-read");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.at(-1) !== 0)
    neutralityError("NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree");
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    neutralityError("NEUTRALITY_INVALID_UTF8", "fatal-tree-decoder");
  }
  const names = decoded.slice(0, -1).split("\0");
  if (names.some((name) => !name)) neutralityError("NEUTRALITY_TREE_INCOMPLETE", "empty-tree-member");
  const members = [];
  for (const name of names) {
    const governed = listNonTestTypeScriptModules(repoRoot, { execGit: () => `${name}\0` });
    if (governed.length === 0) continue;
    const canonicalName = governed[0];
    const raw = Buffer.from(name, "utf8").toString("hex");
    if (aliases.has(canonicalName) && aliases.get(canonicalName) !== raw)
      neutralityError("NEUTRALITY_CANONICAL_ALIAS_COLLISION", "canonical-to-raw-one-to-one");
    aliases.set(canonicalName, raw);
    members.push({ canonicalName, raw });
  }
  const complete = listNonTestTypeScriptModules(repoRoot, { execGit: () => decoded });
  expect(members.map((member) => member.canonicalName).sort()).toEqual(complete);
  return members.sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
}
function compareTrees(base, candidate) {
  const aliases = new Map();
  const before = treeMembers(base, aliases);
  const after = treeMembers(candidate, aliases);
  if (JSON.stringify(before) !== JSON.stringify(after))
    neutralityError("NEUTRALITY_MEMBER_SET_CHANGED", "complete-raw-member-set");
  return after;
}
const tree = (...names) => Buffer.from(`${names.join("\0")}\0`);

describe("candidate-specific inventory neutrality", () => {
  it("H1 actual non-injected provenance resolution or exact refusal", () => {
    try {
      const record = deriveGuardCandidateProvenance();
      for (const name of ["landingCandidate", "baseTipAtAnalysis", "forkPoint"]) {
        expect(record.roles[name].sha).toMatch(/^[a-f0-9]{40}$/);
        expect(record.roles[name].source).toEqual(expect.any(String));
      }
      emit("H1_HOSTED_PROVENANCE", { status: "resolved", environment: record.environment, roles: record.roles });
    } catch (error) {
      emit("H1_HOSTED_PROVENANCE", {
        status: "refused",
        environment: process.env.GITHUB_EVENT_NAME ?? "plain",
        code: error.code,
        reachedClause: error.reachedClause,
      });
      throw error;
    }
  });

  it("N1 complete landingCandidate member set equals its exact forkPoint", () => {
    const { roles } = deriveGuardCandidateProvenance();
    const read = (sha) => () => git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
    const members = compareTrees(read(roles.forkPoint.sha), read(roles.landingCandidate.sha));
    expect(members.length).toBeGreaterThan(0);
    emit("N1_NEUTRALITY", { candidate: roles.landingCandidate, forkPoint: roles.forkPoint, members: members.length });
    const added = git(["diff", "--name-only", "--diff-filter=A", roles.forkPoint.sha, roles.landingCandidate.sha])
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const production = new Set(enumerateTrackedRoots(repoRoot));
    for (const file of added) {
      expect(file).toMatch(/^scripts\/.*\.(?:mjs|json)$/);
      expect(production.has(file)).toBe(false);
    }
  });

  it.each([
    ["N2 addition", tree("src/a.ts"), tree("src/a.ts", "src/b.ts")],
    ["N3 removal", tree("src/a.ts", "src/b.ts"), tree("src/a.ts")],
    ["N4 equal cardinality different membership", tree("src/a.ts"), tree("src/b.ts")],
  ])("%s is red on complete-set comparison", (_name, base, candidate) => {
    refusal(
      () =>
        compareTrees(
          () => base,
          () => candidate,
        ),
      "NEUTRALITY_MEMBER_SET_CHANGED",
      "complete-raw-member-set",
    );
    expect(
      compareTrees(
        () => base,
        () => base,
      ).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ["empty", () => Buffer.alloc(0), "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
    ["short", () => Buffer.from("src/a.ts"), "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
    [
      "failed",
      () => {
        throw new Error("failed ls-tree");
      },
      "NEUTRALITY_TREE_UNREADABLE",
      "tree-read",
    ],
  ])("N5 refuses %s tree read", (_name, read, code, clause) => {
    refusal(() => treeMembers(read), code, clause);
  });

  it("N6 lossless raw identities, fatal UTF-8, and within-tree aliases", () => {
    refusal(
      () => treeMembers(() => tree("src/a\\b.ts", "src/a/b.ts")),
      "NEUTRALITY_CANONICAL_ALIAS_COLLISION",
      "canonical-to-raw-one-to-one",
    );
    for (const invalid of ["7372632fff2e747300", "7372632ffe2e747300"]) {
      refusal(() => treeMembers(() => Buffer.from(invalid, "hex")), "NEUTRALITY_INVALID_UTF8", "fatal-tree-decoder");
    }
    const identities = tree("src/A.ts", "src/a.ts", "src/é.ts", "src/e\u0301.ts", "src/\ufeffa.ts");
    const members = compareTrees(
      () => identities,
      () => identities,
    );
    expect(members).toHaveLength(5);
    expect(new Set(members.map((member) => member.raw)).size).toBe(5);
    emit("N6_RAW_IDENTITIES", members);
  });

  it.each([
    [Buffer.from("7372632f615c622e747300", "hex"), Buffer.from("7372632f612f622e747300", "hex")],
    [tree("src/./a.ts"), tree("src/a.ts")],
  ])("N8 cross-tree canonical aliases refuse; canonical-only mutant stays green", (base, candidate) => {
    refusal(
      () =>
        compareTrees(
          () => base,
          () => candidate,
        ),
      "NEUTRALITY_CANONICAL_ALIAS_COLLISION",
      "canonical-to-raw-one-to-one",
    );
    const canonicalOnly = (bytes) => listNonTestTypeScriptModules(repoRoot, { execGit: () => bytes.toString("utf8") });
    expect(canonicalOnly(base)).toEqual(canonicalOnly(candidate));
    emit("N8_CANONICAL_ONLY_MUTANT_GREEN", { base: base.toString("hex"), candidate: candidate.toString("hex") });
  });

  it("N7 synthetic merge-group base comes from event, never ref name", () => {
    const head = "a".repeat(40),
      base = "b".repeat(40),
      wrong = "c".repeat(40);
    const calls = [];
    const execGit = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
      if (args[0] === "rev-list") return `${head} ${base}`;
      if (args[0] === "merge-base" && args[1] !== "--is-ancestor") {
        expect(args).toEqual(["merge-base", head, base]);
        return base;
      }
      if (args[0] === "cat-file" || args[1] === "--is-ancestor") return "";
      throw new Error(`unexpected synthetic git: ${args}`);
    };
    const options = {
      env: { GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-synthetic-${wrong}` },
      execGit,
      readEventPayload: () => ({ merge_group: { head_sha: head, base_sha: base } }),
    };
    const record = deriveGuardCandidateProvenance(options);
    expect(record.roles.baseTipAtAnalysis).toEqual({ sha: base, source: "merge-group-event-base" });
    expect(calls.some((args) => args.includes("refs/remotes/origin/main"))).toBe(false);
    const mutant = structuredClone(record);
    mutant.roles.baseTipAtAnalysis.sha = wrong;
    expect(() => expect(mutant.roles.baseTipAtAnalysis).toEqual(record.roles.baseTipAtAnalysis)).toThrow();
    emit("N7_SYNTHETIC", { roles: record.roles, refBaseMutant: "red" });
  });

  it("C1 five reclassified modules remain not-sql with zero violations and unresolved roots", () => {
    const files = [
      "bounded-contexts/catalog/support/test-support/source-observation-fixtures.ts",
      "deployables/admin-web/src/test/setup.ts",
      "deployables/marketplace/app/test-support/setup.ts",
      "deployables/platform-api/src/test-support/provider-gateways.ts",
      "deployables/platform-worker/src/test-support/provider-gateways.ts",
    ];
    const result = classifySqlExecutionSurface({ repoRoot, files });
    const check = (value) => {
      expect(value.modules.map(({ file, outcome }) => ({ file, outcome }))).toEqual(
        files.map((file) => ({ file, outcome: "not-sql" })),
      );
      expect(value.violations).toEqual([]);
      expect(value.unresolvedMemberRoots.count).toBe(0);
    };
    check(result);
    const mutant = structuredClone(result);
    mutant.modules[0].outcome = "sql-executing";
    expect(() => check(mutant)).toThrow();
    emit("C1", {
      modules: result.modules.map(({ file, outcome }) => ({ file, outcome })),
      violations: result.violations,
      unresolvedMemberRoots: result.unresolvedMemberRoots,
      mutant: "red",
    });
  });
});
