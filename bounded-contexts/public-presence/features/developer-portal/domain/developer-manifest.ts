import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "@chase-sets/platform-runtime/mcp-protocol";
import { publicPolicyHrefsByKey } from "@chase-sets/public-docs";
import { developerArticles, developerMcpToolCatalog } from "./developer-article-catalog";

export const agentConnectorTermsDeveloperLink = {
  policyKey: "agent-connector-terms",
  href: publicPolicyHrefsByKey["agent-connector-terms"],
  portalLabelKey: "publicPresence.developers.agentTerms",
  manifestTitle: "Agent Connector Terms",
  llmsLabel: "Agent Connector Terms",
} as const;

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

export function buildDeveloperManifest(origin: string) {
  const baseUrl = normalizeOrigin(origin);
  return {
    schemaVersion: 1,
    name: "Chase Sets Developer Portal",
    indexing: "disabled",
    readinessGate: "m86-certification",
    portalUrl: `${baseUrl}/developers`,
    llmsUrl: `${baseUrl}/llms.txt`,
    articles: developerArticles.map(({ slug, locale, title, description, reviewedAt, href }) => ({
      slug,
      locale,
      title,
      description,
      reviewedAt,
      url: `${baseUrl}${href}`,
    })),
    policies: [
      {
        policyKey: agentConnectorTermsDeveloperLink.policyKey,
        title: agentConnectorTermsDeveloperLink.manifestTitle,
        url: `${baseUrl}${agentConnectorTermsDeveloperLink.href}`,
      },
    ],
    mcp: {
      endpoint: `${baseUrl}/mcp`,
      protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      tools: developerMcpToolCatalog,
    },
  } as const;
}

export function buildDeveloperLlmsTxt(origin: string) {
  const manifest = buildDeveloperManifest(origin);
  return [
    "# Chase Sets Developer Portal",
    "",
    "> Gated, non-indexed documentation for the Chase Sets MCP and agent-commerce surface.",
    "",
    `- [Developer portal](${manifest.portalUrl})`,
    ...manifest.articles.map((article) => `- [${article.title}](${article.url}): ${article.description}`),
    `- [${agentConnectorTermsDeveloperLink.llmsLabel}](${manifest.policies[0].url})`,
    `- [Machine-readable developer manifest](${normalizeOrigin(origin)}/developers/manifest.json)`,
    "",
    `MCP endpoint: ${manifest.mcp.endpoint}`,
    `Supported protocol versions: ${manifest.mcp.protocolVersions.join(", ")}`,
    "",
  ].join("\n");
}
