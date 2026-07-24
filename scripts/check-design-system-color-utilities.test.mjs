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

  it("accepts the text-clip text-overflow utility as a non-color utility", () => {
    const violations = collectDesignSystemColorUtilityViolations({
      rootDir: "/repo",
      files: ["/repo/packages/design-system/src/utils/system.ts"],
      readFile: () => 'const classes = "overflow-visible text-clip whitespace-normal";',
    });

    expect(violations).toEqual([]);
  });

  it("still reports unknown text-* colors that merely resemble text-clip", () => {
    const violations = collectDesignSystemColorUtilityViolations({
      rootDir: "/repo",
      files: ["/repo/packages/design-system/src/panel.tsx"],
      readFile: () => 'const classes = "text-clipboard";',
    });

    expect(violations).toEqual([
      "packages/design-system/src/panel.tsx: 'text-clipboard' uses unknown design-system color 'clipboard'.",
    ]);
  });
});
