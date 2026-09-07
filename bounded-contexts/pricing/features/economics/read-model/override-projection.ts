import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  economicsFactNames,
  parseFactValue,
  requireCurrency,
  requireRfc3339Instant,
  type EconomicsFactName,
} from "../domain/contracts";

type OverrideProjectionPayload = Readonly<{
  accountId: string;
  connectionId: string;
  currency: string;
  factName: EconomicsFactName;
  value: unknown;
  occurredAt: string;
}>;

export function buildEconomicsOverrideProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project = async (
    event: Readonly<{
      id: string;
      streamVersion: number;
      data: Record<string, unknown>;
      timing: Readonly<{ recordedAt: string }>;
    }>,
    kind: "set" | "cleared",
  ): Promise<void> => {
    if (!Number.isSafeInteger(event.streamVersion) || event.streamVersion < 1) {
      throw new Error("Economics override projection requires a positive stream version.");
    }
    const data = parsePayload(event.data, kind);
    const value = kind === "set" ? parseFactValue(data.factName, data.value, data.currency) : null;
    const occurredAt = requireRfc3339Instant(data.occurredAt, "occurredAt");

    await db.query(
      `INSERT INTO pricing_economics_overrides (
         account_id,
         connection_id,
         currency_code,
         fact_name,
         override_state,
         override_value,
         set_at,
         cleared_at,
         last_stream_version,
         last_source_event_id,
         last_source_event_recorded_at
       )
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11
       WHERE NOT EXISTS (
         SELECT 1
         FROM pricing_economics_overrides AS stream_watermark
         WHERE stream_watermark.account_id = $1
           AND stream_watermark.connection_id = $2
           AND stream_watermark.currency_code = $3
           AND stream_watermark.last_stream_version >= $9
       )
       ON CONFLICT (account_id, connection_id, currency_code, fact_name) DO UPDATE
       SET override_state = EXCLUDED.override_state,
           override_value = EXCLUDED.override_value,
           set_at = EXCLUDED.set_at,
           cleared_at = EXCLUDED.cleared_at,
           last_stream_version = EXCLUDED.last_stream_version,
           last_source_event_id = EXCLUDED.last_source_event_id,
           last_source_event_recorded_at = EXCLUDED.last_source_event_recorded_at
       WHERE pricing_economics_overrides.last_stream_version < EXCLUDED.last_stream_version`,
      [
        data.accountId,
        data.connectionId,
        data.currency,
        data.factName,
        kind === "set" ? "active" : "cleared",
        kind === "set" ? JSON.stringify(value) : null,
        kind === "set" ? occurredAt : null,
        kind === "cleared" ? occurredAt : null,
        event.streamVersion,
        event.id,
        event.timing.recordedAt,
      ],
    );
  };

  return {
    "pricing.economics-fact-override-set": async (event) => project(event, "set"),
    "pricing.economics-fact-override-cleared": async (event) => project(event, "cleared"),
  };
}

function parsePayload(raw: Record<string, unknown>, kind: "set" | "cleared"): OverrideProjectionPayload {
  const expected = ["accountId", "connectionId", "currency", "factName", "occurredAt", "value"].sort();
  const actual = Object.keys(raw).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Economics override event data must contain exactly: ${expected.join(", ")}.`);
  }
  const accountId = identity(raw.accountId, "accountId");
  const connectionId = identity(raw.connectionId, "connectionId");
  const currency = requireCurrency(raw.currency, "currency");
  const factName = raw.factName;
  if (typeof factName !== "string" || !(economicsFactNames as readonly string[]).includes(factName)) {
    throw new Error("Economics override factName is not supported.");
  }
  if (kind === "cleared" && raw.value !== null) throw new Error("A cleared Economics override must carry null.");
  return {
    accountId,
    connectionId,
    currency,
    factName: factName as EconomicsFactName,
    value: raw.value,
    occurredAt: requireRfc3339Instant(raw.occurredAt, "occurredAt"),
  };
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be non-empty and already trimmed.`);
  }
  return value;
}
