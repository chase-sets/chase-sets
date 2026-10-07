import { beforeEach, expect, test, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execute }));
import { parseLaunchArguments, assertReviewedWorktree, REPOSITORY_ROOT } from "./test-window-admission.mjs";
import { resolve } from "node:path";

const head = "a".repeat(40);
const args = [
  "--candidate-head",
  head,
  "--manifest-path",
  resolve("synthetic-manifest.json"),
  "--manifest-sha256",
  "b".repeat(64),
  "--authorize-one-test-window",
];
beforeEach(() => execute.mockReset());
test("only the exact serialized flag sequence and local absolute manifest path admit", () => {
  expect(parseLaunchArguments(args)).toEqual({ candidateHead: head, manifestPath: args[3], manifestDigest: args[5] });
  expect(Object.isFrozen(parseLaunchArguments(args))).toBe(true);
  for (const bad of [
    [],
    [...args, "extra"],
    [...args.slice(0, 6)],
    args.map((v, i) => (i === 1 ? head.toUpperCase() : v)),
    args.map((v, i) => (i === 3 ? "relative.json" : v)),
    args.map((v, i) => (i === 3 ? "//SYNTHETIC_PRIVATE/share" : v)),
  ])
    expect(() => parseLaunchArguments(bad)).toThrow(/^authority-unavailable$/);
});
test("reviewed worktree binds exact HEAD and rejects dirty or mismatching candidates", () => {
  execute.mockReturnValueOnce(head + "\n").mockReturnValueOnce("");
  expect(() => assertReviewedWorktree(head)).not.toThrow();
  expect(execute).toHaveBeenNthCalledWith(
    1,
    "git",
    ["rev-parse", "HEAD"],
    expect.objectContaining({ cwd: REPOSITORY_ROOT }),
  );
  expect(execute).toHaveBeenNthCalledWith(
    2,
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    expect.objectContaining({ cwd: REPOSITORY_ROOT }),
  );
  execute.mockReturnValueOnce("c".repeat(40));
  expect(() => assertReviewedWorktree(head)).toThrow(/^authority-unavailable$/);
  execute.mockReturnValueOnce(head).mockReturnValueOnce("?? SYNTHETIC_PRIVATE");
  expect(() => assertReviewedWorktree(head)).toThrow(/^authority-unavailable$/);
});
