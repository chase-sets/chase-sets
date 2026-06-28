import { describe, expect, it, vi } from "vitest";
import {
  TESTED_DESIGN_SYSTEM_ROOT_EXPORTS,
  compareDesignSystemExportCoverage,
  formatDesignSystemExportCoverageFailure,
  runDesignSystemExportCoverageCheck,
} from "./check-design-system-export-coverage.mjs";

describe("design-system export coverage guard", () => {
  it("passes when runtime exports match the tested allowlist regardless of order", () => {
    const result = compareDesignSystemExportCoverage({
      runtimeExports: ["Banner", "Button", "Breadcrumbs"],
      testedExports: ["Button", "Breadcrumbs", "Banner"],
    });

    expect(result.passed).toBe(true);
    expect(result.actualExports).toEqual(["Banner", "Breadcrumbs", "Button"]);
    expect(result.untestedExports).toEqual([]);
    expect(result.staleTestedExports).toEqual([]);
  });

  it("reports new runtime exports and stale allowlist entries", () => {
    const result = compareDesignSystemExportCoverage({
      runtimeExports: ["Banner", "Button", "Pagination"],
      testedExports: ["Banner", "Button", "RemovedComponent"],
    });

    expect(result.passed).toBe(false);
    expect(result.untestedExports).toEqual(["Pagination"]);
    expect(result.staleTestedExports).toEqual(["RemovedComponent"]);
    expect(formatDesignSystemExportCoverageFailure(result)).toContain(
      "Add focused behavior or smoke coverage for each export before adding it to the allowlist.",
    );
  });

  it("keeps the checked allowlist stable, sorted, and unique", () => {
    const sorted = [...TESTED_DESIGN_SYSTEM_ROOT_EXPORTS].sort();

    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toEqual(sorted);
    expect(new Set(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).size).toBe(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS.length);
    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toContain("Breadcrumbs");
    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toContain("Pagination");
    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toContain("useMediaQuery");
  });

  it("returns a failing process code with actionable output when coverage drifts", async () => {
    const stderr = vi.fn();

    const exitCode = await runDesignSystemExportCoverageCheck({
      collectRuntimeExports: async () => ["Button", "NewExport"],
      testedExports: ["Button"],
      stdout: vi.fn(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("NewExport"));
  });
});
