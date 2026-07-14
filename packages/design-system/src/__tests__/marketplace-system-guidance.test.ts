import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

function repositoryRoot(): string {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

const marketplaceSystemGuidance = readFileSync(
  join(repositoryRoot(), "packages", "design-system", "MARKETPLACE_SYSTEM.md"),
  "utf8",
);

describe("marketplace system guidance", () => {
  it("documents responsive-safety enforcement", () => {
    expect(marketplaceSystemGuidance).toContain("## Responsive Design Rules");
    expect(marketplaceSystemGuidance).toContain("All functionality must remain available");
    expect(marketplaceSystemGuidance).toContain("pnpm run check:responsive-safety");
    expect(marketplaceSystemGuidance).toContain("RESPONSIVE_SAFETY.json");
    expect(marketplaceSystemGuidance).toContain("Touch targets must remain at least 44px");
    expect(marketplaceSystemGuidance).toContain("compact` density on pointer-primary dense workbenches");
  });

  it("documents object-first item-detail rail actions", () => {
    expect(marketplaceSystemGuidance).toContain("Item detail should use an action accordion rail");
    expect(marketplaceSystemGuidance).toContain("Buy this listing");
    expect(marketplaceSystemGuidance).toContain("Add listing to Buy Cart");
    expect(marketplaceSystemGuidance).toContain("Add product to Buy Cart");
    expect(marketplaceSystemGuidance).toContain("Accept offer");
    expect(marketplaceSystemGuidance).toContain("Add offer to Sell List");
    expect(marketplaceSystemGuidance).toContain("Create listing");
    expect(marketplaceSystemGuidance).toContain("Item-detail rail labels are object-first.");
  });

  it("standardizes Reference Info for rail fine print", () => {
    expect(marketplaceSystemGuidance).toContain("Use `ReferenceInfoTrigger` with `ReferenceInfoDialog`");
    expect(marketplaceSystemGuidance).toContain("standard popup pattern");
    expect(marketplaceSystemGuidance).toContain("do not create competing tooltip, popover, or ad hoc disclosure");
    expect(marketplaceSystemGuidance).toContain("Fine print goes in Reference Info.");
    expect(marketplaceSystemGuidance).toContain("Use at most one visible Reference Info trigger per workflow");
    expect(marketplaceSystemGuidance).toContain("Tooltip-only disclosure is not enough");
  });
});
