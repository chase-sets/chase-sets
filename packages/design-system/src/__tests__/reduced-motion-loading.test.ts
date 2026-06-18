import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles/styles.css");

describe("reduced motion loading affordances", () => {
  it("neutralizes looping Tailwind loading animations when reduced motion is requested", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const reducedMotionBlock = styles.match(/@media \(prefers-reduced-motion: reduce\) \{(?<body>[\s\S]*?)\n  \}/)
      ?.groups?.body;

    expect(reducedMotionBlock).toContain(".animate-spin");
    expect(reducedMotionBlock).toContain(".animate-pulse");
    expect(reducedMotionBlock).toContain("animation: none !important");
  });
});
