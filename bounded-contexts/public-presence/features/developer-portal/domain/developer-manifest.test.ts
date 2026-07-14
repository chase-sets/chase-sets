import { describe, expect, it } from "vitest";
import { buildDeveloperLlmsTxt, buildDeveloperManifest } from "./developer-manifest";

describe("developer manifest", () => {
  it("indexes the developer corpus and generated MCP catalog for agents", () => {
    const manifest = buildDeveloperManifest("https://chasesets.com/");
    expect(manifest.indexing).toBe("disabled");
    expect(manifest.readinessGate).toBe("m86-certification");
    expect(manifest.articles.map((article) => article.url)).toContain(
      "https://chasesets.com/developers/developer-quickstart",
    );
    expect(manifest.mcp.endpoint).toBe("https://chasesets.com/mcp");
    expect(manifest.mcp.protocolVersions).toEqual(["2025-06-18", "2025-11-25", "2026-07-28"]);
    expect(manifest.mcp.tools.some((tool) => tool.availability === "planned")).toBe(true);
  });

  it("renders llms.txt from the same manifest", () => {
    const text = buildDeveloperLlmsTxt("https://chasesets.com");
    expect(text).toContain("https://chasesets.com/developers/manifest.json");
    expect(text).toContain("https://chasesets.com/developers/mcp-tool-catalog");
    expect(text).toContain("2025-06-18, 2025-11-25, 2026-07-28");
  });
});
