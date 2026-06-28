import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles/styles.css");

describe("reduced motion loading affordances", () => {
  it("keeps retired legacy utility aliases out of the stylesheet", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).not.toMatch(/\.glass-surface\b/);
    expect(styles).not.toMatch(/\.brand-gradient\b/);
    expect(styles).not.toMatch(/\.glow-accent\b/);
    expect(styles).not.toMatch(/\.neon-text\b/);
  });

  it("neutralizes looping Tailwind loading animations when reduced motion is requested", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const reducedMotionBlock = styles.match(/@media \(prefers-reduced-motion: reduce\) \{(?<body>[\s\S]*?)\n  \}/)
      ?.groups?.body;

    expect(reducedMotionBlock).toContain(".animate-spin");
    expect(reducedMotionBlock).toContain(".animate-pulse");
    expect(reducedMotionBlock).toContain(".ds-reveal");
    expect(reducedMotionBlock).toContain("animation: none !important");
  });

  it('honors ChaseRoot reducedMotion="always" without depending on the OS media query', () => {
    const styles = readFileSync(stylesPath, "utf8");
    const rootPolicyBlock = styles.match(
      /\[data-reduced-motion="true"\] \.animate-spin,[\s\S]*?\[data-reduced-motion="true"\] \.ds-reveal \{(?<body>[\s\S]*?)\n  \}/,
    )?.groups?.body;

    expect(rootPolicyBlock).toContain("animation: none !important");
  });
});
