import { describe, expect, it } from "vitest";
import { buildAgentConnectorPackaging } from "./agent-connector-packaging";
import { flattenAvailableMcpResources, flattenAvailableMcpTools } from "./mcp-contracts";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./mcp-protocol";

function collectCredentialFindings(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectCredentialFindings(item, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const findings: string[] = [];
  for (const [key, childValue] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (["client_secret", "private_key", "api_key", "access_token", "refresh_token"].includes(lowerKey)) {
      findings.push(`${path}.${key}`);
    }
    if (typeof childValue === "string" && /^(sk_|pk_|ghp_|ucp_at_|ucp_rt_)/i.test(childValue)) {
      findings.push(`${path}.${key}`);
    }
    findings.push(...collectCredentialFindings(childValue, `${path}.${key}`));
  }
  return findings;
}

describe("agent connector packaging", () => {
  it("derives platform manifests from the available native MCP registry", () => {
    const packaging = buildAgentConnectorPackaging("https://marketplace.example/");
    const toolNames = flattenAvailableMcpTools().map((tool) => tool.name);
    const resourceTemplates = flattenAvailableMcpResources().map((resource) => resource.uriTemplate);

    expect(packaging.registration.endpoint).toBe("https://marketplace.example/mcp");
    expect(packaging.registration.protocol_versions).toEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS);
    expect(packaging.registration.tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(packaging.registration.resources.map((resource) => resource.uri_template)).toEqual(resourceTemplates);

    for (const manifest of Object.values(packaging.manifests)) {
      expect(manifest.endpoint).toBe(packaging.registration.endpoint);
      expect(manifest.registration_artifact).toBe("native-mcp-registration.json");
      expect(manifest.tool_names).toEqual(toolNames);
      expect(manifest.resource_uri_templates).toEqual(resourceTemplates);
    }
  });

  it("keeps OAuth-DCR metadata truthful and secret-free", () => {
    const packaging = buildAgentConnectorPackaging("https://marketplace.example");
    const oauth = packaging.registration.authentication.oauth;

    expect(oauth).toMatchObject({
      protected_resource_metadata_url: "https://marketplace.example/.well-known/oauth-protected-resource",
      issuer_metadata_url: "https://marketplace.example/.well-known/oauth-authorization-server",
      authorization_endpoint: "https://marketplace.example/ucp/oauth/authorize",
      token_endpoint: "https://marketplace.example/ucp/oauth/token",
      token_endpoint_auth_method: "none",
      dynamic_client_registration: {
        status: "exposed",
        registration_endpoint: "https://marketplace.example/ucp/oauth/register",
        client_metadata_document_support: true,
        confidential_credential_policy: "not-used",
      },
    });
    expect(collectCredentialFindings(packaging)).toEqual([]);
    expect(JSON.stringify(packaging)).toContain("/ucp/oauth/register");
    expect(JSON.stringify(packaging)).not.toContain('"client_secret":');
  });
});
