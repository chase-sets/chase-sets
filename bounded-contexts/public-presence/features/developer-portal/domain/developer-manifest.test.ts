import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { agentConnectorTermsDeveloperLink, buildDeveloperLlmsTxt, buildDeveloperManifest } from "./developer-manifest";

describe("developer manifest", () => {
  it("indexes the developer corpus and generated MCP catalog for agents", () => {
    const manifest = buildDeveloperManifest("https://chasesets.com/");
    expect(manifest.indexing).toBe("disabled");
    expect(manifest.readinessGate).toBe("m86-certification");
    expect(manifest.articles.map((article) => article.url)).toContain(
      "https://chasesets.com/developers/developer-quickstart",
    );
    expect(agentConnectorTermsDeveloperLink).toEqual({
      policyKey: "agent-connector-terms",
      href: "/agent-terms",
      portalLabelKey: "publicPresence.developers.agentTerms",
      manifestTitle: "Agent Connector Terms",
      llmsLabel: "Agent Connector Terms",
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.policies).toEqual([
      {
        policyKey: "agent-connector-terms",
        title: "Agent Connector Terms",
        url: "https://chasesets.com/agent-terms",
      },
    ]);
    expect(Object.keys(manifest)).toEqual([
      "schemaVersion",
      "name",
      "indexing",
      "readinessGate",
      "portalUrl",
      "llmsUrl",
      "articles",
      "policies",
      "mcp",
    ]);
    expect(manifest.mcp.endpoint).toBe("https://chasesets.com/mcp");
    expect(manifest.mcp.protocolVersions).toEqual(["2025-06-18", "2025-11-25", "2026-07-28"]);
    expect(manifest.mcp.tools.some((tool) => tool.availability === "planned")).toBe(true);
  });

  it("renders the complete ordered llms.txt contract from the same discovery authority", () => {
    const manifest = buildDeveloperManifest("https://chasesets.com");
    const text = buildDeveloperLlmsTxt("https://chasesets.com");
    const lines = text.split("\n");
    const articleLines = manifest.articles.map(
      (article) => `- [${article.title}](${article.url}): ${article.description}`,
    );
    const policyLine = "- [Agent Connector Terms](https://chasesets.com/agent-terms)";
    const manifestLine = "- [Machine-readable developer manifest](https://chasesets.com/developers/manifest.json)";

    expect(lines).toEqual([
      "# Chase Sets Developer Portal",
      "",
      "> Gated, non-indexed documentation for the Chase Sets MCP and agent-commerce surface.",
      "",
      "- [Developer portal](https://chasesets.com/developers)",
      ...articleLines,
      policyLine,
      manifestLine,
      "",
      "MCP endpoint: https://chasesets.com/mcp",
      "Supported protocol versions: 2025-06-18, 2025-11-25, 2026-07-28",
      "",
    ]);
    expect(lines.indexOf(policyLine)).toBe(lines.indexOf(manifestLine) - 1);
    expect(lines.indexOf(policyLine)).toBeGreaterThan(lines.lastIndexOf(articleLines.at(-1)!));
    expect(text).toContain("2025-06-18, 2025-11-25, 2026-07-28");
  });

  it("keeps the policy discovery href in the policy registry instead of recreating it in the Corten portal", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../../..");
    const exportSource = readFileSync(resolve(repoRoot, "deployables/corten-pilot/scripts/export.mjs"), "utf8");
    const portalSource = readFileSync(
      resolve(repoRoot, "deployables/corten-pilot/public/src/views/help_page.rs"),
      "utf8",
    );
    expect(exportSource).toContain('agent_terms: publicPolicyHrefsByKey["agent-connector-terms"],');
    expect(portalSource).toContain("href={crate::developers::agent_terms()}");
    expect(portalSource).not.toContain('href="/agent-terms"');
  });
});
