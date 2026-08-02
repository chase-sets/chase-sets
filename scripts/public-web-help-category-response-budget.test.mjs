import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findHeavySlotClient as findRealHeavySlotClient } from "./lib/heavy-slot.mjs";
import { repoRoot } from "./lib/repo.mjs";
import {
  EXPECTED_SALVAGE_HEAD,
  HelpCategoryResponseBudgetError,
  parseHelpCategoryResponseBudgetArgs,
  runHelpCategoryResponseBudget,
} from "./public-web-help-category-response-budget.mjs";

const ownerToken = "0123456789abcdef0123456789abcdef";
const candidateCommit = "a".repeat(40);
const candidateParent = "b".repeat(40);
const routePath = "bounded-contexts/public-presence/routes/marketplace/help-category.tsx";
const cardPath = "bounded-contexts/public-presence/features/help/ui/help-pages.tsx";
const syntheticContainerRoot = path.join(path.parse(repoRoot).root, "synthetic-heavy-slot-container");
const syntheticClient = path.join(syntheticContainerRoot, ".orchestrator", "heavy-slot.cjs");
const resolvedOuterClient = findRealHeavySlotClient(path.join(repoRoot, "scripts", "lib"));
const containerRoot = resolvedOuterClient ? path.dirname(path.dirname(resolvedOuterClient)) : null;

if (!resolvedOuterClient) {
  console.warn(
    "[public-web-help-category-response-budget] skipping real positional resolver controls: repository has no shared heavy-slot client ancestor",
  );
}

const candidateSmokeOutput = [
  `[public-route-smoke] Derived 43 members at ${EXPECTED_SALVAGE_HEAD}: 41 fetchable, 2 indeterminate, 5 strict healthy targets.`,
  "[public-route-smoke] help-category:selling /help/selling -> 200 (3120 bytes)",
  "[public-route-smoke] Passed 41 fetchable members in no-5xx mode within 450ms.",
].join("\n");

const mutantSmokeOutput = [
  `[public-route-smoke] Derived 43 members at ${EXPECTED_SALVAGE_HEAD}: 41 fetchable, 2 indeterminate, 5 strict healthy targets.`,
  "Public route smoke failed (no-5xx):",
  "- [response-too-large] help-category:selling (/help/selling) exceeded 122727 bytes.",
].join("\n");

function createHarness({
  worktreePath = path.join(syntheticContainerRoot, "review-6441-hermetic"),
  failAt,
  findHeavySlotClient = () => syntheticClient,
} = {}) {
  const spawned = [];
  const fetched = [];
  const removed = [];
  const terminated = [];
  const writes = new Map();
  const started = [];
  const runProcess = vi.fn(async (spec) => {
    spawned.push(spec);
    if (spec.id === failAt) throw new Error(`injected failure at ${spec.id}`);
    const results = {
      "resolve-candidate-commit": { code: 0, stdout: `${candidateCommit}\n`, stderr: "" },
      "resolve-candidate-parent": { code: 0, stdout: `${candidateParent}\n`, stderr: "" },
      "source-patch-inventory": { code: 0, stdout: `${routePath}\n${cardPath}\n`, stderr: "" },
      "create-candidate-patch": {
        code: 0,
        stdout: `diff --git a/${routePath} b/${routePath}\ndiff --git a/${cardPath} b/${cardPath}\n`,
        stderr: "",
      },
      "create-mutant-patch": {
        code: 0,
        stdout: `diff --git a/${routePath} b/${routePath}\n`,
        stderr: "",
      },
      "candidate-working-inventory": { code: 0, stdout: `${routePath}\n${cardPath}\n`, stderr: "" },
      "mutant-working-inventory": { code: 0, stdout: `${cardPath}\n`, stderr: "" },
      "smoke-candidate": { code: 0, stdout: candidateSmokeOutput, stderr: "" },
      "smoke-mutant": { code: 1, stdout: "", stderr: mutantSmokeOutput },
    };
    return results[spec.id] ?? { code: 0, stdout: "", stderr: "" };
  });
  const startProcess = vi.fn((spec) => {
    spawned.push(spec);
    const handle = { id: spec.id, exited: false };
    started.push(handle);
    return handle;
  });
  const dependencies = {
    acquireHeavySlot: vi.fn(() => true),
    findHeavySlotClient,
    readFile: vi.fn(async (filePath) =>
      filePath.endsWith("owner.json")
        ? JSON.stringify({ lockId: ownerToken, pid: 4242, processStartUtc: "2026-08-02T12:00:00.0000000Z" })
        : "/review-*\n",
    ),
    pathExists: vi.fn(async () => false),
    writeFile: vi.fn(async (filePath, content) => {
      writes.set(filePath, content);
    }),
    removePath: vi.fn(async (filePath) => {
      removed.push(filePath);
    }),
    runProcess,
    startProcess,
    terminateProcess: vi.fn(async (handle) => {
      handle.exited = true;
      terminated.push(handle.id);
      return true;
    }),
    buildPackageManagerInvocation: vi.fn((args) => ({ command: "pnpm", args })),
    fetch: vi.fn(async (url) => {
      fetched.push(url);
      return { status: 200 };
    }),
    createWorktreePath: vi.fn(() => worktreePath),
    randomId: vi.fn(() => "hermetic"),
    temporaryDirectory: vi.fn(() => tmpdir()),
    now: vi.fn(() => "2026-08-02T12:34:56.000Z"),
  };
  return { dependencies, spawned, fetched, removed, terminated, writes, started, worktreePath };
}

function runWithHarness(harness, options = {}) {
  return runHelpCategoryResponseBudget(
    {
      salvageHead: EXPECTED_SALVAGE_HEAD,
      port: 18081,
      implementationRoot: repoRoot,
      environment: { PATH: process.env.PATH, CHASE_SETS_HEAVY_SLOT_ID: ownerToken },
      ...options,
    },
    harness.dependencies,
  );
}

describe("public-web help category response-budget driver", () => {
  it("keeps admission first and singular, inherits one owner, and plans the exact candidate/mutant commands hermetically", async () => {
    const harness = createHarness();
    const receipt = await runWithHarness(harness);

    expect(receipt.effectLog[0]).toBe("admission:build");
    expect(receipt.effectLog.filter((effect) => effect === "admission:build")).toHaveLength(1);
    expect(harness.dependencies.acquireHeavySlot).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.acquireHeavySlot).toHaveBeenCalledWith("build", {
      startDirectory: path.join(repoRoot, "scripts", "lib"),
    });

    expect(
      harness.spawned.map((spec) => spec.id).filter((id) => /^(?:install|apply|build|start|smoke)-/u.test(id)),
    ).toEqual([
      "install-dependencies",
      "apply-candidate-patch",
      "build-candidate",
      "start-candidate",
      "smoke-candidate",
      "apply-full-body-mutant",
      "build-mutant",
      "start-mutant",
      "smoke-mutant",
    ]);
    expect(harness.spawned.find((spec) => spec.id === "smoke-candidate").display).toBe(
      "pnpm run smoke:public-web-routes -- --base-url http://localhost:18081 --mode no-5xx",
    );
    expect(harness.spawned.find((spec) => spec.id === "smoke-mutant").display).toBe(
      "pnpm run smoke:public-web-routes -- --base-url http://localhost:18081 --mode no-5xx",
    );
    for (const spec of harness.spawned) {
      expect(spec.env.CHASE_SETS_HEAVY_SLOT_ID, spec.id).toBe(ownerToken);
    }
    expect(harness.fetched).toEqual(["http://localhost:18081", "http://localhost:18081"]);
    expect(harness.terminated).toEqual(["start-candidate", "start-mutant"]);
    expect(harness.removed).toContain(harness.worktreePath);
    expect(receipt.cleanup).toMatchObject({
      serversTerminated: ["start-candidate", "start-mutant"],
      worktreeRemoved: true,
      patchFilesRemoved: 2,
      errors: [],
    });

    const transcript = [...harness.writes.entries()].find(([filePath]) => filePath.endsWith(".log"))?.[1];
    expect(transcript).toBeDefined();
    expect(transcript).not.toContain(ownerToken);
    expect(transcript).toContain(
      `owner=sha256:${createHash("sha256").update(ownerToken).digest("hex").slice(0, 8)} pid=4242`,
    );
    expect(transcript).toContain("[candidate]");
    expect(transcript).toContain("[mutant]");
    expect(transcript).toContain("failureReason=[response-too-large] help-category:selling");
  });

  it("refusal-no-effect clears ambient token authority and reports the named admission diagnostic", async () => {
    const harness = createHarness();
    harness.dependencies.acquireHeavySlot.mockReturnValue(false);
    const findClient = vi.fn(() => syntheticClient);
    harness.dependencies.findHeavySlotClient = findClient;

    const promise = runWithHarness(harness, {
      environment: { PATH: process.env.PATH },
    });
    await expect(promise).rejects.toMatchObject({
      code: "HEAVY_ADMISSION_REFUSED",
      effectLog: ["admission:build"],
    });
    expect(harness.dependencies.acquireHeavySlot).toHaveBeenCalledTimes(1);
    expect(findClient).not.toHaveBeenCalled();
    expect(harness.dependencies.runProcess).not.toHaveBeenCalled();
    expect(harness.dependencies.startProcess).not.toHaveBeenCalled();
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
    expect(harness.dependencies.writeFile).not.toHaveBeenCalled();
    expect(harness.dependencies.removePath).not.toHaveBeenCalled();
  });

  it("rejects an injected null disposable resolver with zero install, build, and start effects", async () => {
    const findClient = vi.fn((startDirectory) =>
      startDirectory === path.join(repoRoot, "scripts", "lib") ? syntheticClient : null,
    );
    const harness = createHarness({ findHeavySlotClient: findClient });

    let failure;
    try {
      await runWithHarness(harness);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HelpCategoryResponseBudgetError);
    expect(failure.code).toBe("HEAVY_CLIENT_RESOLUTION_MISMATCH");
    expect(failure.effectLog).toContain("placement-check:null");
    expect(failure.effectLog).toContain("diagnostic:heavy-client-resolution-mismatch");
    expect(findClient).toHaveBeenCalledWith(path.join(repoRoot, "scripts", "lib"));
    expect(findClient).toHaveBeenCalledWith(path.join(harness.worktreePath, "scripts", "lib"));
    expect(harness.spawned.map((spec) => spec.id)).not.toContain("install-dependencies");
    expect(harness.spawned.map((spec) => spec.id)).not.toContain("build-candidate");
    expect(harness.spawned.map((spec) => spec.id)).not.toContain("start-candidate");
    expect(failure.effectLog).not.toContain("spawn:install-dependencies");
    expect(failure.effectLog).not.toContain("spawn:build-candidate");
    expect(failure.effectLog).not.toContain("spawn:start-candidate");
    expect(harness.removed).toContain(harness.worktreePath);
  });

  describe.runIf(resolvedOuterClient !== null)("real positional resolver controls", () => {
    it("temp-placement-resolves-no-client and refuses install, build, and start through the named diagnostic", async () => {
      const tempWorktree = path.join(tmpdir(), "review-6441-hermetic");
      expect(findRealHeavySlotClient(path.join(tempWorktree, "scripts", "lib"))).toBeNull();
      const harness = createHarness({
        worktreePath: tempWorktree,
        findHeavySlotClient: findRealHeavySlotClient,
      });

      let failure;
      try {
        await runWithHarness(harness);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(HelpCategoryResponseBudgetError);
      expect(failure.code).toBe("HEAVY_CLIENT_RESOLUTION_MISMATCH");
      expect(failure.effectLog).toContain("placement-check:null");
      expect(failure.effectLog).toContain("diagnostic:heavy-client-resolution-mismatch");
      expect(harness.spawned.map((spec) => spec.id)).not.toContain("install-dependencies");
      expect(harness.spawned.map((spec) => spec.id)).not.toContain("build-candidate");
      expect(harness.spawned.map((spec) => spec.id)).not.toContain("start-candidate");
      expect(harness.removed).toContain(tempWorktree);
    });

    it("in-container-placement-resolves-outer-client before install and preserves the outer token", async () => {
      const inContainerWorktree = path.join(containerRoot, "review-6441-hermetic-positive");
      expect(findRealHeavySlotClient(path.join(inContainerWorktree, "scripts", "lib"))).toBe(resolvedOuterClient);
      const harness = createHarness({
        worktreePath: inContainerWorktree,
        findHeavySlotClient: findRealHeavySlotClient,
      });
      const receipt = await runWithHarness(harness);

      const placementIndex = receipt.effectLog.findIndex((effect) => effect.startsWith("placement-check:"));
      const installIndex = receipt.effectLog.indexOf("spawn:install-dependencies");
      expect(placementIndex).toBeGreaterThan(0);
      expect(installIndex).toBeGreaterThan(placementIndex);
      expect(receipt.resolvedClient).toBe(resolvedOuterClient);
      expect(harness.spawned.every((spec) => spec.env.CHASE_SETS_HEAVY_SLOT_ID === ownerToken)).toBe(true);
    });
  });

  it("fails closed by terminating every started process and removing every created path after a mid-run failure", async () => {
    const harness = createHarness({ failAt: "smoke-candidate" });

    await expect(runWithHarness(harness)).rejects.toThrow("injected failure at smoke-candidate");
    expect(harness.terminated).toEqual(["start-candidate"]);
    expect(harness.removed).toContain(harness.worktreePath);
    expect(harness.removed.filter((filePath) => filePath.endsWith(".patch"))).toHaveLength(2);
    expect([...harness.writes.keys()].some((filePath) => filePath.endsWith(".log"))).toBe(true);
  });

  it("accepts only the immutable salvage head and the closed CLI surface", () => {
    expect(parseHelpCategoryResponseBudgetArgs(["--salvage-head", EXPECTED_SALVAGE_HEAD, "--port", "18081"])).toEqual({
      salvageHead: EXPECTED_SALVAGE_HEAD,
      port: 18081,
    });
    expect(() => parseHelpCategoryResponseBudgetArgs(["--salvage-head", "c".repeat(40), "--port", "18081"])).toThrow(
      "SALVAGE_HEAD_INVALID",
    );
    expect(() =>
      parseHelpCategoryResponseBudgetArgs([
        "--salvage-head",
        EXPECTED_SALVAGE_HEAD,
        "--port",
        "18081",
        "--max-response-bytes",
        "999999",
      ]),
    ).toThrow("ARGUMENT_INVALID");
  });
});
