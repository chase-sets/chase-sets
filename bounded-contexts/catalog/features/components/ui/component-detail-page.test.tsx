import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("component metadata edit payload", () => {
  it("sends only metadata fields", () => {
    const source = readFileSync(new URL("./component-detail-page.tsx", import.meta.url), "utf8");
    const handleConfigure = source.match(/async function handleConfigure\(\)[\s\S]*?\n  \}/)?.[0] ?? "";

    expect(handleConfigure).toContain("key: editKey");
    expect(handleConfigure).toContain("name: localizedTextMapFromEnglish(editName)");
    expect(handleConfigure).toContain("description: localizedTextMapFromEnglish(editDescription)");
    expect(handleConfigure).not.toContain("fieldRules");
    expect(handleConfigure).not.toContain("dimensionRules");
  });
});
