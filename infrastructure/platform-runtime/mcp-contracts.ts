// Public MCP contract surface. The catalog itself lives in
// `mcp-contracts/catalog/<service-id>.ts`, one module per service, composed
// here in publication order; `mcp-contracts/builders.ts` holds the vocabulary
// and the shared descriptor builders. Everything a caller may import is named
// explicitly below — shard-internal builders and per-service schema constants
// never reach this file's exports.
import {
  agentOAuthScopesForPermissions,
  missingAgentOAuthScopesForPermissions,
  type AgentOAuthScope,
} from "@chase-sets/auth-context";

import {
  CORE_MCP_SERVICE_IDS,
  DEFAULT_MCP_CAPABILITY_AVAILABILITY,
  EXTERNAL_MCP_SERVICE_IDS,
  type McpAccessScope,
  type McpActor,
  type McpAuditPolicy,
  type McpCapabilityAvailability,
  type McpConfirmationPolicy,
  type McpGuardrails,
  type McpIdempotencyPolicy,
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpPermissionBoundary,
  type McpResourceDescriptor,
  type McpServiceDescriptor,
  type McpServiceKind,
  type McpToolDescriptor,
  type McpToolInvocationAuthorization,
  type McpToolRisk,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

import { authService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/auth";
import { authenticityService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/authenticity";
import { identityService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/identity";
import { catalogService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/catalog";
import { discoveryService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/discovery";
import { inventoryService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/inventory";
import { marketplaceService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/marketplace";
import { pricingService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/pricing";
import { commercialTermsService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/commercial-terms";
import { checkoutService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/checkout";
import { orderingService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/ordering";
import { paymentsService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/payments";
import { fulfillmentService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/fulfillment";
import { settlementService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/settlement";
import { reputationService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/reputation";
import { insightsService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/insights";
import { platformOperationsService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/platform-operations";
import { stripePaymentsService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/stripe-payments";
import { stripeConnectService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/stripe-connect";
import { easypostPostageService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/easypost-postage";

export {
  CORE_MCP_SERVICE_IDS,
  EXTERNAL_MCP_SERVICE_IDS,
  type McpAccessScope,
  type McpActor,
  type McpAuditPolicy,
  type McpCapabilityAvailability,
  type McpConfirmationPolicy,
  type McpGuardrails,
  type McpIdempotencyPolicy,
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpPermissionBoundary,
  type McpResourceDescriptor,
  type McpServiceDescriptor,
  type McpServiceKind,
  type McpToolDescriptor,
  type McpToolInvocationAuthorization,
  type McpToolRisk,
};

export const mcpServiceCatalog = [
  authService,
  authenticityService,
  identityService,
  catalogService,
  discoveryService,
  inventoryService,
  marketplaceService,
  pricingService,
  commercialTermsService,
  checkoutService,
  orderingService,
  paymentsService,
  fulfillmentService,
  settlementService,
  reputationService,
  insightsService,
  platformOperationsService,
  stripePaymentsService,
  stripeConnectService,
  easypostPostageService,
] as const satisfies readonly McpServiceDescriptor[];

export function flattenMcpTools(services: readonly McpServiceDescriptor[] = mcpServiceCatalog): McpToolDescriptor[] {
  return services.flatMap((serviceDescriptor) => [...serviceDescriptor.tools]);
}

export function flattenMcpResources(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpResourceDescriptor[] {
  return services.flatMap((serviceDescriptor) => [...serviceDescriptor.resources]);
}

export function getMcpCapabilityAvailability(
  capability: Pick<McpToolDescriptor | McpResourceDescriptor, "availability">,
): McpCapabilityAvailability {
  return capability.availability ?? DEFAULT_MCP_CAPABILITY_AVAILABILITY;
}

export function isAvailableMcpCapability(capability: Pick<McpToolDescriptor | McpResourceDescriptor, "availability">) {
  return getMcpCapabilityAvailability(capability) === "available";
}

function toConfirmationExpectedValue(title: string) {
  const normalizedTitle = title.trim().replaceAll(/\s+/g, " ");
  if (!normalizedTitle) {
    return null;
  }

  return normalizedTitle.endsWith(".") ? normalizedTitle : `${normalizedTitle}.`;
}

export function getMcpToolConfirmationExpectedValue(tool: McpToolDescriptor): string | null {
  if (!tool.guardrails.confirmation.required || !tool.guardrails.confirmation.matchInputField) {
    return null;
  }

  return toConfirmationExpectedValue(tool.title);
}

export function flattenAvailableMcpTools(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpToolDescriptor[] {
  return flattenMcpTools(services).filter(isAvailableMcpCapability);
}

export function flattenAvailableMcpResources(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpResourceDescriptor[] {
  return flattenMcpResources(services).filter(isAvailableMcpCapability);
}

export function findMcpTool(
  toolName: string,
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpToolDescriptor | null {
  return flattenMcpTools(services).find((tool) => tool.name === toolName) ?? null;
}

export function authorizeMcpToolInvocation(
  tool: McpToolDescriptor,
  actor: McpActor | null,
  confirmation: Readonly<{ confirmed: boolean; text?: string | null }> = {
    confirmed: false,
  },
  input?: Readonly<Record<string, unknown>>,
): McpToolInvocationAuthorization {
  if (tool.permissionBoundary.scope !== "public" && actor === null) {
    return { allowed: false, reason: "An authenticated actor is required." };
  }

  const missingPermissions = tool.permissionBoundary.requiredPermissions.filter(
    (permission) => !(actor?.permissions.includes(permission) ?? false),
  );

  if (missingPermissions.length > 0) {
    const missingScopes = missingOAuthScopesForAuthorization(tool, actor, missingPermissions);
    if (missingScopes.length > 0) {
      return {
        allowed: false,
        reason: `Missing required OAuth scope: ${missingScopes.join(", ")}.`,
        missingScopes,
      };
    }

    return {
      allowed: false,
      reason: `Missing required permission: ${missingPermissions.join(", ")}.`,
    };
  }

  if (tool.permissionBoundary.accountScoped && !actor?.accountId) {
    return { allowed: false, reason: "An account-scoped actor is required." };
  }

  if (tool.guardrails.confirmation.required && !confirmation.confirmed) {
    return { allowed: false, reason: "Confirmation is required for this MCP tool." };
  }

  if (
    tool.guardrails.confirmation.required &&
    tool.guardrails.confirmation.matchInputField &&
    !confirmation.text?.trim()
  ) {
    return {
      allowed: false,
      reason: "Confirmation text is required for this MCP tool.",
    };
  }

  const confirmationExpectedValue = getMcpToolConfirmationExpectedValue(tool);
  const matchInputField = tool.guardrails.confirmation.matchInputField;

  if (confirmationExpectedValue && matchInputField) {
    const confirmationText = confirmation.text?.trim() ?? "";
    const inputConfirmationText = input?.[matchInputField];

    if (confirmationText !== confirmationExpectedValue) {
      return {
        allowed: false,
        reason: `Confirmation text must exactly match '${confirmationExpectedValue}'.`,
      };
    }

    if (input && typeof inputConfirmationText !== "string") {
      return {
        allowed: false,
        reason: `Confirmation input field '${matchInputField}' is required for this MCP tool.`,
      };
    }

    if (typeof inputConfirmationText === "string" && inputConfirmationText.trim() !== confirmationExpectedValue) {
      return {
        allowed: false,
        reason: `Confirmation input field '${matchInputField}' must exactly match '${confirmationExpectedValue}'.`,
      };
    }
  }

  return { allowed: true };
}

function missingOAuthScopesForAuthorization(
  tool: McpToolDescriptor,
  actor: McpActor | null,
  missingPermissions: readonly string[],
): readonly AgentOAuthScope[] {
  const grant = actor?.agentGrant;
  if (!grant || missingPermissions.length === 0) {
    return [];
  }

  const rolePermissions = new Set(grant.rolePermissions);
  if (missingPermissions.some((permission) => !rolePermissions.has(permission))) {
    return [];
  }

  const requiredScopes =
    tool.permissionBoundary.requiredScopes && tool.permissionBoundary.requiredScopes.length > 0
      ? tool.permissionBoundary.requiredScopes
      : agentOAuthScopesForPermissions(tool.permissionBoundary.requiredPermissions);
  const missingScopes = missingAgentOAuthScopesForPermissions(missingPermissions, grant.scopes).filter((scope) =>
    requiredScopes.includes(scope),
  );
  return [...new Set(missingScopes)].sort();
}

export function validateMcpServiceCatalog(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
  expectedServiceIds: readonly string[] = [...CORE_MCP_SERVICE_IDS, ...EXTERNAL_MCP_SERVICE_IDS],
): string[] {
  const errors: string[] = [];
  const serviceIds = new Set(services.map((serviceDescriptor) => serviceDescriptor.serviceId));
  const toolNames = new Set<string>();
  const resourceTemplates = new Set<string>();

  for (const expectedServiceId of expectedServiceIds) {
    if (!serviceIds.has(expectedServiceId)) {
      errors.push(`Missing MCP service descriptor for '${expectedServiceId}'.`);
    }
  }

  for (const serviceDescriptor of services) {
    if (serviceDescriptor.tools.length === 0 && serviceDescriptor.resources.length === 0) {
      errors.push(`${serviceDescriptor.serviceId} must expose at least one tool or resource.`);
    }

    for (const tool of serviceDescriptor.tools) {
      if (tool.serviceId !== serviceDescriptor.serviceId) {
        errors.push(
          `${tool.name} has serviceId '${tool.serviceId}' but is registered under '${serviceDescriptor.serviceId}'.`,
        );
      }

      if (toolNames.has(tool.name)) {
        errors.push(`Duplicate MCP tool '${tool.name}'.`);
      }
      toolNames.add(tool.name);

      if (tool.inputSchema.type !== "object") {
        errors.push(`${tool.name} input schema must be an object.`);
      }

      if (!tool.audit.eventName || !tool.audit.targetType) {
        errors.push(`${tool.name} must define an audit event and target type.`);
      }

      if (tool.risk !== "read") {
        if (tool.permissionBoundary.scope === "public") {
          errors.push(`${tool.name} cannot be public because it is ${tool.risk}.`);
        }

        if (tool.permissionBoundary.requiredPermissions.length === 0) {
          errors.push(`${tool.name} must declare at least one required permission.`);
        }

        if (!tool.guardrails.confirmation.required) {
          errors.push(`${tool.name} must require confirmation.`);
        }

        if (
          tool.guardrails.confirmation.matchInputField &&
          !(tool.guardrails.confirmation.matchInputField in tool.inputSchema.properties)
        ) {
          errors.push(
            `${tool.name} confirmation match field '${tool.guardrails.confirmation.matchInputField}' must exist in the input schema.`,
          );
        }

        if (tool.guardrails.idempotencyKey !== "required") {
          errors.push(`${tool.name} must require an idempotency key.`);
        }
      }
    }

    for (const descriptor of serviceDescriptor.resources) {
      if (descriptor.serviceId !== serviceDescriptor.serviceId) {
        errors.push(
          `${descriptor.uriTemplate} has serviceId '${descriptor.serviceId}' but is registered under '${serviceDescriptor.serviceId}'.`,
        );
      }

      if (resourceTemplates.has(descriptor.uriTemplate)) {
        errors.push(`Duplicate MCP resource '${descriptor.uriTemplate}'.`);
      }
      resourceTemplates.add(descriptor.uriTemplate);
    }
  }

  return errors;
}
