import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDbDurationBaseline, driftBound, validateDbDurationBaseline } from "./db-duration-baseline.mjs";

const empty = () => ({ schemaVersion: "db-duration-baseline/v1", recomputes: [] });
const entry = (overrides = {}) => ({
  recomputedAt: "2026-10-05T00:00:00Z",
  sampleJobIds: Array.from({ length: 20 }, (_, index) => index + 1),
  workspaces: { "@chase-sets/synthetic-db": 240_000 },
  jobWallMs: 240_000,
  cause: "initial (#6660 split)",
  ...overrides,
});
const record = (...entries) => ({ ...empty(), recomputes: entries });

describe("DB duration baseline guard", () => {
  it("accepts empty bootstrap but never supplies a ratified entry", () => {
    const bootstrap = JSON.parse(readFileSync(new URL("../db-duration-baseline-v1.json", import.meta.url), "utf8"));
    expect(validateDbDurationBaseline(bootstrap)).toBe(bootstrap);
    expect(validateDbDurationBaseline(empty()).recomputes.at(-1)).toBeUndefined();
  });

  it.each([
    [239999, 299999],
    [240000, 300000],
    [240001, 300002],
  ])("bound crossover %s -> %s", (value, bound) => {
    expect(driftBound(value)).toBe(bound);
  });

  it.each([
    [
      "root unknown key",
      (r) => {
        r.extra = true;
      },
    ],
    [
      "nested unknown key",
      (r) => {
        r.recomputes[0].extra = true;
      },
    ],
    [
      "workspace unknown key",
      (r) => {
        r.recomputes[0].workspaces.extra = 1;
      },
    ],
    [
      "malformed instant",
      (r) => {
        r.recomputes[0].recomputedAt = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "missing timezone",
      (r) => {
        r.recomputes[0].recomputedAt = "2026-10-05T00:00:00";
      },
    ],
    [
      "non-integer duration",
      (r) => {
        r.recomputes[0].jobWallMs = 1.5;
      },
    ],
    [
      "nonpositive duration",
      (r) => {
        r.recomputes[0].workspaces["@chase-sets/synthetic-db"] = 0;
      },
    ],
    [
      "unbounded duration",
      (r) => {
        r.recomputes[0].jobWallMs = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      "duplicate IDs",
      (r) => {
        r.recomputes[0].sampleJobIds[0] = 2;
      },
    ],
    [
      "short IDs",
      (r) => {
        r.recomputes[0].sampleJobIds.pop();
      },
    ],
    [
      "invalid ID",
      (r) => {
        r.recomputes[0].sampleJobIds[0] = -1;
      },
    ],
    [
      "unnamed cause",
      (r) => {
        r.recomputes[0].cause = "slower";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = record(entry());
    mutate(value);
    expect(() => validateDbDurationBaseline(value)).toThrow();
  });

  it("rejects uncaused workspace and wall step-ups; accepts equal, lower, caused and new-key histories", () => {
    for (const field of ["workspace", "wall"]) {
      const next = entry({ recomputedAt: "2026-10-06T00:00:00+00:00", cause: null });
      if (field === "workspace") next.workspaces["@chase-sets/synthetic-db"] = 300001;
      else next.jobWallMs = 300001;
      expect(() => validateDbDurationBaseline(record(entry(), next))).toThrow("Uncaused step-up");
      next.cause = "Changed load (#123)";
      expect(validateDbDurationBaseline(record(entry(), next)).recomputes).toHaveLength(2);
    }
    for (const ms of [1, 240000, 300000]) {
      expect(
        validateDbDurationBaseline(
          record(
            entry(),
            entry({
              recomputedAt: "2026-10-06T00:00:00Z",
              workspaces: { "@chase-sets/synthetic-db": ms, "@chase-sets/new-db": 800000 },
              jobWallMs: ms,
              cause: null,
            }),
          ),
        ).recomputes,
      ).toHaveLength(2);
    }
  });

  it("rejects erased or rewritten history including populated-to-empty", () => {
    const previous = record(entry());
    expect(() => validateDbDurationBaseline(empty(), previous)).toThrow("append-only");
    expect(() => validateDbDurationBaseline(record(entry({ jobWallMs: 1 })), previous)).toThrow("append-only");
    expect(validateDbDurationBaseline(previous, previous)).toEqual(previous);
  });

  it("is registered in check:structure and checks the origin/main prefix", () => {
    const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(source).toContain("checkDbDurationBaseline({ repoRoot })");
    const git = (_command, args) =>
      args[0] === "ls-tree" ? "scripts/db-duration-baseline-v1.json" : JSON.stringify(record(entry()));
    expect(checkDbDurationBaseline({ repoRoot: ".", read: () => JSON.stringify(empty()), git })[0].message).toContain(
      "append-only",
    );
    expect(checkDbDurationBaseline({ repoRoot: ".", read: () => JSON.stringify(record(entry())), git })).toEqual([]);
  });
});
