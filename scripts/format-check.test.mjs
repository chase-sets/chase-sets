import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PRETTIER_ARGUMENT_CHARS,
  changesFormattingControls,
  chunkPrettierPaths,
  deriveChangedFiles,
  filterCheckableFiles,
  runFormatCheck,
} from "./format-check.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempRoots = [];
const prettierCliPath = fileURLToPath(import.meta.resolve("prettier/bin/prettier.cjs"));

function createFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "format-check-"));
  tempRoots.push(root);
  cpSync(path.join(repoRoot, ".prettierignore"), path.join(root, ".prettierignore"));
  cpSync(path.join(repoRoot, ".prettierrc.json"), path.join(root, ".prettierrc.json"));
  return root;
}

function writeFixture(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  delete env.CHANGED_FILES_JSON;
  delete env.FORMAT_CHECK_SCOPE;
  if (Object.hasOwn(env, "CHASE_SETS_HEAVY_ADMISSION_ORIGINAL_NODE_OPTIONS")) {
    env.NODE_OPTIONS = env.CHASE_SETS_HEAVY_ADMISSION_ORIGINAL_NODE_OPTIONS;
    delete env.CHASE_SETS_HEAVY_ADMISSION_CONFIG;
    delete env.CHASE_SETS_HEAVY_ADMISSION_ORIGINAL_NODE_OPTIONS;
  }
  if (Object.hasOwn(env, "CHASE_SETS_HEAVY_ADMISSION_ORIGINAL_SCRIPT_SHELL")) {
    const originalScriptShell = env.CHASE_SETS_HEAVY_ADMISSION_ORIGINAL_SCRIPT_SHELL;
    if (originalScriptShell) env.npm_config_script_shell = originalScriptShell;
    else delete env.npm_config_script_shell;
    delete env.CHASE_SETS_HEAVY_ADMISSION_ORIGINAL_SCRIPT_SHELL;
    delete env.CHASE_SETS_HEAVY_ADMISSION_PNPM_SCRIPT_SHELL;
  }
  return Object.assign(env, overrides);
}

function runFixturePrettier(root, args) {
  const result = spawnSync(process.execPath, [prettierCliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function fakeFileStat() {
  return { isFile: () => true };
}

function createRunnerHarness() {
  const prettierCalls = [];
  const stdout = [];
  const stderr = [];
  return {
    prettierCalls,
    stdout,
    stderr,
    options: {
      repoRoot,
      runPrettier: (args) => {
        prettierCalls.push(args);
        return 0;
      },
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      getFileInfoImpl: async () => ({ ignored: false }),
      statImpl: async () => fakeFileStat(),
    },
  };
}

function commitFixture(root, message) {
  execFileSync("git", ["-c", "user.name=Format Check", "-c", "user.email=format@example.com", "add", "--all"], {
    cwd: root,
  });
  execFileSync(
    "git",
    ["-c", "user.name=Format Check", "-c", "user.email=format@example.com", "commit", "--quiet", "-m", message],
    { cwd: root },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("format-check soundness corpus", () => {
  const corpus = [
    {
      fixture: "modified",
      changedFiles: ["src/modified.js"],
      arrange: (root) => writeFixture(root, "src/modified.js", "const modified={value:1}\n"),
      expectedStatus: 1,
    },
    {
      fixture: "added",
      changedFiles: ["src/added.ts"],
      arrange: (root) => writeFixture(root, "src/added.ts", "export const added={value:1}\n"),
      expectedStatus: 1,
    },
    {
      fixture: "renamed with spaces and non-ASCII",
      changedFiles: ["src/renamed café file.js"],
      arrange: (root) => writeFixture(root, "src/renamed café file.js", "const renamed={value:1}\n"),
      expectedStatus: 1,
    },
    {
      fixture: "deleted",
      changedFiles: ["src/deleted.js"],
      arrange: () => {},
      expectedStatus: 0,
    },
    {
      fixture: "ignored by the real .prettierignore",
      changedFiles: ["pnpm-lock.yaml"],
      arrange: (root) => writeFixture(root, "pnpm-lock.yaml", "not:       formatted\n"),
      expectedStatus: 0,
    },
    {
      fixture: "unknown extension",
      changedFiles: ["src/opaque.chase-sets-unknown"],
      arrange: (root) => writeFixture(root, "src/opaque.chase-sets-unknown", "not remotely formatted {{{\n"),
      expectedStatus: 0,
    },
  ];

  it.each(corpus)("$fixture: narrowed and full outcomes agree", async ({ arrange, changedFiles, expectedStatus }) => {
    const root = createFixtureRoot();
    arrange(root);
    const full = runFixturePrettier(root, [".", "--check", "--ignore-unknown"]);
    const narrowed = await runFormatCheck({
      repoRoot: root,
      argv: ["--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: JSON.stringify(changedFiles) }),
      runPrettier: (args) => runFixturePrettier(root, args),
      stdout: () => {},
      stderr: () => {},
    });

    expect(full).toBe(expectedStatus);
    expect(narrowed).toBe(expectedStatus);
  });

  it("filters a real ignored path before invoking Prettier", async () => {
    const root = createFixtureRoot();
    writeFixture(root, "deployables/example/src/generated/api-context-registry.ts", "export const value={bad:true}\n");
    const filtered = await filterCheckableFiles({
      repoRoot: root,
      files: ["deployables/example/src/generated/api-context-registry.ts"],
    });

    expect(filtered).toEqual({ files: [], deletedCount: 0, ignoredCount: 1 });
  });

  it("treats a deletion-only changed set as a successful filtered run", async () => {
    const root = createFixtureRoot();
    const stdout = [];
    const prettierCalls = [];
    const status = await runFormatCheck({
      repoRoot: root,
      argv: ["--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["deleted file.js"]' }),
      stdout: (message) => stdout.push(message),
      runPrettier: (args) => {
        prettierCalls.push(args);
        return 0;
      },
    });

    expect(status).toBe(0);
    expect(stdout.join("\n")).toContain("[FORMAT_CHECK_NO_CHECKABLE_FILES]");
    expect(stdout.join("\n")).toContain("deleted=1");
    expect(prettierCalls).toEqual([]);
  });

  it("uses the new path for an actual Git rename with spaces and non-ASCII characters", () => {
    const root = createFixtureRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFixture(root, "src/original.js", "const original = true;\n");
    commitFixture(root, "base");
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    mkdirSync(path.join(root, "src"), { recursive: true });
    execFileSync("git", ["mv", "src/original.js", "src/renamed café file.js"], { cwd: root });
    commitFixture(root, "rename");

    const derived = deriveChangedFiles({ repoRoot: root, env: cleanEnvironment() });

    expect(derived).toEqual({
      source: "git merge-base",
      files: ["src/renamed café file.js"],
    });
  });

  it("retains an actual Git deletion so removing a formatter control forces the full check", async () => {
    const root = createFixtureRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    commitFixture(root, "base");
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    rmSync(path.join(root, ".prettierignore"));
    commitFixture(root, "delete ignore rules");
    const prettierCalls = [];

    await runFormatCheck({
      repoRoot: root,
      argv: ["--changed"],
      env: cleanEnvironment(),
      runPrettier: (args) => {
        prettierCalls.push(args);
        return 0;
      },
    });

    expect(prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
  });
});

describe("format-check fail-closed discovery", () => {
  it("gives explicit CHANGED_FILES_JSON precedence only on the opt-in path", async () => {
    const harness = createRunnerHarness();
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["src/explicit file.ts"]' }),
      execGit: () => {
        throw new Error("Git must not run");
      },
    });

    expect(harness.prettierCalls).toEqual([["--check", "--ignore-unknown", "--", "src/explicit file.ts"]]);
    expect(harness.stdout.join("\n")).toContain("from CHANGED_FILES_JSON");
  });

  it("accepts pnpm's forwarded argument separator on the opt-in path", async () => {
    const harness = createRunnerHarness();
    await runFormatCheck({
      ...harness.options,
      argv: ["--", "--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["src/forwarded.ts"]' }),
    });

    expect(harness.prettierCalls).toEqual([["--check", "--ignore-unknown", "--", "src/forwarded.ts"]]);
  });

  it("falls back to the full tree with a named warning for malformed CHANGED_FILES_JSON", async () => {
    const harness = createRunnerHarness();
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: "{" }),
    });

    expect(harness.stderr.join("\n")).toContain("[FORMAT_CHECK_CHANGED_FILES_INVALID]");
    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
  });

  it("clears ambient changed-file input and proves the missing-merge-base branch ran", async () => {
    const harness = createRunnerHarness();
    const env = cleanEnvironment();
    const gitCalls = [];
    expect(env).not.toHaveProperty("CHANGED_FILES_JSON");
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env,
      execGit: (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") return "true\n";
        throw new Error("missing origin/main");
      },
    });

    expect(gitCalls).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["merge-base", "origin/main", "HEAD"],
    ]);
    expect(harness.stderr.join("\n")).toContain("[FORMAT_CHECK_MERGE_BASE_FAILED]");
    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
  });

  it("clears ambient changed-file input and proves the non-Git branch ran", async () => {
    const harness = createRunnerHarness();
    const env = cleanEnvironment();
    const gitCalls = [];
    expect(env).not.toHaveProperty("CHANGED_FILES_JSON");
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env,
      execGit: (args) => {
        gitCalls.push(args);
        throw new Error("not a repository");
      },
    });

    expect(gitCalls).toEqual([["rev-parse", "--is-inside-work-tree"]]);
    expect(harness.stderr.join("\n")).toContain("[FORMAT_CHECK_NOT_GIT_REPOSITORY]");
    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
  });

  it("falls back to the full tree with a named warning when Git diff fails", async () => {
    const harness = createRunnerHarness();
    const env = cleanEnvironment();
    expect(env).not.toHaveProperty("CHANGED_FILES_JSON");
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env,
      execGit: (args) => {
        if (args[0] === "rev-parse") return "true\n";
        if (args[0] === "merge-base") return "abc123\n";
        throw new Error("diff failed");
      },
    });

    expect(harness.stderr.join("\n")).toContain("[FORMAT_CHECK_DIFF_FAILED]");
    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
  });

  it("only no-ops an empty diff after Git discovery succeeds", async () => {
    const harness = createRunnerHarness();
    const env = cleanEnvironment();
    const gitCalls = [];
    expect(env).not.toHaveProperty("CHANGED_FILES_JSON");
    const status = await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env,
      execGit: (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") return "true\n";
        if (args[0] === "merge-base") return "abc123\n";
        return "";
      },
    });

    expect(status).toBe(0);
    expect(gitCalls.at(-1)).toEqual(["diff", "--name-only", "-z", "--diff-filter=ACMRTD", "abc123...HEAD", "--"]);
    expect(harness.stdout.join("\n")).toContain("[FORMAT_CHECK_EMPTY_DIFF]");
    expect(harness.prettierCalls).toEqual([]);
  });
});

describe("format-check execution controls", () => {
  it("keeps the default command full-tree even when ambient changed files exist", async () => {
    const harness = createRunnerHarness();
    await runFormatCheck({
      ...harness.options,
      argv: [],
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["src/unformatted.ts"]' }),
      execGit: () => {
        throw new Error("default full-tree mode must not derive a diff");
      },
    });

    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
    expect(harness.stdout.join("\n")).toContain("[FORMAT_CHECK_FULL_TREE]");
  });

  it.each([
    [".prettierrc.json"],
    ["nested/.editorconfig"],
    ["package.json"],
    ["pnpm-lock.yaml"],
    ["nested/prettier.config.mjs"],
  ])("runs the full tree when %s can change unchanged-file formatting", async (controlFile) => {
    const harness = createRunnerHarness();
    expect(changesFormattingControls([controlFile])).toBe(true);
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: JSON.stringify([controlFile]) }),
    });

    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
    expect(harness.stdout.join("\n")).toContain("[FORMAT_CHECK_CONTROL_FILE_CHANGED]");
  });

  it("forces CI's opted-in static chain back to the full tree before reading CHANGED_FILES_JSON", async () => {
    const harness = createRunnerHarness();
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env: cleanEnvironment({
        CHANGED_FILES_JSON: '["src/unformatted.ts"]',
        FORMAT_CHECK_SCOPE: "full",
      }),
      execGit: () => {
        throw new Error("the CI override must not derive a diff");
      },
    });

    expect(harness.prettierCalls).toEqual([[".", "--check", "--ignore-unknown"]]);
    expect(harness.stdout.join("\n")).toContain("FORMAT_CHECK_SCOPE=full");
  });

  it("proves CI's full-tree override catches unformatted unchanged files omitted by the scoped path", async () => {
    const root = createFixtureRoot();
    writeFixture(root, "src/changed.js", "const changed = true;\n");
    writeFixture(root, "src/unchanged.js", "const unchanged={value:1}\n");
    const scopedEnvironment = cleanEnvironment({
      CHANGED_FILES_JSON: '["src/changed.js"]',
    });

    const scopedStatus = await runFormatCheck({
      repoRoot: root,
      argv: ["--changed"],
      env: scopedEnvironment,
      runPrettier: (args) => runFixturePrettier(root, args),
      stdout: () => {},
      stderr: () => {},
    });
    const ciStatus = await runFormatCheck({
      repoRoot: root,
      argv: ["--changed"],
      env: { ...scopedEnvironment, FORMAT_CHECK_SCOPE: "full" },
      runPrettier: (args) => runFixturePrettier(root, args),
      stdout: () => {},
      stderr: () => {},
    });

    expect(scopedStatus).toBe(0);
    expect(ciStatus).toBe(1);
  });

  it("preserves paths exactly and chunks a 2,000-file diff below the Windows-safe argument budget", () => {
    const files = Array.from(
      { length: 2_000 },
      (_, index) => `bounded-contexts/example/features/a long café path ${index}/source file ${index}.ts`,
    );
    const chunks = chunkPrettierPaths(files);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(files);
    for (const chunk of chunks) {
      expect(chunk.reduce((length, file) => length + file.length + 1, 0)).toBeLessThanOrEqual(
        MAX_PRETTIER_ARGUMENT_CHARS,
      );
    }
  });

  it("keeps --ignore-unknown on every scoped chunk", async () => {
    const harness = createRunnerHarness();
    await runFormatCheck({
      ...harness.options,
      argv: ["--changed"],
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["src/opaque.unknown"]' }),
    });

    expect(harness.prettierCalls).toEqual([["--check", "--ignore-unknown", "--", "src/opaque.unknown"]]);
  });

  it("wires local verify:static to the explicit opt-in while leaving format:check full by default", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

    expect(packageJson.scripts["format:check"]).toBe("node ./scripts/format-check.mjs");
    expect(packageJson.scripts["verify:static"]).toMatch(/^pnpm run format:check -- --changed && /);
  });
});
