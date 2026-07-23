import { describe, expect, it } from "vitest";
import { ADVISORY_THRESHOLD, LARGE_THRESHOLD, classifyPrScope } from "./pr-scope-policy-v1.mjs";

function file(overrides = {}) {
  return {
    filename: "bounded-contexts/catalog/features/search/domain/search.ts",
    status: "modified",
    previousFilename: null,
    additions: 10,
    deletions: 5,
    patch: null,
    ...overrides,
  };
}

function filesOfSize(count, additionsPerFile) {
  return Array.from({ length: count }, (_, index) => ({
    filename: `bounded-contexts/catalog/features/search/domain/file-${index}.ts`,
    status: "modified",
    additions: additionsPerFile,
    deletions: 0,
    patch: null,
  }));
}

describe("pr-scope-policy/v1", () => {
  it("normalizes lockfile-only churn out of scope with a deterministic reason", () => {
    const scope = classifyPrScope({
      changedFiles: [file(), file({ filename: "pnpm-lock.yaml", additions: 4000, deletions: 3000 })],
    });
    expect(scope.raw.lines).toBe(4000 + 3000 + 15);
    expect(scope.normalized.lines).toBe(15);
    expect(scope.excluded.totals["lockfile-mechanical-churn"]).toEqual({ files: 1, additions: 4000, deletions: 3000 });
  });

  it("normalizes generated registry metadata with a deterministic source", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file(),
        file({
          filename: "deployables/platform-api/src/generated/context-registry.ts",
          additions: 500,
          deletions: 500,
        }),
      ],
    });
    expect(scope.normalized.lines).toBe(15);
    expect(scope.excluded.totals["generated-registry-metadata"]).toEqual({ files: 1, additions: 500, deletions: 500 });
  });

  it("normalizes snapshots as machine-generated API artifacts", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file(),
        file({ filename: "bounded-contexts/catalog/__snapshots__/search.test.ts.snap", additions: 200, deletions: 0 }),
      ],
    });
    expect(scope.excluded.totals["generated-snapshot"]).toEqual({ files: 1, additions: 200, deletions: 0 });
  });

  it("normalizes vendored/binary files GitHub cannot count lines for", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file(),
        file({ filename: "packages/design-system/src/assets/logo.png", additions: 0, deletions: 0, patch: null }),
      ],
    });
    expect(scope.excluded.totals["vendored-or-binary"]).toEqual({ files: 1, additions: 0, deletions: 0 });
  });

  it("never hides an oversized text diff whose patch GitHub omitted for size (not binary)", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file({
          filename: "bounded-contexts/catalog/features/search/domain/huge.ts",
          additions: 5000,
          deletions: 100,
          patch: null,
        }),
      ],
    });
    expect(scope.excluded.entries).toEqual([]);
    expect(scope.normalized.lines).toBe(5100);
  });

  it("normalizes formatting-only changes proven by GitHub diff metadata", () => {
    const patch = "@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 1;\n- const y = 2;\n+  const y = 2;";
    const scope = classifyPrScope({
      changedFiles: [
        file(),
        file({
          filename: "bounded-contexts/catalog/features/search/domain/format.ts",
          additions: 2,
          deletions: 2,
          patch,
        }),
      ],
    });
    expect(scope.excluded.totals["formatting-only"]).toEqual({ files: 1, additions: 2, deletions: 2 });
  });

  it("does not classify formatting-only when the patch is truncated (counted lines undercount reported totals)", () => {
    const truncatedPatch = "@@ -1,5 +1,5 @@\n-const x = 1;\n+const x = 1;";
    const scope = classifyPrScope({
      changedFiles: [
        file({
          filename: "bounded-contexts/catalog/features/search/domain/big.ts",
          additions: 40,
          deletions: 40,
          patch: truncatedPatch,
        }),
      ],
    });
    expect(scope.excluded.entries).toEqual([]);
    expect(scope.normalized.lines).toBe(80);
  });

  it("always counts migrations even though they sit beside normally-excluded shapes", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file({ filename: "bounded-contexts/catalog/migrations/020-add-index.sql", additions: 300, deletions: 0 }),
      ],
    });
    expect(scope.excluded.entries).toEqual([]);
    expect(scope.normalized.lines).toBe(300);
  });

  it("always counts workflow files", () => {
    const scope = classifyPrScope({
      changedFiles: [file({ filename: ".github/workflows/platform-pr.yml", additions: 120, deletions: 30 })],
    });
    expect(scope.excluded.entries).toEqual([]);
    expect(scope.normalized.lines).toBe(150);
  });

  it("always counts test sources", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file({
          filename: "bounded-contexts/catalog/features/search/domain/search.test.ts",
          additions: 90,
          deletions: 10,
        }),
      ],
    });
    expect(scope.excluded.entries).toEqual([]);
    expect(scope.normalized.lines).toBe(100);
  });

  it("always counts handwritten generator sources, not just their generated output", () => {
    const scope = classifyPrScope({
      changedFiles: [file({ filename: "scripts/generate-context-registry.mjs", additions: 80, deletions: 20 })],
    });
    expect(scope.excluded.entries).toEqual([]);
    expect(scope.normalized.lines).toBe(100);
  });

  it("reports bounded contexts and composition roots from mixed-context changes", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file({ filename: "bounded-contexts/catalog/features/search/domain/search.ts" }),
        file({ filename: "bounded-contexts/pricing/features/estimates/domain/estimate.ts" }),
        file({ filename: "deployables/marketplace/app/routes.tsx", additions: 5, deletions: 1 }),
      ],
    });
    expect(scope.boundedContexts).toEqual(["catalog", "pricing"]);
    expect(scope.compositionRoots).toEqual(["deployables/marketplace"]);
    expect(scope.splitSuggestion).toEqual({
      reason: "Multiple bounded contexts changed in one PR",
      boundaries: ["catalog", "pricing"],
    });
  });

  it("does not suggest a split for a single bounded context even when large", () => {
    const scope = classifyPrScope({ changedFiles: filesOfSize(40, 100) });
    expect(scope.status).toBe("large");
    expect(scope.splitSuggestion).toBeNull();
  });

  it("classifies renames by old and new path for bounded-context detection", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file({
          filename: "bounded-contexts/catalog/features/search/domain/renamed.ts",
          previousFilename: "bounded-contexts/pricing/features/search/domain/renamed.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
          patch: null,
        }),
      ],
    });
    expect(scope.boundedContexts).toEqual(["catalog", "pricing"]);
    expect(scope.excluded.entries).toEqual([]);
  });

  it("counts deletions toward normalized scope", () => {
    const scope = classifyPrScope({
      changedFiles: [
        file({
          filename: "bounded-contexts/catalog/features/search/domain/old.ts",
          status: "removed",
          additions: 0,
          deletions: 400,
          patch: "@@ -1,400 +0,0 @@\n" + "-line\n".repeat(400),
        }),
      ],
    });
    expect(scope.normalized.lines).toBe(400);
    expect(scope.status).toBe("normal");
  });

  describe("threshold boundaries", () => {
    it("stays normal exactly at the advisory line boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(1, ADVISORY_THRESHOLD.lines) });
      expect(scope.normalized.lines).toBe(ADVISORY_THRESHOLD.lines);
      expect(scope.status).toBe("normal");
    });

    it("goes advisory one line past the advisory line boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(1, ADVISORY_THRESHOLD.lines + 1) });
      expect(scope.status).toBe("advisory");
    });

    it("stays normal exactly at the advisory file-count boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(ADVISORY_THRESHOLD.files, 1) });
      expect(scope.status).toBe("normal");
    });

    it("goes advisory one file past the advisory file-count boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(ADVISORY_THRESHOLD.files + 1, 1) });
      expect(scope.status).toBe("advisory");
    });

    it("stays advisory exactly at the large line boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(1, LARGE_THRESHOLD.lines) });
      expect(scope.status).toBe("advisory");
    });

    it("goes large one line past the large line boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(1, LARGE_THRESHOLD.lines + 1) });
      expect(scope.status).toBe("large");
    });

    it("stays advisory exactly at the large file-count boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(LARGE_THRESHOLD.files, 1) });
      expect(scope.status).toBe("advisory");
    });

    it("goes large one file past the large file-count boundary", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(LARGE_THRESHOLD.files + 1, 1) });
      expect(scope.status).toBe("large");
    });

    it("is large on a mixed criterion: file count breaches large while lines stay under advisory", () => {
      const scope = classifyPrScope({ changedFiles: filesOfSize(LARGE_THRESHOLD.files + 1, 1) });
      expect(scope.normalized.lines).toBeLessThan(ADVISORY_THRESHOLD.lines);
      expect(scope.status).toBe("large");
    });
  });

  it("reuses the canonical risk-policy categories rather than a divergent list", () => {
    const scope = classifyPrScope({
      changedFiles: [file({ filename: "bounded-contexts/payments/features/refunds/domain/refund.ts" })],
    });
    expect(scope.risk.categories).toContain("money-movement");
  });

  it("rejects a non-array changedFiles input", () => {
    expect(() => classifyPrScope({ changedFiles: null })).toThrow(TypeError);
  });
});
