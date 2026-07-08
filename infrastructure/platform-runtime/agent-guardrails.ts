import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createConfiguredInMemoryRateLimiter,
  type InMemoryRateLimiter,
  type RateLimitDecision,
  type RateLimitRule,
} from "@chase-sets/http/rate-limit";
import type { ResolvedActor } from "./auth";

export type AgentGrantGuardrailViolationKind = "rate-limit" | "spend-cap" | "anomaly";

export type AgentGrantGuardrailViolation = Readonly<{
  kind: AgentGrantGuardrailViolationKind;
  grantId: string | null;
  accountId: string | null;
  operation: string;
  reason: string;
  evidence?: Readonly<Record<string, unknown>>;
}>;

export type AgentGrantSpendPolicyDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason: string;
      remainingCents: number;
      capCents: number;
    }>;

export type AgentGrantSpendPolicy = Readonly<{
  authorize: (
    input: AgentGrantSpendPolicyInput,
  ) => Promise<AgentGrantSpendPolicyDecision> | AgentGrantSpendPolicyDecision;
}>;

export type AgentGrantSpendPolicyInput = Readonly<{
  grantId: string | null;
  accountId: string | null;
  operation: string;
  operationId: string;
  amountCents: number;
  occurredAt?: Date;
}>;

export type AgentGrantRateLimiter = Readonly<{
  check: (input: AgentGrantRateLimitInput) => AgentGrantRateLimitDecision;
}>;

export type AgentGrantRateLimitInput = Readonly<{
  grantId: string | null;
  accountId: string | null;
  actorId: string | null;
  operation: string;
}>;

export type AgentGrantRateLimitDecision =
  | Readonly<{ allowed: true; decision: RateLimitDecision }>
  | Readonly<{ allowed: false; reason: string; decision: RateLimitDecision }>;

export type AgentGrantSpendCapPolicyOptions = Readonly<{
  capCents?: number;
  windowMs?: number;
  disabled?: boolean;
  now?: () => Date;
}>;

export const DEFAULT_AGENT_GRANT_RATE_LIMIT_RULE = {
  max: 60,
  windowMs: 60_000,
} as const satisfies RateLimitRule;

export const DEFAULT_AGENT_GRANT_SPEND_CAP_CENTS = 50_000;
export const DEFAULT_AGENT_GRANT_SPEND_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const platformAgentGuardrailsSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_agent_grant_spend_authorizations (
  operation_id text PRIMARY KEY,
  grant_id text NOT NULL,
  account_id text NULL,
  operation text NOT NULL,
  amount_cents integer NOT NULL,
  authorized_at timestamptz NOT NULL,
  window_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_agent_grant_spend_authorizations_grant_window_idx
  ON platform_agent_grant_spend_authorizations (grant_id, window_started_at, authorized_at);
`;

export function agentGrantIdFromActor(actor: ResolvedActor | null | undefined) {
  const sessionId = actor?.sessionId ?? "";
  return sessionId.startsWith("ucp:") ? sessionId.slice("ucp:".length) || null : null;
}

export function createAgentGrantRateLimiter(
  rule: RateLimitRule = DEFAULT_AGENT_GRANT_RATE_LIMIT_RULE,
  options: Readonly<{ limiter?: InMemoryRateLimiter; env?: Record<string, string | undefined> }> = {},
): AgentGrantRateLimiter {
  const limiter =
    options.limiter ??
    createConfiguredInMemoryRateLimiter("agent-grant.write", rule, {
      env: options.env,
      keyPrefix: "agent-grant:write",
    });

  return {
    check(input) {
      const decision = limiter.check(agentGrantRateLimitKey(input));
      if (!decision.limited) {
        return { allowed: true, decision };
      }

      return {
        allowed: false,
        decision,
        reason: "This agent grant is sending writes too quickly. Retry after the rate-limit window.",
      };
    },
  };
}

export function createInMemoryAgentGrantSpendPolicy(
  options: AgentGrantSpendCapPolicyOptions = {},
): AgentGrantSpendPolicy {
  const capCents = normalizePositiveInteger(options.capCents, DEFAULT_AGENT_GRANT_SPEND_CAP_CENTS);
  const windowMs = normalizePositiveInteger(options.windowMs, DEFAULT_AGENT_GRANT_SPEND_CAP_WINDOW_MS);
  const now = options.now ?? (() => new Date());
  const records = new Map<string, AgentGrantSpendPolicyInput & { authorizedAt: number }>();

  return {
    authorize(input) {
      if (options.disabled || input.amountCents <= 0 || !input.grantId) {
        return { allowed: true };
      }

      const checkedAt = now().getTime();
      const windowStart = checkedAt - windowMs;
      for (const [operationId, record] of records) {
        if (record.authorizedAt < windowStart) {
          records.delete(operationId);
        }
      }

      const previous = records.get(input.operationId);
      if (previous) {
        return { allowed: true };
      }

      const spentCents = [...records.values()]
        .filter((record) => record.grantId === input.grantId && record.authorizedAt >= windowStart)
        .reduce((total, record) => total + record.amountCents, 0);
      const remainingCents = Math.max(capCents - spentCents, 0);
      if (input.amountCents > remainingCents) {
        return {
          allowed: false,
          reason: "This agent grant exceeded its platform spend cap.",
          remainingCents,
          capCents,
        };
      }

      records.set(input.operationId, { ...input, authorizedAt: checkedAt });
      return { allowed: true };
    },
  };
}

export function createPostgresAgentGrantSpendPolicy(
  db: PgQueryable,
  options: AgentGrantSpendCapPolicyOptions = {},
): AgentGrantSpendPolicy {
  const capCents = normalizePositiveInteger(options.capCents, DEFAULT_AGENT_GRANT_SPEND_CAP_CENTS);
  const windowMs = normalizePositiveInteger(options.windowMs, DEFAULT_AGENT_GRANT_SPEND_CAP_WINDOW_MS);
  const now = options.now ?? (() => new Date());

  return {
    async authorize(input) {
      if (options.disabled || input.amountCents <= 0 || !input.grantId) {
        return { allowed: true };
      }

      const checkedAt = input.occurredAt ?? now();
      const windowStartedAt = new Date(checkedAt.getTime() - windowMs);
      const previous = await db.query<{ operation_id: string }>(
        `SELECT operation_id
         FROM platform_agent_grant_spend_authorizations
         WHERE operation_id = $1`,
        [input.operationId],
      );
      if (previous.rows.length > 0) {
        return { allowed: true };
      }

      const spent = await db.query<{ spent_cents: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0)::text AS spent_cents
         FROM platform_agent_grant_spend_authorizations
         WHERE grant_id = $1
           AND authorized_at >= $2::timestamptz`,
        [input.grantId, windowStartedAt.toISOString()],
      );
      const spentCents = Number(spent.rows[0]?.spent_cents ?? 0);
      const remainingCents = Math.max(capCents - spentCents, 0);
      if (input.amountCents > remainingCents) {
        return {
          allowed: false,
          reason: "This agent grant exceeded its platform spend cap.",
          remainingCents,
          capCents,
        };
      }

      await db.query(
        `INSERT INTO platform_agent_grant_spend_authorizations (
           operation_id,
           grant_id,
           account_id,
           operation,
           amount_cents,
           authorized_at,
           window_started_at
         ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
         ON CONFLICT (operation_id) DO NOTHING`,
        [
          input.operationId,
          input.grantId,
          input.accountId,
          input.operation,
          input.amountCents,
          checkedAt.toISOString(),
          windowStartedAt.toISOString(),
        ],
      );

      return { allowed: true };
    },
  };
}

function agentGrantRateLimitKey(input: AgentGrantRateLimitInput) {
  if (input.grantId) {
    return `grant:${input.grantId}:operation:${input.operation}`;
  }

  if (input.accountId || input.actorId) {
    return `account:${input.accountId ?? "unknown"}:actor:${input.actorId ?? "unknown"}:operation:${input.operation}`;
  }

  return `anonymous:operation:${input.operation}`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
