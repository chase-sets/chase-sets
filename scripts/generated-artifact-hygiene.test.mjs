import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("generated artifact hygiene", () => {
  it("keeps the retired structure metrics dashboard generator removed", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const docsReadme = readFileSync("docs/README.md", "utf8");

    expect(packageJson.scripts).not.toHaveProperty("check:structure:budget");
    expect(docsReadme).not.toContain("structure-metrics-dashboard.md");
    expect(docsReadme).not.toContain("Markdown under `artifacts/`");
  });
});
