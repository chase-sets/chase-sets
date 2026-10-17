import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  economicsFactNames,
  parseFactValue,
  requireCurrency,
  requireRfc3339Instant,
  type EconomicsFactName,
} from "../domain/contracts";
import {
  initialEconomicsOverridesState,
  type EconomicsOverrideEntry,
  type EconomicsOverrideKey,
  type EconomicsOverridesState,
} from "../domain/overrides";

type EconomicsOverrideRow = Readonly<{
  fact_name: string;
  override_state: string;
  override_value: unknown;
  set_at: string | null;
  cleared_at: string | null;
  last_stream_version: number;
}>;

/** Reads the durable current projection. Historical effective-time reads use
 * the event stream in the runtime; this query exists for operational/current
 * reads and projection/reset verification. */
export async function readCurrentEconomicsOverrides(
  db: PgQueryable,
  key: EconomicsOverrideKey,
): Promise<EconomicsOverridesState> {
  const initial = initialEconomicsOverridesState(key);
  const result = await db.query<EconomicsOverrideRow>(
    `SELECT
       pricing_economics_overrides.fact_name,
       pricing_economics_overrides.override_state,
       pricing_economics_overrides.override_value,
       pricing_economics_overrides.set_at::text,
       pricing_economics_overrides.cleared_at::text,
       pricing_economics_overrides.last_stream_version
     FROM pricing_economics_overrides
     WHERE pricing_economics_overrides.account_id = $1
       AND pricing_economics_overrides.scope_key = $2
       AND pricing_economics_overrides.currency_code = $3
     ORDER BY pricing_economics_overrides.last_stream_version ASC`,
    [key.accountId, key.scopeKey, requireCurrency(key.currency, "currency")],
  );

  const entries: Partial<Record<EconomicsFactName, EconomicsOverrideEntry>> = {};
  let version = 0;
  for (const row of result.rows) {
    const factName = parseFactName(row.fact_name);
    if (!Number.isSafeInteger(row.last_stream_version) || row.last_stream_version <= version) {
      throw new Error("Economics override projection versions must be strictly increasing.");
    }
    version = row.last_stream_version;
    if (row.override_state === "cleared") {
      if (row.set_at !== null || row.cleared_at === null) {
        throw new Error("Economics override tombstone has an invalid timestamp posture.");
      }
      entries[factName] = {
        kind: "cleared",
        factName,
        value: null,
        revision: row.last_stream_version,
        setAt: null,
        clearedAt: databaseInstant(row.cleared_at, `${factName} clearedAt`),
      };
      continue;
    }
    if (row.override_state !== "active") throw new Error("Economics override state is unknown.");
    if (row.set_at === null || row.cleared_at !== null) {
      throw new Error("Active Economics override has an invalid timestamp posture.");
    }
    entries[factName] = {
      kind: "active",
      factName,
      value: parseFactValue(factName, row.override_value, initial.key.currency),
      revision: row.last_stream_version,
      setAt: databaseInstant(row.set_at, `${factName} setAt`),
      clearedAt: null,
    };
  }

  const lastChangedAt = result.rows.reduce<string | null>((latest, row) => {
    const rawChangedAt = row.set_at ?? row.cleared_at;
    const changedAt = rawChangedAt === null ? null : databaseInstant(rawChangedAt, `${row.fact_name} changedAt`);
    return changedAt !== null && (latest === null || Date.parse(changedAt) > Date.parse(latest)) ? changedAt : latest;
  }, null);
  return { ...initial, version, lastChangedAt, entries };
}

function databaseInstant(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid database instant.`);
  return requireRfc3339Instant(new Date(parsed).toISOString(), name);
}

function parseFactName(value: string): EconomicsFactName {
  if (!(economicsFactNames as readonly string[]).includes(value)) {
    throw new Error(`Unknown Economics fact ${value}.`);
  }
  return value as EconomicsFactName;
}
