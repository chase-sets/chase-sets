import { afterEach, describe, expect, it, vi } from "vitest";
import { reportStructureCheckResults, structureRulesDocPath } from "./phases.mjs";

describe("structure check result reporting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("points failures at the bounded-context structure rules", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = reportStructureCheckResults({
      violations: ["bounded-contexts/example/context.json: manifest must declare contextName"],
      warnings: [],
    });

    expect(ok).toBe(false);
    expect(error).toHaveBeenCalledWith(`\nSee ${structureRulesDocPath} for the enforced rules and fixes.`);
  });
});
