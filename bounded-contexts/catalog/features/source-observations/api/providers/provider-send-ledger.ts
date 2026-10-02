import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  ProviderSendStoppedError,
  providerSendCategories,
  providerSendPolicy,
  providerSendProviders,
  type ProviderSendBinding,
  type ProviderSendDebit,
  type ProviderSendLedger,
  type ProviderSendRefusal,
  type ProviderSendRequest,
} from "./provider-send-admission";

export const providerSendMemberOrdinals = [1, 2, 9, 10, 17, 18] as const;
export type ProviderSendMember = Readonly<{
  ordinal: (typeof providerSendMemberOrdinals)[number];
  unitKey: string;
  language: "en";
  coordinate: string;
}>;
export type ProviderSendWindowInstallation = Readonly<{
  windowId: string;
  actor: string;
  armedAt: string;
  members: readonly ProviderSendMember[];
}>;
type WindowRow = Readonly<{
  window_id: string;
  phase: "preflight" | "pass";
  pass: number;
  state: "armed" | "terminal";
  members: unknown;
  policy: unknown;
  armed_at: string;
  used: number;
  refusal: ProviderSendRefusal | null;
}>;
type Quota = Readonly<{ pass: number; bucket: string; quota: number }>;
const expectedUnits: Readonly<Record<number, string>> = {
  1: "scrydex:lorcana:single-card:source-observation-import",
  2: "scrydex:lorcana:set:reference-data",
  9: "scrydex:lorcana:single-card:source-observation-import",
  10: "scrydex:lorcana:set:reference-data",
  17: "scrydex:one-piece:single-card:source-observation-import",
  18: "scrydex:one-piece:sealed-product:source-observation-import",
};
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function invalid(): never {
  throw new ProviderSendStoppedError("authority-unavailable");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function validateProviderSendInstallation(value: unknown): ProviderSendWindowInstallation {
  if (
    !record(value) ||
    !exactKeys(value, ["windowId", "actor", "armedAt", "members"]) ||
    typeof value.windowId !== "string" ||
    !safeIdentifier.test(value.windowId) ||
    typeof value.actor !== "string" ||
    !safeIdentifier.test(value.actor) ||
    typeof value.armedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.armedAt) ||
    !Number.isFinite(Date.parse(value.armedAt)) ||
    new Date(value.armedAt).toISOString() !== value.armedAt
  )
    invalid();
  const members = validateMembers(value.members);
  return { windowId: value.windowId, actor: value.actor, armedAt: value.armedAt, members };
}
function validateMembers(value: unknown): readonly ProviderSendMember[] {
  if (!Array.isArray(value) || value.length !== 6) invalid();
  const members: ProviderSendMember[] = [];
  for (const entry of value) {
    if (
      !record(entry) ||
      !exactKeys(entry, ["ordinal", "unitKey", "language", "coordinate"]) ||
      typeof entry.ordinal !== "number" ||
      !providerSendMemberOrdinals.some((ordinal) => ordinal === entry.ordinal) ||
      entry.unitKey !== expectedUnits[entry.ordinal] ||
      entry.language !== "en" ||
      typeof entry.coordinate !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,199}$/.test(entry.coordinate)
    )
      invalid();
    const ordinal = providerSendMemberOrdinals.find((candidate) => candidate === entry.ordinal);
    if (ordinal === undefined || typeof entry.unitKey !== "string") invalid();
    members.push({ ordinal, unitKey: entry.unitKey, language: "en", coordinate: entry.coordinate });
  }
  if (
    new Set(members.map((member) => member.ordinal)).size !== 6 ||
    new Set(members.map((member) => `${member.unitKey}|${member.coordinate}`)).size !== 6
  )
    invalid();
  if (
    members.find((member) => member.ordinal === 1)?.coordinate !==
      members.find((member) => member.ordinal === 2)?.coordinate ||
    members.find((member) => member.ordinal === 9)?.coordinate !==
      members.find((member) => member.ordinal === 10)?.coordinate
  )
    invalid();
  return members;
}

function validateWindow(row: WindowRow): readonly ProviderSendMember[] {
  const policy = row.policy;
  if (
    !safeIdentifier.test(row.window_id) ||
    !["armed", "terminal"].includes(row.state) ||
    !Number.isSafeInteger(row.pass) ||
    row.pass < 0 ||
    row.pass > 9 ||
    row.phase !== (row.pass === 0 ? "preflight" : "pass") ||
    !Number.isSafeInteger(row.used) ||
    row.used < 0 ||
    row.used > providerSendPolicy.totalSends ||
    !record(policy) ||
    !exactKeys(policy, Object.keys(providerSendPolicy)) ||
    Object.entries(providerSendPolicy).some(([key, limit]) => policy[key] !== limit)
  )
    invalid();
  return validateMembers(row.members);
}

export function providerSendInstalledQuotas(): readonly Quota[] {
  const quotas: Quota[] = [
    ...[1, 9, 17].map((ordinal) => ({ pass: 0, bucket: `card-${ordinal}`, quota: providerSendPolicy.preflightCard })),
    { pass: 0, bucket: "usage", quota: providerSendPolicy.preflightUsage },
    { pass: 0, bucket: "other-scrydex", quota: providerSendPolicy.preflightOtherScrydex },
    { pass: 0, bucket: "non-scrydex", quota: providerSendPolicy.nonScrydex },
  ];
  for (let pass = 1; pass <= providerSendPolicy.passes; pass++) {
    quotas.push(
      ...providerSendMemberOrdinals.map((ordinal) => ({
        pass,
        bucket: `payload-${ordinal}`,
        quota: providerSendPolicy.payloadMember,
      })),
      { pass, bucket: "additional-scrydex", quota: providerSendPolicy.additionalScrydex },
      { pass, bucket: "non-scrydex", quota: providerSendPolicy.nonScrydex },
    );
  }
  return quotas;
}

function resolveBucket(
  row: WindowRow,
  members: readonly ProviderSendMember[],
  request: ProviderSendRequest,
): string | null {
  if (
    !providerSendProviders.includes(request.provider) ||
    !providerSendCategories.some((category) => category === request.category)
  )
    return null;
  if (request.tariff !== (request.provider === "scrydex" ? "general-one-credit" : "non-scrydex")) return null;
  if (request.provider !== "scrydex") return "non-scrydex";
  if (request.category === "usage") return row.pass === 0 ? "usage" : "additional-scrydex";
  if (request.category === "card-force" || request.category === "payload") {
    const member = members.find(
      (candidate) =>
        candidate.unitKey === request.unitKey &&
        candidate.language === request.language &&
        candidate.coordinate === request.coordinate,
    );
    if (!member) return null;
    if (request.category === "card-force")
      return row.pass === 0 && [1, 9, 17].includes(member.ordinal) ? `card-${member.ordinal}` : null;
    return row.pass > 0 ? `payload-${member.ordinal}` : null;
  }
  return row.pass === 0 ? "other-scrydex" : "additional-scrydex";
}

function bindingOf(row: WindowRow): ProviderSendBinding {
  return { windowId: row.window_id, phase: row.phase, pass: row.pass };
}
function sameBinding(row: WindowRow, binding: ProviderSendBinding | null | undefined): boolean {
  return binding?.windowId === row.window_id && binding.phase === row.phase && binding.pass === row.pass;
}

export function createPostgresProviderSendLedger(pool: PgTransactionalPool) {
  async function current(db: PgQueryable): Promise<WindowRow | null> {
    const authority = await db.query<{ window_id: string | null }>(
      "SELECT window_id FROM catalog_provider_send_authority WHERE singleton = true FOR UPDATE",
    );
    if (authority.rows.length !== 1) invalid();
    const windowId = authority.rows[0]!.window_id;
    if (windowId === null) {
      const history = await db.query("SELECT window_id FROM catalog_provider_send_windows LIMIT 1");
      if (history.rows.length !== 0) invalid();
      return null;
    }
    const result = await db.query<WindowRow>(
      "SELECT window_id, phase, pass, state, members, policy, armed_at::text, used, refusal FROM catalog_provider_send_windows WHERE window_id = $1 FOR UPDATE",
      [windowId],
    );
    const row = result.rows[0];
    if (!row) invalid();
    validateWindow(row);
    const quotas = await db.query<{ pass: number; bucket: string; quota: number; used: number }>(
      "SELECT pass, bucket, quota, used FROM catalog_provider_send_quotas WHERE window_id = $1",
      [windowId],
    );
    const expectedQuotas = new Map(
      providerSendInstalledQuotas().map((quota) => [`${quota.pass}:${quota.bucket}`, quota.quota]),
    );
    if (
      quotas.rows.length !== expectedQuotas.size ||
      quotas.rows.some(
        (quota) =>
          expectedQuotas.get(`${quota.pass}:${quota.bucket}`) !== quota.quota ||
          !Number.isSafeInteger(quota.used) ||
          quota.used < 0 ||
          quota.used > quota.quota,
      ) ||
      quotas.rows.reduce((sum, quota) => sum + quota.used, 0) !== row.used
    )
      invalid();
    return row;
  }
  async function stopInTransaction(
    db: PgQueryable,
    row: WindowRow,
    code: ProviderSendRefusal,
  ): Promise<ProviderSendDebit> {
    await db.query(
      "UPDATE catalog_provider_send_windows SET state = 'terminal', refusal = COALESCE(refusal, $2), terminated_at = COALESCE(terminated_at, clock_timestamp()) WHERE window_id = $1",
      [row.window_id, code],
    );
    return { state: "refused", code };
  }
  const ledger: ProviderSendLedger = {
    maximum: (request) =>
      withPgTransaction(pool, async (db) => {
        const row = await current(db);
        if (!row || row.state !== "armed" || !sameBinding(row, request.binding)) return null;
        const member = validateMembers(row.members).find(
          (candidate) =>
            candidate.ordinal === 18 &&
            candidate.unitKey === request.unitKey &&
            candidate.language === request.language &&
            candidate.coordinate === request.coordinate,
        );
        return member ? providerSendPolicy.payloadMember : null;
      }),
    bind: () =>
      withPgTransaction(pool, async (db) => {
        const row = await current(db);
        if (row?.state === "terminal") throw new ProviderSendStoppedError("terminal");
        return row ? bindingOf(row) : null;
      }),
    debit: (request) =>
      withPgTransaction(pool, async (db): Promise<ProviderSendDebit> => {
        const row = await current(db);
        if (!row) return { state: "unarmed" };
        if (row.state === "terminal") return { state: "refused", code: "terminal" };
        if (!sameBinding(row, request.binding)) return stopInTransaction(db, row, "stale-binding");
        const bucket = resolveBucket(row, validateMembers(row.members), request);
        if (!bucket) return stopInTransaction(db, row, "unknown-request");
        const expected = providerSendInstalledQuotas().find(
          (quota) => quota.pass === row.pass && quota.bucket === bucket,
        );
        if (!expected) return stopInTransaction(db, row, "unknown-request");
        const debit = await db.query<{ used: number }>(
          "UPDATE catalog_provider_send_quotas SET used = used + 1 WHERE window_id = $1 AND pass = $2 AND bucket = $3 AND quota = $4 AND used < quota RETURNING used",
          [row.window_id, row.pass, bucket, expected.quota],
        );
        if (debit.rows.length !== 1) return stopInTransaction(db, row, "quota-exhausted");
        const sequence = row.used + 1;
        await db.query("UPDATE catalog_provider_send_windows SET used = $2 WHERE window_id = $1", [
          row.window_id,
          sequence,
        ]);
        await db.query(
          "INSERT INTO catalog_provider_send_attempts (window_id, sequence, phase, pass, bucket, provider, category, admitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())",
          [row.window_id, sequence, row.phase, row.pass, bucket, request.provider, request.category],
        );
        return { state: "admitted", windowId: row.window_id, sequence };
      }),
    settle: async (windowId, sequence) => {
      const result = await pool.query(
        "UPDATE catalog_provider_send_attempts SET settled_at = COALESCE(settled_at, clock_timestamp()) WHERE window_id = $1 AND sequence = $2 RETURNING sequence",
        [windowId, sequence],
      );
      if (result.rows.length !== 1) invalid();
    },
    stop: (windowId, code) =>
      withPgTransaction(pool, async (db) => {
        const row = await current(db);
        if (!row || row.window_id !== windowId) invalid();
        await stopInTransaction(db, row, code);
      }),
  };
  return {
    ...ledger,
    arm: (value: unknown) =>
      withPgTransaction(pool, async (db) => {
        const installation = validateProviderSendInstallation(value);
        const row = await current(db);
        if (row?.state === "armed") throw new Error("provider-send-window-already-armed");
        await db.query(
          "INSERT INTO catalog_provider_send_windows (window_id, actor, armed_at, members, policy) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)",
          [
            installation.windowId,
            installation.actor,
            installation.armedAt,
            JSON.stringify(installation.members),
            JSON.stringify(providerSendPolicy),
          ],
        );
        for (const quota of providerSendInstalledQuotas()) {
          await db.query(
            "INSERT INTO catalog_provider_send_quotas (window_id, pass, bucket, quota) VALUES ($1,$2,$3,$4)",
            [installation.windowId, quota.pass, quota.bucket, quota.quota],
          );
        }
        await db.query("UPDATE catalog_provider_send_authority SET window_id = $1 WHERE singleton = true", [
          installation.windowId,
        ]);
        return { windowId: installation.windowId, phase: "preflight" as const, pass: 0 };
      }),
    advance: (expected: ProviderSendBinding) =>
      withPgTransaction(pool, async (db) => {
        const row = await current(db);
        if (!row || row.state !== "armed" || !sameBinding(row, expected) || row.pass >= 9)
          throw new Error("provider-send-window-advance-refused");
        const next = row.pass + 1;
        await db.query("UPDATE catalog_provider_send_windows SET phase = 'pass', pass = $2 WHERE window_id = $1", [
          row.window_id,
          next,
        ]);
        return { windowId: row.window_id, phase: "pass" as const, pass: next };
      }),
    terminate: (expected: ProviderSendBinding) =>
      withPgTransaction(pool, async (db) => {
        const row = await current(db);
        if (!row || !sameBinding(row, expected)) throw new Error("provider-send-window-terminate-refused");
        await stopInTransaction(db, row, "terminal");
      }),
    read: () =>
      withPgTransaction(pool, async (db) => {
        const row = await current(db);
        if (!row) return { state: "unarmed" as const };
        const quotas = await db.query<{ pass: number; bucket: string; quota: number; used: number }>(
          "SELECT pass, bucket, quota, used FROM catalog_provider_send_quotas WHERE window_id = $1 ORDER BY pass, bucket",
          [row.window_id],
        );
        const installed = providerSendInstalledQuotas();
        if (
          quotas.rows.length !== installed.length ||
          installed.some(
            (expected) =>
              !quotas.rows.some(
                (actual) =>
                  actual.pass === expected.pass &&
                  actual.bucket === expected.bucket &&
                  actual.quota === expected.quota &&
                  Number.isSafeInteger(actual.used) &&
                  actual.used >= 0 &&
                  actual.used <= actual.quota,
              ),
          ) ||
          quotas.rows.reduce((sum, quota) => sum + quota.used, 0) !== row.used
        )
          invalid();
        const attempts = await db.query<{
          sequence: number;
          phase: string;
          pass: number;
          bucket: string;
          provider: string;
          category: string;
          admittedAt: string;
          settledAt: string | null;
        }>(
          'SELECT sequence, phase, pass, bucket, provider, category, admitted_at::text AS "admittedAt", settled_at::text AS "settledAt" FROM catalog_provider_send_attempts WHERE window_id = $1 ORDER BY sequence DESC LIMIT 50',
          [row.window_id],
        );
        const outstanding = await db.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM catalog_provider_send_attempts WHERE window_id = $1 AND settled_at IS NULL",
          [row.window_id],
        );
        const inFlight = outstanding.rows[0]?.count;
        if (inFlight === undefined || !Number.isSafeInteger(inFlight)) invalid();
        return {
          state: row.state,
          ...bindingOf(row),
          armedAt: new Date(row.armed_at).toISOString(),
          quota: providerSendPolicy.totalSends,
          used: row.used,
          reserved: providerSendPolicy.totalSends - row.used,
          inFlight,
          refusal: row.refusal,
          quotas: quotas.rows,
          members: validateMembers(row.members),
          attempts: attempts.rows.map((attempt) => ({
            ...attempt,
            admittedAt: new Date(attempt.admittedAt).toISOString(),
            settledAt: attempt.settledAt ? new Date(attempt.settledAt).toISOString() : null,
          })),
        };
      }),
  };
}
