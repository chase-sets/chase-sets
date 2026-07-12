import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { McpAuditRecord } from "./mcp";

// A durable, queryable read model built directly off the existing MCP audit sink
// (`McpAuditSink`, `infrastructure/platform-runtime/mcp.ts`). Every native MCP
// tool/resource invocation already flows through that sink today — this module
// only adds a Postgres write to the same records, so the connected-agents
// activity view has something to read without opening a second logging path.
export const platformMcpAuditLogSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_mcp_audit_log (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  method text NOT NULL,
  tool_name text NULL,
  resource_uri text NULL,
  actor_id text NULL,
  account_id text NULL,
  agent_grant_id text NULL,
  agent_grant_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  audit_event_name text NULL,
  target_type text NULL,
  reason text NULL,
  limit_kind text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_mcp_audit_log_grant_occurred_at_idx
  ON platform_mcp_audit_log (agent_grant_id, occurred_at DESC)
  WHERE agent_grant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_mcp_audit_log_account_occurred_at_idx
  ON platform_mcp_audit_log (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;
`;

export type AgentGrantActivityRecord = Readonly<{
  id: string;
  occurredAt: string;
  outcome: "allowed" | "denied" | "failed";
  method: string;
  toolName: string | null;
  resourceUri: string | null;
  auditEventName: string | null;
  targetType: string | null;
  reason: string | null;
  limitKind: string | null;
}>;

export type AgentGrantActivityPage = Readonly<{
  items: readonly AgentGrantActivityRecord[];
  total: number;
}>;

// Read side of the persisted audit trail, scoped by account so a grant lookup
// can never cross an account boundary even if grant ids were guessable.
export type AgentGrantActivityDirectory = Readonly<{
  listForGrant: (
    params: Readonly<{ accountId: string; grantId: string; limit: number; offset: number }>,
  ) => Promise<AgentGrantActivityPage>;
}>;

// Write side — matches `McpAuditSink` so it can be composed directly into the
// sink already wired in the platform-api composition root.
export type McpAuditLogWriter = Readonly<{
  record: (auditRecord: McpAuditRecord, occurredAt?: Date) => Promise<void>;
}>;

export type PostgresMcpAuditLog = AgentGrantActivityDirectory & McpAuditLogWriter;

type AuditLogRow = Readonly<{
  id: string;
  occurred_at: string;
  outcome: string;
  method: string;
  tool_name: string | null;
  resource_uri: string | null;
  audit_event_name: string | null;
  target_type: string | null;
  reason: string | null;
  limit_kind: string | null;
}>;

const DEFAULT_ACTIVITY_PAGE_LIMIT = 50;
const MAX_ACTIVITY_PAGE_LIMIT = 200;

export function createPostgresMcpAuditLog(pool: PgQueryable): PostgresMcpAuditLog {
  return {
    record: async (auditRecord, occurredAt = new Date()) => {
      await pool.query(
        `INSERT INTO platform_mcp_audit_log (
           id, occurred_at, outcome, method, tool_name, resource_uri, actor_id, account_id,
           agent_grant_id, agent_grant_scopes, audit_event_name, target_type, reason, limit_kind
         ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)`,
        [
          createId("mal"),
          occurredAt.toISOString(),
          auditRecord.outcome,
          auditRecord.method,
          auditRecord.toolName ?? null,
          auditRecord.resourceUri ?? null,
          auditRecord.actorId ?? null,
          auditRecord.accountId ?? null,
          auditRecord.agentGrantId ?? null,
          JSON.stringify(auditRecord.agentGrantScopes ?? []),
          auditRecord.auditEventName ?? null,
          auditRecord.targetType ?? null,
          auditRecord.reason ?? null,
          auditRecord.limitKind ?? null,
        ],
      );
    },
    listForGrant: async ({ accountId, grantId, limit, offset }) => {
      const boundedLimit = Math.min(
        Math.max(1, Math.floor(limit) || DEFAULT_ACTIVITY_PAGE_LIMIT),
        MAX_ACTIVITY_PAGE_LIMIT,
      );
      const boundedOffset = Math.max(0, Math.floor(offset) || 0);

      const [rows, count] = await Promise.all([
        pool.query<AuditLogRow>(
          `SELECT id, occurred_at, outcome, method, tool_name, resource_uri,
                  audit_event_name, target_type, reason, limit_kind
           FROM platform_mcp_audit_log
           WHERE account_id = $1 AND agent_grant_id = $2
           ORDER BY occurred_at DESC, id DESC
           LIMIT $3 OFFSET $4`,
          [accountId, grantId, boundedLimit, boundedOffset],
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM platform_mcp_audit_log WHERE account_id = $1 AND agent_grant_id = $2`,
          [accountId, grantId],
        ),
      ]);

      return {
        items: rows.rows.map(mapAuditLogRow),
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
  };
}

function mapAuditLogRow(row: AuditLogRow): AgentGrantActivityRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    outcome: isAuditOutcome(row.outcome) ? row.outcome : "failed",
    method: row.method,
    toolName: row.tool_name,
    resourceUri: row.resource_uri,
    auditEventName: row.audit_event_name,
    targetType: row.target_type,
    reason: row.reason,
    limitKind: row.limit_kind,
  };
}

function isAuditOutcome(value: string): value is AgentGrantActivityRecord["outcome"] {
  return value === "allowed" || value === "denied" || value === "failed";
}
