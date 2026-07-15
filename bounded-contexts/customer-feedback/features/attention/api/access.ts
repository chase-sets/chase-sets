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
    return ["support.view", "support.manage", "support.notify", "support.export"].some((permission) =>
      actor.permissions.includes(permission),
    );
  if (capability === "export")
    return actor.permissions.includes("support.export") || actor.permissions.includes("support.manage");
  if (capability === "notify")
    return actor.permissions.includes("support.notify") || actor.permissions.includes("support.manage");
  if (capability === "manage") return actor.permissions.includes("support.manage");
  return false;
}

export function feedbackAttentionRoutePermission(capability: FeedbackAttentionCapability): string {
  if (capability === "view") return "support.view";
  if (capability === "notify") return "support.notify";
  if (capability === "export") return "support.export";
  return "support.manage";
}

export function feedbackAttentionExportAllowed(actor: FeedbackAttentionApiActor | null | undefined): boolean {
  return canAccessFeedbackAttention(actor, "export");
}
