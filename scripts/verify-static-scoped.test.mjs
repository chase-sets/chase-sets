import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitKeySetTripwireViolations } from "./check-structure/catalog-localization-keyset-tripwire.mjs";
import { classifyChanges } from "./change-scope.mjs";
import { listWorkspacePackages, repoRoot } from "./lib/repo.mjs";
import {
  deriveStaticChangedFiles,
  parseNameStatusZ,
  parseVerifyStaticChain,
  resolvePnpmInvocation,
  runVerifyStaticScoped,
  selectVerifyStaticLinks,
  verifyStaticSurfaceMapCompleteness,
} from "./verify-static-scoped.mjs";
import { ALWAYS_RUN, MAY_NARROW, VERIFY_STATIC_SURFACES } from "./verify-static-surfaces.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.CHANGED_FILES_JSON;
  return { ...env, ...overrides };
}

function packageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function currentChain() {
  return parseVerifyStaticChain(packageJson());
}

function noFanoutDependencies() {
  const workspaces = [{ name: "@fixture/one" }, { name: "@fixture/two" }];
  return {
    listWorkspacePackages: () => workspaces,
    classifyChanges: () => ({ affectedWorkspaces: ["@fixture/one"] }),
  };
}

function selectedNames(changedFiles, options = {}) {
  return selectVerifyStaticLinks({
    chain: currentChain(),
    changedFiles,
    repoRoot,
    dependencies: noFanoutDependencies(),
    ...options,
  }).selected.map((link) => link.name);
}

function execGit(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFixture(rootDir, relativePath, source) {
  const absolutePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, "utf8");
}

function keySetFingerprint(keys) {
  return {
    count: keys.length,
    sha256: createHash("sha256")
      .update(JSON.stringify([...keys].sort()))
      .digest("hex"),
  };
}

describe("verify:static surface-map derivation", () => {
  it("derives every authoritative chain link from package.json and maps it exactly once", () => {
    const chain = currentChain();
    const completeness = verifyStaticSurfaceMapCompleteness(chain);

    expect(chain).toHaveLength(29);
    expect(completeness).toEqual({ missing: [], extra: [], invalidMayNarrow: [] });
    expect(
      Object.values(VERIFY_STATIC_SURFACES).filter(({ classification }) => classification === MAY_NARROW),
    ).toHaveLength(17);
    expect(
      Object.values(VERIFY_STATIC_SURFACES).filter(({ classification }) => classification === ALWAYS_RUN),
    ).toHaveLength(12);
    for (const entry of Object.values(VERIFY_STATIC_SURFACES)) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.rule).toBeTruthy();
      for (const citation of entry.evidence) {
        const match = /^([^:]+):(\d+)/.exec(citation);
        expect(match, citation).not.toBeNull();
        const citedPath = path.join(repoRoot, match[1]);
        expect(existsSync(citedPath), citation).toBe(true);
        expect(readFileSync(citedPath, "utf8").split(/\r?\n/).length, citation).toBeGreaterThanOrEqual(
          Number(match[2]),
        );
      }
    }
  });

  it("fails derivation and still executes an appended unmapped link by default", () => {
    const unmapped = { name: "check:future-static-link", command: "pnpm run check:future-static-link", forwarded: "" };
    const chain = [...currentChain(), unmapped];

    expect(verifyStaticSurfaceMapCompleteness(chain).missing).toEqual(["check:future-static-link"]);
    expect(
      selectVerifyStaticLinks({
        chain,
        changedFiles: ["docs/only-this.md"],
        repoRoot,
        dependencies: noFanoutDependencies(),
      }).selected,
    ).toContain(unmapped);
  });

  it("runs a malformed map classification fail-closed", () => {
    const chain = [{ name: "check:uncertain", command: "pnpm run check:uncertain", forwarded: "" }];
    const selected = selectVerifyStaticLinks({
      chain,
      changedFiles: ["docs/only-this.md"],
      repoRoot,
      surfaces: {
        "check:uncertain": {
          classification: "typo",
          rule: "invalid classification",
          evidence: ["fixture:1"],
        },
      },
      dependencies: noFanoutDependencies(),
    }).selected;

    expect(selected).toEqual(chain);
  });

  it("rejects MAY_NARROW entries without a non-empty include and selects them fail-closed", () => {
    const chain = [
      { name: "check:missing-include", command: "pnpm run check:missing-include", forwarded: "" },
      { name: "check:empty-include", command: "pnpm run check:empty-include", forwarded: "" },
    ];
    const surfaces = {
      "check:missing-include": {
        classification: MAY_NARROW,
        rule: "invalid missing include",
        evidence: ["fixture:1"],
      },
      "check:empty-include": {
        classification: MAY_NARROW,
        rule: "invalid empty include",
        evidence: ["fixture:2"],
        include: [],
      },
    };

    expect(verifyStaticSurfaceMapCompleteness(chain, surfaces).invalidMayNarrow).toEqual([
      "check:missing-include",
      "check:empty-include",
    ]);
    expect(
      selectVerifyStaticLinks({
        chain,
        changedFiles: ["docs/only-this.md"],
        repoRoot,
        surfaces,
        dependencies: noFanoutDependencies(),
      }).selected,
    ).toEqual(chain);
  });

  it("keeps the hosted static job on the unconditional full-chain entrypoint", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");

    expect(packageJson().scripts["verify:static:scoped"]).toBe("node ./scripts/verify-static-scoped.mjs");
    expect(workflow).toContain("pnpm run verify:static");
    expect(workflow).not.toContain("pnpm run verify:static:scoped");
    expect(workflow).toContain("FORMAT_CHECK_SCOPE: full");
  });
});

describe("changed-path discovery", () => {
  it("invokes pnpm portably on Windows instead of spawning a .cmd file directly", () => {
    expect(
      resolvePnpmInvocation({
        env: { npm_execpath: "C:/pnpm/pnpm.cjs" },
        platform: "win32",
      }),
    ).toEqual({
      executable: process.execPath,
      argumentPrefix: ["C:/pnpm/pnpm.cjs"],
      shell: false,
    });
    expect(resolvePnpmInvocation({ env: {}, platform: "win32" })).toEqual({
      executable: "pnpm",
      argumentPrefix: [],
      shell: true,
    });
    expect(
      resolvePnpmInvocation({
        env: { npm_execpath: "C:/pnpm/pnpm.exe" },
        platform: "win32",
      }),
    ).toEqual({
      executable: "C:/pnpm/pnpm.exe",
      argumentPrefix: [],
      shell: false,
    });
  });

  it("keeps modified, added, deleted, and both sides of renamed paths", () => {
    expect(
      parseNameStatusZ(
        [
          "M",
          "bounded-contexts/catalog/modified.ts",
          "A",
          "contracts/added.ts",
          "D",
          "packages/deleted.ts",
          "R100",
          "bounded-contexts/catalog/old.ts",
          "nebula/moved.ts",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      "bounded-contexts/catalog/modified.ts",
      "contracts/added.ts",
      "packages/deleted.ts",
      "bounded-contexts/catalog/old.ts",
      "nebula/moved.ts",
    ]);
  });

  it("uses CHANGED_FILES_JSON before Git discovery", () => {
    const calls = [];
    expect(
      deriveStaticChangedFiles({
        env: cleanEnvironment({ CHANGED_FILES_JSON: '["contracts/added.ts"]' }),
        execGit: (args) => calls.push(args),
      }),
    ).toEqual({ source: "CHANGED_FILES_JSON", files: ["contracts/added.ts"] });
    expect(calls).toEqual([]);
  });

  it("uses merge-base name-status discovery with rename detection", () => {
    const calls = [];
    const result = deriveStaticChangedFiles({
      env: cleanEnvironment(),
      execGit: (args) => {
        calls.push(args);
        if (args[0] === "rev-parse") return "true\n";
        if (args[0] === "merge-base") return "base123\n";
        return "R087\0bounded-contexts/catalog/old.ts\0nebula/new.ts\0";
      },
    });

    expect(result).toEqual({
      source: "git merge-base",
      files: ["bounded-contexts/catalog/old.ts", "nebula/new.ts"],
    });
    expect(calls.at(1)).toEqual(["merge-base", "refs/remotes/origin/main", "HEAD"]);
    expect(calls.at(-1)).toEqual([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--diff-filter=ACMRTD",
      "base123...HEAD",
      "--",
    ]);
  });

  it("ignores a stray local origin/main branch and derives from the remote-tracking ref", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "verify-static-remote-main-"));
    temporaryDirectories.push(rootDir);
    execGit(rootDir, ["init"]);
    execGit(rootDir, ["config", "user.email", "fixture@example.invalid"]);
    execGit(rootDir, ["config", "user.name", "Fixture"]);

    writeFixture(rootDir, "docs/base.md", "base\n");
    execGit(rootDir, ["add", "."]);
    execGit(rootDir, ["commit", "-m", "base"]);
    execGit(rootDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const changedPath = "contracts/auth-context/index.ts";
    writeFixture(rootDir, changedPath, "export const changed = true;\n");
    execGit(rootDir, ["add", "."]);
    execGit(rootDir, ["commit", "-m", "change auth context"]);
    execGit(rootDir, ["update-ref", "refs/heads/origin/main", "HEAD"]);

    expect(deriveStaticChangedFiles({ repoRoot: rootDir, env: cleanEnvironment() })).toEqual({
      source: "git merge-base",
      files: [changedPath],
    });
  });
});

describe("soundness corpus", () => {
  const alwaysRun = Object.entries(VERIFY_STATIC_SURFACES)
    .filter(([, entry]) => entry.classification === ALWAYS_RUN)
    .map(([name]) => name);
  const corpus = [
    {
      change: "modified UI source with a raw form",
      paths: ["bounded-contexts/catalog/features/items/ui/editor.tsx"],
      fullFailures: ["check:no-legacy-forms", "check:structure"],
    },
    {
      change: "added contract with a broken export target",
      paths: ["contracts/new-surface/package.json"],
      fullFailures: ["check:package-export-targets", "check:structure"],
    },
    {
      change: "deleted cited file",
      paths: ["infrastructure/retired/cited-file.ts"],
      fullFailures: ["check:docs-path-claims"],
    },
    {
      change: "rename out of a guarded design-system root",
      paths: ["packages/design-system/src/components/old.tsx", "nebula/renamed.tsx"],
      fullFailures: ["check:design-system-hoc-budget", "check:design-system-component-index"],
    },
    {
      change: "#5745 locale key added without fingerprint rebaseline",
      paths: ["contracts/localization/locales/en/discovery.ts"],
      fullFailures: ["check:structure"],
    },
    {
      change: "workflow runtime defect",
      paths: [".github/workflows/platform-pr.yml"],
      fullFailures: [
        "check:github-actions-runtime",
        "check:workflow-canonical-artifacts",
        "check:managed-postgres-authority",
      ],
    },
    {
      change: "no-legacy-forms guard implementation only",
      paths: ["scripts/check-no-legacy-forms.mjs"],
      fullFailures: ["check:no-legacy-forms", "check:structure", "test:scripts"],
    },
    {
      change: "ledger only",
      paths: ["packages/design-system/DESIGN_SYSTEM_HOC_BUDGET.json"],
      fullFailures: ["check:design-system-hoc-budget"],
    },
  ];

  it.each(corpus)("$change: every full-chain failure remains selected", ({ paths, fullFailures }) => {
    const selected = selectedNames(paths);
    expect(selected).toEqual(expect.arrayContaining(fullFailures));
    expect(selected).toEqual(expect.arrayContaining(alwaysRun));
  });

  it("reports the corpus as guard x diff selected/skipped outcomes", () => {
    const rows = corpus.flatMap(({ change, paths, fullFailures }) => {
      const selected = new Set(selectedNames(paths));
      return currentChain().map(({ name: guard }) => ({
        change,
        guard,
        outcome: fullFailures.includes(guard) ? "failed" : selected.has(guard) ? "ran" : "skipped",
      }));
    });

    expect(rows).toContainEqual(expect.objectContaining({ outcome: "ran" }));
    expect(rows).toContainEqual(expect.objectContaining({ outcome: "skipped" }));
    expect(rows).toContainEqual(expect.objectContaining({ outcome: "failed" }));
    for (const { change, fullFailures } of corpus) {
      for (const guard of fullFailures) {
        expect(rows).toContainEqual({ change, guard, outcome: "failed" });
      }
    }
  });

  it("selects unbounded guards plus predicate-based localization for an arbitrary-path semantic probe", () => {
    const selected = selectedNames(["nebula/alias/features/quiet-client.tsx"]);

    expect(selected).toEqual(expect.arrayContaining(alwaysRun));
    expect(selected).toContain("check:localization");
    expect(selected).not.toContain("check:no-legacy-forms");
  });

  it.each(["scripts/check-no-legacy-forms.mjs", "scripts/lib/files.mjs"])(
    "%s forces the complete chain for guard and sibling tooling changes",
    (changedPath) => {
      const chain = currentChain();
      const plan = selectVerifyStaticLinks({
        chain,
        changedFiles: [changedPath],
        repoRoot,
        dependencies: noFanoutDependencies(),
      });

      expect(plan.selected).toEqual(chain);
      expect(plan.fullReason).toContain("scripts/** changed");
    },
  );

  it.each([
    ["operator locale suffix", "contracts/localization/locales/en/catalog.ts", "check:operator-surface-pm"],
    [
      "operator nested catalog locale",
      "contracts/localization/locales/en/catalog/support.ts",
      "check:operator-surface-pm",
    ],
    ["agent connector auth graph", "contracts/auth-context/index.ts", "check:agent-connector-packaging"],
    [
      "developer help copy guard",
      "bounded-contexts/public-presence/features/help/domain/public-copy-guard.mjs",
      "check:developer-articles",
    ],
    ["developer platform graph", "infrastructure/platform-runtime/mcp-contracts.ts", "check:developer-articles"],
    ["developer auth graph", "contracts/auth-context/index.ts", "check:developer-articles"],
    ["design-system primitive graph", "contracts/primitives/money.ts", "check:design-system-export-coverage"],
    ["design-system compiler API", "packages/typescript-compiler-api/index.mjs", "check:design-system-component-index"],
  ])("%s selects %s", (_probe, changedPath, expectedLink) => {
    expect(selectedNames([changedPath])).toContain(expectedLink);
  });

  it("replays the real #5745 discovery locale-key defect through Git discovery at its actual path", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "verify-static-5745-"));
    temporaryDirectories.push(rootDir);
    execGit(rootDir, ["init"]);
    execGit(rootDir, ["config", "user.email", "fixture@example.invalid"]);
    execGit(rootDir, ["config", "user.name", "Fixture"]);

    const localePath = "contracts/localization/locales/en/discovery.ts";
    const baselinePath = "contracts/localization/discovery-key-set.test.ts";
    const initialKeys = ["discovery.search.results.summary"];
    const fingerprint = keySetFingerprint(initialKeys);
    writeFixture(
      rootDir,
      localePath,
      `export const discoveryEnglishTranslations = {\n  "${initialKeys[0]}": "Showing results",\n} as const;\n`,
    );
    writeFixture(
      rootDir,
      baselinePath,
      `import { createHash } from "node:crypto";
import { discoveryEnglishTranslations } from "./locales/en/discovery";
const englishDiscoveryKeySet = {
  count: ${fingerprint.count},
  sha256: "${fingerprint.sha256}",
} as const;
expect(keySetFingerprint(Object.keys(discoveryEnglishTranslations))).toEqual(englishDiscoveryKeySet);
`,
    );
    execGit(rootDir, ["add", "."]);
    execGit(rootDir, ["commit", "-m", "baseline"]);
    execGit(rootDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    writeFixture(
      rootDir,
      localePath,
      `export const discoveryEnglishTranslations = {
  "${initialKeys[0]}": "Showing results",
  "discovery.search.results.total": "{count} results",
} as const;
`,
    );
    execGit(rootDir, ["add", "."]);
    execGit(rootDir, ["commit", "-m", "add locale key without rebaseline"]);

    const derived = deriveStaticChangedFiles({ repoRoot: rootDir, env: cleanEnvironment() });
    const selected = selectedNames(derived.files);
    const violations = findGitKeySetTripwireViolations({ rootDir });

    expect(derived).toEqual({ source: "git merge-base", files: [localePath] });
    expect(selected).toContain("check:structure");
    expect(violations).toEqual([
      expect.objectContaining({
        testPath: baselinePath,
        sourceRoot: localePath,
        message: expect.stringContaining("without a matching committed key-set fingerprint baseline"),
      }),
    ]);
  });
});

describe("derived root-runtime fanout", () => {
  const rootRuntimePaths = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.json",
    "tsconfig.base.json",
    "tailwind.config.ts",
    "playwright.config.ts",
  ];

  it.each(rootRuntimePaths)("%s selects the full chain through classifier fanout", (changedPath) => {
    const chain = currentChain();
    const plan = selectVerifyStaticLinks({
      chain,
      changedFiles: [changedPath],
      repoRoot,
      dependencies: { classifyChanges, listWorkspacePackages },
    });

    expect(plan.selected).toEqual(chain);
    expect(plan.fullReason).toContain("affected every workspace");
  });

  it("contains no copied root-runtime filename list in runner or surface-map source", () => {
    const source =
      readFileSync(path.join(repoRoot, "scripts/verify-static-scoped.mjs"), "utf8") +
      readFileSync(path.join(repoRoot, "scripts/verify-static-surfaces.mjs"), "utf8");
    const copiedNames = rootRuntimePaths.filter((file) => source.includes(`"${file}"`));

    // package.json appears only because the runner reads the authoritative
    // chain from it; the classifier, not a copied filename list, decides fanout.
    expect(copiedNames).toEqual(["package.json"]);
    expect(source).toContain("classifyChanges");
    expect(source).toContain("affectedWorkspaces.length === workspaces.length");
  });
});

describe("fail-closed execution and reporting", () => {
  const fixturePackage = {
    scripts: {
      "verify:static": "pnpm run check:always && pnpm run check:narrow",
    },
  };
  const fixtureSurfaces = {
    "check:always": {
      classification: ALWAYS_RUN,
      rule: "unbounded",
      evidence: ["fixture:1"],
    },
    "check:narrow": {
      classification: MAY_NARROW,
      rule: "only bounded-contexts/**",
      evidence: ["fixture:2"],
      include: [{ kind: "prefix", value: "bounded-contexts" }],
    },
  };

  async function execute({ env = cleanEnvironment(), execGit } = {}) {
    const ran = [];
    const stdout = [];
    const stderr = [];
    const status = await runVerifyStaticScoped({
      repoRoot,
      env,
      execGit,
      readPackageJson: () => fixturePackage,
      surfaces: fixtureSurfaces,
      dependencies: noFanoutDependencies(),
      runLink: (link) => {
        ran.push(link.name);
        return 0;
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { ran, stdout, stderr, status };
  }

  it("warns on malformed JSON and runs the full chain", async () => {
    const result = await execute({ env: cleanEnvironment({ CHANGED_FILES_JSON: "{" }) });
    expect(result.stderr.join("\n")).toContain("[STATIC_SCOPE_CHANGED_FILES_INVALID]");
    expect(result.ran).toEqual(["check:always", "check:narrow"]);
  });

  it("warns on an out-of-repository changed path and runs the full chain", async () => {
    const result = await execute({ env: cleanEnvironment({ CHANGED_FILES_JSON: '["../outside.ts"]' }) });
    expect(result.stderr.join("\n")).toContain("[STATIC_SCOPE_CHANGED_FILES_INVALID]");
    expect(result.ran).toEqual(["check:always", "check:narrow"]);
  });

  it("warns on a missing base ref and runs the full chain", async () => {
    const result = await execute({
      execGit: (args) => {
        if (args[0] === "rev-parse") return "true\n";
        throw new Error("origin/main missing");
      },
    });
    expect(result.stderr.join("\n")).toContain("[STATIC_SCOPE_MERGE_BASE_FAILED]");
    expect(result.ran).toEqual(["check:always", "check:narrow"]);
  });

  it("warns outside Git and runs the full chain", async () => {
    const result = await execute({
      execGit: () => {
        throw new Error("not a repository");
      },
    });
    expect(result.stderr.join("\n")).toContain("[STATIC_SCOPE_NOT_GIT_REPOSITORY]");
    expect(result.ran).toEqual(["check:always", "check:narrow"]);
  });

  it("warns when classifier fanout cannot be evaluated and runs the full chain", async () => {
    const ran = [];
    const stderr = [];
    const status = await runVerifyStaticScoped({
      repoRoot,
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["docs/readme.md"]' }),
      readPackageJson: () => fixturePackage,
      surfaces: fixtureSurfaces,
      dependencies: {
        listWorkspacePackages: () => {
          throw new Error("workspace inventory unavailable");
        },
        classifyChanges: () => {
          throw new Error("should not be reached");
        },
      },
      runLink: (link) => {
        ran.push(link.name);
        return 0;
      },
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });

    expect(status).toBe(0);
    expect(stderr.join("\n")).toContain("[STATIC_SCOPE_CLASSIFICATION_FAILED]");
    expect(ran).toEqual(["check:always", "check:narrow"]);
  });

  it("accepts a genuinely derived empty diff and runs the empty scoped set", async () => {
    const result = await execute({
      execGit: (args) => {
        if (args[0] === "rev-parse") return "true\n";
        if (args[0] === "merge-base") return "base123\n";
        return "";
      },
    });
    expect(result.status).toBe(0);
    expect(result.ran).toEqual([]);
    expect(result.stdout.join("\n")).toContain("scanned=0/2");
  });

  it("names every skipped link and its triggering rule", async () => {
    const result = await execute({
      env: cleanEnvironment({ CHANGED_FILES_JSON: '["docs/readme.md"]' }),
    });

    expect(result.ran).toEqual(["check:always"]);
    expect(result.stdout).toContain("[SKIPPED-BY-SCOPE] check:narrow: only bounded-contexts/**");
    expect(result.stdout.join("\n")).toContain("scanned=1/2; skipped=1");
  });
});
