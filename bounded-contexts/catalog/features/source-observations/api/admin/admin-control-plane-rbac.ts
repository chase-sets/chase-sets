import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";

export type CatalogIntegrationControlPlanePermission = "catalog.view" | "catalog.manage";

export type CatalogIntegrationControlPlaneActionKey =
  | "integration-control-plane-read"
  | "provider-option-query-read"
  | "provider-profile-read"
  | "provider-profile-author"
  | "provider-profile-lifecycle"
  | "provider-profile-dry-run"
  | "integration-job-read"
  | "integration-job-write"
  | "source-observation-read"
  | "source-observation-review"
  | "promotion-impact-preview"
  | "bulk-review-write";

export type CatalogIntegrationControlPlaneActionPolicy = Readonly<{
  action: CatalogIntegrationControlPlaneActionKey;
  requiredPermission: CatalogIntegrationControlPlanePermission;
  destructive: boolean;
}>;

export const catalogIntegrationControlPlaneActionPolicies = [
  { action: "integration-control-plane-read", requiredPermission: "catalog.view", destructive: false },
  { action: "provider-option-query-read", requiredPermission: "catalog.view", destructive: false },
  { action: "provider-profile-read", requiredPermission: "catalog.view", destructive: false },
  { action: "provider-profile-author", requiredPermission: "catalog.manage", destructive: true },
  { action: "provider-profile-lifecycle", requiredPermission: "catalog.manage", destructive: true },
  { action: "provider-profile-dry-run", requiredPermission: "catalog.manage", destructive: false },
  { action: "integration-job-read", requiredPermission: "catalog.view", destructive: false },
  { action: "integration-job-write", requiredPermission: "catalog.manage", destructive: true },
  { action: "source-observation-read", requiredPermission: "catalog.view", destructive: false },
  { action: "source-observation-review", requiredPermission: "catalog.manage", destructive: true },
  { action: "promotion-impact-preview", requiredPermission: "catalog.manage", destructive: false },
  { action: "bulk-review-write", requiredPermission: "catalog.manage", destructive: true },
] as const satisfies readonly CatalogIntegrationControlPlaneActionPolicy[];

const actionPoliciesByKey = new Map(
  catalogIntegrationControlPlaneActionPolicies.map((policy) => [policy.action, policy]),
);

export function catalogIntegrationControlPlanePolicyFor(
  action: CatalogIntegrationControlPlaneActionKey,
): CatalogIntegrationControlPlaneActionPolicy {
  const policy = actionPoliciesByKey.get(action);
  if (!policy) {
    throw new Error(`Catalog Integration Control Plane action policy is missing for '${action}'.`);
  }
  return policy;
}

export function requireCatalogIntegrationControlPlanePermission(
  c: Context<CatalogAuthoringEnv>,
  action: CatalogIntegrationControlPlaneActionKey,
): Response | null {
  const policy = catalogIntegrationControlPlanePolicyFor(action);
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }
  if (!actor.permissions.includes(policy.requiredPermission)) {
    return c.json(forbiddenResponse(), 403);
  }
  return null;
}
