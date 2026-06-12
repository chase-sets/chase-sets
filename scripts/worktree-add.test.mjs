import { describe, expect, it } from "vitest";
import { validateBranchName, validateWorktreeName } from "./worktree-add.mjs";

describe("worktree-add validation", () => {
  it("accepts plain kebab-case names", () => {
    expect(validateWorktreeName("velocity-recovery-2")).toBe("velocity-recovery-2");
    expect(validateWorktreeName("20260612-feature")).toBe("20260612-feature");
  });

  it("rejects the path-mangling shapes that produced the ;C husks", () => {
    expect(() => validateWorktreeName("freshness-canary-gates;C")).toThrow(/invalid/);
    expect(() => validateWorktreeName("name;C:\\Users\\x")).toThrow(/invalid/);
    expect(() => validateWorktreeName("../escape")).toThrow(/invalid/);
    expect(() => validateWorktreeName("name with spaces")).toThrow(/invalid/);
    expect(() => validateWorktreeName("")).toThrow(/invalid/);
  });

  it("accepts conventional branch names and rejects traversal", () => {
    expect(validateBranchName("codex/my-feature")).toBe("codex/my-feature");
    expect(validateBranchName("velocity2/catalog-seed")).toBe("velocity2/catalog-seed");
    expect(() => validateBranchName("bad..ref")).toThrow(/invalid/);
    expect(() => validateBranchName("trailing/")).toThrow(/invalid/);
    expect(() => validateBranchName("has space")).toThrow(/invalid/);
  });
});
