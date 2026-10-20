import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// The run-named control-database login a staging evidence window lends its journal
// (#10224). It is limited to `evidence_window_provider_write` and `evidence_window`:
// `FOR SHARE` on `evidence_window` needs a column UPDATE grant
// (https://www.postgresql.org/docs/current/ddl-priv.html), which the ledgered control-plane
// migration makes non-effective for every name this pattern accepts. The job that
// provisions the login also revokes it; nothing here opens, closes or writes a window.

export const EVIDENCE_WINDOW_JOURNAL_PRINCIPAL_PREFIX = "evidence_window_journal_";
// GitHub run ids and attempts are positive decimals; anything else is not ours to reclaim.
export const EVIDENCE_WINDOW_JOURNAL_PRINCIPAL_PATTERN = "^evidence_window_journal_[1-9][0-9]{0,19}_[1-9][0-9]{0,5}$";
const principalPattern = new RegExp(EVIDENCE_WINDOW_JOURNAL_PRINCIPAL_PATTERN);
const runIdPattern = /^[1-9][0-9]{0,19}$/;
const scramIterations = 4096;

// The shipped journal's reserve lock, mirrored statement-for-statement so the probe
// exercises the same privilege path without writing a journal row.
export const EVIDENCE_WINDOW_JOURNAL_LOCK_SQL = `SELECT expires_at, statement_timestamp() AS created_at FROM evidence_window
         WHERE window_id = $1 AND state = 'open' AND expires_at > statement_timestamp() FOR SHARE`;
export const EVIDENCE_WINDOW_JOURNAL_ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

export type EvidenceWindowJournalPrincipal = Readonly<{ name: string; runId: string; attempt: number }>;

export function evidenceWindowJournalPrincipal(runId: string, attempt: number): EvidenceWindowJournalPrincipal {
  if (!runIdPattern.test(runId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 999_999) {
    throw new TypeError("evidence-window-journal-principal-identity-invalid");
  }
  return { name: `${EVIDENCE_WINDOW_JOURNAL_PRINCIPAL_PREFIX}${runId}_${attempt}`, runId, attempt };
}

/** Returns the run identity a name encodes, or null for any name this lane must not reclaim. */
export function parseEvidenceWindowJournalPrincipal(name: unknown): EvidenceWindowJournalPrincipal | null {
  if (typeof name !== "string" || !principalPattern.test(name)) return null;
  const [runId, attempt] = name.slice(EVIDENCE_WINDOW_JOURNAL_PRINCIPAL_PREFIX.length).split("_");
  return { name, runId: runId!, attempt: Number(attempt) };
}

/**
 * A SCRAM-SHA-256 verifier, so the login's password never reaches the server, a
 * statement log or an error message as plaintext.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, scramIterations, 32, "sha256");
  const storedKey = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${scramIterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const isInstant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));

export function evidenceWindowJournalPrincipalProvisionStatements(input: {
  principal: EvidenceWindowJournalPrincipal;
  database: string;
  verifier: string;
  validUntil: string;
}): string[] {
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(input.verifier)) {
    throw new TypeError("evidence-window-journal-principal-verifier-invalid");
  }
  if (!isInstant(input.validUntil) || input.database.length === 0) {
    throw new TypeError("evidence-window-journal-principal-input-invalid");
  }
  const role = identifier(input.principal.name);
  return [
    `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD ${literal(input.verifier)} VALID UNTIL ${literal(input.validUntil)}`,
    `GRANT CONNECT ON DATABASE ${identifier(input.database)} TO ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT ON TABLE public.evidence_window TO ${role}`,
    `GRANT UPDATE (version) ON TABLE public.evidence_window TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON TABLE public.evidence_window_provider_write TO ${role}`,
  ];
}

export function evidenceWindowJournalPrincipalExpireStatement(principal: EvidenceWindowJournalPrincipal): string {
  return `ALTER ROLE ${identifier(principal.name)} NOLOGIN VALID UNTIL '-infinity'`;
}

export function evidenceWindowJournalPrincipalDropStatements(
  principal: EvidenceWindowJournalPrincipal,
  database: string,
): string[] {
  const role = identifier(principal.name);
  return [
    `REVOKE ALL ON TABLE public.evidence_window_provider_write FROM ${role}`,
    `REVOKE ALL ON TABLE public.evidence_window FROM ${role}`,
    `REVOKE ALL ON SCHEMA public FROM ${role}`,
    `REVOKE ALL ON DATABASE ${identifier(database)} FROM ${role}`,
    `DROP ROLE IF EXISTS ${role}`,
  ];
}

// Every name in this database's cluster that the pattern owns, so residue is found by
// run-derived names rather than by a journal of what was created.
export async function listEvidenceWindowJournalPrincipals(db: PgQueryable): Promise<{
  principals: EvidenceWindowJournalPrincipal[];
  malformed: number;
}> {
  const result = await db.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE starts_with(rolname, $1) ORDER BY rolname LIMIT 101`,
    [EVIDENCE_WINDOW_JOURNAL_PRINCIPAL_PREFIX],
  );
  const principals: EvidenceWindowJournalPrincipal[] = [];
  let malformed = 0;
  for (const { rolname } of result.rows) {
    const principal = parseEvidenceWindowJournalPrincipal(rolname);
    if (principal) principals.push(principal);
    else malformed += 1;
  }
  return { principals, malformed: result.rows.length > 100 ? malformed + 1 : malformed };
}

export async function countEvidenceWindowJournalSessions(
  db: PgQueryable,
  principal: EvidenceWindowJournalPrincipal,
): Promise<number> {
  const result = await db.query<{ sessions: number }>(
    "SELECT count(*)::integer AS sessions FROM pg_stat_activity WHERE usename = $1",
    [principal.name],
  );
  return Number(result.rows[0]?.sessions ?? 0);
}

export async function terminateEvidenceWindowJournalSessions(
  db: PgQueryable,
  principal: EvidenceWindowJournalPrincipal,
): Promise<void> {
  await db.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [principal.name],
  );
}

export async function evidenceWindowJournalPrincipalExists(
  db: PgQueryable,
  principal: EvidenceWindowJournalPrincipal,
): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [principal.name]);
  return result.rows.length > 0;
}

export type EvidenceWindowJournalProbeName =
  | "advisory-lock"
  | "window-lock"
  | "evidence-window-update"
  | "evidence-window-insert"
  | "evidence-window-delete"
  | "journal-delete"
  | "unrelated-table-read"
  | "admin-function";

type ProbeExpectation = Readonly<{ name: EvidenceWindowJournalProbeName; sql: string; expect: "allowed" | "refused" }>;

// Each statement is a no-op even if a grant were wrong: false predicates, LIMIT 0, and
// one rolled-back transaction per statement, so a probe never writes probe data. The
// allowed window lock beside the refused update is what proves the column grant exists
// and the migration's trigger, not a missing grant, refuses the write.
export const evidenceWindowJournalProbes: readonly ProbeExpectation[] = Object.freeze([
  { name: "advisory-lock", sql: EVIDENCE_WINDOW_JOURNAL_ADVISORY_LOCK_SQL, expect: "allowed" },
  { name: "window-lock", sql: EVIDENCE_WINDOW_JOURNAL_LOCK_SQL, expect: "allowed" },
  {
    name: "evidence-window-update",
    sql: "UPDATE evidence_window SET version = version WHERE false",
    expect: "refused",
  },
  {
    name: "evidence-window-insert",
    sql: "INSERT INTO evidence_window SELECT * FROM evidence_window WHERE false",
    expect: "refused",
  },
  { name: "evidence-window-delete", sql: "DELETE FROM evidence_window WHERE false", expect: "refused" },
  { name: "journal-delete", sql: "DELETE FROM evidence_window_provider_write WHERE false", expect: "refused" },
  { name: "unrelated-table-read", sql: "SELECT 1 FROM platform_control_leases LIMIT 0", expect: "refused" },
  { name: "admin-function", sql: "SELECT pg_reload_conf()", expect: "refused" },
]);

export type EvidenceWindowJournalProbeResult = Readonly<{
  name: EvidenceWindowJournalProbeName;
  expected: "allowed" | "refused";
  observed: "allowed" | "refused" | "failed";
}>;

type ProbeClient = Readonly<{
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}>;

/** Runs every probe on one principal session; a mismatch is reported, never thrown. */
export async function runEvidenceWindowJournalProbes(
  client: ProbeClient,
  windowId: string,
): Promise<EvidenceWindowJournalProbeResult[]> {
  const results: EvidenceWindowJournalProbeResult[] = [];
  for (const probe of evidenceWindowJournalProbes) {
    const values = probe.sql.includes("$1")
      ? [probe.name === "advisory-lock" ? `provider-write:${windowId}:1` : windowId]
      : [];
    let observed: EvidenceWindowJournalProbeResult["observed"];
    try {
      await client.query("BEGIN");
      await client.query(probe.sql, values);
      observed = "allowed";
    } catch (error) {
      observed = sqlState(error) === "42501" ? "refused" : "failed";
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    results.push({ name: probe.name, expected: probe.expect, observed });
  }
  return results;
}

function sqlState(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}
