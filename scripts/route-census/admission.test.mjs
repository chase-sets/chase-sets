import { describe, expect, it } from "vitest";
import { runParity } from "./runner.mts";
import { makeArtifact, repoRoot } from "./test-support.mjs";

function dependencies(capture, events, acquire = true) {
  return {
    preflight: async (options) => {
      events.push("preflight");
      return {
        baseRoot: repoRoot,
        candidateRoot: `${repoRoot}-candidate`,
        harnessRoot: repoRoot,
        outputPath: options.outputPath,
      };
    },
    acquire: () => {
      events.push("acquire");
      return acquire;
    },
    evaluate: async (_root, _head) => {
      events.push(events.includes("base") ? "candidate" : "base");
      return capture;
    },
    reread: async () => {
      events.push("reread");
    },
    harness: async () => {
      events.push("harness");
      return {
        root: repoRoot,
        head: "0".repeat(40),
        runFile: {
          relativePath: "scripts/route-census/run.mts",
          realpath: `${repoRoot}/scripts/route-census/run.mts`,
          sha256: "0".repeat(64),
        },
      };
    },
    validate: async () => {
      events.push("validate");
    },
    publish: async () => {
      events.push("publish");
    },
  };
}

const options = {
  baseRoot: "base",
  baseHead: "0".repeat(40),
  candidateRoot: "candidate",
  candidateHead: "0".repeat(40),
  harnessHead: "0".repeat(40),
  expectedState: "empty",
  outputPath: "artifact.json",
};

describe("process-lifetime admission", () => {
  it("preflights before one acquire and owns base, candidate, validation, and publication", async () => {
    const { artifact } = await makeArtifact();
    const events = [];
    await runParity(options, dependencies(artifact.base, events));
    expect(events).toEqual(["preflight", "acquire", "base", "candidate", "reread", "harness", "validate", "publish"]);
    expect(events.filter((event) => event === "acquire")).toHaveLength(1);
  });

  it("refuses false client availability before children and output", async () => {
    const { artifact } = await makeArtifact();
    const events = [];
    await expect(runParity(options, dependencies(artifact.base, events, false))).rejects.toMatchObject({
      code: "E_SLOT_CLIENT_UNAVAILABLE",
    });
    expect(events).toEqual(["preflight", "acquire"]);
  });

  it("does not acquire when preflight fails", async () => {
    const { artifact } = await makeArtifact();
    const events = [];
    const deps = dependencies(artifact.base, events);
    deps.preflight = async () => {
      events.push("preflight");
      throw Object.assign(new Error("dirty"), { code: "E_WORKTREE_DIRTY" });
    };
    await expect(runParity(options, deps)).rejects.toMatchObject({ code: "E_WORKTREE_DIRTY" });
    expect(events).toEqual(["preflight"]);
  });

  it.each(["base child", "candidate child", "recursive validation"])(
    "publishes nothing when %s fails",
    async (stage) => {
      const { artifact } = await makeArtifact();
      const events = [];
      const deps = dependencies(artifact.base, events);
      if (stage === "base child")
        deps.evaluate = async () => {
          events.push("base");
          throw new Error("base");
        };
      if (stage === "candidate child") {
        let calls = 0;
        deps.evaluate = async () => {
          calls += 1;
          events.push(calls === 1 ? "base" : "candidate");
          if (calls === 2) throw new Error("candidate");
          return artifact.base;
        };
      }
      if (stage === "recursive validation")
        deps.validate = async () => {
          events.push("validate");
          throw new Error("invalid");
        };
      await expect(runParity(options, deps)).rejects.toThrow();
      expect(events).not.toContain("publish");
    },
  );

  it("returns expectation mismatch after recursive validation and before publication", async () => {
    const { artifact } = await makeArtifact({}, { routes: ["/items/:id"] }, "nonempty");
    const events = [];
    const deps = dependencies(artifact.base, events);
    let calls = 0;
    deps.evaluate = async () => {
      calls += 1;
      events.push(calls === 1 ? "base" : "candidate");
      return calls === 1 ? artifact.base : artifact.candidate;
    };
    await expect(runParity({ ...options, expectedState: "empty" }, deps)).rejects.toMatchObject({
      code: "E_EXPECTATION_MISMATCH",
    });
    expect(events).toContain("validate");
    expect(events).not.toContain("publish");
  });

  it("has no release, retry, wait, or descendant acquisition seam", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./runner.mts", import.meta.url), "utf8"),
    );
    expect(source.match(/acquireHeavySlot\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/releaseHeavy|retryHeavy|steal|setTimeout/);
    expect(source).toContain('acquireHeavySlot("script-battery"');
  });
});
