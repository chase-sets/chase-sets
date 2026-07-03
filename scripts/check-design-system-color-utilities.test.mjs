import { describe, expect, it } from "vitest";
import { collectDesignSystemColorUtilityViolations } from "./check-design-system-color-utilities.mjs";

describe("design-system color utility guard", () => {
  it("accepts canonical DS color utilities", () => {
    const violations = collectDesignSystemColorUtilityViolations({
      rootDir: "/repo",
      files: ["/repo/packages/design-system/src/card.tsx"],
      readFile: () => 'const classes = "border border-muted bg-surface-2 text-secondary hover:bg-accent-hover";',
    });

    expect(violations).toEqual([]);
  });

  it("reports unknown color utility values in design-system class strings", () => {
    const violations = collectDesignSystemColorUtilityViolations({
      rootDir: "/repo",
      files: ["/repo/packages/design-system/src/panel.tsx"],
      readFile: () => 'const classes = "grid rounded-tokenMd border border-border-subtle bg-surface";',
    });

    expect(violations).toEqual([
      "packages/design-system/src/panel.tsx: 'border-border-subtle' uses unknown design-system color 'border-subtle'.",
    ]);
  });
});
