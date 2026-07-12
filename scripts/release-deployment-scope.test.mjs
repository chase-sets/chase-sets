import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReleaseDeploymentScope } from "./release-deployment-scope.mjs";

const productionCommit = "a".repeat(40);
const deployableCommit = "b".repeat(40);
const docsCommit = "c".repeat(40);

function workspace(baseDir, root, dirName, name, dependencies = {}) {
  return {
    name,
    dir: path.join(baseDir, root, dirName),
    dirName,
    root,
    packageJson: {
      name,
      dependencies,
      scripts: { test: "vitest run" },
    },
  };
}

function execRecorder(responses = {}) {
  const calls = [];
  return {
    calls,
    execFileSync: (_command, args) => {
      calls.push(args);
      const key = args.join(" ");
      const response = responses[key];
      if (response instanceof Error) {
        throw response;
      }
      return response ?? "";
    },
  };
}

function failure() {
  const error = new Error("git command failed");
  error.status = 1;
  return error;
}

function resolveWithGit({ eventName = "push", forceDeploy = false, productionRef, changedFiles }) {
  const baseDir = path.join(process.cwd(), "repo");
  const appended = [];
  const listedDiffs = [];
  const showProductionRef = productionRef === null ? failure() : "";
  const exec = execRecorder({
    "fetch origin production": "",
    "show-ref --verify --quiet refs/remotes/origin/production": showProductionRef,
    "rev-parse origin/production": productionRef ? `${productionRef}\n` : "",
    [`rev-parse ${docsCommit}^`]: `${deployableCommit}\n`,
  });

  const result = resolveReleaseDeploymentScope(
    {
      eventName,
      releaseCommit: docsCommit,
      forceDeploy,
      githubOutputPath: "github-output.txt",
      gitPath: "git",
    },
    {
      cwd: baseDir,
      execFileSync: exec.execFileSync,
      appendFileSync: (outputPath, value) => appended.push({ outputPath, value }),
      listChangedFiles: (base, head) => {
        listedDiffs.push({ base, head });
        return changedFiles;
      },
      log: () => {},
      workspaces: [workspace(baseDir, "deployables", "platform-api", "@test/platform-api")],
    },
  );

  return { result, appended, listedDiffs, gitCalls: exec.calls };
}

describe("release deployment scope", () => {
  it("deploys a latest docs-only push when production has pending deployable commits", () => {
    const { result, appended, listedDiffs } = resolveWithGit({
      productionRef: productionCommit,
      changedFiles: ["deployables/platform-api/src/main.ts", "docs/index.md"],
    });

    expect(result.reason).toBe("scoped");
    expect(result.baseCommit).toBe(productionCommit);
    expect(result.deploy).toBe(true);
    expect(listedDiffs).toEqual([{ base: productionCommit, head: docsCommit }]);
    expect(appended[0].value).toContain("deploy=true");
    expect(appended[0].value).toContain('changed_files_json=["deployables/platform-api/src/main.ts","docs/index.md"]');
  });

  it("accepts a docs-only no-op only after the deployed marker already includes the deployable commit", () => {
    const { result, appended, listedDiffs } = resolveWithGit({
      productionRef: deployableCommit,
      changedFiles: ["docs/index.md"],
    });

    expect(result.reason).toBe("scoped");
    expect(result.baseCommit).toBe(deployableCommit);
    expect(result.deploy).toBe(false);
    expect(listedDiffs).toEqual([{ base: deployableCommit, head: docsCommit }]);
    expect(appended[0].value).toContain("deploy=false");
    expect(appended[0].value).toContain('changed_files_json=["docs/index.md"]');
  });

  it("scopes a queued push even when newer main exists so the pending deploy can apply", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const appended = [];
    const listedDiffs = [];
    const exec = execRecorder({
      "fetch origin production": "",
      "show-ref --verify --quiet refs/remotes/origin/production": failure(),
      [`rev-parse ${deployableCommit}^`]: `${productionCommit}\n`,
    });

    const result = resolveReleaseDeploymentScope(
      {
        eventName: "push",
        releaseCommit: deployableCommit,
        forceDeploy: false,
        githubOutputPath: "github-output.txt",
        gitPath: "git",
      },
      {
        cwd: baseDir,
        execFileSync: exec.execFileSync,
        appendFileSync: (outputPath, value) => appended.push({ outputPath, value }),
        listChangedFiles: (base, head) => {
          listedDiffs.push({ base, head });
          return ["deployables/platform-api/src/main.ts"];
        },
        workspaces: [workspace(baseDir, "deployables", "platform-api", "@test/platform-api")],
        log: () => {},
      },
    );

    expect(result.reason).toBe("scoped");
    expect(result.deploy).toBe(true);
    expect(listedDiffs).toEqual([{ base: productionCommit, head: deployableCommit }]);
    expect(appended[0].value).toContain("deploy=true");
    expect(exec.calls).not.toContainEqual(["fetch", "origin", "main"]);
  });

  it("keeps manual force_deploy as an explicit deployment override", () => {
    const { result, appended, listedDiffs } = resolveWithGit({
      eventName: "workflow_dispatch",
      forceDeploy: true,
      productionRef: deployableCommit,
      changedFiles: ["docs/index.md"],
    });

    expect(result.reason).toBe("manual-force");
    expect(result.deploy).toBe(true);
    expect(listedDiffs).toEqual([]);
    expect(appended[0].value).toContain("deploy=true");
    expect(appended[0].value).toContain("changed_files_json=[]");
  });
});
