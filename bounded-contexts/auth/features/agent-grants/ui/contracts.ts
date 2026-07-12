// DTO shapes returned by the UCP OAuth agent-grant routes
// (bounded-contexts/auth/support/ucp-support/oauth.ts), matching the API JSON exactly.

export type AgentGrantSpendingMandate = Readonly<{
  max_per_order_cents: number | null;
  daily_cap_cents: number | null;
  monthly_cap_cents: number | null;
  human_present_required: boolean;
  allowed_rails: readonly string[];
}>;

export type AgentGrantSpend = Readonly<{
  daily_cents: number;
  monthly_cents: number;
}>;

export type AgentGrant = Readonly<{
  id: string;
  platform_profile_url: string;
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  scopes: readonly string[];
  status: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string | null;
  granted_at: string;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  updated_at: string;
  spending_mandate?: AgentGrantSpendingMandate;
  spend?: AgentGrantSpend;
}>;

export type AgentGrantActivityRecord = Readonly<{
  id: string;
  occurred_at: string;
  outcome: "allowed" | "denied" | "failed";
  method: string;
  tool_name: string | null;
  resource_uri: string | null;
  audit_event_name: string | null;
  target_type: string | null;
  reason: string | null;
  limit_kind: string | null;
}>;

export type AgentGrantActivityPage = Readonly<{
  activity: readonly AgentGrantActivityRecord[];
  total: number;
}>;

// The three payment rails a mandate can allow (mirrors AGENT_GRANT_RAILS in
// infrastructure/platform-runtime/agent-guardrails.ts).
export const AGENT_GRANT_PAYMENT_RAILS = ["handoff-only", "stored-pm", "ap2"] as const;
export type AgentGrantPaymentRail = (typeof AGENT_GRANT_PAYMENT_RAILS)[number];
