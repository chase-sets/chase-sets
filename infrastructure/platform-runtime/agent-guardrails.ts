import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
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

// The payment rails an agent grant can be authorized to move money over. `handoff-only`
// keeps the human in the loop through the trusted checkout UI; `stored-pm` and `ap2`
// are autonomous rails opened by the stored-payment-method setup and AP2 mandates.
export const AGENT_GRANT_RAILS = ["handoff-only", "stored-pm", "ap2"] as const;
export type AgentGrantRail = (typeof AGENT_GRANT_RAILS)[number];

export function isAgentGrantRail(value: unknown): value is AgentGrantRail {
  return typeof value === "string" && (AGENT_GRANT_RAILS as readonly string[]).includes(value);
}

// Per-grant spending mandate — the consent state a person configures for an agent grant.
// A `null` cap means "no explicit ceiling"; `0` means "no autonomous spend on that period".
export type AgentSpendingMandate = Readonly<{
  maxPerOrderCents: number | null;
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
  humanPresentRequired: boolean;
  allowedRails: readonly AgentGrantRail[];
}>;

// Conservative default until the person opts in during consent or the connected-agents UI:
// no autonomous money movement at all — every purchase must go through a trusted handoff.
export const HANDOFF_ONLY_SPENDING_MANDATE: AgentSpendingMandate = {
  maxPerOrderCents: 0,
  dailyCapCents: 0,
  monthlyCapCents: 0,
  humanPresentRequired: true,
  allowedRails: ["handoff-only"],
};

export type AgentGrantSpendLimitKind =
  | "rail-not-allowed"
  | "human-present-required"
  | "human-not-present-unsupported"
  | "per-order-cap"
  | "daily-cap"
  | "monthly-cap";

export type AgentGrantSpendPolicyDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      limitKind: AgentGrantSpendLimitKind;
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
  // Payment rail the completion intends to move money over. Omitted for
  // purchase-intent operations (offers) that never create a PaymentIntent.
  rail?: AgentGrantRail | null;
  // Whether a person is actively present for this purchase (trusted-UI review).
  humanPresent?: boolean;
  // Whether the rail carries an explicit human-not-present authorization
  // (an AP2 human-not-present mandate or a standing instruction).
  humanNotPresentAuthorized?: boolean;
  occurredAt?: Date;
}>;

export type AgentGrantSpendSummary = Readonly<{
  dailyCents: number;
  monthlyCents: number;
}>;

export type AgentGrantConsentDirectory = Readonly<{
  resolveMandate: (grantId: string) => Promise<AgentSpendingMandate>;
  setMandate: (
    params: Readonly<{ grantId: string; accountId: string; mandate: AgentSpendingMandate }>,
  ) => Promise<void>;
  getSpendSummary: (grantId: string, now?: Date) => Promise<AgentGrantSpendSummary>;
}>;

export type AgentGrantMandateResolver = (grantId: string) => Promise<AgentSpendingMandate> | AgentSpendingMandate;

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
  // Absolute platform ceiling applied on top of the per-grant mandate as defense in depth.
  capCents?: number;
  windowMs?: number;
  disabled?: boolean;
  now?: () => Date;
  // Resolves the per-grant mandate. Defaults to the conservative handoff-only mandate.
  mandateResolver?: AgentGrantMandateResolver;
}>;

export const DEFAULT_AGENT_GRANT_RATE_LIMIT_RULE = {
  max: 60,
  windowMs: 60_000,
} as const satisfies RateLimitRule;

export const DEFAULT_AGENT_GRANT_SPEND_CAP_CENTS = 50_000;
export const DEFAULT_AGENT_GRANT_SPEND_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const platformAgentGuardrailsSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_agent_grant_spend_authorizations (
  operation_id text PRIMARY KEY,
  grant_id text NOT NULL,
  account_id text NULL,
  operation text NOT NULL,
  amount_cents integer NOT NULL,
  rail text NULL,
  authorized_at timestamptz NOT NULL,
  window_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_agent_grant_spend_authorizations
  ADD COLUMN IF NOT EXISTS rail text NULL;

CREATE INDEX IF NOT EXISTS platform_agent_grant_spend_authorizations_grant_window_idx
  ON platform_agent_grant_spend_authorizations (grant_id, authorized_at);

CREATE TABLE IF NOT EXISTS platform_agent_grant_spending_mandates (
  grant_id text PRIMARY KEY,
  account_id text NOT NULL,
  max_per_order_cents integer NULL,
  daily_cap_cents integer NULL,
  monthly_cap_cents integer NULL,
  human_present_required boolean NOT NULL DEFAULT true,
  allowed_rails jsonb NOT NULL DEFAULT '["handoff-only"]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
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

// Pure enforcement decision. Restrictions on rail/human-presence are evaluated before caps
// so the person always receives the most fundamental reason to hand off.
export function decideAgentGrantSpend(
  params: Readonly<{
    mandate: AgentSpendingMandate;
    amountCents: number;
    rail: AgentGrantRail | null;
    humanPresent: boolean;
    humanNotPresentAuthorized: boolean;
    spentDailyCents: number;
    spentMonthlyCents: number;
    platformCeilingCents?: number;
  }>,
): AgentGrantSpendPolicyDecision {
  const { mandate, amountCents, rail, humanPresent, humanNotPresentAuthorized } = params;

  // Rail and human-presence gates only apply to operations that actually move money.
  // Purchase-intent operations (offers) pass a null rail and are governed by caps alone.
  if (rail !== null) {
    if (!mandate.allowedRails.includes(rail)) {
      return {
        allowed: false,
        limitKind: "rail-not-allowed",
        reason: `This agent grant is not authorized to pay over the ${rail} rail. Continue in a trusted checkout.`,
        remainingCents: 0,
        capCents: 0,
      };
    }

    if (!humanPresent && mandate.humanPresentRequired) {
      return {
        allowed: false,
        limitKind: "human-present-required",
        reason: "This agent grant requires a person to approve purchases. Continue in a trusted checkout.",
        remainingCents: 0,
        capCents: 0,
      };
    }

    if (!humanPresent && !humanNotPresentAuthorized) {
      return {
        allowed: false,
        limitKind: "human-not-present-unsupported",
        reason:
          "This purchase cannot be completed while the buyer is away without an AP2 human-not-present mandate. Continue in a trusted checkout.",
        remainingCents: 0,
        capCents: 0,
      };
    }
  }

  const perOrderCap = mandate.maxPerOrderCents;
  if (perOrderCap !== null && amountCents > perOrderCap) {
    return {
      allowed: false,
      limitKind: "per-order-cap",
      reason: `This ${formatUsd(amountCents)} purchase exceeds the agent grant's ${formatUsd(perOrderCap)} per-order limit.`,
      remainingCents: perOrderCap,
      capCents: perOrderCap,
    };
  }

  const dailyDecision = evaluateWindowCap({
    kind: "daily-cap",
    label: "daily",
    capCents: minCap(mandate.dailyCapCents, params.platformCeilingCents),
    spentCents: params.spentDailyCents,
    amountCents,
  });
  if (dailyDecision) {
    return dailyDecision;
  }

  const monthlyDecision = evaluateWindowCap({
    kind: "monthly-cap",
    label: "monthly",
    capCents: mandate.monthlyCapCents,
    spentCents: params.spentMonthlyCents,
    amountCents,
  });
  if (monthlyDecision) {
    return monthlyDecision;
  }

  return { allowed: true };
}

function evaluateWindowCap(
  params: Readonly<{
    kind: "daily-cap" | "monthly-cap";
    label: string;
    capCents: number | null;
    spentCents: number;
    amountCents: number;
  }>,
): (AgentGrantSpendPolicyDecision & { allowed: false }) | null {
  if (params.capCents === null) {
    return null;
  }
  const remainingCents = Math.max(params.capCents - params.spentCents, 0);
  if (params.amountCents <= remainingCents) {
    return null;
  }
  return {
    allowed: false,
    limitKind: params.kind,
    reason: `This ${formatUsd(params.amountCents)} purchase exceeds the agent grant's ${formatUsd(
      params.capCents,
    )} ${params.label} limit; ${formatUsd(remainingCents)} remains.`,
    remainingCents,
    capCents: params.capCents,
  };
}

export function createInMemoryAgentGrantSpendPolicy(
  options: AgentGrantSpendCapPolicyOptions = {},
): AgentGrantSpendPolicy {
  const platformCeilingCents = normalizePositiveIntegerOrNull(options.capCents);
  const now = options.now ?? (() => new Date());
  const resolveMandate = options.mandateResolver ?? (() => HANDOFF_ONLY_SPENDING_MANDATE);
  const records = new Map<string, { grantId: string; amountCents: number; authorizedAt: number }>();

  return {
    async authorize(input) {
      if (options.disabled || !input.grantId) {
        return { allowed: true };
      }

      const checkedAt = (input.occurredAt ?? now()).getTime();
      const previous = records.get(input.operationId);
      if (previous) {
        return { allowed: true };
      }

      const mandate = await resolveMandate(input.grantId);
      const spentDailyCents = sumRecords(records, input.grantId, checkedAt - DAILY_WINDOW_MS);
      const spentMonthlyCents = sumRecords(records, input.grantId, checkedAt - MONTHLY_WINDOW_MS);
      const decision = decideAgentGrantSpend({
        mandate,
        amountCents: input.amountCents,
        rail: input.rail ?? null,
        humanPresent: input.humanPresent ?? false,
        humanNotPresentAuthorized: input.humanNotPresentAuthorized ?? false,
        spentDailyCents,
        spentMonthlyCents,
        platformCeilingCents: platformCeilingCents ?? undefined,
      });
      if (!decision.allowed) {
        return decision;
      }

      records.set(input.operationId, {
        grantId: input.grantId,
        amountCents: input.amountCents,
        authorizedAt: checkedAt,
      });
      return { allowed: true };
    },
  };

  function sumRecords(
    entries: Map<string, { grantId: string; amountCents: number; authorizedAt: number }>,
    grantId: string,
    windowStart: number,
  ) {
    let total = 0;
    for (const record of entries.values()) {
      if (record.grantId === grantId && record.authorizedAt >= windowStart) {
        total += record.amountCents;
      }
    }
    return total;
  }
}

export function createPostgresAgentGrantSpendPolicy(
  pool: PgTransactionalPool,
  options: AgentGrantSpendCapPolicyOptions = {},
): AgentGrantSpendPolicy {
  const platformCeilingCents = normalizePositiveIntegerOrNull(options.capCents);
  const now = options.now ?? (() => new Date());
  const resolveMandate = options.mandateResolver ?? (() => Promise.resolve(HANDOFF_ONLY_SPENDING_MANDATE));

  return {
    async authorize(input) {
      if (options.disabled || !input.grantId) {
        return { allowed: true };
      }

      const grantId = input.grantId;
      const checkedAt = input.occurredAt ?? now();

      // Single-flight per grant: the advisory lock serializes concurrent completions so two
      // in-flight purchases cannot jointly read a stale spend total and jointly exceed the cap.
      return withPgTransaction<AgentGrantSpendPolicyDecision>(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `agent-grant-spend:${grantId}`,
        ]);

        const previous = await client.query<{ operation_id: string }>(
          `SELECT operation_id FROM platform_agent_grant_spend_authorizations WHERE operation_id = $1`,
          [input.operationId],
        );
        if (previous.rows.length > 0) {
          return { allowed: true };
        }

        const mandate = await resolveMandate(grantId);
        const spentDailyCents = await sumWindowSpend(client, grantId, new Date(checkedAt.getTime() - DAILY_WINDOW_MS));
        const spentMonthlyCents = await sumWindowSpend(
          client,
          grantId,
          new Date(checkedAt.getTime() - MONTHLY_WINDOW_MS),
        );

        const decision = decideAgentGrantSpend({
          mandate,
          amountCents: input.amountCents,
          rail: input.rail ?? null,
          humanPresent: input.humanPresent ?? false,
          humanNotPresentAuthorized: input.humanNotPresentAuthorized ?? false,
          spentDailyCents,
          spentMonthlyCents,
          platformCeilingCents: platformCeilingCents ?? undefined,
        });
        if (!decision.allowed) {
          return decision;
        }

        await client.query(
          `INSERT INTO platform_agent_grant_spend_authorizations (
             operation_id,
             grant_id,
             account_id,
             operation,
             amount_cents,
             rail,
             authorized_at,
             window_started_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
           ON CONFLICT (operation_id) DO NOTHING`,
          [
            input.operationId,
            grantId,
            input.accountId,
            input.operation,
            input.amountCents,
            input.rail ?? null,
            checkedAt.toISOString(),
            new Date(checkedAt.getTime() - DAILY_WINDOW_MS).toISOString(),
          ],
        );

        return { allowed: true };
      });
    },
  };
}

export function createPostgresAgentGrantConsentDirectory(pool: PgQueryable): AgentGrantConsentDirectory {
  return {
    resolveMandate: async (grantId) => {
      const result = await pool.query<MandateRow>(
        `SELECT max_per_order_cents, daily_cap_cents, monthly_cap_cents, human_present_required, allowed_rails
         FROM platform_agent_grant_spending_mandates
         WHERE grant_id = $1
         LIMIT 1`,
        [grantId],
      );
      const row = result.rows[0];
      return row ? mapMandateRow(row) : HANDOFF_ONLY_SPENDING_MANDATE;
    },
    setMandate: async ({ grantId, accountId, mandate }) => {
      const normalized = normalizeMandate(mandate);
      await pool.query(
        `INSERT INTO platform_agent_grant_spending_mandates (
           grant_id, account_id, max_per_order_cents, daily_cap_cents, monthly_cap_cents,
           human_present_required, allowed_rails, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
         ON CONFLICT (grant_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           max_per_order_cents = EXCLUDED.max_per_order_cents,
           daily_cap_cents = EXCLUDED.daily_cap_cents,
           monthly_cap_cents = EXCLUDED.monthly_cap_cents,
           human_present_required = EXCLUDED.human_present_required,
           allowed_rails = EXCLUDED.allowed_rails,
           updated_at = now()`,
        [
          grantId,
          accountId,
          normalized.maxPerOrderCents,
          normalized.dailyCapCents,
          normalized.monthlyCapCents,
          normalized.humanPresentRequired,
          JSON.stringify(normalized.allowedRails),
        ],
      );
    },
    getSpendSummary: async (grantId, now = new Date()) => {
      const dailyCents = await sumWindowSpend(pool, grantId, new Date(now.getTime() - DAILY_WINDOW_MS));
      const monthlyCents = await sumWindowSpend(pool, grantId, new Date(now.getTime() - MONTHLY_WINDOW_MS));
      return { dailyCents, monthlyCents };
    },
  };
}

export function normalizeMandate(mandate: AgentSpendingMandate): AgentSpendingMandate {
  const allowedRails = [...new Set(mandate.allowedRails.filter(isAgentGrantRail))];
  return {
    maxPerOrderCents: normalizeNonNegativeIntegerOrNull(mandate.maxPerOrderCents),
    dailyCapCents: normalizeNonNegativeIntegerOrNull(mandate.dailyCapCents),
    monthlyCapCents: normalizeNonNegativeIntegerOrNull(mandate.monthlyCapCents),
    humanPresentRequired: mandate.humanPresentRequired !== false,
    allowedRails: allowedRails.length > 0 ? allowedRails : ["handoff-only"],
  };
}

async function sumWindowSpend(db: PgQueryable, grantId: string, windowStartedAt: Date) {
  const result = await db.query<{ spent_cents: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS spent_cents
     FROM platform_agent_grant_spend_authorizations
     WHERE grant_id = $1
       AND authorized_at >= $2::timestamptz`,
    [grantId, windowStartedAt.toISOString()],
  );
  return Number(result.rows[0]?.spent_cents ?? 0);
}

type MandateRow = Readonly<{
  max_per_order_cents: number | null;
  daily_cap_cents: number | null;
  monthly_cap_cents: number | null;
  human_present_required: boolean;
  allowed_rails: unknown;
}>;

function mapMandateRow(row: MandateRow): AgentSpendingMandate {
  const rails = Array.isArray(row.allowed_rails) ? row.allowed_rails.filter(isAgentGrantRail) : [];
  return {
    maxPerOrderCents: normalizeNonNegativeIntegerOrNull(row.max_per_order_cents),
    dailyCapCents: normalizeNonNegativeIntegerOrNull(row.daily_cap_cents),
    monthlyCapCents: normalizeNonNegativeIntegerOrNull(row.monthly_cap_cents),
    humanPresentRequired: row.human_present_required !== false,
    allowedRails: rails.length > 0 ? rails : ["handoff-only"],
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

function minCap(a: number | null, b: number | null | undefined): number | null {
  if (a === null && (b === null || b === undefined)) {
    return null;
  }
  if (a === null) {
    return b ?? null;
  }
  if (b === null || b === undefined) {
    return a;
  }
  return Math.min(a, b);
}

function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function normalizePositiveIntegerOrNull(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeNonNegativeIntegerOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
