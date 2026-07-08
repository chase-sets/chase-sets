import {
  flattenAvailableMcpResources,
  flattenAvailableMcpTools,
  type McpResourceDescriptor,
  type McpToolDescriptor,
} from "./mcp-contracts";
import { MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH } from "./mcp";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./mcp-protocol";

export const AGENT_CONNECTOR_PACKAGE_VERSION = "2026-07-08";
export const AGENT_CONNECTOR_ORIGIN_PLACEHOLDER = "https://<marketplace-host>";
export const NATIVE_MCP_ENDPOINT_PATH = "/mcp";

export type AgentConnectorPlatform = "claude-directory" | "chatgpt-app" | "gemini";

export type AgentConnectorOAuthConfiguration = Readonly<{
  protected_resource_metadata_url: string;
  issuer_metadata_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  introspection_endpoint: string;
  revocation_endpoint: string;
  grant_types: readonly ["authorization_code", "refresh_token"];
  pkce: Readonly<{ required: true; methods: readonly ["S256"] }>;
  token_endpoint_auth_method: "none";
  dynamic_client_registration: Readonly<{
    status: "exposed";
    registration_endpoint: string;
    client_id_source: "dynamic-registration-response or Client ID Metadata Document URL";
    client_metadata_document_support: true;
    constraints: readonly string[];
    confidential_credential_policy: "not-used";
  }>;
}>;

export type AgentConnectorToolRegistration = Readonly<{
  name: string;
  title: string;
  description: string;
  service_id: string;
  risk: McpToolDescriptor["risk"];
  access_scope: McpToolDescriptor["permissionBoundary"]["scope"];
  required_permissions: readonly string[];
  required_scopes: readonly string[];
  input_schema: McpToolDescriptor["inputSchema"];
  output_schema?: McpToolDescriptor["outputSchema"];
  confirmation_required: boolean;
  idempotency_key: McpToolDescriptor["guardrails"]["idempotencyKey"];
  dry_run_supported: boolean;
  expected_usage: readonly string[];
}>;

export type AgentConnectorResourceRegistration = Readonly<{
  uri_template: string;
  title: string;
  description: string;
  service_id: string;
  access_scope: McpResourceDescriptor["permissionBoundary"]["scope"];
  required_permissions: readonly string[];
  required_scopes: readonly string[];
  expected_usage: readonly string[];
}>;

export type AgentConnectorRegistration = Readonly<{
  package_version: string;
  generated_from: "infrastructure/platform-runtime/mcp-contracts.ts";
  endpoint: string;
  protocol_versions: readonly string[];
  authentication: Readonly<{
    type: "oauth2-pkce";
    oauth: AgentConnectorOAuthConfiguration;
  }>;
  tools: readonly AgentConnectorToolRegistration[];
  resources: readonly AgentConnectorResourceRegistration[];
}>;

export type AgentConnectorPlatformManifest = Readonly<{
  platform: AgentConnectorPlatform;
  name: "Chase Sets";
  description: string;
  endpoint: string;
  registration_artifact: "native-mcp-registration.json";
  authentication: AgentConnectorRegistration["authentication"];
  tool_names: readonly string[];
  resource_uri_templates: readonly string[];
  platform_notes: readonly string[];
}>;

export type AgentConnectorPackaging = Readonly<{
  package_version: string;
  generated_at_policy: "stable-source-generated";
  origin: string;
  registration: AgentConnectorRegistration;
  manifests: Readonly<Record<AgentConnectorPlatform, AgentConnectorPlatformManifest>>;
}>;

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

function oauthConfiguration(origin: string): AgentConnectorOAuthConfiguration {
  const baseUrl = normalizeOrigin(origin);
  return {
    protected_resource_metadata_url: `${baseUrl}${MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`,
    issuer_metadata_url: `${baseUrl}/.well-known/oauth-authorization-server`,
    authorization_endpoint: `${baseUrl}/ucp/oauth/authorize`,
    token_endpoint: `${baseUrl}/ucp/oauth/token`,
    introspection_endpoint: `${baseUrl}/ucp/oauth/introspect`,
    revocation_endpoint: `${baseUrl}/ucp/oauth/revoke`,
    grant_types: ["authorization_code", "refresh_token"],
    pkce: { required: true, methods: ["S256"] },
    token_endpoint_auth_method: "none",
    dynamic_client_registration: {
      status: "exposed",
      registration_endpoint: `${baseUrl}/ucp/oauth/register`,
      client_id_source: "dynamic-registration-response or Client ID Metadata Document URL",
      client_metadata_document_support: true,
      constraints: [
        "Public OAuth clients only; token_endpoint_auth_method must be none.",
        "No client_secret, jwks, or jwks_uri is accepted, stored, or returned.",
        "redirect_uris and platform_profile_url/client_uri must be HTTPS URLs or localhost HTTP URLs.",
        "Registered scopes are limited to the advertised UCP OAuth scopes; authorization requests cannot exceed registered scopes.",
        "Authorization Code with PKCE S256 is required.",
      ],
      confidential_credential_policy: "not-used",
    },
  };
}

function toolRegistration(tool: McpToolDescriptor): AgentConnectorToolRegistration {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    service_id: tool.serviceId,
    risk: tool.risk,
    access_scope: tool.permissionBoundary.scope,
    required_permissions: tool.permissionBoundary.requiredPermissions,
    required_scopes: tool.permissionBoundary.requiredScopes ?? [],
    input_schema: tool.inputSchema,
    ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
    confirmation_required: tool.guardrails.confirmation.required,
    idempotency_key: tool.guardrails.idempotencyKey,
    dry_run_supported: tool.guardrails.dryRunSupported,
    expected_usage: tool.expectedUsage,
  };
}

function resourceRegistration(resource: McpResourceDescriptor): AgentConnectorResourceRegistration {
  return {
    uri_template: resource.uriTemplate,
    title: resource.title,
    description: resource.description,
    service_id: resource.serviceId,
    access_scope: resource.permissionBoundary.scope,
    required_permissions: resource.permissionBoundary.requiredPermissions,
    required_scopes: resource.permissionBoundary.requiredScopes ?? [],
    expected_usage: resource.expectedUsage,
  };
}

function buildRegistration(origin: string): AgentConnectorRegistration {
  const baseUrl = normalizeOrigin(origin);
  return {
    package_version: AGENT_CONNECTOR_PACKAGE_VERSION,
    generated_from: "infrastructure/platform-runtime/mcp-contracts.ts",
    endpoint: `${baseUrl}${NATIVE_MCP_ENDPOINT_PATH}`,
    protocol_versions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
    authentication: {
      type: "oauth2-pkce",
      oauth: oauthConfiguration(baseUrl),
    },
    tools: flattenAvailableMcpTools().map(toolRegistration),
    resources: flattenAvailableMcpResources().map(resourceRegistration),
  };
}

function platformManifest(
  platform: AgentConnectorPlatform,
  registration: AgentConnectorRegistration,
  platformNotes: readonly string[],
): AgentConnectorPlatformManifest {
  return {
    platform,
    name: "Chase Sets",
    description:
      "Authenticated Chase Sets marketplace MCP connector for inventory, listings, offers, fulfillment, settlement, pricing, reputation, and account workflows.",
    endpoint: registration.endpoint,
    registration_artifact: "native-mcp-registration.json",
    authentication: registration.authentication,
    tool_names: registration.tools.map((tool) => tool.name),
    resource_uri_templates: registration.resources.map((resource) => resource.uri_template),
    platform_notes: platformNotes,
  };
}

export function buildAgentConnectorPackaging(
  origin: string = AGENT_CONNECTOR_ORIGIN_PLACEHOLDER,
): AgentConnectorPackaging {
  const normalizedOrigin = normalizeOrigin(origin);
  const registration = buildRegistration(normalizedOrigin);
  return {
    package_version: AGENT_CONNECTOR_PACKAGE_VERSION,
    generated_at_policy: "stable-source-generated",
    origin: normalizedOrigin,
    registration,
    manifests: {
      "claude-directory": platformManifest("claude-directory", registration, [
        "Submit this metadata to the Claude connector directory as a remote MCP server entry.",
        "Use the OAuth issuer metadata URL for authorization endpoint discovery; do not embed credentials.",
      ]),
      "chatgpt-app": platformManifest("chatgpt-app", registration, [
        "Register as a ChatGPT app backed by the native remote MCP endpoint.",
        "Use OAuth Authorization Code with PKCE and either dynamic client registration or a Client ID Metadata Document URL as client_id.",
      ]),
      gemini: platformManifest("gemini", registration, [
        "Register as a Gemini extension backed by the native remote MCP endpoint.",
        "Use the OAuth issuer metadata URL and dynamic public-client registration.",
      ]),
    },
  };
}
