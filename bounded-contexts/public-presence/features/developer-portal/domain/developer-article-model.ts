import type {
  McpGuardrails,
  McpJsonSchema,
  McpPermissionBoundary,
  McpToolRisk,
} from "@chase-sets/platform-runtime/mcp-contracts";
import type { HelpArticle } from "../../help/domain/article-model";

export type DeveloperArticle = HelpArticle &
  Readonly<{
    audience: "developer";
    href: `/developers/${string}`;
  }>;

export type DeveloperMcpToolCatalogEntry = Readonly<{
  name: string;
  title: string;
  description: string;
  availability: "available" | "planned";
  serviceId: string;
  risk: McpToolRisk;
  inputSchema: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  permissionBoundary: McpPermissionBoundary;
  guardrails: McpGuardrails;
  expectedUsage: readonly string[];
}>;
