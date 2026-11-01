import { describe, expect, it } from "vitest";
import { inventoryImportSourceProfiles } from "./import-source-profiles";
import { importBatchCommitReadiness, importRowNeedsSeller } from "./import-batch-review";

describe("import batch review rules", () => {
  it("covers every source, row state, resolution, product and commit cell", () => {
    for (const { sourceKey } of inventoryImportSourceProfiles) {
      for (const status of ["accepted", "rejected", "committed"] as const) {
        for (const resolutionStatus of ["native", "resolved", "unresolved"] as const) {
          for (const productId of [null, "product"]) {
            for (const committedAt of [null, "2026-10-29T00:00:00.000Z"]) {
              const expected =
                status === "rejected" &&
                committedAt === null &&
                (sourceKey === "saved-list" || resolutionStatus === "unresolved" || productId === null);
              expect(
                importRowNeedsSeller({ sourceKey, status, resolutionStatus, productId, committedAt }),
                JSON.stringify({ sourceKey, status, resolutionStatus, productId, committedAt }),
              ).toBe(expected);
            }
          }
        }
      }
    }
  });

  it("covers all nine statuses by zero/one ready rows by absent/on/off rollout", () => {
    for (const status of [
      "uploaded",
      "validating",
      "ready-to-commit",
      "committing",
      "committed",
      "partial",
      "failed-safe",
      "ambiguous",
      "expired",
    ] as const) {
      for (const ready of [0, 1]) {
        for (const stockProgressionEnabled of [undefined, true, false]) {
          expect(
            importBatchCommitReadiness({
              status,
              acceptedCount: 2 + ready,
              committedCount: 2,
              stockProgressionEnabled,
            }),
          ).toEqual({
            commitReadyCount: ready,
            canCommit:
              ["uploaded", "ready-to-commit", "partial"].includes(status) &&
              ready > 0 &&
              stockProgressionEnabled !== false,
          });
        }
      }
    }
    expect(importBatchCommitReadiness({ status: "uploaded", acceptedCount: 1, committedCount: 2 })).toEqual({
      canCommit: false,
      commitReadyCount: 0,
    });
  });

  it.each(inventoryImportSourceProfiles.map(({ sourceKey }) => sourceKey))(
    "projects needs seller for every source profile: %s",
    (sourceKey) => {
      expect(
        importRowNeedsSeller({
          sourceKey,
          status: "rejected",
          resolutionStatus: "native",
          productId: null,
          committedAt: null,
        }),
      ).toBe(true);
      expect(
        importRowNeedsSeller({
          sourceKey,
          status: "rejected",
          resolutionStatus: "unresolved",
          productId: "product",
          committedAt: null,
        }),
      ).toBe(true);
      expect(
        importRowNeedsSeller({
          sourceKey,
          status: "rejected",
          resolutionStatus: "resolved",
          productId: "product",
          committedAt: null,
        }),
      ).toBe(sourceKey === "saved-list");
      expect(
        importRowNeedsSeller({
          sourceKey,
          status: "accepted",
          resolutionStatus: "unresolved",
          productId: null,
          committedAt: null,
        }),
      ).toBe(false);
      expect(
        importRowNeedsSeller({
          sourceKey,
          status: "rejected",
          resolutionStatus: "unresolved",
          productId: null,
          committedAt: "2026-10-29T00:00:00.000Z",
        }),
      ).toBe(false);
    },
  );

  it.each([
    "uploaded",
    "validating",
    "ready-to-commit",
    "committing",
    "committed",
    "partial",
    "failed-safe",
    "ambiguous",
    "expired",
  ] as const)("projects commit readiness for %s", (status) => {
    const readiness = importBatchCommitReadiness({
      status,
      acceptedCount: 2,
      committedCount: 1,
    });
    expect(readiness.commitReadyCount).toBe(1);
    expect(readiness.canCommit).toBe(["uploaded", "ready-to-commit", "partial"].includes(status));
  });

  it.each([undefined, true, false] as const)("applies stock progression rollout: %s", (stockProgressionEnabled) => {
    expect(
      importBatchCommitReadiness({
        status: "ready-to-commit",
        acceptedCount: 2,
        committedCount: 1,
        stockProgressionEnabled,
      }),
    ).toEqual({
      commitReadyCount: 1,
      canCommit: stockProgressionEnabled !== false,
    });
  });
});
