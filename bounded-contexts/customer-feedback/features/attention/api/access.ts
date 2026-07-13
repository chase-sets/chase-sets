export type FeedbackAttentionCapability = "view" | "manage" | "notify" | "export";

export type FeedbackAttentionApiActor = Readonly<{
  permissions: readonly string[];
  roleKey?: string | null;
}>;

export function canAccessFeedbackAttention(
  actor: FeedbackAttentionApiActor | null | undefined,
  capability: FeedbackAttentionCapability,
): boolean {
  if (!actor) return false;
  if (capability === "view")
    return actor.permissions.includes("support.view") || actor.permissions.includes("support.manage");
  if (capability === "export") return actor.permissions.includes("support.manage");
  if (capability === "manage" || capability === "notify") return actor.permissions.includes("support.manage");
  return false;
}

export function feedbackAttentionRoutePermission(capability: FeedbackAttentionCapability): string {
  return capability === "view" ? "support.view" : "support.manage";
}

export function feedbackAttentionExportAllowed(actor: FeedbackAttentionApiActor | null | undefined): boolean {
  return canAccessFeedbackAttention(actor, "export");
}
