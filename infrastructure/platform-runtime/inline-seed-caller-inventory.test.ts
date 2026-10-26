import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

const callerPaths = [
  "infrastructure/platform-runtime/api.ts",
  "deployables/platform-api/src/bootstrap.ts",
  "deployables/platform-api/src/representative-commerce-state.ts",
  "deployables/platform-api/src/admin-qa-actor-fixtures.ts",
  "infrastructure/platform-runtime/index.test.ts",
  "infrastructure/platform-runtime/representative-seed-convergence.test.ts",
  "infrastructure/bounded-context-runtime/projection-operations.db.test.ts",
  "deployables/platform-api/__tests__/authoritative-seed-resume-test-support.ts",
  "deployables/platform-api/__tests__/authoritative-seed-resume-core.db.test.ts",
  "deployables/platform-api/__tests__/bootstrap-shared-seed-command.db.test.ts",
  "deployables/platform-api/__tests__/bootstrap-scenario.db.test.ts",
  "deployables/platform-api/__tests__/bootstrap-lock-contention.db.test.ts",
  "deployables/platform-api/__tests__/bootstrap-production-reconciliation.db.test.ts",
  "deployables/platform-api/__tests__/inventory-seed-resume.db.test.ts",
  "deployables/platform-api/__tests__/catalog-seed-test-support.ts",
  "deployables/platform-api/__tests__/seed-command-pools.test.ts",
];

describe("inline seed caller inventory", () => {
  it("keeps every seedApiHostIfEmpty caller on an injected lease-port path", async () => {
    const sources = await Promise.all(
      callerPaths.map(
        async (relativePath) => [relativePath, await readFile(resolve(repoRoot, relativePath), "utf8")] as const,
      ),
    );

    for (const [relativePath, source] of sources) {
      expect(source, relativePath).toContain("seedApiHostIfEmpty");
      expect(
        source.includes("projectionGroupLeasePort") ||
          source.includes("seedOptions") ||
          source.includes("bootstrapOptions"),
        relativePath,
      ).toBe(true);
    }
  });
});
