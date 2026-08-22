import { describe, expect, it } from "vitest";
import {
  AUTHORIZED_PATHS,
  classifyCleanupAuthorityFootprint,
  classifyOutOfFootprintReason,
  isAuthorizedPath,
  renderFootprintArtifact,
} from "./cleanup-authority-footprint.mjs";

const DELIVERED_FOOTPRINT = [
  "bounded-contexts/inventory/GLOSSARY.md",
  "bounded-contexts/inventory/features/holds/api/cleanup-authority-source-index.db.test.ts",
  "bounded-contexts/inventory/features/holds/api/cleanup-authority.test.ts",
  "bounded-contexts/inventory/features/holds/api/cleanup-authority.ts",
  "bounded-contexts/inventory/package.json",
  "bounded-contexts/inventory/server.ts",
  "bounded-contexts/inventory/support/runtime-support/hold-source-index-migrations.ts",
  "bounded-contexts/inventory/support/runtime-support/schema.ts",
  "bounded-contexts/inventory/support/runtime-support/services.ts",
  "bounded-contexts/ordering/GLOSSARY.md",
  "bounded-contexts/ordering/client.ts",
  "bounded-contexts/ordering/context.json",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority-route.test.ts",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority-test-support.ts",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority.test.ts",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority.ts",
  "bounded-contexts/ordering/features/orders/api/route.test.ts",
  "bounded-contexts/ordering/features/orders/api/route.ts",
  "bounded-contexts/ordering/features/orders/api/runtime-test-harness.ts",
  "bounded-contexts/ordering/features/orders/api/runtime.ts",
  "bounded-contexts/ordering/server.ts",
  "bounded-contexts/ordering/support/runtime-support/seed.ts",
  "bounded-contexts/ordering/support/runtime-support/services.ts",
  "bounded-contexts/ordering/tests/cleanup-authority-composition.test.ts",
  "contracts/localization/locales/en/ordering.ts",
  "deployables/platform-api/__tests__/cleanup-authority-host-capability.test.ts",
  "deployables/platform-api/src/app.ts",
  "deployables/platform-worker/__tests__/cleanup-authority-host-capability.test.ts",
  "deployables/platform-worker/__tests__/projection-wake-interest-graph.test.ts",
  "deployables/platform-worker/__tests__/scheduled-runners.db.test.ts",
  "deployables/platform-worker/src/bootstrap.ts",
  "deployables/platform-worker/src/main.ts",
  "scripts/check-structure/authoritative-stream-read-classification.test.mjs",
  "scripts/check-structure/authoritative-stream-read-detachment.test.mjs",
  "scripts/check-structure/sql-execution-surface-partition.json",
  "scripts/check-structure/sql-execution-surface.test.mjs",
  "scripts/cleanup-authority-footprint.mjs",
  "scripts/cleanup-authority-footprint.test.mjs",
];

describe("cleanup-authority-footprint", () => {
  it("accepts the delivered footprint", () => {
    const result = classifyCleanupAuthorityFootprint(DELIVERED_FOOTPRINT);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.authorized).toHaveLength(DELIVERED_FOOTPRINT.length);
  });

  it("rejects every planted scope mutant with its own forbidden-surface class", () => {
    const mutants = [
      {
        path: "bounded-contexts/inventory/features/reservations/read-model/projection.ts",
        reason: "projection",
      },
      { path: "bounded-contexts/ordering/features/orders/read-model/schema.ts", reason: "schema" },
      {
        path: "bounded-contexts/inventory/support/runtime-support/unlogged-projection-migrations.ts",
        reason: "schema",
      },
      {
        path: "bounded-contexts/ordering/features/orders/integrations/support-cancellation/support-cancellation-reaction.ts",
        reason: "cancellation",
      },
      {
        path: "bounded-contexts/inventory/features/reservations/api/order-reservation-workflow.ts",
        reason: "write",
      },
      { path: "bounded-contexts/inventory/features/holds/api/runtime.ts", reason: "write" },
      { path: "bounded-contexts/ordering/features/orders/domain/domain.ts", reason: "write" },
      {
        path: "bounded-contexts/payments/features/payments/api/stripe-gateway.ts",
        reason: "provider",
      },
      { path: "deployables/platform-api/src/main.ts", reason: "out-of-footprint" },
    ];

    for (const mutant of mutants) {
      const result = classifyCleanupAuthorityFootprint([...DELIVERED_FOOTPRINT, mutant.path]);
      expect({ path: mutant.path, ok: result.ok, violations: result.violations }).toEqual({
        path: mutant.path,
        ok: false,
        violations: [{ path: mutant.path, reason: mutant.reason }],
      });
      expect(classifyOutOfFootprintReason(mutant.path)).toBe(mutant.reason);
    }
  });

  it("normalises win32 separators and de-duplicates before classifying", () => {
    const result = classifyCleanupAuthorityFootprint([
      "bounded-contexts\\ordering\\index.ts",
      "bounded-contexts/ordering/index.ts",
    ]);

    expect(result.authorized).toEqual(["bounded-contexts/ordering/index.ts"]);
    expect(result.ok).toBe(true);
  });

  it("keeps every authorized path exact and sorted so the allowlist cannot drift silently", () => {
    expect([...AUTHORIZED_PATHS]).toEqual([...AUTHORIZED_PATHS].map((entry) => entry.replaceAll("\\", "/")));
    for (const entry of AUTHORIZED_PATHS) {
      expect(isAuthorizedPath(entry)).toBe(true);
      expect(entry).not.toContain("*");
    }
  });

  it("renders a filtered-diff artifact that names the rejected surfaces", () => {
    const result = classifyCleanupAuthorityFootprint([
      "bounded-contexts/ordering/index.ts",
      "bounded-contexts/ordering/features/orders/read-model/projection.ts",
    ]);
    const artifact = renderFootprintArtifact(result);

    expect(artifact).toContain("Result: OUT OF SCOPE");
    expect(artifact).toContain("- bounded-contexts/ordering/index.ts");
    expect(artifact).toContain("- bounded-contexts/ordering/features/orders/read-model/projection.ts (projection)");
  });
});
